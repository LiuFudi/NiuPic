// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 筛选条件的"读数"（谁是激活的、激活了几项）
 *
 * 单独放这里而不是写在组件里：Header 的按钮角标、面板里的摘要都要用，
 * 两处各写一份迟早会对不上。
 */

/** 激活了几项条件（模式本身不算 —— 一个都没选时"排除"不产生任何效果） */
export function countActiveFilters(filters) {
  if (!filters) return 0;
  let n = 0;
  if (filters.formats && filters.formats.length > 0) n += 1;
  if (Number.isFinite(filters.minSize) || Number.isFinite(filters.maxSize)) n += 1;
  if (filters.orientations && filters.orientations.length > 0) n += 1;
  if (filters.ratings && filters.ratings.length > 0) n += 1;
  return n;
}

/** 当前是"筛选"还是"排除"模式 */
export function filterModeLabel(filters) {
  return filters && filters.mode === 'exclude' ? '排除' : '筛选';
}

/**
 * 区间滑块的两个把手当前停在哪个挡位上
 *
 * 不额外存"选了哪几档"—— 那就是同一件事的两份表示，早晚会不一致。
 * 直接拿 filters 里的 minSize/maxSize 去挡位表里对：选中的时候写入的就是挡位表里的原值。
 *
 * 两端都放开（minSize/maxSize 都是 null）= 不限，两个把手分别在最左和最右。
 *
 * @returns {{left:number, right:number, isFull:boolean}}
 */
export function findSizeRangeIndexes(brackets, filters) {
  const list = Array.isArray(brackets) ? brackets : [];
  const last = Math.max(0, list.length - 1);
  const min = Number.isFinite(filters && filters.minSize) ? filters.minSize : null;
  const max = Number.isFinite(filters && filters.maxSize) ? filters.maxSize : null;

  // 默认（没筛）就是两端
  if (min === null && max === null) return { left: 0, right: last, isFull: true };

  const matchMin = (b) => (b.minSize == null ? null : b.minSize) === min;
  const matchMax = (b) => (b.maxSize == null ? null : b.maxSize) === max;

  const leftIndex = min === null ? 0 : list.findIndex(matchMin);
  const rightIndex = max === null ? last : list.findIndex(matchMax);

  return {
    left: leftIndex >= 0 ? leftIndex : 0,
    right: rightIndex >= 0 ? rightIndex : last,
    isFull: false,
  };
}

/**
 * 把挡位标签缩成能塞进滑条下面的短刻度
 *
 * 「< 1 MB」→「<1M」，「1 - 5 MB」→「1-5」，「100 MB 以上」→「100+」
 * （完整标签仍然在滑条上面的读数里显示，刻度只是定位用）
 */
export function shortBracketLabel(label) {
  const text = String(label || '').trim();
  if (!text) return '';

  // 「100 MB 以上」→「100+」
  if (/以上/.test(text)) {
    const num = text.match(/([\d.]+)/);
    return num ? `${num[1]}+` : text;
  }
  // 「1 - 5 MB」→「1-5」
  const range = text.match(/^([\d.]+)\s*-\s*([\d.]+)/);
  if (range) return `${range[1]}-${range[2]}`;
  // 「< 1 MB」→「<1M」
  const less = text.match(/^<\s*([\d.]+)/);
  if (less) return `<${less[1]}M`;

  return text;
}

/** 区间里所有挡位的张数合计（挡位口径是 [min,max)，各档互不重叠） */
export function sumBracketCounts(brackets, left, right) {
  const list = Array.isArray(brackets) ? brackets : [];
  let total = 0;
  for (let i = Math.max(0, left); i <= Math.min(list.length - 1, right); i += 1) {
    total += list[i].count || 0;
  }
  return total;
}

export default {
  countActiveFilters,
  filterModeLabel,
  findSizeRangeIndexes,
  shortBracketLabel,
  sumBracketCounts,
};
