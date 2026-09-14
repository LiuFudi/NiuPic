/**
 * 主题色（强调色）工具
 *
 * 界面里 150 多处用的是 Tailwind 的 `bg-blue-500` / `text-blue-600` 这类类名。
 * 与其把它们逐个改成变量，不如**把 `blue` 这一族调色板整体重映射到 CSS 变量上**
 * （见 tailwind.config.js），于是换主题色只要改 11 个 CSS 变量，整站立刻变。
 *
 * 本模块负责：
 *   1. 生成一套 50~950 的强调色色阶（预设色和色轮取到的任意颜色走同一套算法）
 *   2. 明度护航：太亮会让「白字按钮」看不清，太暗会让暗色模式下的文字没有对比，
 *      所以把基础色夹到一个可用区间，并在需要时压低明度保证白字至少有 3:1
 *   3. 把色阶写进 document.documentElement 的 CSS 变量
 */

/** 色阶档位，与 Tailwind 的编号一致 */
export const ACCENT_STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** 默认主题色 = Tailwind blue-500，和改造前的观感一致 */
export const DEFAULT_ACCENT = '#3b82f6';

/**
 * 每一档的形状：目标明度、跟随基础色的权重、明度上下限
 *
 *   l —— 基础色明度正好是 60 时的明度（这套数值是照 Tailwind blue 反推的）
 *   w —— 基础色比 60 深/浅时，这一档跟着走多少：
 *        亮端权重小，因为 bg-blue-50/100 是「浅浅的一层底色」，
 *        不管主题色选多深，它都得是接近白的浅色，否则整块地方会发暗；
 *        暗端权重为 1，整体跟着主题色走。
 *   min/max —— 防止两端被压成纯黑或纯白
 */
const STOP_SHAPE = {
  50: { l: 97, w: 0.15, min: 90, max: 99 },
  100: { l: 93, w: 0.3, min: 84, max: 97 },
  200: { l: 87, w: 0.5, min: 74, max: 93 },
  300: { l: 78, w: 0.7, min: 60, max: 88 },
  400: { l: 68, w: 0.9, min: 46, max: 80 },
  // 500 档就是用户选的那个颜色，这里不能再夹：可用范围已经由 normalizeAccentBase
  // 的两条对比度底线筛过了，再夹一次会把刚保证的东西破坏掉
  500: { l: 60, w: 1.0, min: 0, max: 100 },
  600: { l: 52, w: 1.0, min: 26, max: 62 },
  700: { l: 44, w: 1.0, min: 20, max: 55 },
  800: { l: 36, w: 1.0, min: 15, max: 48 },
  900: { l: 29, w: 1.0, min: 10, max: 42 },
  950: { l: 20, w: 1.0, min: 6, max: 34 }
};

/** 每一档的饱和度系数（相对基础色）
 *  亮端略降一点：bg-blue-50/100 是「一层浅浅的底色」，饱和度拉满会变得很扎眼
 *  （比如翠绿主题的选中行会变成一片荧光薄荷绿），降 5% 左右就柔和多了 */
const STOP_SATURATION = {
  50: 1.0,
  100: 0.96,
  200: 0.94,
  300: 0.96,
  400: 1.0,
  500: 1.0,
  600: 0.92,
  700: 0.85,
  800: 0.75,
  900: 0.72,
  950: 0.72
};

/** 基础色明度的允许区间：再亮白字按钮就看不清，再暗就没有「彩色」的感觉 */
const BASE_LIGHTNESS_MIN = 40;
const BASE_LIGHTNESS_MAX = 62;
/** 白字压在强调色底上，至少要有的对比度 */
const MIN_WHITE_CONTRAST = 3.0;
/** 强调色当文字用在暗色背景（#1e1e1e）上，至少要有的对比度 */
const MIN_DARK_CONTRAST = 3.0;
const WHITE = { r: 255, g: 255, b: 255 };
const DARK_BG = { r: 30, g: 30, b: 30 };

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 把各种写法解析成 {r,g,b}，解析不了返回 null
 * 支持 #abc / abc / #aabbcc / aabbcc
 */
