// Tally 应用图标 / 托盘图标 / ICO 生成器（唯一的图标生成入口）。
//
//   node scripts/make-icons.mjs                            用默认方案生成完整图标集
//   node scripts/make-icons.mjs --variant=card             换方案
//   node scripts/make-icons.mjs --list                     列出所有方案
//   node scripts/make-icons.mjs --compare=letterT,letterTtight   只拼这两个方案做二选一
//
// 产出：
//   electron/assets/app-{16..256}.png   窗口 / 任务栏用多尺寸 PNG
//   electron/assets/icon.ico            多尺寸 ICO（窗口 + 资源管理器 + 快捷方式）
//   electron/assets/tray-{16,32}.png    托盘（logo 单独绘制，不带底板）
//   snapshots/icons/<方案>/*.png         各方案预览图，用于对比挑选
//   snapshots/icons/contact-sheet.png   全部方案对照图
//   snapshots/icons/zoom.png            16px / 32px 像素级放大图
//   snapshots/icons/compare.png         --compare 指定的少数方案对比图
//
// 设计说明：几何在 32x32 设计空间里定义，渲染时才放大到目标分辨率，
// 所以 16px 与 256px 是同一套比例。边缘靠 4~8 倍超采样算覆盖率。
// 风格固定为「立体蓝」：竖向渐变底板 + 顶部高光 + 笔画投影。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'electron', 'assets');
const REVIEW = path.join(ROOT, 'snapshots', 'icons');

const DEFAULT_VARIANT = 'letterT';
const APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const REVIEW_SIZES = [16, 32, 48, 128, 256];

// ---------------------------------------------------------------- PNG 编码
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = rgba[y * stride + i];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO 编码
// 16~64 用 32bpp DIB（兼容性最好），128/256 用 PNG 直嵌（Vista+ 支持）。
function encodeDIB(size, rgba) {
  const n = size;
  const xor = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const s = ((n - 1 - y) * n + x) * 4; // DIB 自下而上
      const d = (y * n + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }
  const maskStride = Math.ceil(n / 32) * 4;
  const and = Buffer.alloc(maskStride * n);
  const ih = Buffer.alloc(40);
  ih.writeUInt32LE(40, 0);
  ih.writeInt32LE(n, 4);
  ih.writeInt32LE(n * 2, 8);
  ih.writeUInt16LE(1, 12);
  ih.writeUInt16LE(32, 14);
  ih.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([ih, xor, and]);
}

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const b = i * 16;
    dir[b] = e.size >= 256 ? 0 : e.size;
    dir[b + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(e.data.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

// ---------------------------------------------------------------- 几何
const DESIGN = 32;

function segDist(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy));
}

// 圆头线段
const seg = (x1, y1, x2, y2, w) => (x, y) => segDist(x, y, x1, y1, x2, y2) <= w / 2;
const dot = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) <= r;

// 圆角矩形
const rrect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
};

// 只有上面两个角是圆的（做日历卡抬头用）
const rrectTop = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (y < y0 + r) {
    const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
    const dy = y0 + r - y;
    return dx * dx + dy * dy <= r * r;
  }
  return true;
};

const ring = (outer, inner) => (x, y) => outer(x, y) && !inner(x, y);
const union = (...fs) => (x, y) => fs.some((f) => f(x, y));

// ---------------------------------------------------------------- 配色
const WHITE = [255, 255, 255];
const BLUE = [0x3a, 0x5b, 0xe0];
const BAND = [0xa9, 0xbc, 0xff];
const ACCENT = [0x6d, 0x8d, 0xf8];
const SHADOW_OUTER = [0x16, 0x22, 0x4a];
const SHADOW_MARK = [0x10, 0x20, 0x4a];

