// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

import { useMemo } from 'react';

/**
 * 区间双滑块（两个把手，默认占两端）
 *
 * 用两个原生 input[type=range] 叠在一起：键盘操作、移动端触摸拖动都由浏览器提供，
 * 比自己写 pointermove 靠谱。两个 input 都不接收指针事件，只有圆形把手接收
 * （见 index.css 的 .niupic-range）。
 *
 * 刻度显示在**滑条下方**（用户要求：不是侧面），每个刻度正对着自己的停靠点。
 *
 * @param {Array<{key,label,shortLabel?,count}>} stops 停靠点（这里就是后端的 9 个大小挡位）
 * @param {number} valueLeft  左手把停在几号停靠点
 * @param {number} valueRight 右手把停在几号停靠点
 * @param {Function} onChange     ({left,right}) 拖动过程中实时回调（外部可以先只改本地显示）
 * @param {Function} onChangeEnd  ({left,right}) 松手时回调（真正提交）
 */
export default function DualRangeSlider({
  stops = [],
  valueLeft = 0,
  valueRight = 0,
  onChange,
  onChangeEnd,
  testId = 'dual-range',
  ariaLabel = '区间',
  disabled = false,
}) {
  const max = Math.max(0, stops.length - 1);

  const { left, right } = useMemo(() => {
    const l = Math.min(Math.max(Number(valueLeft) || 0, 0), max);
    const r = Math.min(Math.max(Number(valueRight) || 0, 0), max);
    return { left: Math.min(l, r), right: Math.max(l, r) };
  }, [valueLeft, valueRight, max]);

  const leftPct = max > 0 ? (left / max) * 100 : 0;
  const rightPct = max > 0 ? (right / max) * 100 : 100;

  const emit = (nextLeft, nextRight, done) => {
    const value = { left: Math.min(nextLeft, nextRight), right: Math.max(nextLeft, nextRight) };
    if (done) onChangeEnd?.(value);
    else onChange?.(value);
  };

  // 两个把手重叠时，上面的那个会挡住下面的 —— 谁更靠右谁抬到上层，
  // 否则把左手把拖到最右边之后就再也拖不回来了
  const leftOnTop = left > max / 2;

  return (
    <div className={disabled || max === 0 ? 'opacity-50' : ''}>
      {/* 松手事件挂在容器上：input 是 pointer-events:none，mouseup 的目标常常是外层 div */}
      <div
        className="niupic-range"
        data-testid={testId}
        onMouseUp={() => emit(left, right, true)}
        onTouchEnd={() => emit(left, right, true)}
      >
        <div className="niupic-range-track" />
        <div
          className="niupic-range-fill"
          style={{ left: `${leftPct}%`, width: `${Math.max(0, rightPct - leftPct)}%` }}
        />
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={left}
          disabled={disabled || max === 0}
          data-testid={`${testId}-left`}
          aria-label={`${ariaLabel}起点`}
          aria-valuetext={stops[left] ? stops[left].label : ''}
          style={{ zIndex: leftOnTop ? 4 : 3 }}
          onChange={(e) => emit(Number(e.target.value), right, false)}
          onKeyUp={() => emit(left, right, true)}
        />
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={right}
          disabled={disabled || max === 0}
          data-testid={`${testId}-right`}
          aria-label={`${ariaLabel}终点`}
          aria-valuetext={stops[right] ? stops[right].label : ''}
          style={{ zIndex: leftOnTop ? 3 : 4 }}
          onChange={(e) => emit(left, Number(e.target.value), false)}
          onKeyUp={() => emit(left, right, true)}
        />
      </div>

      {/* 刻度在下面 */}
      <div className="niupic-range-ticks" data-testid={`${testId}-ticks`}>
        {stops.map((stop, i) => (
          <span
            key={stop.key || i}
            className="niupic-range-tick"
            data-active={i >= left && i <= right}
            style={{ left: `${max > 0 ? (i / max) * 100 : 0}%` }}
            title={stop.count != null ? `${stop.label}：${stop.count} 张` : stop.label}
          >
            {stop.shortLabel || stop.label}
          </span>
        ))}
      </div>
    </div>
  );
}
