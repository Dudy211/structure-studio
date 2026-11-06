/*
 * modimport.js — 浏览器端「模组 jar 导入」核心模块（Forge / Fabric / Quilt）
 *
 * 职责：解压 jar（zip）→ 解析方块/物品/贴图 → 转成本项目的数据格式（models.json 的 els）。
 * 不碰 DOM、不碰 app.js。挂到 window.ModImport（node 下同时提供 CommonJS exports 供测试）。
 *
 * 网页接入示例（index.html）：
 *   <script src="js/modimport.js"></script>
 *   var z = await ModImport.readZip(buf);      // buf = await file.arrayBuffer()
 *   var m = ModImport.parseMod(z.files, {});   // m.blocks / m.items / m.textures
 *
 * 约束：纯原生 JS（ES2017），零第三方依赖，不用 ES module import/export。
 *   - method 8（deflate）默认用浏览器内建 DecompressionStream('deflate-raw')；
 *     node 环境可用 readZip(data, { inflate }) 注入同步解压函数（如 zlib.inflateRawSync）。
 *
 * els 格式（renderer 的输入，与 data/models.json 严格一致）：
 *   [x0, y0, z0, x1, y1, z1, faces, rotation?]
 *   - 坐标 0..16，y 向上，原点 = 方块角点（MC from/to 约定）
 *   - faces: { north: [texName, [u0, v0, u1, v1]], ... }，面名只允许
 *     north south east west up down
 *   - 贴图名带命名空间（modid:block/x 或 minecraft:block/x）
 *   - UV 用 MC 的 0..16 贴图坐标（不是 0..1），v 向下
 *   - 可选 rotation: { o: [ox,oy,oz], a: 'x'|'y'|'z', g: 角度, rs: true }
 *   - 面朝向：north=-z, south=+z, east=+x, west=-x, up=+y, down=-y
 */