// ---------------------------------------------------------------- 方案定义
// marks：按顺序绘制。shadow:true 的图层会额外生成一层投影。
const VARIANTS = {
  panel: {
    label: '叠层面板',
    note: '两张错位卡片 + 两条额条',
    marks: [
      { f: rrect(10.6, 6.4, 25.6, 21.4, 3.4), color: WHITE, alpha: 0.4 },
      { f: rrect(6.4, 10.6, 21.4, 25.6, 3.4), color: WHITE, alpha: 1, shadow: true },
      { f: rrect(9.4, 14.0, 18.4, 16.6, 1.3), color: BLUE },
      { f: rrect(9.4, 18.2, 15.4, 20.8, 1.3), color: BLUE },
    ],
  },
  gauge: {
    label: '容量舱',
    note: '胶囊加内填，直读剩余额度',
    // 内圈半径必须 <= 自身半高（1.2），否则挖孔会塌成透镜形
    marks: [
      {
        f: ring(rrect(6.4, 12.6, 23.4, 19.4, 3.4), rrect(8.6, 14.8, 21.2, 17.2, 1.2)),
        color: WHITE,
        shadow: true,
      },
      { f: rrect(9.4, 14.6, 17.6, 17.4, 1.4), color: WHITE },
      { f: rrect(23.8, 15.0, 25.4, 17.0, 1.0), color: WHITE },
    ],
  },
  card: {
    label: '打卡卡',
    note: '卡片加对勾，对应每日签到',
    marks: [
      { f: rrect(7, 7.4, 25, 24.6, 3.4), color: WHITE, shadow: true },
      { f: rrectTop(7, 7.4, 25, 11.8, 3.4), color: BAND },
      {
        f: union(seg(11.4, 18.4, 14.6, 21.6, 2.4), seg(14.6, 21.6, 21, 14.2, 2.4)),
        color: BLUE,
      },
    ],
  },
  tally: {
    label: '半划刻痕',
    note: '斜杠划到一半，表示计数进行中',
    marks: [
      {
        f: union(
          seg(11, 8.4, 11, 23.6, 2.8),
          seg(16, 8.4, 16, 23.6, 2.8),
          seg(21, 8.4, 21, 23.6, 2.8),
          seg(8.8, 22.4, 17.2, 14.6, 2.8)
        ),
        color: WHITE,
        shadow: true,
      },
    ],
  },
  progress: {
    label: '进度正字',
    note: '四竖一斜，最后一竖半透明',
    marks: [
      {
        f: union(
          seg(10.4, 8.2, 10.4, 23.8, 2.4),
          seg(14.0, 8.2, 14.0, 23.8, 2.4),
          seg(17.6, 8.2, 17.6, 23.8, 2.4)
        ),
        color: WHITE,
        shadow: true,
      },
      { f: seg(21.2, 8.2, 21.2, 23.8, 2.4), color: WHITE, alpha: 0.35 },
      { f: seg(8.7, 22.0, 23.3, 10.0, 2.4), color: WHITE },
    ],
  },
  letterT: {
    label: '刻痕 T',
    note: 'T 的竖笔拆成两道刻痕，正字计数的味道',
    marks: [
      {
        f: union(
          seg(8.4, 10.6, 23.6, 9.4, 2.6),
          seg(13.4, 10.4, 13.4, 24.2, 2.6),
          seg(18.6, 10.4, 18.6, 24.2, 2.6)
        ),
        color: WHITE,
        shadow: true,
      },
    ],
  },
  // 与 letterT 同一套语言，但两笔向下收拢成一根 —— 轮廓读作 T 而不是 π
  letterTtight: {
    label: '刻痕 T·收拢',
    note: '两道刻痕向下收拢，轮廓仍是 T',
    marks: [
      {
        f: union(
          seg(8.4, 10.6, 23.6, 9.4, 2.6),
          seg(13.4, 10.4, 15.5, 23.8, 2.6),
          seg(18.6, 10.4, 16.5, 23.8, 2.6)
        ),
        color: WHITE,
        shadow: true,
      },
    ],
  },
  hourglass: {
    label: '沙漏',
    note: '对应额度多久后重置',
    marks: [
      {
        f: union(
          seg(9.6, 7.6, 22.4, 7.6, 2.6),
          seg(9.6, 24.4, 22.4, 24.4, 2.6),
          seg(22.4, 7.6, 16, 16, 2.6),
          seg(16, 16, 22.4, 24.4, 2.6),
          seg(9.6, 7.6, 16, 16, 2.6),
          seg(16, 16, 9.6, 24.4, 2.6)
        ),
        color: WHITE,
        shadow: true,
      },
      { f: dot(16, 19.4, 1.6), color: WHITE },
    ],
  },
  page: {
    label: '纸页',
    note: '白纸底板加黑色刻痕，Notion 味',
    style: 'paper',
    marks: [
      {
        f: union(
          seg(11, 8.6, 11, 23.4, 2.4),
          seg(16, 8.6, 16, 23.4, 2.4),
          seg(21, 8.6, 21, 23.4, 2.4),
          seg(9.2, 21.6, 22.8, 10.4, 2.4)
        ),
        color: [0x19, 0x19, 0x19],
      },
    ],
  },
};

