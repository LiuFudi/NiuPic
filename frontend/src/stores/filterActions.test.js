// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 筛选 action 的行为测试
 *
 * store 是筛选状态的唯一落点，字段名一旦对不上（比如滑块给 {min,max}、
 * store 收 {minSize,maxSize}），表现出来的就是"操作了但没生效"，
 * 而且不报错 —— 端到端测试里真的踩到过，所以这里把形状钉死。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useImageStore } from './useImageStore.js';
import { countActiveFilters } from '../utils/filters.js';

const get = () => useImageStore.getState();
const reset = () => get().clearFilters();

describe('筛选 action', () => {
  beforeEach(() => reset());

  it('默认是全空、模式为 include', () => {
    const f = get().filters;
    expect(f.mode).toBe('include');
    expect(f.formats).toEqual([]);
    expect(f.orientations).toEqual([]);
    expect(f.ratings).toEqual([]);
    expect(f.minSize).toBeNull();
    expect(f.maxSize).toBeNull();
  });

  it('每次改动都换新对象（MainContent 靠引用变化重新取图）', () => {
    const before = get().filters;
    get().toggleFilterValue('formats', 'jpeg');
    expect(get().filters).not.toBe(before);
  });

  it('多选是切换：再点一次就取消', () => {
    get().toggleFilterValue('formats', 'jpeg');
    get().toggleFilterValue('formats', 'png');
    expect(get().filters.formats).toEqual(['jpeg', 'png']);
    get().toggleFilterValue('formats', 'jpeg');
    expect(get().filters.formats).toEqual(['png']);
  });

  it('toggleFilterValues：整组一起选 / 一起取消（格式组头用）', () => {
    get().toggleFilterValues('formats', ['jpeg', 'png', 'webp']);
    expect(get().filters.formats).toEqual(['jpeg', 'png', 'webp']);

    // 再点一次整组取消
    get().toggleFilterValues('formats', ['jpeg', 'png', 'webp']);
    expect(get().filters.formats).toEqual([]);
  });

  it('toggleFilterValues：只选中了一部分时，补齐整组（而不是取消）', () => {
    get().toggleFilterValue('formats', 'jpeg');
    get().toggleFilterValues('formats', ['jpeg', 'png']);
    expect(get().filters.formats.sort()).toEqual(['jpeg', 'png']);
    // 已经全选中了，再点就是取消
    get().toggleFilterValues('formats', ['jpeg', 'png']);
    expect(get().filters.formats).toEqual([]);
  });

  it('toggleFilterValues：空数组不做任何事（不把别的选择清掉）', () => {
    get().toggleFilterValue('formats', 'jpeg');
    get().toggleFilterValues('formats', []);
    expect(get().filters.formats).toEqual(['jpeg']);
  });

  it('方向 / 评分也是同一套切换逻辑', () => {
    get().toggleFilterValue('orientations', 'vertical');
    get().toggleFilterValue('ratings', 0);
    expect(get().filters.orientations).toEqual(['vertical']);
    expect(get().filters.ratings).toEqual([0]);
  });

  it('setSizeRange：区间两端原样写进 minSize / maxSize（字节）', () => {
    const MB = 1024 * 1024;
    get().setSizeRange({ minSize: 1 * MB, maxSize: 5 * MB });
    expect(get().filters.minSize).toBe(1 * MB);
    expect(get().filters.maxSize).toBe(5 * MB);
  });

  it('setSizeRange：两端放开就是 null（不限）', () => {
    get().setSizeRange({ minSize: null, maxSize: null });
    expect(get().filters.minSize).toBeNull();
    expect(get().filters.maxSize).toBeNull();
    expect(countActiveFilters(get().filters)).toBe(0);
  });

  it('setSizeRange：只管一端也行', () => {
    const MB = 1024 * 1024;
    get().setSizeRange({ maxSize: 1 * MB });
    expect(get().filters.minSize).toBeNull();
    expect(get().filters.maxSize).toBe(1 * MB);
    get().setSizeRange({ minSize: 100 * MB });
    expect(get().filters.minSize).toBe(100 * MB);
    expect(get().filters.maxSize).toBeNull();
  });

  it('脏数据不会写进去（NaN / undefined 都当不限）', () => {
    get().setSizeRange({ minSize: NaN, maxSize: undefined });
    expect(get().filters.minSize).toBeNull();
    expect(get().filters.maxSize).toBeNull();
  });

  it('模式只认 include / exclude', () => {
    get().setFilterMode('exclude');
    expect(get().filters.mode).toBe('exclude');
    get().setFilterMode('乱七八糟');
    expect(get().filters.mode).toBe('include');
  });

  it('clearFilters 把条件和模式一起清掉（不会留下"空条件的排除"）', () => {
    get().setFilterMode('exclude');
    get().toggleFilterValue('formats', 'jpeg');
    get().setSizeRange({ minSize: 1024 * 1024, maxSize: 5 * 1024 * 1024 });
    get().clearFilters();
    const f = get().filters;
    expect(f.mode).toBe('include');
    expect(f.formats).toEqual([]);
    expect(f.minSize).toBeNull();
  });

  it('resetFilters（切文件夹时调用）会清空条件', () => {
    get().toggleFilterValue('formats', 'jpeg');
    get().resetFilters();
    expect(get().filters.formats).toEqual([]);
    expect(get().searchKeywords).toBe('');
  });
});