export function hexToRgb(value) {
  if (typeof value !== 'string') return null;
  let hex = value.trim().replace(/^#/, '');
  if (hex.length === 3) {
    hex = hex.split('').map((c) => c + c).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

/** {r,g,b} → '#rrggbb' */
export function rgbToHex({ r, g, b }) {
  const part = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** 统一成小写 '#rrggbb'，非法返回 null */
export function normalizeHex(value) {
  const rgb = hexToRgb(value);
  return rgb === null ? null : rgbToHex(rgb);
}

/** {r,g,b} → {h:0-360, s:0-100, l:0-100} */
export function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

/** {h,s,l} → {r,g,b} */
export function hslToRgb({ h, s, l }) {
  const hn = ((h % 360) + 360) % 360 / 360;
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;

  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v };
  }

  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const channel = (t) => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };

  return {
    r: Math.round(channel(hn + 1 / 3) * 255),
    g: Math.round(channel(hn) * 255),
    b: Math.round(channel(hn - 1 / 3) * 255)
  };
}

/** WCAG 相对亮度 */
export function relativeLuminance({ r, g, b }) {
  const channel = (v) => {
    const vn = v / 255;
    return vn <= 0.03928 ? vn / 12.92 : Math.pow((vn + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 对比度，1 ~ 21 */
export function contrastRatio(rgbA, rgbB) {
  const la = relativeLuminance(rgbA);
  const lb = relativeLuminance(rgbB);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * 把用户选的颜色收敛成一个「能当强调色用」的基础色。
 *
 * - 保留色相与饱和度（饱和度 0 也允许，那就是无彩色主题）
 * - 明度尽量贴着 [40, 62]：太亮 → 白字按钮看不清；太暗 → 暗色模式下没层次
 * - 但真正决定取值的是两条对比度底线：
 *     白字压在 500 档上 ≥ 3:1（黄色系会因此压深）
 *     500 档当文字用在暗色背景上 ≥ 3:1（靛蓝这类会因此提亮）
 *   在满足两条底线的明度里，挑离「理想明度」最近的那个
 *
 * @param {string} value 任意颜色写法
 * @returns {{h:number,s:number,l:number,rgb:object,hex:string}|null}
 */
export function normalizeAccentBase(value) {
  const rgb = hexToRgb(value);
  if (rgb === null) return null;

  const { h, s, l: rawLightness } = rgbToHsl(rgb);
  const ideal = clamp(rawLightness, BASE_LIGHTNESS_MIN, BASE_LIGHTNESS_MAX);

  // 明度只按整数档扫一遍（100 次），拿到满足两条底线的所有取值
  const feasible = [];
  for (let l = 0; l <= 100; l += 1) {
    const candidate = hslToRgb({ h, s, l });
    if (
      contrastRatio(candidate, WHITE) >= MIN_WHITE_CONTRAST &&
      contrastRatio(candidate, DARK_BG) >= MIN_DARK_CONTRAST
    ) {
      feasible.push(l);
    }
  }

  const l = feasible.length
    ? feasible.reduce((best, cur) => (Math.abs(cur - ideal) < Math.abs(best - ideal) ? cur : best), feasible[0])
    : ideal; // 理论上到不了这里（两条底线之间有很宽的可行区间）

  const finalRgb = hslToRgb({ h, s, l });
  return { h, s, l, rgb: finalRgb, hex: rgbToHex(finalRgb) };
}

/**
 * 生成 50~950 的强调色色阶
 *
 * @param {string} value 任意颜色写法
 * @returns {{hex:object, rgb:object, base:string, input:string}}
 *   hex —— {50:'#eff6ff', ...}
 *   rgb —— {50:'239 246 255', ...}（CSS 变量用的三元组，支持 Tailwind 的 /50 透明度）
 */
export function buildAccentPalette(value) {
  const base = normalizeAccentBase(value) || normalizeAccentBase(DEFAULT_ACCENT);
  const delta = base.l - STOP_SHAPE[500].l;

  // 先按形状表算出各档明度
  const lightness = {};
  let previous = Infinity;
  for (const stop of ACCENT_STOPS) {
    const shape = STOP_SHAPE[stop];
    let l = clamp(shape.l + delta * shape.w, shape.min, shape.max);
    // 上下限有可能把某一档顶到比上一档还亮（深浅极端的基础色会遇到），
    // 这里顺着扫一遍强制严格递减，保证色阶不会忽明忽暗
    l = Math.min(l, previous - 1);
    lightness[stop] = l;
    previous = l;
  }

  const hex = {};
  const rgb = {};
  for (const stop of ACCENT_STOPS) {
    const color = hslToRgb({
      h: base.h,
      s: clamp(base.s * STOP_SATURATION[stop], 0, 100),
      l: lightness[stop]
    });
    hex[stop] = rgbToHex(color);
    rgb[stop] = `${color.r} ${color.g} ${color.b}`;
  }

  return { hex, rgb, base: base.hex, input: normalizeHex(value) || DEFAULT_ACCENT };
}

/** 把色阶写成 CSS 变量名 -> 三元组的映射（方便测试，也方便别处复用） */
export function accentCssVariables(value) {
  const { rgb } = buildAccentPalette(value);
  const vars = {};
  for (const stop of ACCENT_STOPS) {
    vars[`--accent-${stop}`] = rgb[stop];
  }
  return vars;
}

/**
 * 应用到 DOM。传 null / 非法值 = 清掉内联变量，回到 CSS 里的默认蓝
 * @param {string|null} value
 * @param {HTMLElement} [target]
 * @returns {object|null} 色阶，未应用时返回 null
 */
export function applyAccentColor(value, target) {
  const root = target || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!root || !root.style) return null;

  const normalized = value === null || value === undefined ? null : normalizeHex(value);
  if (normalized === null) {
    for (const stop of ACCENT_STOPS) {
      root.style.removeProperty(`--accent-${stop}`);
    }
    return null;
  }

  const palette = buildAccentPalette(normalized);
  for (const stop of ACCENT_STOPS) {
    root.style.setProperty(`--accent-${stop}`, palette.rgb[stop]);
  }
  return palette;
}

/**
 * 预设主题色
 * 全部落在「中等明度」区间，保证白字按钮和暗色模式文字都看得清
 */
export const ACCENT_PRESETS = [
  { id: 'blue', name: '默认蓝', color: '#3b82f6' },
  { id: 'sky', name: '天蓝', color: '#0ea5e9' },
  { id: 'cyan', name: '青色', color: '#06b6d4' },
  { id: 'teal', name: '青绿', color: '#14b8a6' },
  { id: 'emerald', name: '翠绿', color: '#10b981' },
  { id: 'amber', name: '琥珀', color: '#f59e0b' },
  { id: 'orange', name: '橙色', color: '#f97316' },
  { id: 'red', name: '红色', color: '#ef4444' },
  { id: 'pink', name: '玫红', color: '#ec4899' },
  { id: 'violet', name: '紫罗兰', color: '#8b5cf6' },
  { id: 'indigo', name: '靛蓝', color: '#6366f1' },
  { id: 'slate', name: '石板灰', color: '#64748b' }
];

/** 判断某个颜色是否就是默认主题色 */
export function isDefaultAccent(value) {
  return normalizeHex(value) === normalizeHex(DEFAULT_ACCENT);
}