// 底板：默认立体蓝；paper 风格是白纸 + 细灰边
const TILE = rrect(0.6, 0.6, 31.4, 31.4, 7.2);

function tileColorAt(x, y, style) {
  if (style === 'paper') return [255, 255, 255];
  const t = Math.max(0, Math.min(1, (y - 0.6) / 30.8));
  return [
    Math.round(0x82 + (0x3a - 0x82) * t),
    Math.round(0xa6 + (0x5b - 0xa6) * t),
    Math.round(0xff + (0xe0 - 0xff) * t),
  ];
}

function highlightAt(y, style) {
  if (style === 'paper') return 0;
  const t = Math.max(0, Math.min(1, (y - 0.6) / 30.8));
  return 0.4 * (1 - t);
}

// ---------------------------------------------------------------- 渲染
function coverage(shapeFn, size, scale, ss) {
  const buf = new Float32Array(size * size);
  const step = 1 / ss;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) {
        const y = (py + (sy + 0.5) * step) * scale;
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) * step) * scale;
          if (shapeFn(x, y)) hit++;
        }
      }
      buf[py * size + px] = hit / (ss * ss);
    }
  }
  return buf;
}

function boxBlur(src, size, r) {
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  const w = 2 * r + 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[y * size + Math.min(size - 1, Math.max(0, x + i))];
      tmp[y * size + x] = s / w;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[Math.min(size - 1, Math.max(0, y + i)) * size + x];
      out[y * size + x] = s / w;
    }
  }
  return out;
}

function gaussBlur(src, size, sigma) {
  const r = Math.max(1, Math.round(sigma));
  let b = src;
  for (let i = 0; i < 3; i++) b = boxBlur(b, size, r);
  return b;
}

