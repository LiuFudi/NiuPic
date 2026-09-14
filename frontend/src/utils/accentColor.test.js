/**
 * 主题色（强调色）工具测试
 *
 * 这套工具决定了整站的配色，所以重点锁住三件事：
 *   1. 行为契约：默认蓝生成出来的色阶要贴着 Tailwind blue，换主题色不能把界面搞花
 *   2. 可读性底线：任何颜色收敛之后，白字压在 500 档上、500 档当文字放在暗底上，都要看得清
 *   3. 健壮性：乱七八糟的输入不能把界面搞崩
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fc from 'fast-check';
import {
  ACCENT_STOPS,
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentCssVariables,
  applyAccentColor,
  buildAccentPalette,
  contrastRatio,
  hexToRgb,
  hslToRgb,
  isDefaultAccent,
  normalizeAccentBase,
  normalizeHex,
  rgbToHex,
  rgbToHsl
} from './accentColor.js';

const WHITE = { r: 255, g: 255, b: 255 };
const DARK_BG = { r: 30, g: 30, b: 30 };

/** 生成一个合法的 #rrggbb */
const hexArb = fc
  .tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 })
  )
  .map(([r, g, b]) => rgbToHex({ r, g, b }));

describe('颜色解析', () => {
  it('支持 #rrggbb / rrggbb / #rgb 三种写法', () => {
    expect(normalizeHex('#3b82f6')).toBe('#3b82f6');
    expect(normalizeHex('3b82f6')).toBe('#3b82f6');
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc');
    expect(normalizeHex('  #3B82F6  ')).toBe('#3b82f6');
  });

  it('非法输入返回 null，不抛异常', () => {
    for (const bad of ['', '   ', '#12345', '#1234567', 'zzzzzz', 'red', null, undefined, 42, {}, []]) {
      expect(normalizeHex(bad)).toBe(null);
      expect(hexToRgb(bad)).toBe(null);
    }
  });

  it('RGB / HSL 互转能往返', () => {
    fc.assert(
      fc.property(hexArb, (hex) => {
        const rgb = hexToRgb(hex);
        const back = hslToRgb(rgbToHsl(rgb));
        // 允许 1 的舍入误差
        expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
        expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
        expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 }
    );
  });
});

describe('对比度', () => {
  it('白对黑是 21:1', () => {
    expect(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 })).toBeCloseTo(21, 1);
  });

  it('同色是 1:1', () => {
    expect(contrastRatio({ r: 18, g: 52, b: 86 }, { r: 18, g: 52, b: 86 })).toBeCloseTo(1, 5);
  });

  it('与顺序无关', () => {
    const a = { r: 59, g: 130, b: 246 };
    expect(contrastRatio(a, WHITE)).toBeCloseTo(contrastRatio(WHITE, a), 10);
  });
});

describe('默认主题色', () => {
  const palette = buildAccentPalette(DEFAULT_ACCENT);

  it('默认蓝生成出来的色阶贴着 Tailwind blue', () => {
    const tailwind = {
      50: '#eff6ff',
      100: '#dbeafe',
      200: '#bfdbfe',
      300: '#93c5fd',
      400: '#60a5fa',
      500: '#3b82f6',
      600: '#2563eb',
      700: '#1d4ed8',
      800: '#1e40af',
      900: '#1e3a8a',
      950: '#172554'
    };
    for (const stop of ACCENT_STOPS) {
      const generated = hexToRgb(palette.hex[stop]);
      const expected = hexToRgb(tailwind[stop]);
      for (const channel of ['r', 'g', 'b']) {
        // 允许少量偏差，但不允许「整体跑偏」
        expect(Math.abs(generated[channel] - expected[channel])).toBeLessThanOrEqual(26);
      }
    }
  });

  it('500 档就是用户选的那个颜色（蓝）', () => {
    expect(palette.hex[500]).toBe('#3c83f6');
    expect(contrastRatio(hexToRgb(palette.hex[500]), hexToRgb(DEFAULT_ACCENT))).toBeLessThan(1.05);
  });

  it('isDefaultAccent 能认出默认色及其各种写法', () => {
    expect(isDefaultAccent('#3b82f6')).toBe(true);
    expect(isDefaultAccent('3B82F6')).toBe(true);
    expect(isDefaultAccent('#ef4444')).toBe(false);
    expect(isDefaultAccent(null)).toBe(false);
  });
});

