// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 取图参数构造测试
 *
 * 这是「排序只对第一页生效」那个 bug 的回归测试。
 *
 * 之前首屏和翻页各写了一份参数拼装，翻页那份漏了 sort/order/seed，
 * 于是第 2 页起就退回后端默认排序（创建时间倒序），看起来像排序完全没用。
 * 这里从两个方向钉死：参数构造本身的行为，以及「源码里不许再各写一份」。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildImageQueryParams } from './imageQuery.js';

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (rel) => readFileSync(resolve(here, '..', rel), 'utf8');

describe('buildImageQueryParams', () => {
  it('排序字段一定会带上（这就是那个 bug）', () => {
    const params = buildImageQueryParams({
      sort: { field: 'name', order: 'asc', seed: 0 },
      offset: 100,
      limit: 100
    });
    expect(params.sort).toBe('name');
    expect(params.order).toBe('asc');
    expect(params.offset).toBe(100);
  });

  it('首页和翻页用的是同一套排序参数，只有 offset 不同', () => {
    const common = {
      folder: '3D&2D/Akiryo',
      keywords: 'cat',
      filters: { formats: ['jpg', 'png'] },
      sort: { field: 'modified', order: 'desc', seed: 0 }
    };
    const first = buildImageQueryParams({ ...common, offset: 0 });
    const second = buildImageQueryParams({ ...common, offset: 100 });

    const { offset: o1, ...rest1 } = first;
    const { offset: o2, ...rest2 } = second;
    expect(rest1).toEqual(rest2);
    expect(o1).toBe(0);
    expect(o2).toBe(100);
  });

  it('随机排序会带上 seed（不带的话每页洗牌都不一样，会重复漏图）', () => {
    const params = buildImageQueryParams({
      sort: { field: 'random', order: 'asc', seed: 12345 },
      offset: 200
    });
    expect(params.sort).toBe('random');
    expect(params.seed).toBe(12345);
  });

  it('非随机排序不带 seed', () => {
    const params = buildImageQueryParams({ sort: { field: 'size', order: 'desc', seed: 999 } });
    expect(params.seed).toBeUndefined();
  });

  it('没有排序时完全不传 sort（交给后端默认）', () => {
    const params = buildImageQueryParams({ offset: 0 });
    expect(params.sort).toBeUndefined();
    expect(params.order).toBeUndefined();
  });

  it('文件夹 / 关键词 / 格式筛选只在有值时出现', () => {
    expect(buildImageQueryParams({})).toEqual({ offset: 0, limit: 100 });
    expect(buildImageQueryParams({ folder: '', keywords: '', filters: { formats: [] } }))
      .toEqual({ offset: 0, limit: 100 });

    const full = buildImageQueryParams({
      folder: 'A/B', keywords: 'x y', filters: { formats: ['jpg'] }
    });
    expect(full.folder).toBe('A/B');
    expect(full.keywords).toBe('x y');
    expect(full.formats).toBe('jpg');
  });

  it('筛选条件全部交给后端：模式 / 格式 / 大小 / 方向 / 评分', () => {
    const params = buildImageQueryParams({
      folder: 'A',
      filters: {
        mode: 'exclude',
        formats: ['jpg', 'png'],
        minSize: 102400,
        maxSize: 20971520,
        orientations: ['horizontal', 'vertical'],
        ratings: [0, 5],
      },
    });
    expect(params.filterMode).toBe('exclude');
    expect(params.formats).toBe('jpg,png');
    expect(params.minSize).toBe(102400);
    expect(params.maxSize).toBe(20971520);
    expect(params.orientations).toBe('horizontal,vertical');
    expect(params.ratings).toBe('0,5');
  });

  it('默认（不筛）时不带任何筛选参数，只显示模式也不用带', () => {
    const params = buildImageQueryParams({
      filters: { mode: 'include', formats: [], minSize: null, maxSize: null, orientations: [], ratings: [] },
    });
    expect(params.filterMode).toBeUndefined();
    expect(params.formats).toBeUndefined();
    expect(params.minSize).toBeUndefined();
    expect(params.maxSize).toBeUndefined();
    expect(params.orientations).toBeUndefined();
    expect(params.ratings).toBeUndefined();
    expect(params).toEqual({ offset: 0, limit: 100 });
  });

  it('大小是脏数据也不会把 min/max 发成 NaN', () => {
    const params = buildImageQueryParams({
      filters: { formats: [], minSize: NaN, maxSize: undefined, orientations: [], ratings: [] },
    });
    expect(params.minSize).toBeUndefined();
    expect(params.maxSize).toBeUndefined();
  });

  it('offset / limit 是脏数据也不会把请求带崩', () => {
    expect(buildImageQueryParams({ offset: -5 }).offset).toBe(0);
    expect(buildImageQueryParams({ offset: 'abc' }).offset).toBe(0);
    expect(buildImageQueryParams({ limit: 0 }).limit).toBe(100);
    expect(buildImageQueryParams({ limit: -3 }).limit).toBe(100);
  });

  it('order 只认 asc / desc', () => {
    expect(buildImageQueryParams({ sort: { field: 'name', order: 'ASC' } }).order).toBe('desc');
    expect(buildImageQueryParams({ sort: { field: 'name', order: 'asc' } }).order).toBe('asc');
  });
});

describe('源码里只允许有一处拼参数', () => {
  const callers = [
    'components/MainContent.jsx',
    'hooks/useInfiniteScroll.js'
  ];

  it('首屏和翻页都走 buildImageQueryParams', () => {
    for (const file of callers) {
      const src = readSource(file);
      expect(src.includes('buildImageQueryParams'), `${file} 没有用 buildImageQueryParams`).toBe(true);
    }
  });

  it('两个调用方都不再手写 params.sort / params.formats', () => {
    for (const file of callers) {
      const src = readSource(file);
      expect(src.includes('params.sort'), `${file} 又在自己拼 sort 了`).toBe(false);
      expect(src.includes('params.formats'), `${file} 又在自己拼 formats 了`).toBe(false);
      expect(src.includes('params.keywords'), `${file} 又在自己拼 keywords 了`).toBe(false);
    }
  });
});