function renderVariant(name, size, opts = {}) {
  const v = VARIANTS[name];
  if (!v) throw new Error('unknown variant: ' + name);
  const style = v.style || 'blue';
  const scale = DESIGN / size;
  const ss = size <= 32 ? 8 : 4;
  const useTileShadow = opts.tileShadow !== false;

  const n = size * size;
  const pr = new Float32Array(n);
  const pg = new Float32Array(n);
  const pb = new Float32Array(n);
  const pa = new Float32Array(n);

  const over = (i, color, alpha) => {
    if (alpha <= 0) return;
    const a = Math.min(1, alpha);
    const ia = 1 - a;
    pr[i] = color[0] * a + pr[i] * ia;
    pg[i] = color[1] * a + pg[i] * ia;
    pb[i] = color[2] * a + pb[i] * ia;
    pa[i] = a + pa[i] * ia;
  };

  const tileMask = coverage(TILE, size, scale, ss);

  // 1) 底板外投影
  if (useTileShadow) {
    const sigma = 1.3 * (size / DESIGN);
    const dy = Math.round(1.1 * (size / DESIGN));
    const blurred = gaussBlur(tileMask, size, sigma);
    for (let y = 0; y < size; y++) {
      const sy = Math.min(size - 1, Math.max(0, y - dy));
      for (let x = 0; x < size; x++) {
        over(y * size + x, SHADOW_OUTER, blurred[sy * size + x] * 0.3);
      }
    }
  }

  // 2) 底板 + 顶部高光
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const c = tileMask[i];
      if (c <= 0) continue;
      const dx = (x + 0.5) * scale;
      const dyv = (y + 0.5) * scale;
      over(i, tileColorAt(dx, dyv, style), c);
      const hi = highlightAt(dyv, style);
      if (hi > 0) over(i, WHITE, hi * c);
    }
  }

  // paper 风格：细灰描边
  if (style === 'paper') {
    const edge = ring(TILE, rrect(1.5, 1.5, 30.5, 30.5, 6.6));
    const em = coverage(edge, size, scale, ss);
    for (let i = 0; i < n; i++) if (em[i] > 0) over(i, [0xd8, 0xd5, 0xcf], em[i]);
  }

  // 3) 笔画投影（所有 shadow:true 的图层合并成一层）
  const shadowShapes = v.marks.filter((m) => m.shadow).map((m) => m.f);
  if (shadowShapes.length) {
    const mask = coverage(union(...shadowShapes), size, scale, ss);
    const sigma = 0.55 * (size / DESIGN);
    const dy = Math.max(1, Math.round(0.5 * (size / DESIGN)));
    const blurred = gaussBlur(mask, size, sigma);
    for (let y = 0; y < size; y++) {
      const sy = Math.min(size - 1, Math.max(0, y - dy));
      for (let x = 0; x < size; x++) {
        over(y * size + x, SHADOW_MARK, blurred[sy * size + x] * 0.36);
      }
    }
  }

  // 4) 笔画本体
  for (const m of v.marks) {
    const cov = coverage(m.f, size, scale, ss);
    const a0 = m.alpha == null ? 1 : m.alpha;
    for (let i = 0; i < n; i++) if (cov[i] > 0) over(i, m.color, cov[i] * a0);
  }

  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = pa[i];
    if (a <= 0) continue;
    out[i * 4] = Math.round(Math.min(255, pr[i] / a));
    out[i * 4 + 1] = Math.round(Math.min(255, pg[i] / a));
    out[i * 4 + 2] = Math.round(Math.min(255, pb[i] / a));
    out[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  return out;
}

// 托盘图标：只画 logo 本身（不带底板），单色扁平
function renderTrayMark(name, size) {
  const v = VARIANTS[name];
  const scale = DESIGN / size;
  const ss = size <= 32 ? 8 : 4;
  const n = size * size;
  const pr = new Float32Array(n);
  const pg = new Float32Array(n);
  const pb = new Float32Array(n);
  const pa = new Float32Array(n);
  const over = (i, color, alpha) => {
    const a = Math.min(1, alpha);
    const ia = 1 - a;
    pr[i] = color[0] * a + pr[i] * ia;
    pg[i] = color[1] * a + pg[i] * ia;
    pb[i] = color[2] * a + pb[i] * ia;
    pa[i] = a + pa[i] * ia;
  };
  for (const m of v.marks) {
    const cov = coverage(m.f, size, scale, ss);
    const a0 = m.alpha == null ? 1 : m.alpha;
    for (let i = 0; i < n; i++) if (cov[i] > 0) over(i, ACCENT, cov[i] * a0);
  }
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = pa[i];
    if (a <= 0) continue;
    out[i * 4] = Math.round(pr[i] / a);
    out[i * 4 + 1] = Math.round(pg[i] / a);
    out[i * 4 + 2] = Math.round(pb[i] / a);
    out[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  return out;
}

// ---------------------------------------------------------------- 对照图
function blit(canvas, cw, ch, src, sw, sh, ox, oy) {
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const di = ((oy + y) * cw + (ox + x)) * 4;
      if (oy + y < 0 || oy + y >= ch || ox + x < 0 || ox + x >= cw) continue;
      const si = (y * sw + x) * 4;
      const a = src[si + 3] / 255;
      if (a <= 0) continue;
      const ia = 1 - a;
      canvas[di] = Math.round(src[si] * a + canvas[di] * ia);
      canvas[di + 1] = Math.round(src[si + 1] * a + canvas[di + 1] * ia);
      canvas[di + 2] = Math.round(src[si + 2] * a + canvas[di + 2] * ia);
      canvas[di + 3] = 255;
    }
  }
}

