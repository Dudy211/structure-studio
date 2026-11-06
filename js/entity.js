/* 通用 Minecraft 实体渲染器 —— 吃 data/entities.json 的模型树 + 一张贴图。
 *
 * 模型树来自官方 jar 的字节码（tools/extract_entities.py 把 createBodyLayer 跑了一遍）：
 *   {n:零件名, p:[pivot x,y,z], r:[rot x,y,z], c:[{o:[x,y,z], s:[w,h,d], uv:[u,v], m:mirror, i:inflate}], k:[子零件]}
 * 坐标是 MC 的「模型像素」：1 格 = 16，y 轴向下。
 * 所以最外层套一个 scale(1/16, -1/16, 1/16) 就变成 three 的「y 向上、1 格 = 1」。
 *
 * UV 用 MC 的 cuboid 展开表（Blockbench 同款）：
 *      [u+d, v   ] up          [u+d+w, v   ] down
 *  [u , v+d] west  [u+d, v+d] north  [u+d+w, v+d] east  [u+d+w+d, v+d] south
 */
(function () {
  var texCache = {};

  function texFor(url) {
    if (texCache[url]) return texCache[url];
    var t = new THREE.Texture();
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.image = new Image();
    t.image.onload = function () {
      t.needsUpdate = true;
      if (t.__onload) t.__onload(t);
    };
    t.image.src = url;
    if (t.image.complete && t.image.naturalWidth) t.needsUpdate = true;  // 命中缓存时 onload 可能已错过
    texCache[url] = t;
    return t;
  }

  /* 一个 cuboid 的 6 个面：pos 用模型像素，uv 用贴图像素 */
  function cubeFaces(c, texW, texH) {
    var i = c.i || 0;
    var x0 = c.o[0] - i, y0 = c.o[1] - i, z0 = c.o[2] - i;
    var x1 = c.o[0] + c.s[0] + i, y1 = c.o[1] + c.s[1] + i, z1 = c.o[2] + c.s[2] + i;
    var u = c.uv[0], v = c.uv[1];
    var w = c.s[0], h = c.s[1], d = c.s[2];
    // 每张面：4 个角(顺序: 起点, +u, +u+v, +v)，uv 矩形
    var faces = [
      // up (y0)：u→+X, v→+Z
      { p: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
        r: [u + d, v, u + d + w, v + d] },
      // down (y1)：u→+X, v→-Z
      { p: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]],
        r: [u + d + w, v, u + d + w + w, v + d] },
      // north (z0)：u→+X, v→+Y
      { p: [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]],
        r: [u + d, v + d, u + d + w, v + d + h] },
      // south (z1)：u→-X, v→+Y
      { p: [[x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [x1, y0, z1]],
        r: [u + d + w + d, v + d, u + d + w + d + w, v + d + h] },
      // west (x0)：u→+Z, v→+Y
      { p: [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]],
        r: [u, v + d, u + d, v + d + h] },
      // east (x1)：u→-Z, v→+Y
      { p: [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]],
        r: [u + d + w, v + d, u + d + w + d, v + d + h] }
    ];
    if (c.m) {  // mirror：每个面水平翻转
      for (var k = 0; k < faces.length; k++) {
        var r = faces[k].r;
        faces[k].r = [r[2], r[1], r[0], r[3]];
      }
    }
    if (c.fuv) {
      var nm3 = ['up', 'down', 'north', 'south', 'west', 'east'];
      for (var fi4 = 0; fi4 < nm3.length; fi4++) {
        if (c.fuv[nm3[fi4]]) faces[fi4].tf = c.fuv[nm3[fi4]];
      }
    }
    // 逐面 UV 覆盖（床这种「贴图不是标准 cuboid 展开」的模型用）
    if (c.fv) {   // 指定面「上下翻转」（床的侧面就是这个问题）
      var nm2 = ['up', 'down', 'north', 'south', 'west', 'east'];
      for (var fi3 = 0; fi3 < nm2.length; fi3++) {
        if (c.fv.indexOf(nm2[fi3]) >= 0) faces[fi3].fv = true;
      }
    }
    if (c.f) {
      var names = ['up', 'down', 'north', 'south', 'west', 'east'];
      for (var fi2 = 0; fi2 < names.length; fi2++) {
        var ov = c.f[names[fi2]];
        if (ov) faces[fi2].r = ov;
      }
    }
    return faces;
  }

  function buildGeometry(model) {
    var pos = [], uv = [], idx = [], vbase = 0;
    var texW = model.texW || 64, texH = model.texH || 32;

    function walk(node) {
      if (node.c) {
        for (var ci = 0; ci < node.c.length; ci++) {
          var faces = cubeFaces(node.c[ci], texW, texH);
          for (var fi = 0; fi < faces.length; fi++) {
            var f = faces[fi], r = f.r;
            var tf = f.tf;   // [rot90, flipH, flipV]
            for (var vi = 0; vi < 4; vi++) {
              var p = f.p[vi];
              pos.push(p[0], p[1], p[2]);
              var cu = (vi === 0 || vi === 3) ? 0 : 1;
              var cv = (vi < 2) ? 1 : 0;
              if (tf) {
                for (var rr = 0; rr < (tf[0] || 0); rr++) { var t0 = cu; cu = cv; cv = 1 - t0; }
                if (tf[1]) cu = 1 - cu;
                if (tf[2]) cv = 1 - cv;
              }
              var uu = cu ? r[2] : r[0];
              var vv = cv ? r[1] : r[3];
              // 半个纹素内缩：细长面（旗杆/栏杆）在边界上会采到相邻透明像素被裁掉
              var insU = 0.5 / texW, insV = 0.5 / texH;
              uv.push(uu / texW + (cu ? -insU : insU), 1 - vv / texH + (cv ? insV : -insV));
            }
            idx.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
            vbase += 4;
          }
        }
      }
      if (node.k) for (var k = 0; k < node.k.length; k++) walk(node.k[k]);
    }
    walk(model.root);

    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function build(node, texW, texH, ctx) {
    var g = new THREE.Group();
    g.position.set(node.p[0], node.p[1], node.p[2]);
    if (node.r && (node.r[0] || node.r[1] || node.r[2])) {
      g.rotation.set(node.r[0], node.r[1], node.r[2], 'ZYX');
    }
    if (node.c && node.c.length) {
      var geo = buildGeometry({ root: { c: node.c }, texW: texW, texH: texH });
      var mesh = new THREE.Mesh(geo, ctx.mat);
      mesh.name = node.n;
      mesh.userData.node = node;      // 面编辑器用：反查是哪个 part
      g.add(mesh);
    }
    if (node.k) {
      for (var i = 0; i < node.k.length; i++) g.add(build(node.k[i], texW, texH, ctx));
    }
    return g;
  }

  window.EntityRenderer = {
    /* 返回一个 Group：原点 = 模型空间 (0,0,0)，y 向上，1 格 = 1 单位 */
    build: function (model, texUrl, opts) {
      opts = opts || {};
      var tex = texFor(texUrl);
      var mat = new THREE.MeshLambertMaterial({
        map: tex, transparent: false, alphaTest: 0.5, side: THREE.DoubleSide
      });
      if (opts.noAlphaTest) { mat.alphaTest = 0; mat.transparent = true; }
      if (opts.color) mat.color.setHex(opts.color);
      var ctx = { mat: mat, tex: tex };
      var tw = (opts.texW || model.texW || 64);
      var th = (opts.texH || model.texH || 32);
      var inner = build(model.root, tw, th, ctx);
      if (opts.raw) {          // 原始模型空间：像素、y 向下、不缩放（交给外面的变换链）
        inner.userData.texture = tex;
        inner.userData.material = mat;
        inner.userData.model = model;
        return inner;
      }
      var root = new THREE.Group();
      root.add(inner);
      if (opts.rot) {
        var r = opts.rot;
        root.rotation.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180, 'XYZ');
      }
      // MC 的模型坐标 y 向下 → 翻转；少数方块实体模型是 y 向上（箱子），用 yUp 关掉翻转
      var sy = opts.yUp ? 1 / 16 : -1 / 16;
      root.scale.set(1 / 16, sy, 1 / 16);
      root.userData.model = model;
      root.userData.texture = tex;
      root.userData.material = mat;
      return root;
    },
    /* 多图层（饰纹陶罐：罐体 + 四个面各一张贴图） */
    buildComposite: function (layers, opts) {
      opts = opts || {};
      var root = new THREE.Group();
      var ys = opts.yUp ? 1 / 16 : -1 / 16;
      var inner = new THREE.Group();
      for (var i = 0; i < layers.length; i++) {
        var L = layers[i];                     // {model: <模型对象>, tex, texW, texH}
        var g = EntityRenderer.build(L.model, L.tex, {
          texW: L.texW, texH: L.texH, yUp: true
        });
        inner.add(g.children[0]);
      }
      root.add(inner);
      root.scale.set(1 / 16, ys, 1 / 16);
      if (opts.rot) {
        var r = opts.rot;
        root.rotation.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180, 'XYZ');
      }
      root.userData.model = { name: "composite" };
      return root;
    },
    /* 复刻 MC 渲染器的 PoseStack 变换链：ops = [['t',x,y,z] | ['rx',deg] | ['rz',deg|'yrot@+180'] | ['s',x,y,z]] */
    applyXf: function (obj, ops, ctx) {
      var node = obj;
      for (var i = ops.length - 1; i >= 0; i--) {
        var g = new THREE.Group();
        g.add(node);
        var o = ops[i];
        if (o[0] === 't') g.position.set(o[1], o[2], o[3]);
        else if (o[0] === 's') g.scale.set(o[1], o[2], o[3]);
        else if (o[0] === 'rx') g.rotation.x = o[1] * Math.PI / 180;
        else if (o[0] === 'ry') {
          var dy = o[1];
          if (typeof dy === 'string') {
            var m2 = /^yrot([+-][0-9.]+)?$/.exec(dy);
            dy = m2 ? (ctx && ctx.yrot || 0) + (m2[1] ? parseFloat(m2[1]) : 0) : 0;
          }
          g.rotation.y = dy * Math.PI / 180;
        }
        else if (o[0] === 'rz') {
          var deg = o[1];
          if (typeof deg === 'string') {
            var m = /^yrot([+-][0-9.]+)?$/.exec(deg);
            if (m) deg = (ctx && ctx.yrot || 0) + (m[1] ? parseFloat(m[1]) : 0);
            else deg = 0;
          }
          g.rotation.z = deg * Math.PI / 180;
        }
        node = g;
      }
      return node;
    },
    preload: function (url) { return texFor(url); },
    allReady: function () {
      for (var k in texCache) {
        var im = texCache[k] && texCache[k].image;
        if (!im || !im.complete || !im.naturalWidth) return false;
      }
      return true;
    },
    dispose: function (obj) {
      obj.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
  };
})();
