// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 筛选读数 / 大小挡位 / 文件大小显示的测试
 *
 * 这一轮把筛选从「前端过滤已加载的那一页」改成「后端 SQL 筛」；
 * 大小筛选先是滑块 → 固定挡位 → 又按要求改回滑块（停靠在这 9 个挡位上）。
 * 挡位表本身在后端（constants.SIZE_BRACKETS），这里只测前端的换算与读数。
 */

import { describe, it, expect } from 'vitest';
import {
  countActiveFilters, filterModeLabel,
  findSizeRangeIndexes, shortBracketLabel, sumBracketCounts,
} from './filters.js';
import { formatFileSize } from './fileSize.js';

const emptyFilters = () => ({
  mode: 'include', formats: [], minSize: null, maxSize: null, orientations: [], ratings: [],
});
const MB = 1024 * 1024;
const brackets = [
  { key: 'lt1', label: '< 1 MB', minSize: null, maxSize: 1 * MB, count: 117 },
  { key: '1-5', label: '1 - 5 MB', minSize: 1 * MB, maxSize: 5 * MB, count: 14 },
  { key: 'gt100', label: '100 MB 以上', minSize: 100 * MB, maxSize: null, count: 0 },
];

describe('countActiveFilters', () => {
  it('什么都没选 = 0 项', () => {
    expect(countActiveFilters(emptyFilters())).toBe(0);
    expect(countActiveFilters(null)).toBe(0);
    expect(countActiveFilters(undefined)).toBe(0);
  });

  it('每个维度最多算一项，多选不算多项', () => {
    expect(countActiveFilters({ ...emptyFilters(), formats: ['jpg'] })).toBe(1);
    expect(countActiveFilters({ ...emptyFilters(), formats: ['jpg', 'png', 'gif'] })).toBe(1);
    expect(countActiveFilters({ ...emptyFilters(), orientations: ['horizontal'] })).toBe(1);
    expect(countActiveFilters({ ...emptyFilters(), ratings: [0, 1, 2] })).toBe(1);
    expect(countActiveFilters({ ...emptyFilters(), minSize: 1024 })).toBe(1);
    expect(countActiveFilters({ ...emptyFilters(), maxSize: 1024 })).toBe(1);
  });

  it('多个维度累加', () => {
    expect(countActiveFilters({
      ...emptyFilters(), formats: ['jpg'], minSize: 1024, orientations: ['square'], ratings: [5],
    })).toBe(4);
  });

  it('只有模式（没选任何条件）不算激活 —— 那时排除和筛选结果一样', () => {
    expect(countActiveFilters({ ...emptyFilters(), mode: 'exclude' })).toBe(0);
  });
});

describe('filterModeLabel', () => {
  it('默认是筛选，exclude 是排除', () => {
    expect(filterModeLabel(emptyFilters())).toBe('筛选');
    expect(filterModeLabel({ ...emptyFilters(), mode: 'exclude' })).toBe('排除');
    expect(filterModeLabel(null)).toBe('筛选');
  });
});

describe('大小区间滑块：两个把手停在哪一档', () => {
  it('没筛的时候两个把手占两端（不限）', () => {
    const r = findSizeRangeIndexes(brackets, emptyFilters());
    expect(r).toEqual({ left: 0, right: 2, isFull: true });
    expect(findSizeRangeIndexes(brackets, null).isFull).toBe(true);
    expect(findSizeRangeIndexes(null, emptyFilters())).toEqual({ left: 0, right: 0, isFull: true });
  });

  it('按挡位表里的原值对得上（选中时写入的就是那两个数）', () => {
    // 只筛上限：右手把停在 < 1 MB，左手把在最左
    expect(findSizeRangeIndexes(brackets, { ...emptyFilters(), maxSize: 1 * MB }))
      .toEqual({ left: 0, right: 0, isFull: false });
    // 只筛下限：左手把停在 1 - 5 MB，右手把在最右
    expect(findSizeRangeIndexes(brackets, { ...emptyFilters(), minSize: 1 * MB }))
      .toEqual({ left: 1, right: 2, isFull: false });
    // 两端都筛 = 中间那一档
    expect(findSizeRangeIndexes(brackets, { ...emptyFilters(), minSize: 1 * MB, maxSize: 5 * MB }))
      .toEqual({ left: 1, right: 1, isFull: false });
  });

  it('值对不上任何挡位时退回两端，而不是乱停', () => {
    const r = findSizeRangeIndexes(brackets, { ...emptyFilters(), minSize: 7 * MB });
    expect(r.left).toBe(0);
    expect(r.right).toBe(2);
  });

  it('刻度短标签：能塞进滑条下面', () => {
    expect(shortBracketLabel('< 1 MB')).toBe('<1M');
    expect(shortBracketLabel('1 - 5 MB')).toBe('1-5');
    expect(shortBracketLabel('80 - 100 MB')).toBe('80-100');
    expect(shortBracketLabel('100 MB 以上')).toBe('100+');
    expect(shortBracketLabel('')).toBe('');
  });

  it('区间张数 = 区间内各挡位之和（挡位口径互不重叠）', () => {
    expect(sumBracketCounts(brackets, 0, 2)).toBe(117 + 14 + 0);
    expect(sumBracketCounts(brackets, 1, 1)).toBe(14);
    expect(sumBracketCounts(brackets, 1, 99)).toBe(14 + 0);
  });
});

describe('formatFileSize', () => {
  it('1024 进制，去掉没意义的小数', () => {
    expect(formatFileSize(0)).toBe('0 KB');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(102400)).toBe('100 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
  });

  it('脏数据不显示 NaN', () => {
    expect(formatFileSize(null)).toBe('0 KB');
    expect(formatFileSize(NaN)).toBe('0 KB');
    expect(formatFileSize(-5)).toBe('0 KB');
  });
});
