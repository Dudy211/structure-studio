/*
 * voxel.js — 体素数据模型 + 撤销栈 + 导出
 * 与渲染无关，纯逻辑，便于单元测试。
 */
(function (root) {
  'use strict';

  var AIR = null;

  function VoxelWorld(sx, sy, sz) {
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.map = new Map();          // "x,y,z" -> {n: blockName, p: propsObj|null, c: catalogIndex}
    this.entities = new Map();     // "x,y,z" -> {id, model, yaw}   （结构里的 entities 列表）
    this.undoStack = [];
    this.redoStack = [];
    this._batch = null;
  }

  VoxelWorld.prototype.key = function (x, y, z) { return x + ',' + y + ',' + z; };

  VoxelWorld.prototype.inBounds = function (x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  };

  VoxelWorld.prototype.get = function (x, y, z) {
    return this.map.get(this.key(x, y, z)) || null;
  };

  VoxelWorld.prototype.has = function (x, y, z) {
    return this.map.has(this.key(x, y, z));
  };

  // ---- 撤销批处理：一次手势 = 一条撤销记录 ----
  VoxelWorld.prototype.beginBatch = function (label) {
    if (this._batch) return;
    this._batch = { label: label || '', ops: [] };
  };
  VoxelWorld.prototype.endBatch = function () {
    if (!this._batch) return;
    if (this._batch.ops.length) {
      this.undoStack.push(this._batch);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this._batch = null;
  };

  function pushOp(w, k, before, after) {
    if (w._batch) w._batch.ops.push({ k: k, b: before, a: after });
  }

  VoxelWorld.prototype.set = function (x, y, z, blockName, props, catIdx) {
    if (!this.inBounds(x, y, z)) return false;
    var k = this.key(x, y, z);
    var before = this.map.get(k) || null;
    var after = { n: blockName, p: props || null, c: catIdx };
    if (before && before.n === after.n && JSON.stringify(before.p) === JSON.stringify(after.p)) return false;
    this.map.set(k, after);
    pushOp(this, k, before, after);
    return true;
  };

  VoxelWorld.prototype.remove = function (x, y, z) {
    if (!this.inBounds(x, y, z)) return false;
    var k = this.key(x, y, z);
    var before = this.map.get(k);
    if (!before) return false;
    this.map.delete(k);
    pushOp(this, k, before, null);
    return true;
  };

  // ---- 实体（生物）----
  VoxelWorld.prototype.setEntity = function (x, y, z, ent) {
    if (!this.inBounds(x, y, z)) return false;
    this.entities.set(this.key(x, y, z), ent);
    return true;
  };
  VoxelWorld.prototype.getEntity = function (x, y, z) {
    return this.entities.get(this.key(x, y, z)) || null;
  };
  VoxelWorld.prototype.removeEntity = function (x, y, z) {
    return this.entities.delete(this.key(x, y, z));
  };

  VoxelWorld.prototype.undo = function () {
    var b = this.undoStack.pop();
    if (!b) return false;
    for (var i = b.ops.length - 1; i >= 0; i--) {
      var op = b.ops[i];
      if (op.b) this.map.set(op.k, op.b); else this.map.delete(op.k);
    }
    this.redoStack.push(b);
    return true;
  };

  VoxelWorld.prototype.redo = function () {
    var b = this.redoStack.pop();
    if (!b) return false;
    for (var i = 0; i < b.ops.length; i++) {
      var op = b.ops[i];
      if (op.a) this.map.set(op.k, op.a); else this.map.delete(op.k);
    }
    this.undoStack.push(b);
    return true;
  };

  /** 清空（可撤销） */
  /** 批量替换方块名（可撤销）。返回替换数量 */
  VoxelWorld.prototype.replaceBlocks = function (fromName, toName, catIdx, keepProps) {
    if (!fromName || !toName || fromName === toName) return 0;
    this.beginBatch('替换 ' + fromName + ' → ' + toName);
    var n = 0;
    var self = this;
    this.map.forEach(function (v, k) {
      if (v.n !== fromName) return;
      self._batch.ops.push({ k: k, b: { n: v.n, p: v.p, c: v.c }, a: { n: toName, p: keepProps ? v.p : null, c: catIdx } });
      v.n = toName;
      if (!keepProps) v.p = null;
      v.c = catIdx;
      n++;
    });
    this.endBatch();
    return n;
  };

  /** 当前世界里的方块种类 + 数量（用于替换面板的下拉） */
  VoxelWorld.prototype.nameCounts = function () {
    var m = new Map();
    this.map.forEach(function (v) { m.set(v.n, (m.get(v.n) || 0) + 1); });
    return m;
  };

  VoxelWorld.prototype.clear = function () {
    this.beginBatch('清空');
    var self = this;
    this.map.forEach(function (v, k) {
      self._batch.ops.push({ k: k, b: v, a: null });
    });
    this.map.clear();
    this.entities.clear();
    this.endBatch();
  };

  /**
   * 只返回「至少有一面暴露」的方块（用于渲染，内部方块跳过）
   * 返回 [{x,y,z,v}]
   */
  VoxelWorld.prototype.surface = function () {
    var out = [];
    var self = this;
    var sx = this.sx, sy = this.sy, sz = this.sz;
    this.map.forEach(function (v, k) {
      var p = k.split(',');
      var x = +p[0], y = +p[1], z = +p[2];
      if (x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1) {
        out.push({ x: x, y: y, z: z, v: v });
        return;
      }
      if (!self.map.has((x - 1) + ',' + y + ',' + z) ||
          !self.map.has((x + 1) + ',' + y + ',' + z) ||
          !self.map.has(x + ',' + (y - 1) + ',' + z) ||
          !self.map.has(x + ',' + (y + 1) + ',' + z) ||
          !self.map.has(x + ',' + y + ',' + (z - 1)) ||
          !self.map.has(x + ',' + y + ',' + (z + 1))) {
        out.push({ x: x, y: y, z: z, v: v });
      }
    });
    return out;
  };

  /** 全部方块（透视模式用：不做内部剔除，所有面都画） */
  VoxelWorld.prototype.allBlocks = function () {
    var out = [];
    this.map.forEach(function (v, k) {
      var p = k.split(',');
      out.push({ x: +p[0], y: +p[1], z: +p[2], v: v });
    });
    return out;
  };

  /** 统计 */
  VoxelWorld.prototype.stats = function () {
    var byType = new Map();
    this.map.forEach(function (v) {
      byType.set(v.n, (byType.get(v.n) || 0) + 1);
    });
    return { total: this.map.size, types: byType.size, byType: byType };
  };

  /**
   * 导出为结构 NBT
   * @param {object} opts {dataVersion, ns?, includeEntities:false}
   * @returns {object} 结构 NBT 复合体（喂给 NBT.buildStructure 结果）
   */
  VoxelWorld.prototype.toStructureNBT = function (opts) {
    var NBT = root.NBT;
    var N = NBT.N, TAG = NBT.TAG;

    // 1. 收集 palette（name + props 排序后去重）
    var palIdx = new Map();
    var palette = [];
    var blocks = [];
    var maxY = 0;

    var self = this;
    this.map.forEach(function (v, k) {
      var p = k.split(',');
      var x = +p[0], y = +p[1], z = +p[2];
      if (y > maxY) maxY = y;

      var propKey = '';
      if (v.p) {
        var keys = Object.keys(v.p).sort();
        for (var i = 0; i < keys.length; i++) propKey += keys[i] + '=' + v.p[keys[i]] + ';';
      }
      var sig = v.n + '|' + propKey;
      var idx = palIdx.get(sig);
      if (idx === undefined) {
        idx = palette.length;
        palIdx.set(sig, idx);
        palette.push({ name: v.n, props: v.p || null });
      }
      blocks.push({ x: x, y: y, z: z, state: idx });
    });

    // 2. size：用世界尺寸（保证 y 不越界）
    var size = [this.sx, Math.max(this.sy, maxY + 1), this.sz];

    // 3. entities：生物放在格子中心、脚踩格子底面
    var ents = [];
    this.entities.forEach(function (e, k) {
      var q = k.split(',');
      var ex = +q[0], ey = +q[1], ez = +q[2];
      var nbt = { id: NBT.N.string(e.id || 'minecraft:pig') };
      if (e.yaw) nbt.Rotation = NBT.N.list(NBT.TAG.Float, [NBT.N.float(e.yaw), NBT.N.float(0)]);
      ents.push({
        pos: [ex + 0.5, ey, ez + 0.5],
        blockPos: [ex, ey, ez],
        nbt: NBT.N.compound(nbt)
      });
    });

    return NBT.buildStructure({
      size: size,
      dataVersion: opts && opts.dataVersion ? opts.dataVersion : 3465,
      palette: palette,
      blocks: blocks,
      entities: ents
    });
  };

  /** 序列化到 JSON（存档） */
  VoxelWorld.prototype.toJSON = function () {
    var arr = [];
    this.map.forEach(function (v, k) {
      arr.push([k, v.n, v.p, v.c]);
    });
    var ents = [];
    this.entities.forEach(function (v, k) { ents.push([k, v]); });
    return { sx: this.sx, sy: this.sy, sz: this.sz, blocks: arr, entities: ents };
  };

  VoxelWorld.fromJSON = function (o) {
    var w = new VoxelWorld(o.sx, o.sy, o.sz);
    for (var i = 0; i < o.blocks.length; i++) {
      var b = o.blocks[i];
      w.map.set(b[0], { n: b[1], p: b[2], c: b[3] });
    }
    if (o.entities) {
      for (var j = 0; j < o.entities.length; j++) {
        var e = o.entities[j];
        w.entities.set(e[0], e[1]);
      }
    }
    return w;
  };

  root.VoxelWorld = VoxelWorld;
})(typeof window !== 'undefined' ? window : this);