(function () {
  'use strict';

  var FACE_NAMES = ['north', 'south', 'east', 'west', 'up', 'down'];

  // ============ 小工具 ============

  /** 修「UTF-8 字节被当 Latin-1 再编码」的双重编码乱码（如 Forge mods.toml 的 description）。
   *  仅当字符串里出现 Latin-1 扩展区（C1/áàä...）字符时才尝试修复，否则原样返回。 */
  function cleanText(s) {
    if (typeof s !== 'string' || !s.length) return s;
    if (!/[\u0080-\u00FF\uFFFD]/.test(s)) return s;
    try {
      var bytes = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c > 0xFF) return s; // 含 Latin-1 之外的字符，不是纯双重编码，原样保留
        bytes[i] = c;
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      return s; // 重新解释不是合法 UTF-8 → 原文如此，保留
    }
  }

  function bytesToText(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function isArray3(a) {
    return Array.isArray(a) && a.length === 3 &&
      typeof a[0] === 'number' && typeof a[1] === 'number' && typeof a[2] === 'number';
  }

  /** 从 files Map 读一个 JSON 文件；失败记 issue（issues 可空）并返回 null */
  function readJson(files, p, issues, tag) {
    var bytes = files.get(p);
    if (!bytes) return null;
    try {
      return JSON.parse(bytesToText(bytes));
    } catch (err) {
      if (issues) issues.push('[' + (tag || 'json') + '] ' + p + ' 不是合法 JSON: ' + err.message);
      return null;
    }
  }

  function normBytes(x) {
    return (x instanceof Uint8Array) ? x : new Uint8Array(x);
  }

  // ============ zip 解析（EOCD → Central Directory → 局部头） ============

  var SIG_EOCD = 0x06054b50;
  var SIG_ZIP64_LOC = 0x07064b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_LOCAL = 0x04034b50;

  /** 浏览器默认解压：DecompressionStream('deflate-raw') */
  function inflateBrowser(raw) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error(
        'readZip: 当前浏览器没有 DecompressionStream，无法解压 deflate 条目'));
    }
    var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (ab) {
      return new Uint8Array(ab);
    });
  }

  /** 文件名解码：flag 0x800 → UTF-8，否则按 Latin-1 字节直读 */
  function decodeName(bytes, utf8) {
    if (utf8) return bytesToText(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /**
   * 解析 zip（jar）。
   * @param {ArrayBuffer} arrayBuffer 整个文件的字节
   * @param {object} [opts] { inflate?: (raw:Uint8Array) => Uint8Array|Promise } 覆盖解压函数
   * @returns {Promise<{files: Map<string, Uint8Array>}>}
   *
   * 支持 method 0（store）和 8（deflate）；目录条目跳过。
   * 加密条目、zip64、未知压缩方法、结构损坏 → 抛带人读信息的 Error。
   */
  function readZip(arrayBuffer, opts) {
    opts = opts || {};
    var buf = new Uint8Array(arrayBuffer);
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // 1) 从尾部倒扫 End of Central Directory（最多 65535 字节注释 + 22 字节头）
    var minPos = Math.max(0, buf.length - 65557);
    var eocd = -1;
    for (var i = buf.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) {
      throw new Error('readZip: 找不到 End of Central Directory —— 文件不是有效的 zip/jar，或已截断');
    }

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);

    // 2) zip64 判定（极端情况不支持）
    if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) {
      if (eocd >= 20 && dv.getUint32(eocd - 20, true) === SIG_ZIP64_LOC) {
        throw new Error('readZip: 该 zip 使用 zip64 格式（文件过大），暂不支持');
      }
      throw new Error('readZip: 中央目录记录数/偏移为 0xFFFFFFFF 但没有 zip64 定位器，无法解析');
    }
    if (cdOffset + 1 > buf.length) {
      throw new Error('readZip: 中央目录偏移越界（文件可能损坏或是 zip64）');
    }

    // 3) 逐条读 Central Directory
    var entries = [];
    var p = cdOffset;
    for (var e = 0; e < count; e++) {
      if (p + 46 > buf.length || dv.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error('readZip: 中央目录第 ' + e + ' 条记录签名不符，文件损坏');
      }
      var flag = dv.getUint16(p + 8, true);
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var usize = dv.getUint32(p + 24, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), !!(flag & 0x800));
      p += 46 + nameLen + extraLen + commentLen;

      if (name.charAt(name.length - 1) === '/') continue; // 目录条目
      if (flag & 0x1) {
        throw new Error('readZip: 条目 ' + name + ' 是加密条目，暂不支持');
      }
      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF) {
        throw new Error('readZip: 条目 ' + name + ' 大小超过 4GB（zip64），暂不支持');
      }
      if (method !== 0 && method !== 8) {
        throw new Error('readZip: 条目 ' + name + ' 使用压缩方法 ' + method + '（只支持 0=store / 8=deflate）');
      }
      if (localOff + 30 > buf.length || dv.getUint32(localOff, true) !== SIG_LOCAL) {
        throw new Error('readZip: 条目 ' + name + ' 的局部头签名不符，文件损坏');
      }
      var lNameLen = dv.getUint16(localOff + 26, true);
      var lExtraLen = dv.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      if (dataStart + csize > buf.length) {
        throw new Error('readZip: 条目 ' + name + ' 的数据越界，文件被截断');
      }
      entries.push({ name: name, method: method, data: buf.subarray(dataStart, dataStart + csize) });
    }

    // 4) 解压（store 直接拷贝；deflate 用注入函数或 DecompressionStream）
    var inflate = typeof opts.inflate === 'function' ? opts.inflate : null;
    var jobs = entries.map(function (en) {
      if (en.method === 0) return Promise.resolve(new Uint8Array(en.data));
      if (inflate) {
        return Promise.resolve().then(function () { return normBytes(inflate(en.data)); });
      }
      return inflateBrowser(en.data);
    });
    return Promise.all(jobs).then(function (arr) {
      var files = new Map();
      for (var j = 0; j < arr.length; j++) files.set(entries[j].name, arr[j]);
      return { files: files };
    });
  }

  // ============ 模组元信息 ============

  /** 极简 mods.toml 解析：只取 [[mods]] 段（及顶层）的 modId / displayName / version。
   *  处理 '' 引号、# 注释和 ''' 多行字符串（只跳过，不解析内容）。 */
  function parseModsToml(text) {
    var out = { modid: null, name: null, version: null };
    var section = '';
    var inTriple = false;
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, '');
      if (inTriple) {
        if (line.indexOf("'''") >= 0) inTriple = false;
        continue;
      }
      if (!line || line.charAt(0) === '#') continue;
      if (line.charAt(0) === '[') {
        section = line.replace(/\s+/g, '');
        continue;
      }
      var eq = line.indexOf('=');
      if (eq < 0) continue;
      var key = line.slice(0, eq).replace(/\s+/g, '');
      var val = line.slice(eq + 1).replace(/^\s+|\s+$/g, '');
      if (val.indexOf("'''") === 0) {
        var rest = val.slice(3);
        var close = rest.indexOf("'''");
        if (close >= 0) val = rest.slice(0, close);
        else inTriple = true;
      } else if (val.length >= 2 &&
        (val.charAt(0) === '"' || val.charAt(0) === "'") &&
        val.charAt(val.length - 1) === val.charAt(0)) {
        val = val.slice(1, -1);
      }
      if (section === '' || section === '[[mods]]') {
        if (key === 'modId' && !out.modid) out.modid = cleanText(val);
        else if (key === 'displayName' && !out.name) out.name = cleanText(val);
        else if (key === 'version' && section === '[[mods]]' && !out.version) out.version = val;
      }
    }
    return out;
  }

  // ============ 模型链 / 贴图变量 ============

  /** 'modid:block/x' 或无命名空间的相对引用 → jar 内模型文件路径；解析不了返回 null */
  function modelRefToPath(ref, modid) {
    if (typeof ref !== 'string' || !ref) return null;
    var ci = ref.indexOf(':');
    if (ci > 0) return 'assets/' + ref.slice(0, ci) + '/models/' + ref.slice(ci + 1) + '.json';
    if (modid) return 'assets/' + modid + '/models/' + ref + '.json';
    return null;
  }

  /**
   * 沿 parent 链解析模型（上限 16 层，防环）。
   * minecraft: 前缀的 parent 是原版模板，不读文件，记到 terminal。
   * @returns {{chain, texMap, elements, terminal, missingParent}}
   *   texMap     根→叶合并后的贴图变量表（子覆盖父）
   *   elements   链上最靠近叶子的 elements 数组；链上没有该字段时 undefined
   *   terminal   命中的原版模板名（去掉 minecraft: 前缀），如 'block/cube_all'
   *   missingParent 父模型引用了但文件不存在/损坏时的引用名
   */
  function resolveModelChain(startPath, files, modid, issues, label) {
    var chain = [];
    var seen = {};
    var cur = startPath;
    var terminal = null;
    var missingParent = null;
    for (var i = 0; i < 16; i++) {
      if (seen[cur]) {
        issues.push('[parent] ' + label + ': 模型 parent 链出现环: ' + cur);
        break;
      }
      seen[cur] = true;
      var data = readJson(files, cur, issues, 'model');
      if (!data) {
        missingParent = cur;
        break;
      }
      chain.push(data);
      var par = data.parent;
      if (!par || typeof par !== 'string') break;
      if (par.indexOf('minecraft:') === 0) {
        terminal = par.slice('minecraft:'.length);
        break;
      }
      var np = modelRefToPath(par, modid);
      if (!np || !files.has(np)) {
        issues.push('[model] ' + label + ': 父模型文件不存在: ' + par);
        missingParent = par;
        break;
      }
      cur = np;
    }
    if (chain.length >= 16) {
      issues.push('[parent] ' + label + ': 模型 parent 链超过 16 层，已截断');
    }

    var texMap = {};
    for (var j = 0; j < chain.length; j++) {
      var t = chain[j].textures;
      if (t && typeof t === 'object') {
        for (var k in t) {
          if (Object.prototype.hasOwnProperty.call(t, k)) texMap[k] = t[k];
        }
      }
    }
    var elements = undefined;
    for (var m = chain.length - 1; m >= 0; m--) {
      if (Object.prototype.hasOwnProperty.call(chain[m], 'elements')) {
        elements = chain[m].elements;
        break;
      }
    }
    return {
      chain: chain,
      texMap: texMap,
      elements: elements,
      terminal: terminal,
      missingParent: missingParent
    };
  }

  /** 把一个贴图引用解析成带命名空间的真实贴图名；#变量沿 texMap 递归（上限 8 层）。
   *  失败记 issue 并返回 null。无命名空间的补本 modid。 */
  function resolveTexName(value, texMap, modid, issues, label, depth) {
    depth = depth || 0;
    if (typeof value !== 'string' || !value) return null;
    var v = value;
    if (v.charAt(0) === '#') {
      if (depth > 8) {
        issues.push('[texture] ' + label + ': 贴图变量引用过深: ' + value);
        return null;
      }
      v = texMap[v.slice(1)];
      if (v === undefined || v === null || v === '') {
        issues.push('[texture] ' + label + ': 贴图变量 #' + value.slice(1) + ' 未定义（模型 textures 里没有该变量）');
        return null;
      }
      return resolveTexName(v, texMap, modid, issues, label, depth + 1);
    }
    if (v.indexOf(':') < 0) v = modid + ':' + v;
    return v;
  }

  // ============ 几何模板与元素构建 ============

  /** 默认 UV：照 MC BlockFaceUV.getDefaultUVs 的规则（v 从贴图顶部向下，0..16） */
  function defaultUVs(fn, from, to) {
    var minX = Math.min(from[0], to[0]), maxX = Math.max(from[0], to[0]);
    var minY = Math.min(from[1], to[1]), maxY = Math.max(from[1], to[1]);
    var minZ = Math.min(from[2], to[2]), maxZ = Math.max(from[2], to[2]);
    if (fn === 'up' || fn === 'down') return [minX, minZ, maxX, maxZ];
    if (fn === 'north' || fn === 'south') return [minX, 16 - maxY, maxX, 16 - minY];
    return [minZ, 16 - maxY, maxZ, 16 - minY]; // west / east
  }

  /** 面内贴图旋转（MC FaceBakery 的 rotate 规则）：0/90/180/270 */
  function rotateUV(uv, deg) {
    var d = ((deg % 360) + 360) % 360;
    if (d === 90) return [uv[0], uv[3], uv[2], uv[1]];
    if (d === 180) return [uv[2], uv[3], uv[0], uv[1]];
    if (d === 270) return [uv[2], uv[1], uv[0], uv[3]];
    return uv;
  }

  function allFaces(t) {
    return { north: t, south: t, east: t, west: t, up: t, down: t };
  }

  /** 整方块（0..16 六面）；texPerFace 里为 null 的面省略 */
  function fullCubeEls(texPerFace) {
    var faces = {};
    for (var i = 0; i < FACE_NAMES.length; i++) {
      var fn = FACE_NAMES[i];
      var t = texPerFace[fn];
      if (t) faces[fn] = [t, [0, 0, 16, 16]];
    }
    return [[0, 0, 0, 16, 16, 16, faces]];
  }

  /** cross 类：两片对角薄平面（y 0..16），绕 (8,8,8) 转 45°——与 models.json 里原版花/草一致 */
  function crossEls(tex) {
    var rot = { o: [8, 8, 8], a: 'y', g: 45, rs: true };
    return [
      [0.8, 0, 8, 15.2, 16, 8, { north: [tex, [0, 0, 16, 16]], south: [tex, [0, 0, 16, 16]] }, rot],
      [8, 0, 0.8, 8, 16, 15.2, { west: [tex, [0, 0, 16, 16]], east: [tex, [0, 0, 16, 16]] }, rot]
    ];
  }

  /** carpet：薄层 y 0..1，侧面取贴图最下一行 */
  function carpetEls(tex) {
    return [[0, 0, 0, 16, 1, 16, {
      up: [tex, [0, 0, 16, 16]],
      down: [tex, [0, 0, 16, 16]],
      north: [tex, [0, 15, 16, 16]],
      south: [tex, [0, 15, 16, 16]],
      west: [tex, [0, 15, 16, 16]],
      east: [tex, [0, 15, 16, 16]]
    }]];
  }

  /**
   * 原版模板表（父模型没有 elements 时的兜底）。
   * parent 是去掉 minecraft: 前缀的模板名；texMap 为已合并的贴图变量表。
   * 贴图解析不出来返回 null（issue 已记）。
   */
  function templateEls(parent, texMap, modid, issues, label) {
    // 按候选变量表顺序查 texMap（直接查，避免每个缺失变量都刷 issue），
    // 查到的值可能还是 #嵌套变量，交给 resolveTexName 解析
    function tex(cands) {
      for (var i = 0; i < cands.length; i++) {
        var v = texMap[cands[i]];
        if (v === undefined || v === null || v === '') continue;
        var t = resolveTexName(v, texMap, modid, issues, label);
        if (t) return t;
      }
      return null;
    }
    var t, map;
    if (parent === 'block/cube') {
      map = {};
      var cvars = { down: 'down', up: 'up', north: 'north', south: 'south', east: 'east', west: 'west' };
      var ks = Object.keys(cvars);
      for (var i = 0; i < ks.length; i++) map[ks[i]] = tex([cvars[ks[i]], 'particle']);
      return fullCubeEls(map);
    }
    if (parent === 'block/cube_all' || parent === 'block/leaves') {
      t = tex(['all']);
      return t ? fullCubeEls(allFaces(t)) : null;
    }
    if (parent === 'block/cube_bottom_top') {
      t = tex(['side']);
      map = { up: tex(['top']), down: tex(['bottom']), north: t, south: t, east: t, west: t };
      return fullCubeEls(map);
    }
    if (parent === 'block/cube_top') {
      t = tex(['side']);
      map = { up: tex(['top']), down: t, north: t, south: t, east: t, west: t };
      return fullCubeEls(map);
    }
    if (parent === 'block/cube_column') {
      t = tex(['side']);
      map = { up: tex(['end']), down: tex(['end']), north: t, south: t, east: t, west: t };
      return fullCubeEls(map);
    }
    if (parent === 'block/cube_column_horizontal') {
      t = tex(['side']);
      map = { up: t, down: t, north: t, south: t, east: tex(['end']), west: tex(['end']) };
      return fullCubeEls(map);
    }
    if (parent === 'block/orientable') {
      t = tex(['side']);
      map = { up: tex(['top']), down: t, north: tex(['front']), south: t, east: t, west: t };
      return fullCubeEls(map);
    }
    if (parent === 'block/orientable_with_bottom') {
      t = tex(['side']);
      map = { up: tex(['top']), down: tex(['bottom']), north: tex(['front']), south: t, east: t, west: t };
      return fullCubeEls(map);
    }
    if (parent === 'block/cross' || parent === 'block/tinted_cross') {
      t = tex(['cross', 'all']);
      return t ? crossEls(t) : null;
    }
    if (parent === 'block/crop') {
      t = tex(['crop', 'all']);
      return t ? crossEls(t) : null;
    }
    if (parent === 'block/carpet') {
      t = tex(['wool', 'all']);
      return t ? carpetEls(t) : null;
    }
    // 其它未知 parent：整方块，all → texture → side → particle
    t = tex(['all', 'texture', 'side', 'particle']);
    if (!t) {
      issues.push('[model] ' + label + ': 父模型 ' + parent + ' 不在模板表里且没有 all/texture/side/particle 贴图，无法生成几何');
      return null;
    }
    return fullCubeEls(allFaces(t));
  }

  /** 把 MC 模型 elements 数组转成本项目的 els */
  function buildElements(elements, texMap, modid, issues, label) {
    var els = [];
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el || typeof el !== 'object') continue;
      var from = el.from, to = el.to;
      if (!isArray3(from) || !isArray3(to)) {
        issues.push('[model] ' + label + ': 第 ' + i + ' 个元素 from/to 坐标不合法，跳过');
        continue;
      }
      var faces = {};
      var ef = (el.faces && typeof el.faces === 'object') ? el.faces : {};
      for (var fi = 0; fi < FACE_NAMES.length; fi++) {
        var fn = FACE_NAMES[fi];
        var f = ef[fn];
        if (!f || typeof f !== 'object') continue;
        if (f.texture === undefined || f.texture === null) continue; // cullface/tintindex 等忽略
        var tex = resolveTexName(f.texture, texMap, modid, issues, label + ' 面' + fn);
        if (!tex) continue;
        var uv = f.uv;
        if (!Array.isArray(uv) || uv.length < 4 ||
          typeof uv[0] !== 'number' || typeof uv[1] !== 'number' ||
          typeof uv[2] !== 'number' || typeof uv[3] !== 'number') {
          uv = defaultUVs(fn, from, to);
        } else {
          uv = [uv[0], uv[1], uv[2], uv[3]];
        }
        if (typeof f.rotation === 'number') uv = rotateUV(uv, f.rotation);
        faces[fn] = [tex, uv];
      }
      var faceKeys = Object.keys(faces);
      if (!faceKeys.length) continue; // 没有可画面的元素直接丢
      var out = [from[0], from[1], from[2], to[0], to[1], to[2], faces];
      if (el.rotation && typeof el.rotation.angle === 'number' && el.rotation.angle % 360 !== 0) {
        out.push({
          o: isArray3(el.rotation.origin) ? el.rotation.origin : [8, 8, 8],
          a: (el.rotation.axis === 'x' || el.rotation.axis === 'z') ? el.rotation.axis : 'y',
          g: el.rotation.angle,
          rs: !!el.rotation.rescale
        });
      }
      els.push(out);
    }
    return els;
  }

  /** els 是不是整方块六面（可走 InstancedMesh 快路径） */
  function isCubeEls(els) {
    if (!els || els.length !== 1) return false;
    var e = els[0];
    if (e[0] !== 0 || e[1] !== 0 || e[2] !== 0 ||
      e[3] !== 16 || e[4] !== 16 || e[5] !== 16) return false;
    if (e.length > 7) return false; // 带旋转的不是标准立方
    var f = e[6] || {};
    for (var i = 0; i < FACE_NAMES.length; i++) {
      var fv = f[FACE_NAMES[i]];
      if (!fv) return false;
      var uv = fv[1];
      if (uv) {
        if (Math.min(uv[0], uv[2]) !== 0 || Math.max(uv[0], uv[2]) !== 16 ||
          Math.min(uv[1], uv[3]) !== 0 || Math.max(uv[1], uv[3]) !== 16) return false;
      }
    }
    return true;
  }

  /** 收集 els 里用到的贴图名（去重、保序） */
  function blockTextures(els) {
    var out = [];
    var seen = {};
    for (var i = 0; i < els.length; i++) {
      var f = els[i][6] || {};
      for (var j = 0; j < FACE_NAMES.length; j++) {
        var fv = f[FACE_NAMES[j]];
        if (fv && fv[0] && !seen[fv[0]]) {
          seen[fv[0]] = true;
          out.push(fv[0]);
        }
      }
    }
    return out;
  }

  /** blockstate → 首选模型引用（优先 variants[""]，否则第一个带 model 的） */
  function pickVariantModel(bs) {
    var v = bs.variants;
    if (!v || typeof v !== 'object') return null;
    var first = null;
    if (Object.prototype.hasOwnProperty.call(v, '')) first = v[''];
    if (!first) {
      var keys = Object.keys(v);
      if (keys.length) first = v[keys[0]];
    }
    if (!first) return null;
    if (typeof first === 'string') return first;
    if (typeof first === 'object') return first.model || null;
    return null;
  }

  // ============ 主入口 ============

  /**
   * 解析一个已解压的模组 jar（readZip 的结果）。
   * @param {Map<string, Uint8Array>} files zip 内文件表
   * @param {object} [opts] { modid?, name? } 手动指定（缺省时从元信息推断）
   * @returns {{modid, name, loader, blocks, items, textures, issues}}
   */
  function parseMod(files, opts) {
    opts = opts || {};
    var issues = [];
    var report = {
      modid: null,
      name: null,
      loader: 'unknown',
      blocks: [],
      items: [],
      textures: {},
      issues: issues
    };

    // ---- 1) 元信息：loader / modid / name ----
    var modid = typeof opts.modid === 'string' && opts.modid ? opts.modid : null;
    var name = typeof opts.name === 'string' && opts.name ? opts.name : null;
    var loader = 'unknown';

    var quilt = readJson(files, 'quilt.mod.json', null);
    var fabric = readJson(files, 'fabric.mod.json', null);
    var toml = null;
    var tomlBytes = files.get('META-INF/mods.toml');
    if (tomlBytes) toml = parseModsToml(bytesToText(tomlBytes));

    if (quilt && quilt.id) {
      loader = 'quilt';
      if (!modid) modid = cleanText(String(quilt.id));
      if (!name && quilt.name) name = quilt.name;
    } else if (fabric && fabric.id) {
      loader = 'fabric';
      if (!modid) modid = cleanText(String(fabric.id));
      if (!name && fabric.name) name = fabric.name;
    } else if (toml) {
      loader = 'forge';
      if (!modid && toml.modid) modid = toml.modid;
      if (!name && toml.name) name = toml.name;
    }
    if (!modid) {
      // 元信息里没有 → 从 assets/<ns>/{blockstates,models}/ 推断
      var seenNs = {};
      var nsList = [];
      files.forEach(function (bytes, path) {
        var mm = /^assets\/([^/]+)\/(blockstates|models)\//.exec(path);
        if (mm && !seenNs[mm[1]]) {
          seenNs[mm[1]] = true;
          nsList.push(mm[1]);
        }
      });
      nsList.sort();
      if (nsList.length) {
        modid = nsList[0];
        issues.push('[meta] 模组元信息里没有 modid，按资源目录推断为 ' + modid +
          (nsList.length > 1 ? '（共 ' + nsList.length + ' 个命名空间，取第一个）' : ''));
      } else {
        issues.push('[meta] 找不到模组元信息（mods.toml / fabric.mod.json / quilt.mod.json），也没有 assets 资源目录');
      }
    }
    if (name) name = cleanText(String(name));
    report.modid = modid;
    report.name = name || modid;
    report.loader = loader;

    if (!modid) return report; // 连命名空间都没有，后面的目录都不成立

    // ---- 2) 语言文件（zh_cn → en_us → 英文名兜底） ----
    var zh = readJson(files, 'assets/' + modid + '/lang/zh_cn.json', null) || {};
    var en = readJson(files, 'assets/' + modid + '/lang/en_us.json', null) || {};
    function cnFor(prefix, n) {
      var k = prefix + '.' + modid + '.' + n;
      var v = (zh && zh[k]) || (en && en[k]) || null;
      return v ? cleanText(String(v)) : n;
    }

    // ---- 3) 方块：blockstates 驱动 ----
    var bsPrefix = 'assets/' + modid + '/blockstates/';
    var bsNames = [];
    files.forEach(function (bytes, path) {
      if (path.indexOf(bsPrefix) === 0 && /\.json$/.test(path) &&
        path.slice(bsPrefix.length).indexOf('/') < 0) {
        bsNames.push(path.slice(bsPrefix.length, -5)); // 目录条目在 readZip 已跳过
      }
    });
    bsNames.sort();

    for (var bi = 0; bi < bsNames.length; bi++) {
      var bname = bsNames[bi];
      var label = '方块 ' + modid + ':' + bname;
      var mark = issues.length; // 记 issue 起点，给 block.issue 用
      var bs = readJson(files, bsPrefix + bname + '.json', issues, 'block');
      if (!bs) continue;

      var ref = pickVariantModel(bs);
      if (Array.isArray(ref)) ref = ref[0];
      if (!ref || typeof ref !== 'string') {
        issues.push('[block] ' + label + ': blockstate 里没有可用的模型引用（variants 为空或缺 model 字段）');
        continue;
      }
      if (ref.indexOf('minecraft:') === 0) {
        issues.push('[block] ' + label + ': 引用了原版模型 ' + ref + '，暂不支持');
        continue;
      }
      var mpath = modelRefToPath(ref, modid);
      if (!mpath || !files.has(mpath)) {
        issues.push('[block] ' + label + ': 模型文件不存在: ' + ref);
        continue;
      }

      var resolved = resolveModelChain(mpath, files, modid, issues, label);
      var els = null;
      if (resolved.elements !== undefined) {
        // 链上有 elements：非空才用，空数组 → 记 issue 并跳过
        if (!Array.isArray(resolved.elements) || resolved.elements.length === 0) {
          issues.push('[block] ' + label + ': elements 是空数组，跳过该方块');
          continue;
        }
        els = buildElements(resolved.elements, resolved.texMap, modid, issues, label);
        if (!els.length) {
          issues.push('[block] ' + label + ': elements 解析后没有任何可画面，跳过该方块');
          continue;
        }
      } else if (resolved.terminal) {
        // 父模型是原版模板 → 模板表兜底
        els = templateEls(resolved.terminal, resolved.texMap, modid, issues, label);
        if (!els) continue;
      } else {
        // 父模型缺失且没有 elements → 整方块贴图链兜底（all/texture/side/particle）
        els = templateEls(resolved.missingParent || '（缺失父模型）', resolved.texMap, modid, issues, label);
        if (!els) continue;
      }

      report.blocks.push({
        name: bname,
        id: modid + ':' + bname,
        cn: cnFor('block', bname),
        els: els,
        cube: isCubeEls(els),
        textures: blockTextures(els),
        issue: issues.length > mark ? issues[mark] : null
      });
    }

    // ---- 4) 物品：models/item 与 textures/item 求并集 ----
    var itemPrefixM = 'assets/' + modid + '/models/item/';
    var itemPrefixT = 'assets/' + modid + '/textures/item/';
    var itemNames = {};
    files.forEach(function (bytes, path) {
      if (path.indexOf(itemPrefixM) === 0 && /\.json$/.test(path) &&
        path.slice(itemPrefixM.length).indexOf('/') < 0) {
        itemNames[path.slice(itemPrefixM.length, -5)] = { model: true, tex: null };
      } else if (path.indexOf(itemPrefixT) === 0 && /\.png$/.test(path) &&
        path.slice(itemPrefixT.length).indexOf('/') < 0) {
        var tn = path.slice(itemPrefixT.length, -4);
        if (!itemNames[tn]) itemNames[tn] = { model: false, tex: modid + ':item/' + tn };
      }
    });
    var inames = Object.keys(itemNames).sort();

    for (var ii = 0; ii < inames.length; ii++) {
      var iname = inames[ii];
      var info = itemNames[iname];
      var itex = info.tex;
      if (info.model) {
        var ip = itemPrefixM + iname + '.json';
        var im = readJson(files, ip, issues, 'item');
        if (im) {
          var ir = resolveModelChain(ip, files, modid, issues, '物品 ' + modid + ':' + iname);
          // item/generated：取 layer0；3D 物品：取链上贴图表里第一个（通常是 all/side）
          var tval = ir.texMap.layer0;
          if (tval === undefined) {
            var tvKeys = Object.keys(ir.texMap);
            if (tvKeys.length) tval = ir.texMap[tvKeys[0]];
          }
          if (tval !== undefined && tval !== null) {
            var rt = resolveTexName(tval, ir.texMap, modid, issues, '物品 ' + modid + ':' + iname);
            if (rt) itex = rt;
          }
        }
      }
      if (!itex) {
        itex = modid + ':item/' + iname;
        issues.push('[item] ' + modid + ':' + iname + ': 模型里没有取到贴图，回退用 item/' + iname);
      }
      report.items.push({
        name: iname,
        id: modid + ':' + iname,
        cn: cnFor('item', iname),
        tex: itex
      });
    }

    // ---- 5) 贴图收集：只收本 mod 引用到、且 jar 里真实存在的 PNG ----
    var refSet = {};
    function refTex(t) {
      if (t && typeof t === 'string' && t.indexOf(modid + ':') === 0) refSet[t] = true;
    }
    report.blocks.forEach(function (b) {
      b.textures.forEach(function (t) { refTex(t); });
    });
    report.items.forEach(function (it) { refTex(it.tex); });

    Object.keys(refSet).sort().forEach(function (t) {
      // 'modid:block/x' → 'assets/modid/textures/block/x.png'
      var ci = t.indexOf(':');
      var p = 'assets/' + t.slice(0, ci) + '/textures/' + t.slice(ci + 1) + '.png';
      var bytes = files.get(p);
      if (bytes) report.textures[t] = bytes;
      else issues.push('[texture] ' + t + ': jar 里找不到对应 PNG（' + p + '）');
    });

    return report;
  }

  // ============ 导出 ============

  var api = {
    readZip: readZip,
    parseMod: parseMod,
    // 内部函数也导出，方便 node 测试/调试
    _cleanText: cleanText,
    _defaultUVs: defaultUVs,
    _rotateUV: rotateUV
  };

  if (typeof window !== 'undefined') window.ModImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
