/*
 * render.js — three.js 体素渲染器
 * 单 InstancedMesh 渲染全部方块，每个实例携带 top/side 的 atlas UV 原点，
 * 顶点着色器按面法线选择贴图。只渲染表面方块（内部方块由 voxel.surface() 剔除）。
 *
 * 相机：球坐标轨道（触摸拖拽旋转 / 双指缩放平移）
 * 拾取：InstancedMesh.raycast → instanceId → 方块坐标 + 面法线
 */
(function (root) {
  'use strict';
  var THREE = root.THREE;

  var MAX_INSTANCES = 65536;

  function VoxelRenderer(canvas, atlas) {
    this.canvas = canvas;
    this.atlas = atlas;                 // {img, cell, pad, cols, size, uv}
    this.sx = 16; this.sy = 16; this.sz = 16;
    this.camera = null;
    this.scene = null;
    this.renderer = null;
    this.mesh = null;
    this._surface = [];                 // 当前可见列表（instanceId -> {x,y,z,v}）
    this._grid = null;
    this._outline = null;
    this._needRebuild = true;
    this._init();
  }

  VoxelRenderer.prototype._init = function () {
    var w = this.canvas.clientWidth || 300;
    var h = this.canvas.clientHeight || 300;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(0x0f1118, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0f1118, 60, 160);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 2000);

    var amb = new THREE.AmbientLight(0xffffff, 0.72);
    this.scene.add(amb);
    var dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(0.6, 1, 0.35);
    this.scene.add(dir);
    var dir2 = new THREE.DirectionalLight(0xaaccff, 0.32);
    dir2.position.set(-0.7, 0.4, -0.6);
    this.scene.add(dir2);

    // atlas 纹理
    var tex = new THREE.Texture(this.atlas.img);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = true;
    tex.needsUpdate = true;
    this.tex = tex;

    var W = this.atlas.size[0], H = this.atlas.size[1];
    this._cellU = this.atlas.cell / W;
    this._cellV = this.atlas.cell / H;
    this._W = W; this._H = H;

    // 相机轨道
    // theta 取 0.21π（约 38°）而非 0.25π：45° 会让相机与 cross 类方块的 45° 平面共面，投影成一条线
    this.orbit = { theta: Math.PI * 0.167, phi: Math.PI * 0.32, radius: 34, tx: 0, ty: 3, tz: 0 };

    this._buildMesh();
    this._buildGrid();
    this._buildGround();
    this._buildOutline();
  };

  /**
   * 运行时换图集（导入模组时把新贴图并进 atlas）。
   * 材质的 uCellU/uCellV 是编译期常量，所以必须重建 mesh/material；
   * 轨道相机、网格、选中框都不动，只换方块层。
   */
  VoxelRenderer.prototype.setAtlas = function (atlas) {
    this.atlas = atlas;
    if (this.tex) this.tex.dispose();
    var tex = new THREE.Texture(atlas.img);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = true;
    tex.needsUpdate = true;
    this.tex = tex;
    var W = atlas.size[0], H = atlas.size[1];
    this._cellU = atlas.cell / W;
    this._cellV = atlas.cell / H;
    this._W = W;
    this._H = H;
    var oldMat = this.mesh && this.mesh.material;
    this._buildMesh();
    if (oldMat) oldMat.dispose();
    this.markDirty();
  };

  VoxelRenderer.prototype._makeMaterial = function () {
    var self = this;
    var mat = new THREE.MeshLambertMaterial({ map: this.tex, alphaTest: 0.5 });
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.uCellU = { value: self._cellU };
      shader.uniforms.uCellV = { value: self._cellV };
      // 注意：r137 的 <uv_vertex> 出现在 <beginnormal_vertex> 之前，
      // 那时 objectNormal 还不存在。必须注入到 <begin_vertex> 之后，
      // 此时 objectNormal 已定义，且 vUv 已由 uv_vertex 赋过值（可直接覆盖）。
      shader.vertexShader =
        'attribute vec2 aTopUv;\nattribute vec2 aSideUv;\nuniform float uCellU;\nuniform float uCellV;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
          '  float _isTop = step(0.5, abs(objectNormal.y));\n' +
          '  vec2 _org = mix(aSideUv, aTopUv, _isTop);\n' +
          '  vUv = _org + uv * vec2(uCellU, uCellV);'
        );
    };
    mat.customProgramCacheKey = function () { return 'voxel-atlas-3'; };
    return mat;
  };

  VoxelRenderer.prototype._buildMesh = function () {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    var geo = new THREE.BoxGeometry(1, 1, 1);
    var topUv = new Float32Array(MAX_INSTANCES * 2);
    var sideUv = new Float32Array(MAX_INSTANCES * 2);
    geo.setAttribute('aTopUv', new THREE.InstancedBufferAttribute(topUv, 2));
    geo.setAttribute('aSideUv', new THREE.InstancedBufferAttribute(sideUv, 2));

    var mat = this._makeMaterial();
    var mesh = new THREE.InstancedMesh(geo, mat, MAX_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.scene.add(mesh);
  };

  VoxelRenderer.prototype._buildGrid = function () {
    var g = new THREE.Group();
    var mat = new THREE.LineBasicMaterial({ color: 0x5b7fc7 });
    this._gridMat = mat;
    this._grid = g;
    this.scene.add(g);
  };

  /** 坐标轴指示器（MC 配色：X 红 / Y 绿 / Z 蓝），从方块坐标 (0,0,0) 的角出发 */
  VoxelRenderer.prototype._buildAxes = function () {
    if (this._axes) {
      this.scene.remove(this._axes);
      for (var i = this._axes.children.length - 1; i >= 0; i--) {
        var ch = this._axes.children[i];
        if (ch.geometry) ch.geometry.dispose();
        if (ch.material) ch.material.dispose();
      }
      this._axes = null;
    }
    var sx = this.sx || 16, sy = this.sy || 16, sz = this.sz || 16;
    var ox = -sx / 2, oz = -sz / 2;
    // 三条轴占满立方体的三条边（从 (0,0,0) 角到对端）
    var yA = 0.008;   // 微小抬高，避开底面网格共面闪烁
    var defs = [
      [0xff4d4d, [ox, yA, oz], [ox + sx, yA, oz]],      // X 红：整条宽度
      [0x4dff4d, [ox, yA, oz], [ox, sy, oz]],           // Y 绿：整条高度
      [0x4d8dff, [ox, yA, oz], [ox, yA, oz + sz]]       // Z 蓝：整条深度
    ];
    var g = new THREE.Group();
    for (var k = 0; k < defs.length; k++) {
      var d = defs[k];
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(
        [d[1][0], d[1][1], d[1][2], d[2][0], d[2][1], d[2][2]], 3));
      var mat = new THREE.LineBasicMaterial({ color: d[0] });
      var line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      g.add(line);
    }
    this._axes = g;
    this.scene.add(g);
  };



  /** 透明地面：空世界时也能拾取，用于放第一块方块 */
  /** 场景内壁：一个 BackSide 的透明立方体，六个内表面都能被射线命中 */





  /** 只显示朝向相机的内壁（正交等轴测：相机在哪个轴的正/负侧就显示对面） */
  /** 只显示朝向相机的内壁。
   *  xmin 画在 x=-sx/2，xmax 画在 x=+sx/2，以此类推。
   *  相机在 +x 侧时，看到的是 xmin 那面墙（离相机最远的内壁）。
   */
  VoxelRenderer.prototype._updateGridVisibility = function () {
    if (!this._gridFaces || !this.camera) return;
    var p = this.camera.position;
    var f = this._gridFaces;
    var sx = this.sx || 16, sy = this.sy || 16, sz = this.sz || 16;
    if (f.xmin) f.xmin.visible = p.x > 0;
    if (f.xmax) f.xmax.visible = p.x < 0;
    if (f.ymin) f.ymin.visible = p.y > 0;
    if (f.ymax) f.ymax.visible = p.y < sy / 2;
    if (f.zmin) f.zmin.visible = p.z > 0;
    if (f.zmax) f.zmax.visible = p.z < 0;
  };

  /** 场景内壁：一个 BackSide 的透明立方体，六个内表面都能被射线命中 */
  VoxelRenderer.prototype._buildGround = function () {
    if (this._ground) {
      this.scene.remove(this._ground);
      if (this._ground.geometry) this._ground.geometry.dispose();
    }
    var sx = this.sx || 16, sy = this.sy || 16, sz = this.sz || 16;
    var geo = new THREE.BoxGeometry(sx, sy, sz);
    var mat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, side: THREE.BackSide
    });
    var m = new THREE.Mesh(geo, mat);
    m.position.set(0, sy / 2, 0);
    m.frustumCulled = false;
    this._ground = m;
    this.scene.add(m);
  };

  VoxelRenderer.prototype._updateGround = function () {
    this._buildGround();
  };


  /** 框选区域可视化（半透明盒 + 线框） */
  VoxelRenderer.prototype.setSelection = function (x0, y0, z0, x1, y1, z1) {
    if (!this._selBox) {
      var g = new THREE.BoxGeometry(1, 1, 1);
      var m = new THREE.MeshBasicMaterial({
        color: 0x4ea1ff, transparent: true, opacity: 0.2, depthWrite: false
      });
      this._selBox = new THREE.Mesh(g, m);
      this._selBox.frustumCulled = false;
      this.scene.add(this._selBox);
      var eg = new THREE.EdgesGeometry(g);
      this._selEdge = new THREE.LineSegments(eg,
        new THREE.LineBasicMaterial({ color: 0x6fb5ff, transparent: true, opacity: 0.9 }));
      this._selEdge.frustumCulled = false;
      this.scene.add(this._selEdge);
    }
    var w = Math.abs(x1 - x0) + 1, h = Math.abs(y1 - y0) + 1, d = Math.abs(z1 - z0) + 1;
    var cx = (x0 + x1) / 2 + 0.5 - this.sx / 2;
    var cy = (y0 + y1) / 2 + 0.5;
    var cz = (z0 + z1) / 2 + 0.5 - this.sz / 2;
    this._selBox.scale.set(w, h, d);
    this._selBox.position.set(cx, cy, cz);
    this._selEdge.scale.set(w, h, d);
    this._selEdge.position.set(cx, cy, cz);
    this._selBox.visible = true;
    this._selEdge.visible = true;
  };

  VoxelRenderer.prototype.clearSelection = function () {
    if (this._selBox) this._selBox.visible = false;
    if (this._selEdge) this._selEdge.visible = false;
  };

  VoxelRenderer.prototype._buildOutline = function () {
    var g = new THREE.BoxGeometry(1.02, 1.02, 1.02);
    var edges = new THREE.EdgesGeometry(g);
    var mat = new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.95 });
    var line = new THREE.LineSegments(edges, mat);
    line.visible = false;
    this._outline = line;
    this.scene.add(line);
  };

  VoxelRenderer.prototype.setSize = function (sx, sy, sz) {
    this.sx = sx; this.sy = sy; this.sz = sz;
    // 方块世界以 (0,0,0) 为中心，相机也要盯中心
    this.orbit.tx = 0; this.orbit.ty = sy / 4; this.orbit.tz = 0;
    this.orbit.radius = Math.max(sx, sy, sz) * 1.9 + 10;
    this._rebuildGrid();
    this._buildAxes();
    this._updateGround();
    this._needRebuild = true;
  };

  VoxelRenderer.prototype._rebuildGrid = function () {
    while (this._grid.children.length) {
      var c = this._grid.children.pop();
      if (c.geometry) c.geometry.dispose();
    }
    var sx = this.sx || 16;
    var sy = this.sy || sx;
    var sz = this.sz || sx;
    var ox = -sx / 2, oz = -sz / 2;
    var self = this;
    this._gridFaces = {};

    function face(key, fn) {
      var pts = [];
      fn(pts);
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      var l = new THREE.LineSegments(g, self._gridMat);
      l.frustumCulled = false;
      self._grid.add(l);
      self._gridFaces[key] = l;
    }

    face('ymin', function (p) {
      for (var x = 0; x <= sx; x++) p.push(ox + x, 0, oz, ox + x, 0, oz + sz);
      for (var z = 0; z <= sz; z++) p.push(ox, 0, oz + z, ox + sx, 0, oz + z);
    });
    face('ymax', function (p) {
      for (var x = 0; x <= sx; x++) p.push(ox + x, sy, oz, ox + x, sy, oz + sz);
      for (var z = 0; z <= sz; z++) p.push(ox, sy, oz + z, ox + sx, sy, oz + z);
    });
    face('zmin', function (p) {
      for (var y = 0; y <= sy; y++) p.push(ox, y, oz, ox + sx, y, oz);
      for (var x = 0; x <= sx; x++) p.push(ox + x, 0, oz, ox + x, sy, oz);
    });
    face('zmax', function (p) {
      for (var y = 0; y <= sy; y++) p.push(ox, y, oz + sz, ox + sx, y, oz + sz);
      for (var x = 0; x <= sx; x++) p.push(ox + x, 0, oz + sz, ox + x, sy, oz + sz);
    });
    face('xmin', function (p) {
      for (var y = 0; y <= sy; y++) p.push(ox, y, oz, ox, y, oz + sz);
      for (var z = 0; z <= sz; z++) p.push(ox, 0, oz + z, ox, sy, oz + z);
    });
    face('xmax', function (p) {
      for (var y = 0; y <= sy; y++) p.push(ox + sx, y, oz, ox + sx, y, oz + sz);
      for (var z = 0; z <= sz; z++) p.push(ox + sx, 0, oz + z, ox + sx, sy, oz + z);
    });

    var corners = [[ox, 0, oz], [ox + sx, 0, oz], [ox + sx, 0, oz + sz], [ox, 0, oz + sz],
                   [ox, sy, oz], [ox + sx, sy, oz], [ox + sx, sy, oz + sz], [ox, sy, oz + sz]];
    // 去掉 [0,1]（X轴红）、[0,3]（Z轴蓝）、[0,4]（Y轴绿）三条边，交给坐标轴画
    var edges = [[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[1,5],[2,6],[3,7]];
    var epts = [];
    edges.forEach(function (e) {
      var a = corners[e[0]], b = corners[e[1]];
      epts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    });
    var g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(epts, 3));
    var m2 = new THREE.LineBasicMaterial({ color: 0x5a6b8c, transparent: true, opacity: 0.9 });
    var l2 = new THREE.LineSegments(g2, m2);
    l2.frustumCulled = false;
    this._grid.add(l2);

    this._gridDbg = 'sx' + sx + ' sy' + sy + ' sz' + sz;
    this._updateGridVisibility();
  };


  /** 不可见的拾取网格：包含所有方块（含非立方体），只用于射线检测 */
  VoxelRenderer.prototype._buildPickMesh = function (list) {
    if (this._pickMesh) {
      this.scene.remove(this._pickMesh);
      this._pickMesh.geometry.dispose();
      this._pickMesh = null;
    }
    if (!list.length) return;
    var geo = new THREE.BoxGeometry(1, 1, 1);
    if (!this._pickMat) {
      this._pickMat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false
      });
    }
    var n = Math.min(list.length, MAX_INSTANCES);
    var mm = new THREE.InstancedMesh(geo, this._pickMat, n);
    var m4 = new THREE.Matrix4();
    var ox = -this.sx / 2, oz = -this.sz / 2;
    for (var i = 0; i < n; i++) {
      var s = list[i];
      m4.makeTranslation(s.x + ox + 0.5, s.y + 0.5, s.z + oz + 0.5);
      mm.setMatrixAt(i, m4);
    }
    mm.count = n;
    mm.instanceMatrix.needsUpdate = true;
    mm.frustumCulled = false;
    this._pickMesh = mm;
    this.scene.add(mm);
  };

  /** 非立方体方块：合并成一个 BufferGeometry */
  VoxelRenderer.prototype._buildModelMesh = function (list, catalog) {
    if (this._modelMesh) {
      this.scene.remove(this._modelMesh);
      this._modelMesh.geometry.dispose();
      this._modelMesh = null;
    }
    if (!list.length || !this._models || !root.ModelMesh) return;
    var ox = -this.sx / 2, oz = -this.sz / 2;
    var res = root.ModelMesh.buildSceneGeometry(
      list, catalog, this._models, this.atlas, ox, oz, this._states);
    // 流体几何在 res.fluid 里，即使不透明部分为空也要先构建（全水场景）
    this._buildFluidMesh(res.fluid);
    if (!res.pos.length) return;

    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(res.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(res.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(res.uv, 2));
    g.setIndex(res.idx);

    if (!this._modelMat) {
      this._modelMat = new THREE.MeshLambertMaterial({
        map: this.tex, alphaTest: 0.5, side: THREE.DoubleSide
      });
    }
    var mesh = new THREE.Mesh(g, this._modelMat);
    mesh.frustumCulled = false;
    this._modelMesh = mesh;
    this.scene.add(mesh);
  };

  /** 流体（水/岩浆）：半透明材质 + 在不透明物体之后渲染 */
  VoxelRenderer.prototype._buildFluidMesh = function (fl) {
    if (this._fluidMesh) {
      this.scene.remove(this._fluidMesh);
      this._fluidMesh.geometry.dispose();
      this._fluidMesh = null;
    }
    if (!fl || !fl.pos.length) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(fl.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(fl.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(fl.uv, 2));
    g.setIndex(fl.idx);
    if (!this._fluidMat) {
      this._fluidMat = new THREE.MeshLambertMaterial({
        map: this.tex, transparent: true, opacity: 0.78,
        depthWrite: false, side: THREE.DoubleSide
      });
    }
    var mesh = new THREE.Mesh(g, this._fluidMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    this._fluidMesh = mesh;
    this.scene.add(mesh);
  };

  /** 隐藏方块用线框表示（颜色取各自贴图主色） */
  VoxelRenderer.prototype._buildHiddenWire = function (list, catalog) {
    if (this._hiddenWire) {
      this.scene.remove(this._hiddenWire);
      this._hiddenWire.geometry.dispose();
      this._hiddenWire = null;
    }
    if (!list || !list.length) return;
    var ox = -this.sx / 2, oz = -this.sz / 2;
    var E = [[0,0,0,1,0,0],[1,0,0,1,0,1],[1,0,1,0,0,1],[0,0,1,0,0,0],
             [0,1,0,1,1,0],[1,1,0,1,1,1],[1,1,1,0,1,1],[0,1,1,0,1,0],
             [0,0,0,0,1,0],[1,0,0,1,1,0],[1,0,1,1,1,1],[0,0,1,0,1,1]];
    var pos = [], col = [];
    var self = this;
    var colorCache = {};
    function rgbOf(name) {
      if (colorCache[name]) return colorCache[name];
      var uv = self.atlas.uv[name];
      var r = 0.6, g = 0.6, b = 0.6;
      if (uv && self.atlas.img) {
        try {
          var cv = document.createElement('canvas');
          cv.width = 16; cv.height = 16;
          var cx = cv.getContext('2d');
          cx.drawImage(self.atlas.img, uv.x, uv.y, 16, 16, 0, 0, 16, 16);
          var d = cx.getImageData(0, 0, 16, 16).data;
          var sr = 0, sg = 0, sb = 0, n = 0;
          for (var i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 40) continue;
            sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++;
          }
          if (n) { r = sr / n / 255; g = sg / n / 255; b = sb / n / 255; }
        } catch (e) { /* ignore */ }
      }
      var out = [r, g, b];
      colorCache[name] = out;
      return out;
    }
    for (var i2 = 0; i2 < list.length; i2++) {
      var s = list[i2];
      var c = catalog[s.v.c];
      if (!c) continue;
      var cl = rgbOf(c.top || c.side);
      var x0 = s.x + ox, y0 = s.y, z0 = s.z + oz;
      for (var e = 0; e < E.length; e++) {
        var ed = E[e];
        pos.push(x0 + ed[0], y0 + ed[1], z0 + ed[2]);
        pos.push(x0 + ed[3], y0 + ed[4], z0 + ed[5]);
        col.push(cl[0], cl[1], cl[2], cl[0], cl[1], cl[2]);
      }
    }
    if (!pos.length) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    var mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
    var line = new THREE.LineSegments(g, mat);
    line.frustumCulled = false;
    this._hiddenWire = line;
    this.scene.add(line);
  };

  VoxelRenderer.prototype._uvOf = function (texName) {
    var u = this.atlas.uv[texName];
    if (!u) return [0, 0];
    var pad = this.atlas.pad;
    var W = this._W, H = this._H;
    var x = u.x, y = u.y;              // 内容左上（像素，图像坐标系）
    return [x / W, 1 - (y + this.atlas.cell) / H];
  };

  VoxelRenderer.prototype.markDirty = function () { this._needRebuild = true; };

  /** 用 world 重建实例数据 */
  /** 注入 models.json */
  VoxelRenderer.prototype.setStates = function (st) {
    this._states = st;
    this._needRebuild = true;
  };

  VoxelRenderer.prototype.setModels = function (models) {
    this._models = models;
    this._needRebuild = true;
  };

  /** 透视：不做内部剔除，渲染所有方块的所有面 */
  VoxelRenderer.prototype.setXray = function (on) {
    this._xray = !!on;
    this._needRebuild = true;
  };

  VoxelRenderer.prototype.setEntityBlocks = function (set) {
    this._entBlocks = set || null;
    this._needRebuild = true;
  };

  VoxelRenderer.prototype.update = function (world, catalog, hiddenSet) {
    if (!this._needRebuild) return;
    this._catalog = catalog;
    if (hiddenSet) this._hiddenSet = hiddenSet;
    else if (!this._hiddenSet) this._hiddenSet = new Set();
    var allSurf = world.surface();      // 拾取用全量（含实体方块）
    // ★ 透视模式：用「全部方块」而不是表面方块 —— 内部面也要画出来
    var surf = this._xray ? world.allBlocks() : allSurf;
    var hiddenSurf = [];
    if (this._hiddenSet && this._hiddenSet.size) {
      var hs = this._hiddenSet;
      var ct = catalog;
      var kept = [];
      for (var _i = 0; _i < surf.length; _i++) {
        var _s = surf[_i];
        var _c = ct[_s.v.c];
        if (_c && hs.has(_c.n)) hiddenSurf.push(_s);
        else kept.push(_s);
      }
      surf = kept;
    }
    this._buildHiddenWire(hiddenSurf, catalog);

    // 实体方块（箱子/告示牌…）交给实体渲染器画，这里只从「显示」里摘掉，拾取保留
    if (this._entBlocks && this._entBlocks.size) {
      var _es = this._entBlocks, _ct2 = catalog, _kept2 = [];
      for (var _j = 0; _j < surf.length; _j++) {
        var _c2 = _ct2[surf[_j].v.c];
        if (_c2 && _es.has(_c2.n)) continue;
        _kept2.push(surf[_j]);
      }
      surf = _kept2;
    }

    // 分离：立方体走 InstancedMesh，其余走合并几何
    var cubeList = [], modelList = [];
    var mdl = this._models || {};
    for (var si = 0; si < surf.length; si++) {
      var sc = catalog[surf[si].v.c];
      var mm = sc ? mdl[sc.n] : null;
      // 流体要按 level 变高度，必须走模型路径（InstancedMesh 只能画满方块）
      var isFluid = sc && (sc.n === 'water' || sc.n === 'lava');
      if (isFluid || (mm && mm.els && !mm.cube)) modelList.push(surf[si]);
      else cubeList.push(surf[si]);
    }
    this._allSurface = allSurf;       // ★ 拾取索引必须和 _buildPickMesh(allSurf) 对齐
    this._cubeSurface = cubeList;
    this._buildModelMesh(modelList, catalog);
    this._buildPickMesh(allSurf);

    var m = this.mesh;
    var mat4 = new THREE.Matrix4();
    var mRx = new THREE.Matrix4(), mRy = new THREE.Matrix4(), mRz = new THREE.Matrix4();
    var hasTf = !!(root.ModelMesh && root.ModelMesh.stateTransform);
    var arrTop = m.geometry.getAttribute('aTopUv');
    var arrSide = m.geometry.getAttribute('aSideUv');
    var n = Math.min(cubeList.length, MAX_INSTANCES);
    var ox = -this.sx / 2, oz = -this.sz / 2;

    for (var i = 0; i < n; i++) {
      var s = cubeList[i];
      // 立方体方块也要响应状态（原木 axis 等）：实例矩阵带旋转
      var tf = hasTf ? root.ModelMesh.stateTransform(s.v) : null;
      if (tf) {
        mat4.identity();
        if (tf.x) mat4.multiply(mRx.makeRotationX(tf.x * Math.PI / 180));
        if (tf.y) mat4.multiply(mRy.makeRotationY(tf.y * Math.PI / 180));
        if (tf.z) mat4.multiply(mRz.makeRotationZ(tf.z * Math.PI / 180));
        mat4.setPosition(s.x + ox + 0.5, s.y + 0.5, s.z + oz + 0.5);
      } else {
        mat4.makeTranslation(s.x + ox + 0.5, s.y + 0.5, s.z + oz + 0.5);
      }
      m.setMatrixAt(i, mat4);

      var cat = catalog[s.v.c];
      var topUv = this._uvOf(cat ? cat.top : 'stone');
      var sideUv = this._uvOf(cat ? cat.side : 'stone');
      arrTop.setXY(i, topUv[0], topUv[1]);
      arrSide.setXY(i, sideUv[0], sideUv[1]);
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    arrTop.needsUpdate = true;
    arrSide.needsUpdate = true;
    this._needRebuild = false;
  };

  /**
   * 相机朝向用四元数存（orbit.q）——真正的「绝对自由旋转」：
   * 没有俯仰角上下限、能翻过极点、能带滚转。
   * theta/phi 只是从 q 反推出来的兼容量（放置朝向 viewFacing 还在用）。
   */
  VoxelRenderer.prototype.setOrbitFromAngles = function () {
    var o = this.orbit;
    var x = Math.sin(o.phi) * Math.cos(o.theta);
    var y = Math.cos(o.phi);
    var z = Math.sin(o.phi) * Math.sin(o.theta);
    // ★ 用 Matrix4.lookAt（相机约定：-Z 看向目标）→ 四元数的 +Z 正好是「目标指向相机」
    var m = new THREE.Matrix4();
    m.lookAt(new THREE.Vector3(x, y, z), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    o.q = new THREE.Quaternion().setFromRotationMatrix(m);
  };

  VoxelRenderer.prototype.updateCamera = function () {
    var o = this.orbit;
    if (!o.q) this.setOrbitFromAngles();
    var off = new THREE.Vector3(0, 0, o.radius).applyQuaternion(o.q);
    this.camera.quaternion.copy(o.q);
    this.camera.position.set(o.tx + off.x, o.ty + off.y, o.tz + off.z);
    // 反推 theta/phi（供 placement 的「朝向相机」判断）
    var d = new THREE.Vector3(0, 0, 1).applyQuaternion(o.q);
    o.theta = Math.atan2(d.z, d.x);
    o.phi = Math.acos(Math.max(-1, Math.min(1, d.y)));
  };

  VoxelRenderer.prototype.render = function () {
    this.updateCamera();
    this._updateGridVisibility();
    this.renderer.render(this.scene, this.camera);
  };

  VoxelRenderer.prototype.resize = function () {
    var w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  };

  /**
   * 屏幕坐标 -> 命中的实体（obj.userData.entityKey 由 app.js 的 rebuildEntities 写入）
   * ★ 不用 THREE 射线：实体模型常带负缩放（yUp 翻转）→ 三角面绕向反了，
   *   FrontSide 材质会被背面剔除，射线永远打不中。这里改成「包围盒投影到屏幕」判定，
   *   对少量实体足够准，也不受模型绕向影响。
   * 返回 { key:'x,y,z', dist } 或 null
   */
  VoxelRenderer.prototype.pickEntity = function (clientX, clientY, root) {
    if (!root || !root.children.length) return null;
    var rect = this.canvas.getBoundingClientRect();
    var cam = this.camera;
    var best = null;
    var box = new THREE.Box3();
    var v = new THREE.Vector3();
    for (var i = 0; i < root.children.length; i++) {
      var o = root.children[i];
      if (!o.userData || !o.userData.entityKey) continue;
      box.setFromObject(o);
      if (box.isEmpty()) continue;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, behind = true;
      for (var c = 0; c < 8; c++) {
        v.set(c & 1 ? box.max.x : box.min.x,
              c & 2 ? box.max.y : box.min.y,
              c & 4 ? box.max.z : box.min.z);
        v.project(cam);
        if (v.z < 1) behind = false;
        var sx = (v.x * 0.5 + 0.5) * rect.width + rect.left;
        var sy = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
      }
      if (behind) continue;
      var pad = 6;                              // 手指点击容差
      if (clientX < minX - pad || clientX > maxX + pad || clientY < minY - pad || clientY > maxY + pad) continue;
      var ctr = box.getCenter(new THREE.Vector3());
      var d = cam.position.distanceTo(ctr);
      if (!best || d < best.dist) best = { key: o.userData.entityKey, dist: d };
    }
    return best;
  };

  /** 屏幕坐标 -> 命中的方块 {x,y,z,nx,ny,nz} 或 null */
  VoxelRenderer.prototype.pick = function (clientX, clientY, mode, pierceSet) {
    var rect = this.canvas.getBoundingClientRect();
    var ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    var ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    ray.far = 400;
    // ① 先打方块（能堆叠、能点面）；被标记「穿透」的方块跳过
    var pickObj = this._pickMesh || this.mesh;
    var surfRef = this._pickMesh ? this._allSurface : this._surface;
    var hits = ray.intersectObject(pickObj, false);
    for (var hi = 0; hi < hits.length; hi++) {
      var h = hits[hi];
      if (h.instanceId === undefined || h.instanceId >= surfRef.length) continue;
      var s = surfRef[h.instanceId];
      if (pierceSet && pierceSet.size && this._catalog) {
        var cc = this._catalog[s.v.c];
        if (cc && pierceSet.has(cc.n)) continue;
      }
      if (mode === "erase") {
        return { x: s.x, y: s.y, z: s.z, nx: 0, ny: 0, nz: 0, dist: h.distance };
      }
      var n = h.face ? h.face.normal : new THREE.Vector3(0, 1, 0);
      // 命中点在格子内的局部坐标（0..1）：按放置情况选形态（半砖上/下、楼梯上/下、原木朝向）用
      var pcx = s.x - this.sx / 2 + 0.5, pcy = s.y + 0.5, pcz = s.z - this.sz / 2 + 0.5;
      var lx = h.point ? (h.point.x - pcx + 0.5) : 0.5;
      var ly = h.point ? (h.point.y - pcy + 0.5) : 0.5;
      var lz = h.point ? (h.point.z - pcz + 0.5) : 0.5;
      return { x: s.x, y: s.y, z: s.z,
               nx: Math.round(n.x), ny: Math.round(n.y), nz: Math.round(n.z),
               lx: lx, ly: ly, lz: lz, dist: h.distance };
    }
    // ② 没命中方块 -> 检测场景内壁（六面立方体），用于在高处/空白处放方块
    if (mode === "erase") return null;
    if (this._ground) {
      var gh = ray.intersectObject(this._ground, false);
      if (gh.length) {
        var pt = gh[0].point;
        var sx = this.sx, sy = this.sy, sz = this.sz;
        var lx = pt.x + sx / 2;   // 0..sx
        var ly = pt.y;            // 0..sy
        var lz = pt.z + sz / 2;   // 0..sz
        var eps = 0.6;
        var cx = function (v, n) { return v < 0 ? 0 : (v >= n ? n - 1 : v); };

        if (ly < eps) {                       // 底面
          return { x: cx(Math.floor(lx), sx), y: 0, z: cx(Math.floor(lz), sz),
                   nx: 0, ny: 0, nz: 0, ground: true, lx: 0.5, ly: 0.5, lz: 0.5 };
        }
        if (ly > sy - eps) {                  // 顶面 -> 放在最上层
          return { x: cx(Math.floor(lx), sx), y: sy - 1, z: cx(Math.floor(lz), sz),
                   nx: 0, ny: 0, nz: 0, wall: true, lx: 0.5, ly: 0.5, lz: 0.5 };
        }
        if (lx < eps) {                       // x=0 墙
          return { x: 0, y: cx(Math.floor(ly), sy), z: cx(Math.floor(lz), sz),
                   nx: 0, ny: 0, nz: 0, wall: true, lx: 0.5, ly: 0.5, lz: 0.5 };
        }
        if (lx > sx - eps) {                  // x=sx 墙
          return { x: sx - 1, y: cx(Math.floor(ly), sy), z: cx(Math.floor(lz), sz),
                   nx: 0, ny: 0, nz: 0, wall: true, lx: 0.5, ly: 0.5, lz: 0.5 };
        }
        if (lz < eps) {                       // z=0 墙
          return { x: cx(Math.floor(lx), sx), y: cx(Math.floor(ly), sy), z: 0,
                   nx: 0, ny: 0, nz: 0, wall: true, lx: 0.5, ly: 0.5, lz: 0.5 };
        }
        if (lz > sz - eps) {                  // z=sz 墙
          return { x: cx(Math.floor(lx), sx), y: cx(Math.floor(ly), sy), z: sz - 1,
                   nx: 0, ny: 0, nz: 0, wall: true, lx: 0.5, ly: 0.5, lz: 0.5 };
        }
      }
    }
    return null;
  };

  VoxelRenderer.prototype.setOutline = function (cell) {
    if (!cell) { this._outline.visible = false; return; }
    var ox = -this.sx / 2, oz = -this.sz / 2;
    this._outline.position.set(cell.x + ox + 0.5, cell.y + 0.5, cell.z + oz + 0.5);
    this._outline.visible = true;
  };

  root.VoxelRenderer = VoxelRenderer;
})(typeof window !== 'undefined' ? window : this);
