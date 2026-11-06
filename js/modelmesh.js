/*
 * modelmesh.js — 把 models.json 的 elements 生成 three.js 几何
 * 用于 3D 场景里的非立方体方块（楼梯/栅栏/蜡烛/蛋糕/紫颂花…）
 *
 * 每个元素是一个 box（MC 的 0~16 坐标），拆成 6 个面，
 * 每个面用 face 自带的 uv（0~16）映射到 atlas 的对应格子。
 */
(function (root) {
  'use strict';

  /**
   * @param {object} opts
   *   opts.el       元素数组 [fx,fy,fz, tx,ty,tz, faces]
   *                  faces: { up:[tex,[u0,v0,u1,v1]], ... }
   *   opts.base     [bx, by, bz] 该方块在世界里的原点
   *   opts.atlas    {uv:{tex:{x,y}}, cell, pad, size:[W,H]}
   *   opts.out      {pos:[], nor:[], uv:[], idx:[]} 累加目标
   */
  /** 绕 Y 轴旋转（MC 的 rotation:{axis:y,angle:45}） */
  function rotY(p, origin, deg) {
    var a = deg * Math.PI / 180;
    var c = Math.cos(a), sn = Math.sin(a);
    var x = p[0] - origin[0], z = p[2] - origin[2];
    return [origin[0] + x * c + z * sn, p[1], origin[2] - x * sn + z * c];
  }

  /** 只旋转方向（法线用），不平移 */
  function rotDir(n, deg) {
    var a = deg * Math.PI / 180;
    var c = Math.cos(a), sn = Math.sin(a);
    return [n[0] * c + n[2] * sn, n[1], -n[0] * sn + n[2] * c];
  }

  /** 通用：绕某轴（'x'|'y'|'z'）旋转 */
  function rotAxis(p, origin, axis, deg) {
    var a = deg * Math.PI / 180;
    var c = Math.cos(a), s = Math.sin(a);
    var x = p[0] - origin[0], y = p[1] - origin[1], z = p[2] - origin[2];
    var nx = x, ny = y, nz = z;
    if (axis === 'x') { ny = y * c - z * s; nz = y * s + z * c; }
    else if (axis === 'y') { nx = x * c + z * s; nz = -x * s + z * c; }
    else { nx = x * c - y * s; ny = x * s + y * c; }
    return [origin[0] + nx, origin[1] + ny, origin[2] + nz];
  }

  function rotDirAxis(n, axis, deg) {
    var q = rotAxis([n[0], n[1], n[2]], [0, 0, 0], axis, deg);
    return q;
  }

  // models.json 里的几何是按「朝北」选的 variant（build_models.py 优先挑 facing=north），
  // 所以 facing 到旋转角的映射以 north 为 0°
  var FACING_DEG = { north: 0, east: 90, south: 180, west: 270 };

  /**
   * 方块状态 -> 几何变换（只能在合并几何里逐块应用）
   * 支持：facing（朝向，绕 Y）、楼梯 half=top / 台阶 type=top（绕 X 翻转 180°）
   */
  function stateTransform(v) {
    var p = v && v.p;
    var glow = !!(v && v.x && (v.x.active === 'true' || v.x.active === true));
    if (!p) return glow ? { y: 0, x: 0, z: 0, glow: true } : null;
    var ay = 0, ax = 0, az = 0;
    if (p.facing !== undefined && FACING_DEG[p.facing] !== undefined) {
      ay = FACING_DEG[p.facing];
      // 贴墙类：facing 是「朝向」，墙在反方向 -> 旋转要反过来，
      // 否则旗面会离墙一整格（布在方块的另一侧边缘）
      if (/_wall_(banner|sign|head|skull|hanging_sign)$/.test(v.n)) {
        ay = (ay + 180) % 360;
      }
    }
    // 告示牌：rotation 0~15（每 22.5°，逆时针）
    if (p.rotation !== undefined && p.rotation !== null) {
      var rr = parseInt(p.rotation, 10);
      if (!isNaN(rr)) ay += rr * 22.5;
    }
    // 楼梯的 left/right 用同一个模型文件，靠额外 90° 旋转区分（MC 里就是 y=270/0）
    if (p.shape === 'inner_left' || p.shape === 'outer_left') ay += 90;
    if (p.half === 'top' || p.type === 'top') ax = 180;
    // 门 open=true：绕铰链那一侧的竖边转 90°（hinge=left 铰链在左）
    var pivot = null;
    if (p.open === 'true' && v.n && /_door$/.test(v.n)) {
      ay += 90;
      pivot = (p.hinge === 'right') ? [16, 8, 8] : [0, 8, 8];
    }
    // 活板门 open=true：绕 facing 那一侧的「下缘/上缘」立起来
    var trapPivot = null;
    if (p.open === 'true' && v.n && /_trapdoor$/.test(v.n)) {
      var hTop = (p.half === 'top');
      var ang = hTop ? 90 : -90;
      ax = (ax || 0) + ang;
      var tfc = p.facing || 'north';
      var py = hTop ? 16 : 0;
      if (tfc === 'north') trapPivot = [8, py, 0];
      else if (tfc === 'south') trapPivot = [8, py, 16];
      else if (tfc === 'west') trapPivot = [0, py, 8];
      else trapPivot = [16, py, 8];
    }
    // 原木/柱子的 axis：躺倒（模型里只有竖立的那一种）
    if (p.axis === 'x') az = 90;
    else if (p.axis === 'z') ax = 90;
    var sc = 1;
    // 潮涌核心：未激活时「折起来」很小，激活后展开
    if (v && v.n === 'conduit') sc = glow ? 1.35 : 0.62;
    if (!ay && !ax && !az && !glow && sc === 1) return null;
    var tfObj = { y: ay, x: ax, z: az, glow: glow, s: sc };
    if (pivot) tfObj.pivot = pivot;
    if (trapPivot) tfObj.pivot = trapPivot;
    return tfObj;
  }

  function applyTf(p, tf) {
    var o = tf.pivot || [8, 8, 8];      // 旋转中心（门的铰链用得到）
    var q = p;
    if (tf.s && tf.s !== 1) {
      q = [8 + (q[0] - 8) * tf.s, 8 + (q[1] - 8) * tf.s, 8 + (q[2] - 8) * tf.s];
    }
    if (tf.x) q = rotAxis(q, o, 'x', tf.x);
    if (tf.y) q = rotY(q, o, tf.y);
    if (tf.z) q = rotAxis(q, o, 'z', tf.z);
    return q;
  }

  function applyTfDir(n, tf) {
    var q = n;
    if (tf.x) q = rotDirAxis(q, 'x', tf.x);
    if (tf.y) q = rotDir(q, tf.y);
    if (tf.z) q = rotDirAxis(q, 'z', tf.z);
    return q;
  }

  function appendElement(el, base, atlas, out, tf) {
    var fx = el[0], fy = el[1], fz = el[2];
    var tx = el[3], ty = el[4], tz = el[5];
    var faces = el[6];
    var rot = el[7] || null;
    var W = atlas.size[0], H = atlas.size[1];
    var S = 1 / 16;

    // 0~16 坐标 -> 世界坐标（元素自身旋转 -> 方块状态变换 -> 缩放）
    function toWorld(p) {
      var q = p;
      if (rot && rot.g) q = rotAxis(p, rot.o, rot.a || 'y', rot.g);
      if (tf) q = applyTf(q, tf);
      return [base[0] + q[0] * S, base[1] + q[1] * S, base[2] + q[2] * S];
    }

    // 每个面：A 角（= uv 的 (u0,v0)，即贴图左上）、u 终点、v 终点、法线、退化判定
    // ★ 方向必须与 MC 的 BlockFaceUV.getDefaultUVs() 一致（u 向右 / v 向下）：
    //   up   : u=+X v=+Z      down : u=+X v=-Z
    //   north: u=-X v=-Y      south: u=+X v=-Y
    //   west : u=+Z v=-Y      east : u=-Z v=-Y
    // 角序 P0=A, P1=A+u, P2=A+u+v, P3=A+v，uv 依次取 (u0,v0)(u1,v0)(u1,v1)(u0,v1)
    var FACES = [
      ['up',    [fx, ty, fz], [tx, ty, fz], [fx, ty, tz], [0, 1, 0],
                (fx === tx || fz === tz)],
      ['down',  [fx, fy, tz], [tx, fy, tz], [fx, fy, fz], [0, -1, 0],
                (fx === tx || fz === tz)],
      ['north', [tx, ty, fz], [fx, ty, fz], [tx, fy, fz], [0, 0, -1],
                (fx === tx || fy === ty)],
      ['south', [fx, ty, tz], [tx, ty, tz], [fx, fy, tz], [0, 0, 1],
                (fx === tx || fy === ty)],
      ['west',  [fx, ty, fz], [fx, ty, tz], [fx, fy, fz], [-1, 0, 0],
                (fz === tz || fy === ty)],
      ['east',  [tx, ty, tz], [tx, ty, fz], [tx, fy, tz], [1, 0, 0],
                (fz === tz || fy === ty)]
    ];

    for (var i = 0; i < FACES.length; i++) {
      var name = FACES[i][0];
      if (FACES[i][5]) continue;            // 退化面（面积为 0）直接跳过
      var nrm = FACES[i][4];
      if (rot && rot.g) nrm = rotDirAxis(nrm, rot.a || 'y', rot.g);
      if (tf) nrm = applyTfDir(nrm, tf);
      // 厚度为 0 的薄片：正反两面其实是同一个平面，只画一次（靠 DoubleSide 显示背面）
      if (name === 'south' && fz === tz) continue;
      if (name === 'east' && fx === tx) continue;
      if (name === 'down' && fy === ty) continue;
      var fd = faces[name];
      if (!fd) continue;

      var tex = fd[0];
      // 虚拟状态「激活」（潮涌核心）-> 换成加亮的 _lit 贴图
      if (tf && tf.glow && atlas.uv[tex + '_lit']) tex = tex + '_lit';
      var uv4 = fd[1] || [0, 0, 16, 16];
      var cell = atlas.uv[tex];
      if (!cell) continue;

      var A = FACES[i][1], U = FACES[i][2], V = FACES[i][3];
      var corners = [
        A,
        [U[0], U[1], U[2]],
        [U[0] + V[0] - A[0], U[1] + V[1] - A[1], U[2] + V[2] - A[2]],
        [V[0], V[1], V[2]]
      ];

      // face.rotation：贴图在面内旋转 90° 的倍数
      var rotq = (fd[2] | 0) % 4;
      var uvs4 = [[uv4[0], uv4[1]], [uv4[2], uv4[1]], [uv4[2], uv4[3]], [uv4[0], uv4[3]]];
      if (rotq) {
        var tmp = uvs4.slice();
        for (var q = 0; q < 4; q++) uvs4[q] = tmp[(q + 4 - rotq) % 4];
      }

      var vi = out.pos.length / 3;
      for (var k = 0; k < 4; k++) {
        var w = toWorld(corners[k]);
        out.pos.push(w[0], w[1], w[2]);
        out.nor.push(nrm[0], nrm[1], nrm[2]);
        out.uv.push((cell.x + uvs4[k][0]) / W, 1 - (cell.y + uvs4[k][1]) / H);
      }
      out.idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    }
  }

  /** 这个格子有没有方块（任何非空气都算，藤蔓判断贴面用） */
  function isSolidAt(cellMap, models, catalog, x, y, z) {
    return !!cellMap[x + ',' + y + ',' + z];
  }

  /** 相邻格子能不能和栅栏连上（栅栏 / 栅栏门 / 实心方块） */
  function canFenceConnect(cellMap, models, catalog, x, y, z) {
    var s2 = cellMap[x + ',' + y + ',' + z];
    if (!s2) return false;
    var mc = catalog[s2.v.c];
    if (!mc) return false;
    var n = mc.n;
    if (/_fence$/.test(n) || /_fence_gate$/.test(n) || /_pane$/.test(n) ||
        /_wall$/.test(n) || n === 'iron_bars') return true;
    var m2 = models[n];
    return !!(m2 && m2.cube);        // 实心方块也连
  }

  /** 判断这个元素是栅栏的哪个方向的横杆（中柱返回 null） */
  function fenceArmDir(e) {
    var x0 = e[0], z0 = e[2], x1 = e[3], z1 = e[5];
    if (x0 >= 6 && x1 <= 10) {
      if (z1 <= 9) return 'n';
      if (z0 >= 7) return 's';
    }
    if (z0 >= 6 && z1 <= 10) {
      if (x1 <= 9) return 'w';
      if (x0 >= 7) return 'e';
    }
    return null;
  }


  /** states.json 预处理：把 "a=b,c=d" 字符串拆成属性表（结果缓存在对象上） */
  function prepareStates(states) {
    if (states.__prep) return states.__prep;
    var blocks = {};
    var src = states.blocks || {};
    for (var name in src) {
      if (!Object.prototype.hasOwnProperty.call(src, name)) continue;
      var b = src[name];
      if (!b.variants) continue;               // multipart 仍走老的邻居逻辑
      var list = [];
      for (var key in b.variants) {
        if (!Object.prototype.hasOwnProperty.call(b.variants, key)) continue;
        var attrs = {};
        if (key) {
          var parts = key.split(',');
          for (var i = 0; i < parts.length; i++) {
            var kv = parts[i].split('=');
            if (kv.length === 2) attrs[kv[0]] = kv[1];
          }
        }
        var v = b.variants[key];
        list.push({ a: attrs, m: v[0], x: v[1] | 0, y: v[2] | 0 });
      }
      if (list.length) blocks[name] = list;
    }
    states.__prep = { blocks: blocks, models: states.models || {} };
    return states.__prep;
  }

  /** 按 props 挑最匹配的 variant（props 里没写的属性当通配；匹配得越多越优先） */
  function pickStateVariant(list, props) {
    var best = null, bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var v = list[i], ok = true, score = 0;
      if (props) {
        for (var k in props) {
          if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
          if (v.a[k] === undefined) { ok = false; break; }
          if (String(v.a[k]) !== String(props[k])) { ok = false; break; }
          score++;
        }
      }
      if (!ok) continue;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }


  /**
   * 生成整个场景里「非立方体方块」的合并几何
   * @param {Array} surf    渲染列表 [{x,y,z,v}]
   * @param {Array} catalog 方块目录
   * @param {object} models models.json
   * @param {object} atlas  atlas.json
   * @param {number} ox, oz 世界坐标偏移（= -sx/2, -sz/2）
   */
  function buildSceneGeometry(surf, catalog, models, atlas, ox, oz, states) {
    var prep = states ? prepareStates(states) : null;
    var out = { pos: [], nor: [], uv: [], idx: [] };
    // 流体单独一个缓冲：半透明材质 + 不同的渲染顺序
    var fout = { pos: [], nor: [], uv: [], idx: [] };
    var blocks = 0, elems = 0;
    // 相邻格子索引：判断两格高方块的另一半还在不在
    var cellMap = {};
    for (var ci = 0; ci < surf.length; ci++) {
      var sc0 = surf[ci];
      cellMap[sc0.x + ',' + sc0.y + ',' + sc0.z] = sc0;
    }
    for (var i = 0; i < surf.length; i++) {
      var s = surf[i];
      var c = catalog[s.v.c];
      if (!c) continue;
      // ---- 流体：按 level 算高度（MC：源 8/9，流动 (8-level)/9，下落 1.0）----
      if (c.n === 'water' || c.n === 'lava') {
        var lv = 0;
        if (s.v.p && s.v.p.level !== undefined) lv = parseInt(s.v.p.level, 10) || 0;
        var fh = lv === 0 ? 8 / 9 : (lv <= 7 ? (8 - lv) / 9 : 1);
        var still = c.n === 'water' ? 'water_still' : 'lava_still';
        var flowt = c.n === 'water' ? 'water_flow' : 'lava_flow';
        var sideTex = atlas.uv[flowt] ? flowt : still;
        var vt = Math.round(fh * 16 * 100) / 100;
        var ffaces = {
          'up': [still, [0, 0, 16, 16]],
          'down': [still, [0, 0, 16, 16]],
          'north': [sideTex, [0, 0, 16, vt]],
          'south': [sideTex, [0, 0, 16, vt]],
          'west': [sideTex, [0, 0, 16, vt]],
          'east': [sideTex, [0, 0, 16, vt]]
        };
        // 相邻是同类流体时去掉那一面（否则连成一片会看到每块的边界）
        var FN = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1],
                   south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
        for (var fk in FN) {
          var d2 = FN[fk];
          var nb = cellMap[(s.x + d2[0]) + ',' + (s.y + d2[1]) + ',' + (s.z + d2[2])];
          if (nb) {
            var nc = catalog[nb.v.c];
            if (nc && nc.n === c.n) delete ffaces[fk];
          }
        }
        var fel = [0, 0, 0, 16, vt, 16, ffaces];
        appendElement(fel, [s.x + ox, s.y, s.z + oz], atlas, fout, null);
        blocks++;
        elems++;
        continue;
      }

      // ---- 优先走 blockstate 规则表：精确还原所有 state 变体（门/蜡烛/中继器…）----
      var vb = prep ? prep.blocks[c.n] : null;
      if (vb) {
        var pick = pickStateVariant(vb, s.v.p);
        if (pick) {
          var els3 = prep.models[pick.m];
          if (els3 && els3.length) {
            var tf2 = { x: pick.x, y: pick.y, z: 0, s: 1, glow: false };
            if (s.v.x && (s.v.x.active === 'true' || s.v.x.active === true)) tf2.glow = true;
            var base2 = [s.x + ox, s.y, s.z + oz];
            for (var e5 = 0; e5 < els3.length; e5++) {
              appendElement(els3[e5], base2, atlas, out, tf2);
            }
            blocks++;
            elems += els3.length;
            continue;
          }
        }
      }

      var m = models[c.n];
      if (!m || !m.els || m.cube) continue;   // 立方体走 InstancedMesh
      // 楼梯：按 shape 换几何（inner_left/right 用 inner，outer_* 用 outer）
      if (m.var && s.v.p && s.v.p.shape) {
        var sh = s.v.p.shape;
        var alt = sh.indexOf('inner') === 0 ? m.var.inner
                : (sh.indexOf('outer') === 0 ? m.var.outer : null);
        if (alt) m = { els: alt, cube: false };
      }
      // 两格高的方块（门/高草/大型花）：模型里上下两半都在，
      // half=lower 只画 y<16 的元素，half=upper 只画 y>=16 的（坐标基准下移一格）
      // 栅栏门：开/关 × 是否嵌墙，四选一
      if (m.var && s.v.p && (m.var.open || m.var.wall)) {
        var gInWall = (s.v.p.in_wall === 'true');
        var gOpen = (s.v.p.open === 'true');
        var gKey = gInWall ? (gOpen ? 'wall_open' : 'wall') : (gOpen ? 'open' : null);
        if (gKey && m.var[gKey]) m = { els: m.var[gKey], cube: false };
      }

      // ---- 藤蔓 / 发光地衣 / 菌丝：贴在相邻方块朝内的那一面 ----
      if (/^(vine|glow_lichen|sculk_vein)$/.test(c.n)) {
        // 旋转 0=北 90=西 180=南 270=东；x 轴 ±90 是顶/底
        var VDIRS = [
          [0, 0, -1, { y: 0 }],      // 北
          [0, 0, 1, { y: 180 }],     // 南
          [-1, 0, 0, { y: 90 }],     // 西
          [1, 0, 0, { y: 270 }],     // 东
          [0, 1, 0, { x: 90 }],      // 顶
          [0, -1, 0, { x: -90 }]     // 底
        ];
        var drew = 0;
        for (var vd = 0; vd < VDIRS.length; vd++) {
          var dir1 = VDIRS[vd];
          if (isSolidAt(cellMap, models, catalog, s.x + dir1[0], s.y + dir1[1], s.z + dir1[2])) {
            appendElement(m.els[0], [s.x + ox, s.y, s.z + oz], atlas, out, dir1[3]);
            drew++;
          }
        }
        if (!drew) appendElement(m.els[0], [s.x + ox, s.y, s.z + oz], atlas, out, null);
        blocks++;
        elems += drew || 1;
        continue;
      }

      // ---- 栅栏：只看相邻有没有能连的方块，没连的方向不画横杆 ----
      var dirOK = null;
      if (/_fence$|_pane$|iron_bars$/.test(c.n)) {
        dirOK = {
          n: canFenceConnect(cellMap, models, catalog, s.x, s.y, s.z - 1),
          s: canFenceConnect(cellMap, models, catalog, s.x, s.y, s.z + 1),
          w: canFenceConnect(cellMap, models, catalog, s.x - 1, s.y, s.z),
          e: canFenceConnect(cellMap, models, catalog, s.x + 1, s.y, s.z)
        };
      }

      var half = s.v.p ? s.v.p.half : null;
      // 另一半不在（被删/悬空放置）就画完整模型，避免出现"半个门"
      if (half === 'lower' && !cellMap[s.x + ',' + (s.y + 1) + ',' + s.z]) half = null;
      if (half === 'upper' && !cellMap[s.x + ',' + (s.y - 1) + ',' + s.z]) half = null;
      var yBase = s.y + (half === 'upper' ? -1 : 0);
      var base = [s.x + ox, yBase, s.z + oz];
      // 贴墙类方块：按 facing 把模型推到墙边（否则悬在格子中间）
      if (/_wall_(head|skull|sign|banner|hanging_sign)$/.test(c.n)) {
        var wf = (s.v.p && s.v.p.facing) || 'north';
        var WOFF = { north: [0, -4], south: [0, 4], west: [-4, 0], east: [4, 0] };
        var wo = WOFF[wf] || WOFF.north;
        base = [base[0] + wo[0] / 16, base[1], base[2] + wo[1] / 16];
      }
      var tf = stateTransform(s.v);

      // ---- 矮墙：中柱 + 四个方向的臂（邻居上方还有墙就用高的臂）----
      if (/_wall$/.test(c.n) && m.var && m.var.side) {
        for (var e3 = 0; e3 < m.els.length; e3++) {
          appendElement(m.els[e3], base, atlas, out, tf);
        }
        var WDIRS = [[0, 0, -1, 0], [0, 0, 1, 180], [-1, 0, 0, 90], [1, 0, 0, 270]];
        for (var wd = 0; wd < WDIRS.length; wd++) {
          var w3 = WDIRS[wd];
          if (!canFenceConnect(cellMap, models, catalog, s.x + w3[0], s.y + w3[1], s.z + w3[2])) continue;
          var isTall = !!cellMap[(s.x + w3[0]) + ',' + (s.y + 1) + ',' + (s.z + w3[2])];
          var armEls = (isTall && m.var.tall) ? m.var.tall : m.var.side;
          for (var ae = 0; ae < armEls.length; ae++) {
            appendElement(armEls[ae], base, atlas, out, { y: w3[3], x: 0, z: 0 });
          }
          elems++;
        }
        blocks++;
        continue;
      }

      for (var e = 0; e < m.els.length; e++) {
        var el = m.els[e];
        if (half === 'lower' && el[1] >= 16) continue;
        if (half === 'upper' && el[4] <= 16) continue;
        if (dirOK) {
          var fd = fenceArmDir(el);
          if (fd && !dirOK[fd]) continue;      // 该方向没邻居 -> 不画这根横杆
          // 玻璃板连起来后中间不该有竖边框（原版是一整片玻璃）
          if (!fd && /_pane$/.test(c.n) && (dirOK.n || dirOK.s || dirOK.e || dirOK.w)) continue;
        }
        appendElement(el, base, atlas, out, tf);
        elems++;
      }
      blocks++;
    }
    return { pos: out.pos, nor: out.nor, uv: out.uv, idx: out.idx,
             fluid: fout, blocks: blocks, elems: elems };
  }

  root.ModelMesh = {
    buildSceneGeometry: buildSceneGeometry,
    appendElement: appendElement,
    stateTransform: stateTransform
  };
})(typeof window !== 'undefined' ? window : this);