function fill(canvas, cw, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * cw + x) * 4;
      canvas[i] = color[0];
      canvas[i + 1] = color[1];
      canvas[i + 2] = color[2];
      canvas[i + 3] = 255;
    }
  }
}

// 全部方案横向排开：上排浅底（128/32/16），下排深底（32/16）
function makeContactSheet(renders, names) {
  const colW = 148;
  const cw = 40 + names.length * colW;
  const ch = 348;
  const canvas = Buffer.alloc(cw * ch * 4);
  fill(canvas, cw, 0, 0, cw, 250, [0xf0, 0xf1, 0xf4]);
  fill(canvas, cw, 0, 250, cw, ch, [0x1d, 0x21, 0x28]);
  names.forEach((name, idx) => {
    const x = 40 + idx * colW;
    blit(canvas, cw, ch, renders[name][128], 128, 128, x, 26);
    blit(canvas, cw, ch, renders[name][32], 32, 32, x + 6, 176);
    blit(canvas, cw, ch, renders[name][16], 16, 16, x + 54, 184);
    blit(canvas, cw, ch, renders[name][32], 32, 32, x + 6, 276);
    blit(canvas, cw, ch, renders[name][16], 16, 16, x + 54, 284);
  });
  return { buf: canvas, w: cw, h: ch };
}

// 小尺寸像素级放大（最近邻），用来判断 16px 到底糊不糊
function zoomInto(canvas, cw, src, size, z, ox, oy) {
  for (let y = 0; y < size * z; y++) {
    for (let x = 0; x < size * z; x++) {
      const si = (Math.floor(y / z) * size + Math.floor(x / z)) * 4;
      const di = ((oy + y) * cw + (ox + x)) * 4;
      const a = src[si + 3] / 255;
      const ia = 1 - a;
      canvas[di] = Math.round(src[si] * a + canvas[di] * ia);
      canvas[di + 1] = Math.round(src[si + 1] * a + canvas[di + 1] * ia);
      canvas[di + 2] = Math.round(src[si + 2] * a + canvas[di + 2] * ia);
      canvas[di + 3] = 255;
    }
  }
}

function makeZoomSheet(renders, names) {
  const z16 = 12;
  const z32 = 6;
  const cell = 192;
  const gap = 16;
  const cw = 40 + names.length * (cell + gap);
  const ch = 24 + cell + 24 + cell + 24;
  const canvas = Buffer.alloc(cw * ch * 4);
  fill(canvas, cw, 0, 0, cw, 24 + cell + 12, [0xf0, 0xf1, 0xf4]);
  fill(canvas, cw, 0, 24 + cell + 12, cw, ch, [0x1d, 0x21, 0x28]);
  names.forEach((name, idx) => {
    const x = 40 + idx * (cell + gap);
    zoomInto(canvas, cw, renders[name][16], 16, z16, x, 24);
    zoomInto(canvas, cw, renders[name][32], 32, z32, x, 24 + cell + 36);
  });
  return { buf: canvas, w: cw, h: ch };
}

