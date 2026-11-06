/*
 * nbt.js — Minecraft 结构文件(.nbt) 写入器 + gzip 压缩
 * 零依赖，可在浏览器 / WebView 直接跑。
 *
 * 关键点：
 *  - NBT 字符串用 modified UTF-8（Java DataInputStream.readUTF 语义），
 *    补平面字符（emoji）走代理对 ×2 三字节，标准 UTF-8 会读错。
 *  - gzip 优先用 CompressionStream；不支持时退到 stored-block gzip（不压缩但合法）。
 */
(function (root) {
  'use strict';

  var TAG = {
    End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
    ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12
  };

  // ---------------------------------------------------------------- 写入器
  function Writer(initial) {
    this.buf = new Uint8Array(initial || 1 << 16);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }
  Writer.prototype._ensure = function (n) {
    if (this.len + n <= this.buf.length) return;
    var cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  };
  Writer.prototype.u8 = function (v) { this._ensure(1); this.view.setUint8(this.len, v & 0xff); this.len += 1; };
  Writer.prototype.i8 = function (v) { this._ensure(1); this.view.setInt8(this.len, v); this.len += 1; };
  Writer.prototype.i16 = function (v) { this._ensure(2); this.view.setInt16(this.len, v); this.len += 2; };
  Writer.prototype.u16 = function (v) { this._ensure(2); this.view.setUint16(this.len, v); this.len += 2; };
  Writer.prototype.i32 = function (v) { this._ensure(4); this.view.setInt32(this.len, v); this.len += 4; };
  Writer.prototype.i64 = function (v) {
    this._ensure(8);
    var big = typeof v === 'bigint' ? v : BigInt(Math.trunc(v));
    this.view.setBigInt64(this.len, big);
    this.len += 8;
  };
  Writer.prototype.f32 = function (v) { this._ensure(4); this.view.setFloat32(this.len, v); this.len += 4; };
  Writer.prototype.f64 = function (v) { this._ensure(8); this.view.setFloat64(this.len, v); this.len += 8; };
  Writer.prototype.raw = function (arr) { this._ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; };

  // modified UTF-8
  function mutf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var cp = str.codePointAt(i);
      if (cp > 0xffff) i++;              // 吃掉低代理
      if (cp === 0) { out.push(0xC0, 0x80); }
      else if (cp < 0x80) { out.push(cp); }
      else if (cp < 0x800) { out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3f)); }
      else if (cp <= 0xffff) {
        out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        var v = cp - 0x10000;
        var hi = 0xd800 + (v >> 10), lo = 0xdc00 + (v & 0x3ff);
        [hi, lo].forEach(function (s) {
          out.push(0xE0 | (s >> 12), 0x80 | ((s >> 6) & 0x3f), 0x80 | (s & 0x3f));
        });
      }
    }
    return out;
  }
  Writer.prototype.str = function (s) {
    var b = mutf8(String(s));
    if (b.length > 65535) throw new Error('NBT string too long: ' + b.length);
    this.u16(b.length);
    this.raw(b);
  };

  /*
   * 值构造器：所有值都是 {t: tagId, v: value}
   *   compound: v = {key: value, ...}
   *   list:     v = {et: elemTagId, items: [value...]}
   */
  function t(tag, v) { return { t: tag, v: v }; }
  var N = {
    byte: function (v) { return t(TAG.Byte, v); },
    short: function (v) { return t(TAG.Short, v); },
    int: function (v) { return t(TAG.Int, v); },
    long: function (v) { return t(TAG.Long, v); },
    float: function (v) { return t(TAG.Float, v); },
    double: function (v) { return t(TAG.Double, v); },
    string: function (v) { return t(TAG.String, v); },
    byteArray: function (a) { return t(TAG.ByteArray, a); },
    intArray: function (a) { return t(TAG.IntArray, a); },
    longArray: function (a) { return t(TAG.LongArray, a); },
    compound: function (o) { return t(TAG.Compound, o); },
    list: function (et, items) { return t(TAG.List, { et: et, items: items }); },
    TAG: TAG
  };

  function writeValue(w, val) {
    var tag = val.t, v = val.v, i;
    switch (tag) {
      case TAG.Byte: w.i8(v); break;
      case TAG.Short: w.i16(v); break;
      case TAG.Int: w.i32(v); break;
      case TAG.Long: w.i64(v); break;
      case TAG.Float: w.f32(v); break;
      case TAG.Double: w.f64(v); break;
      case TAG.String: w.str(v); break;
      case TAG.ByteArray:
        w.i32(v.length); w.raw(v); break;
      case TAG.IntArray:
        w.i32(v.length);
        for (i = 0; i < v.length; i++) w.i32(v[i]);
        break;
      case TAG.LongArray:
        w.i32(v.length);
        for (i = 0; i < v.length; i++) w.i64(v[i]);
        break;
      case TAG.Compound:
        for (var k in v) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
          var child = v[k];
          w.u8(child.t);
          w.str(k);
          writeValue(w, child);
        }
        w.u8(TAG.End);
        break;
      case TAG.List:
        w.u8(v.et);
        w.i32(v.items.length);
        for (i = 0; i < v.items.length; i++) {
          if (v.items[i].t !== v.et) throw new Error('List 元素类型不一致');
          writeValue(w, v.items[i]);
        }
        break;
      default:
        throw new Error('未知 tag: ' + tag);
    }
  }

  // ---------------------------------------------------------------- 读取
  function Reader(buf) {
    this.d = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.v = new DataView(this.d.buffer, this.d.byteOffset, this.d.byteLength);
    this.i = 0;
  }
  Reader.prototype.u8 = function () { return this.v.getUint8(this.i++); };
  Reader.prototype.i8 = function () { return this.v.getInt8(this.i++); };
  Reader.prototype.i16 = function () { return this.v.getInt16((this.i += 2) - 2); };
  Reader.prototype.i32 = function () { return this.v.getInt32((this.i += 4) - 4); };
  Reader.prototype.i64 = function () { return this.v.getBigInt64((this.i += 8) - 8); };
  Reader.prototype.f32 = function () { return this.v.getFloat32((this.i += 4) - 4); };
  Reader.prototype.f64 = function () { return this.v.getFloat64((this.i += 8) - 8); };
  Reader.prototype.bytes = function (n) {
    var out = this.d.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  };
  /** modified UTF-8（Java DataInputStream.readUTF），代理对是两段三字节 */
  Reader.prototype.str = function () {
    var n = this.i16();
    var b = this.bytes(n), out = '', i = 0;
    while (i < b.length) {
      var c = b[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if ((c & 0xE0) === 0xC0) out += String.fromCharCode(((c & 0x1F) << 6) | (b[i++] & 0x3F));
      else out += String.fromCharCode(((c & 0x0F) << 12) | ((b[i++] & 0x3F) << 6) | (b[i++] & 0x3F));
    }
    return out;
  };

  function readPayload(r, t) {
    var i, n;
    switch (t) {
      case 1: return r.i8();
      case 2: return r.i16();
      case 3: return r.i32();
      case 4: return r.i64();
      case 5: return r.f32();
      case 6: return r.f64();
      case 7: n = r.i32(); return r.bytes(n);
      case 8: return r.str();
      case 9:
        var et = r.u8(); n = r.i32();
        var arr = [];
        for (i = 0; i < n; i++) arr.push(readPayload(r, et));
        return arr;
      case 10:
        var o = {};
        while (true) {
          var tt = r.u8();
          if (tt === 0) return o;
          var name = r.str();
          o[name] = readPayload(r, tt);
        }
      case 11:
        n = r.i32(); var ia = [];
        for (i = 0; i < n; i++) ia.push(r.i32());
        return ia;
      case 12:
        n = r.i32(); var la = [];
        for (i = 0; i < n; i++) la.push(r.i64());
        return la;
      default:
        throw new Error('未知 tag: ' + t);
    }
  }

  /** 反序列化（返回根 compound 的值对象） */
  function decode(buf) {
    var r = new Reader(buf);
    var t = r.u8();
    if (t !== TAG.Compound) throw new Error('根不是 Compound');
    r.str();
    return readPayload(r, TAG.Compound);
  }

  /** 自动 gunzip（带 gzip 魔数时用 DecompressionStream） */
  function gunzip(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return Promise.resolve(u8);
    if (!window.DecompressionStream) return Promise.reject(new Error('浏览器不支持 gzip 解压'));
    var ds = new DecompressionStream('gzip');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  /** 序列化为未压缩 NBT 字节（根为无名 Compound） */
  function encode(rootCompound) {
    var w = new Writer(1 << 18);
    w.u8(TAG.Compound);
    w.str('');
    writeValue(w, rootCompound);
    return w.buf.subarray(0, w.len);
  }

  // ---------------------------------------------------------------- gzip
  var CRC_TABLE = (function () {
    var tbl = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      tbl[n] = c >>> 0;
    }
    return tbl;
  })();

  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** 兜底：stored-block gzip（不压缩，但完全合法，MC 能读） */
  function gzipStored(u8) {
    var MAX = 65535;
    var blocks = Math.max(1, Math.ceil(u8.length / MAX));
    var out = new Uint8Array(10 + blocks * 5 + u8.length + 8);
    var p = 0;
    // gzip header
    out[p++] = 0x1f; out[p++] = 0x8b; out[p++] = 0x08; out[p++] = 0x00;
    out[p++] = 0; out[p++] = 0; out[p++] = 0; out[p++] = 0;
    out[p++] = 0x00; out[p++] = 0xff;      // XFL=0, OS=unknown
    var off = 0;
    for (var b = 0; b < blocks; b++) {
      var n = Math.min(MAX, u8.length - off);
      var final = (b === blocks - 1) ? 1 : 0;
      out[p++] = final;                      // BFINAL + BTYPE=00
      out[p++] = n & 0xff; out[p++] = (n >> 8) & 0xff;
      out[p++] = (~n) & 0xff; out[p++] = ((~n) >> 8) & 0xff;
      out.set(u8.subarray(off, off + n), p);
      p += n; off += n;
    }
    var crc = crc32(u8);
    out[p++] = crc & 0xff; out[p++] = (crc >>> 8) & 0xff;
    out[p++] = (crc >>> 16) & 0xff; out[p++] = (crc >>> 24) & 0xff;
    var isz = u8.length >>> 0;
    out[p++] = isz & 0xff; out[p++] = (isz >>> 8) & 0xff;
    out[p++] = (isz >>> 16) & 0xff; out[p++] = (isz >>> 24) & 0xff;
    return out.subarray(0, p);
  }

  /** gzip 压缩（自动选择实现） */
  function gzip(u8) {
    if (typeof CompressionStream !== 'undefined' && typeof Blob !== 'undefined' && typeof Response !== 'undefined') {
      try {
        var cs = new CompressionStream('gzip');
        var stream = new Blob([u8]).stream().pipeThrough(cs);
        return new Response(stream).arrayBuffer().then(function (ab) {
          return new Uint8Array(ab);
        });
      } catch (e) { /* 落到兜底 */ }
    }
    return Promise.resolve(gzipStored(u8));
  }

  // ---------------------------------------------------------------- 结构文件
  /**
   * 构建 Minecraft 结构 NBT
   * @param {object} o
   *   o.size        [sx,sy,sz]
   *   o.dataVersion number
   *   o.palette     [{name:string, props:object|null}, ...]
   *   o.blocks      [{x,y,z,state:number, nbt?:object(T-value) }, ...]
   *   o.entities    [{pos:[x,y,z], blockPos:[x,y,z], nbt:object}]
   */
  function buildStructure(o) {
    var paletteItems = o.palette.map(function (p) {
      var c = { Name: N.string(p.name) };
      if (p.props) {
        var props = {};
        for (var k in p.props) {
          if (Object.prototype.hasOwnProperty.call(p.props, k)) props[k] = N.string(p.props[k]);
        }
        c.Properties = N.compound(props);
      }
      return N.compound(c);
    });

    var blockItems = o.blocks.map(function (b) {
      var c = {
        pos: N.list(TAG.Int, [N.int(b.x), N.int(b.y), N.int(b.z)]),
        state: N.int(b.state)
      };
      if (b.nbt) c.nbt = b.nbt;
      return N.compound(c);
    });

    var entities = (o.entities || []).map(function (e) {
      return N.compound({
        pos: N.list(TAG.Double, [N.double(e.pos[0]), N.double(e.pos[1]), N.double(e.pos[2])]),
        blockPos: N.list(TAG.Int, [N.int(e.blockPos[0]), N.int(e.blockPos[1]), N.int(e.blockPos[2])]),
        nbt: e.nbt
      });
    });

    return N.compound({
      DataVersion: N.int(o.dataVersion | 0),
      size: N.list(TAG.Int, [N.int(o.size[0]), N.int(o.size[1]), N.int(o.size[2])]),
      palette: N.list(TAG.Compound, paletteItems),
      blocks: N.list(TAG.Compound, blockItems),
      entities: N.list(TAG.Compound, entities)
    });
  }

  root.NBT = {
    TAG: TAG,
    N: N,
    encode: encode,
    decode: decode,
    gunzip: gunzip,
    gzip: gzip,
    gzipStored: gzipStored,
    crc32: crc32,
    buildStructure: buildStructure,
    mutf8: mutf8
  };
})(typeof window !== 'undefined' ? window : this);
