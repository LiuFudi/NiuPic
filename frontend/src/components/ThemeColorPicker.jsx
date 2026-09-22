// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 主题色选择面板：预设颜色 + 色轮 + 明度 + 十六进制输入
 *
 * 交互约定：
 *   - 拖动色轮 / 滑块时**立刻**改变界面（只更新本地状态，不写后端）
 *   - 停手 400ms 后才写后端，避免拖一次发几十个请求
 *   - 面板里显示的「实际效果」是收敛后的颜色：太亮或太暗的颜色会被
 *     accentColor.js 拉到可用区间，所以预览色可能与你点的位置略有不同
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Check } from 'lucide-react';
import ColorWheel from './ColorWheel';
import { useTheme } from '../hooks/useTheme';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  buildAccentPalette,
  hexToRgb,
  hslToRgb,
  normalizeHex,
  rgbToHex,
  rgbToHsl
} from '../utils/accentColor';

/** 停手多久之后才落盘 */
const PERSIST_DELAY = 400;

export default function ThemeColorPicker({ className = '', compact = false }) {
  const { accentColor, changeAccentColor, resetAccentColor } = useTheme();

  // 色轮的本地状态（色相 / 饱和度 / 明度）
  const [hsl, setHsl] = useState(() => {
    const rgb = hexToRgb(accentColor || DEFAULT_ACCENT) || hexToRgb(DEFAULT_ACCENT);
    return rgbToHsl(rgb);
  });
  const [hexInput, setHexInput] = useState(() => normalizeHex(accentColor || DEFAULT_ACCENT));
  const persistTimerRef = useRef(null);

  // 外部（例如另一端改了主题色、点了恢复默认）变化时同步回来
  useEffect(() => {
    const rgb = hexToRgb(accentColor || DEFAULT_ACCENT);
    if (!rgb) return;
    const next = rgbToHsl(rgb);
    setHsl(next);
    setHexInput(rgbToHex(rgb));
  }, [accentColor]);

  useEffect(() => () => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
  }, []);

  /** 本地选中的颜色（未收敛），用于色轮标记与输入框 */
  const pickedHex = useMemo(() => rgbToHex(hslToRgb(hsl)), [hsl]);

  /** 收敛后的颜色 = 界面实际会变成的样子 */
  const effective = useMemo(() => buildAccentPalette(pickedHex).base, [pickedHex]);
  const effectivePalette = useMemo(() => buildAccentPalette(pickedHex), [pickedHex]);

  /** 预览（不落盘） */
  const preview = (hex) => {
    changeAccentColor(hex, { persist: false });
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      changeAccentColor(hex, { persist: true });
    }, PERSIST_DELAY);
  };

  /** 立即落盘（点预设、恢复默认走这条） */
  const commit = (hex) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    changeAccentColor(hex, { persist: true });
  };

  const handleWheelChange = ({ hue, saturation }) => {
    const next = { ...hsl, h: hue, s: saturation };
    setHsl(next);
    const hex = rgbToHex(hslToRgb(next));
    setHexInput(hex);
    preview(hex);
  };

  const handleLightnessChange = (value) => {
    const next = { ...hsl, l: value };
    setHsl(next);
    const hex = rgbToHex(hslToRgb(next));
    setHexInput(hex);
    preview(hex);
  };

  const handleHexInput = (value) => {
    setHexInput(value);
    const normalized = normalizeHex(value);
    if (normalized === null) return;
    setHsl(rgbToHsl(hexToRgb(normalized)));
    preview(normalized);
  };

  const handlePreset = (preset) => {
    const normalized = normalizeHex(preset.color);
    if (normalized === null) return;
    setHsl(rgbToHsl(hexToRgb(normalized)));
    setHexInput(normalized);
    commit(normalized);
  };

  const isUsingDefault = !accentColor;
  const activePresetId = (() => {
    const current = normalizeHex(effective);
    const match = ACCENT_PRESETS.find((preset) => normalizeHex(preset.color) === current);
    return match ? match.id : null;
  })();

  return (
    <div className={className} data-testid="theme-color-picker">
      <div className={`flex items-center justify-between ${compact ? 'mb-2' : 'mb-3'} gap-2 flex-wrap`}>
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
          主题色
          <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
            {compact ? '预设或色轮' : '选一个预设，或用色轮自己调'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
            resetAccentColor();
          }}
          disabled={isUsingDefault}
          className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 disabled:text-gray-400 disabled:cursor-not-allowed dark:disabled:text-gray-500"
          title="恢复默认的蓝色主题"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          恢复默认
        </button>
      </div>

      <div className={compact ? 'flex flex-col gap-3 min-w-0' : 'flex flex-col lg:flex-row lg:items-start gap-5 flex-wrap'}>
        {/* 左：预设 + 色轮 */}
        <div className="flex flex-col gap-3">
          <div className={`grid grid-cols-6 ${compact ? 'gap-1.5' : 'gap-2'}`} data-testid="accent-presets">
            {ACCENT_PRESETS.map((preset) => {
              const active = activePresetId === preset.id;
              return (
                <button
                  type="button"
                  key={preset.id}
                  title={preset.name}
                  aria-label={preset.name}
                  onClick={() => handlePreset(preset)}
                  className={`relative ${compact ? 'w-7 h-7' : 'w-8 h-8'} rounded-full transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-gray-400 ${
                    active ? 'ring-2 ring-offset-2 ring-gray-400 dark:ring-offset-gray-800' : ''
                  }`}
                  style={{ backgroundColor: preset.color }}
                >
                  {active && <Check className="w-4 h-4 text-white absolute inset-0 m-auto drop-shadow" />}
                </button>
              );
            })}
          </div>

          <div className={`flex gap-4 flex-wrap ${compact ? 'items-center' : 'items-center'}`}>
            <ColorWheel
              hue={hsl.h}
              saturation={hsl.s}
              onChange={handleWheelChange}
              size={compact ? 132 : 168}
            />
            <div className={`flex flex-col gap-2 ${compact ? 'flex-1 min-w-[7rem]' : 'w-40'}`}>
              <div className="text-xs text-gray-500 dark:text-gray-400">明度</div>
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(hsl.l)}
                onChange={(e) => handleLightnessChange(parseInt(e.target.value, 10))}
                className="w-full"
                aria-label="明度"
              />
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">十六进制</div>
              <input
                type="text"
                value={hexInput}
                onChange={(e) => handleHexInput(e.target.value)}
                spellCheck={false}
                className="w-full px-2 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                aria-label="主题色十六进制值"
              />
            </div>
          </div>
        </div>

        {/* 右：实际效果预览 */}
        <div className={`flex flex-col gap-2 ${compact ? 'min-w-0' : 'lg:ml-2'}`}>
          <div className="text-xs text-gray-500 dark:text-gray-400">实际效果</div>
          <div className="flex items-center gap-3">
            <span
              className="w-10 h-10 rounded-lg border border-gray-200 dark:border-gray-600"
              style={{ backgroundColor: effective }}
              data-testid="accent-effective-swatch"
              title={effective}
            />
            <div className="flex flex-col gap-1">
              <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{effective}</span>
              <span className="text-[11px] text-gray-400 dark:text-gray-500">
                过亮或过暗的颜色会被自动收敛，保证按钮和文字都看得清
              </span>
            </div>
          </div>

          {/* 一排实际控件，直观看到换色之后长什么样 */}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span
              className="px-3 py-1.5 rounded-lg text-xs text-white"
              style={{ backgroundColor: effectivePalette.hex[500] }}
            >
              主按钮
            </span>
            <span
              className="px-3 py-1.5 rounded-lg text-xs border"
              style={{ borderColor: effectivePalette.hex[500], color: effectivePalette.hex[600] }}
            >
              次要按钮
            </span>
            <span
              className="px-2 py-1.5 rounded-lg text-xs"
              style={{ backgroundColor: effectivePalette.hex[50], color: effectivePalette.hex[700] }}
            >
              标签
            </span>
          </div>

          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {[50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((stop) => (
              <span
                key={stop}
                className="w-5 h-5 rounded"
                style={{ backgroundColor: effectivePalette.hex[stop] }}
                title={`${stop} · ${effectivePalette.hex[stop]}`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
