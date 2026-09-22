// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 色轮
 *
 * 角度 = 色相（0~360），半径 = 饱和度（0~100），盘面固定画在明度 50% 上
 * （明度单独用滑块调，这样任何色相、任何明度都能在盘上点到，不会出现
 * 「明度拉到 95 之后整个盘变成白的，没法选色」）。
 *
 * 指针事件直接覆盖鼠标 + 触屏 + 触控笔，拖动时实时回调。
 */

import { useCallback, useEffect, useRef } from 'react';
import { hslToRgb, rgbToHex, hexToRgb, rgbToHsl } from '../utils/accentColor';

/** 盘面分辨率（CSS 尺寸另行通过 style 控制） */
const SIZE = 200;
const WHEEL_LIGHTNESS = 50;

/**
 * 画一次色轮（逐像素算 HSL → RGB）
 * 只在挂载时画一次：盘面本身不随选中颜色变化，省得每帧重绘。
 */
function paintWheel(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const radius = SIZE / 2;
  const image = ctx.createImageData(SIZE, SIZE);
  const data = image.data;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const dx = x - radius + 0.5;
      const dy = y - radius + 0.5;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const index = (y * SIZE + x) * 4;

      if (distance > radius) {
        data[index + 3] = 0; // 圆外透明
        continue;
      }

      let hue = (Math.atan2(dy, dx) * 180) / Math.PI + 90; // 0° 在正上方
      if (hue < 0) hue += 360;
      const saturation = Math.min(1, distance / radius) * 100;

      const { r, g, b } = hslToRgb({ h: hue, s: saturation, l: WHEEL_LIGHTNESS });
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      // 边缘一像素做个渐隐，避免锯齿
      data[index + 3] = distance > radius - 1 ? Math.round(255 * (radius - distance)) : 255;
    }
  }

  ctx.putImageData(image, 0, 0);
}

export default function ColorWheel({ hue = 0, saturation = 100, onChange, size = 168 }) {
  const canvasRef = useRef(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (canvasRef.current) paintWheel(canvasRef.current);
  }, []);

  /** 屏幕坐标 → {hue, saturation} */
  const pickFromEvent = useCallback((event) => {
    const canvas = canvasRef.current;
    if (!canvas || typeof onChange !== 'function') return;

    const rect = canvas.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = event.clientX - rect.left - radius;
    const dy = event.clientY - rect.top - radius;

    let nextHue = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (nextHue < 0) nextHue += 360;

    const distance = Math.sqrt(dx * dx + dy * dy);
    // 靠近圆心（低饱和）时色相没意义，保留原来的色相，免得指针乱跳
    const nextSaturation = Math.min(1, distance / radius) * 100;
    onChange({
      hue: nextSaturation < 2 ? hue : nextHue,
      saturation: nextSaturation
    });
  }, [hue, onChange]);

  const handlePointerDown = (event) => {
    draggingRef.current = true;
    // 先取色再指针捕获：捕获对「没有真实按下」的合成事件会抛 NotFoundError，
    // 放在前面会把取色一起带崩（自动化测试里就是这么踩到的）
    pickFromEvent(event);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch { /* 合成事件没有活动指针，忽略即可 */ }
  };

  const handlePointerMove = (event) => {
    if (!draggingRef.current) return;
    pickFromEvent(event);
  };

  const endDrag = (event) => {
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch { /* 同上 */ }
  };

  // 指针位置（百分比），用于画选中标记
  const radians = ((hue - 90) * Math.PI) / 180;
  const markerRadius = Math.min(100, Math.max(0, saturation)) / 100;
  const markerX = 50 + Math.cos(radians) * markerRadius * 50;
  const markerY = 50 + Math.sin(radians) * markerRadius * 50;

  const markerColor = rgbToHex(hslToRgb({
    h: hue,
    s: saturation,
    l: WHEEL_LIGHTNESS
  }));
  // 标记点的描边用「亮色还是暗色」取决于标记处颜色本身，保证在任何位置都看得见
  const markerIsLight = rgbToHsl(hexToRgb(markerColor) || { r: 0, g: 0, b: 0 }).l > 60;

  return (
    <div
      className="relative select-none touch-none"
      style={{ width: size, height: size }}
      data-testid="accent-color-wheel"
    >
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="w-full h-full rounded-full cursor-crosshair"
        style={{ touchAction: 'none' }}
      />
      {/* 当前选中的色相 / 饱和度 */}
      <span
        className="absolute w-4 h-4 rounded-full pointer-events-none -translate-x-1/2 -translate-y-1/2"
        style={{
          left: `${markerX}%`,
          top: `${markerY}%`,
          backgroundColor: markerColor,
          border: `2px solid ${markerIsLight ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.9)'}`,
          boxShadow: '0 1px 3px rgba(0,0,0,0.35)'
        }}
      />
    </div>
  );
}