describe('色阶结构', () => {
  it('每个预设都生成完整 11 档', () => {
    for (const preset of ACCENT_PRESETS) {
      const palette = buildAccentPalette(preset.color);
      expect(Object.keys(palette.hex).sort()).toEqual(
        ACCENT_STOPS.map(String).sort()
      );
      for (const stop of ACCENT_STOPS) {
        expect(normalizeHex(palette.hex[stop])).toBe(palette.hex[stop]);
      }
    }
  });

  it('明度从 50 到 950 单调递减（色阶不会忽明忽暗）', () => {
    fc.assert(
      fc.property(hexArb, (hex) => {
        const palette = buildAccentPalette(hex);
        const lightness = ACCENT_STOPS.map((stop) => rgbToHsl(hexToRgb(palette.hex[stop])).l);
        for (let i = 1; i < lightness.length; i += 1) {
          expect(lightness[i]).toBeLessThan(lightness[i - 1]);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('CSS 变量是 "R G B" 三元组（Tailwind 的透明度写法要用）', () => {
    const vars = accentCssVariables('#10b981');
    for (const stop of ACCENT_STOPS) {
      expect(vars[`--accent-${stop}`]).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
      const [r, g, b] = vars[`--accent-${stop}`].split(' ').map(Number);
      for (const channel of [r, g, b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('可读性底线（任意颜色都要守住）', () => {
  it('白字压在 500 档上至少 3:1', () => {
    fc.assert(
      fc.property(hexArb, (hex) => {
        const palette = buildAccentPalette(hex);
        expect(contrastRatio(hexToRgb(palette.hex[500]), WHITE)).toBeGreaterThanOrEqual(3);
      }),
      { numRuns: 300 }
    );
  });

  it('500 档当文字放在暗色背景上至少 3:1', () => {
    fc.assert(
      fc.property(hexArb, (hex) => {
        const palette = buildAccentPalette(hex);
        expect(contrastRatio(hexToRgb(palette.hex[500]), DARK_BG)).toBeGreaterThanOrEqual(3);
      }),
      { numRuns: 300 }
    );
  });

  it('所有预设都守得住这两条底线', () => {
    for (const preset of ACCENT_PRESETS) {
      const palette = buildAccentPalette(preset.color);
      const base = hexToRgb(palette.hex[500]);
      expect(contrastRatio(base, WHITE), `${preset.name} 白字`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(base, DARK_BG), `${preset.name} 暗底`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('极端输入', () => {
  it('纯白 / 纯黑 / 纯黄都能收敛成可用颜色', () => {
    for (const extreme of ['#ffffff', '#000000', '#ffff00', '#00ff00', '#ff00ff', '#7f7f7f']) {
      const base = normalizeAccentBase(extreme);
      expect(base).not.toBe(null);
      expect(base.l).toBeGreaterThanOrEqual(0);
      expect(base.l).toBeLessThanOrEqual(100);
      const palette = buildAccentPalette(extreme);
      expect(contrastRatio(hexToRgb(palette.hex[500]), WHITE)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(hexToRgb(palette.hex[500]), DARK_BG)).toBeGreaterThanOrEqual(3);
    }
  });

  it('灰色（饱和度为 0）也能生成一整套灰阶', () => {
    const palette = buildAccentPalette('#808080');
    const lightness = ACCENT_STOPS.map((stop) => rgbToHsl(hexToRgb(palette.hex[stop])).l);
    for (let i = 1; i < lightness.length; i += 1) {
      expect(lightness[i]).toBeLessThan(lightness[i - 1]);
    }
  });

  it('非法输入回退到默认蓝而不是崩掉', () => {
    for (const bad of ['', 'zzz', null, undefined, 42]) {
      const palette = buildAccentPalette(bad);
      expect(contrastRatio(hexToRgb(palette.hex[500]), hexToRgb(DEFAULT_ACCENT))).toBeLessThan(1.05);
    }
  });
});

describe('index.css 里的默认值不能和算法脱节', () => {
  it(':root 里的 --accent-* 必须等于 buildAccentPalette(默认蓝)', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    const root = css.slice(css.indexOf(':root'), css.indexOf('.dark'));
    const expected = accentCssVariables(DEFAULT_ACCENT);

    for (const stop of ACCENT_STOPS) {
      const match = root.match(new RegExp(`--accent-${stop}:\\s*([\\d ]+);`));
      expect(match, `index.css 缺少 --accent-${stop}`).not.toBe(null);
      expect(match[1].trim(), `--accent-${stop} 与算法不一致`).toBe(expected[`--accent-${stop}`]);
    }
  });
});

describe('applyAccentColor', () => {
  /** 假的 CSSStyleDeclaration，够用就行 */
  const fakeRoot = () => {
    const store = new Map();
    return {
      style: {
        setProperty: (k, v) => store.set(k, v),
        removeProperty: (k) => store.delete(k),
        getPropertyValue: (k) => store.get(k) || ''
      },
      store
    };
  };

  it('写入全部 11 个变量', () => {
    const root = fakeRoot();
    const palette = applyAccentColor('#10b981', root);
    expect(palette).not.toBe(null);
    expect(root.store.size).toBe(ACCENT_STOPS.length);
    for (const stop of ACCENT_STOPS) {
      expect(root.store.get(`--accent-${stop}`)).toBe(palette.rgb[stop]);
    }
  });

  it('传 null 清掉内联变量，交回 CSS 里的默认蓝', () => {
    const root = fakeRoot();
    applyAccentColor('#10b981', root);
    expect(root.store.size).toBe(ACCENT_STOPS.length);
    const result = applyAccentColor(null, root);
    expect(result).toBe(null);
    expect(root.store.size).toBe(0);
  });

  it('非法值同样按「恢复默认」处理', () => {
    const root = fakeRoot();
    applyAccentColor('#10b981', root);
    applyAccentColor('completely-not-a-color', root);
    expect(root.store.size).toBe(0);
  });

  it('重复应用同一个颜色结果稳定（幂等）', () => {
    const root = fakeRoot();
    const first = applyAccentColor('#ec4899', root);
    const second = applyAccentColor('#ec4899', root);
    expect(second.rgb).toEqual(first.rgb);
    expect(root.store.size).toBe(ACCENT_STOPS.length);
  });
});