// ---------------------------------------------------------------- 主流程
const args = process.argv.slice(2);
const variantArg = args.find((a) => a.startsWith('--variant='));
const active = variantArg ? variantArg.split('=')[1] : DEFAULT_VARIANT;

// --compare=a,b：只把这两个（或几个）方案拼进 compare.png，用来做二选一
const compareArg = args.find((a) => a.startsWith('--compare='));
const compareNames = compareArg
  ? compareArg
      .slice('--compare='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
for (const n of compareNames) {
  if (!VARIANTS[n]) {
    console.error(`--compare 里有未知方案：${n}\n可用：${Object.keys(VARIANTS).join(', ')}`);
    process.exit(1);
  }
}

if (args.includes('--list')) {
  for (const [k, v] of Object.entries(VARIANTS)) console.log(`${k.padEnd(10)} ${v.label} — ${v.note}`);
  process.exit(0);
}
if (!VARIANTS[active]) {
  console.error(`未知方案：${active}\n可用：${Object.keys(VARIANTS).join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(REVIEW, { recursive: true });

console.log(`生成图标集（方案：${active} · ${VARIANTS[active].label}）`);

// a) 每个方案的预览图
const renders = {};
for (const name of Object.keys(VARIANTS)) {
  const dir = path.join(REVIEW, name);
  fs.mkdirSync(dir, { recursive: true });
  renders[name] = {};
  const sizes = name === active ? APP_SIZES : REVIEW_SIZES;
  for (const s of sizes) {
    const px = renderVariant(name, s);
    renders[name][s] = px;
    fs.writeFileSync(path.join(dir, `icon-${s}.png`), encodePNG(s, s, px));
  }
}
console.log(`· 方案预览图 ${Object.keys(VARIANTS).length} 套 → snapshots/icons/`);

// b) 默认方案写进 electron/assets
for (const s of APP_SIZES) {
  fs.writeFileSync(path.join(ASSETS, `app-${s}.png`), encodePNG(s, s, renders[active][s]));
}
console.log(`· electron/assets/app-{${APP_SIZES.join(',')}}.png`);

const icoEntries = APP_SIZES.map((s) => ({
  size: s,
  data: s >= 128 ? encodePNG(s, s, renders[active][s]) : encodeDIB(s, renders[active][s]),
}));
fs.writeFileSync(path.join(ASSETS, 'icon.ico'), encodeICO(icoEntries));
console.log(`· electron/assets/icon.ico（${APP_SIZES.join('/')} 共 ${icoEntries.length} 个尺寸）`);

// c) 托盘：只画 logo，不带底板
for (const s of [16, 32]) {
  fs.writeFileSync(path.join(ASSETS, `tray-${s}.png`), encodePNG(s, s, renderTrayMark(active, s)));
}
console.log('· electron/assets/tray-{16,32}.png（纯 logo，无底板）');

// d) 对照图 + 像素级放大图
const sheet = makeContactSheet(renders, Object.keys(VARIANTS));
fs.writeFileSync(path.join(REVIEW, 'contact-sheet.png'), encodePNG(sheet.w, sheet.h, sheet.buf));
console.log(`· snapshots/icons/contact-sheet.png（${sheet.w}x${sheet.h}，含深色任务栏带）`);

const zoom = makeZoomSheet(renders, Object.keys(VARIANTS));
fs.writeFileSync(path.join(REVIEW, 'zoom.png'), encodePNG(zoom.w, zoom.h, zoom.buf));
console.log(`· snapshots/icons/zoom.png（16px 放大 12 倍 / 32px 放大 6 倍，最近邻）`);

// e) --compare=a,b 时，只把选中的方案拼成一张对比图，用来二选一
if (compareNames.length) {
  const cs = makeContactSheet(renders, compareNames);
  fs.writeFileSync(path.join(REVIEW, 'compare.png'), encodePNG(cs.w, cs.h, cs.buf));
  console.log(`· snapshots/icons/compare.png（仅 ${compareNames.join(' / ')}）`);
}
