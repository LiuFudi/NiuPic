// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 排序字段的一致性测试
 *
 * 排序字段在**两个地方**各写了一份：
 *   - 前端 frontend/src/stores/useImageStore.js  的 SORT_OPTIONS（决定面板显示什么）
 *   - 后端 backend/src/config/constants.js       的 SORT.FIELDS（决定白名单和 SQL）
 *
 * 两边的键必须一一对应：只改一边的话，要么面板上有个点了没反应的选项，
 * 要么后端有个用户永远选不到的字段。这里把它钉死。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SORT_OPTIONS, SORT_STORAGE_KEY, loadSortPref, DEFAULT_SORT } from './useImageStore.js';

const here = dirname(fileURLToPath(import.meta.url));
const constantsPath = resolve(here, '../../../backend/src/config/constants.js');

/** 从后端 constants.js 里把 SORT.FIELDS 的键抠出来（比 import 一个 CJS 文件稳） */
function backendSortFields() {
  const source = readFileSync(constantsPath, 'utf8');
  const sortBlock = source.slice(source.indexOf('SORT: {'));
  const fieldsBlock = sortBlock.slice(sortBlock.indexOf('FIELDS: {') + 'FIELDS: {'.length);
  const end = fieldsBlock.indexOf('\n    }');
  const body = end === -1 ? fieldsBlock : fieldsBlock.slice(0, end);
  return [...body.matchAll(/^\s{6}(\w+):\s*\{/gm)].map((m) => m[1]);
}

describe('排序字段前后端一致', () => {
  it('前端 SORT_OPTIONS 与后端 SORT.FIELDS 的键完全相同', () => {
    const frontend = SORT_OPTIONS.map((o) => o.field);
    const backend = backendSortFields();

    expect(backend.length).toBeGreaterThan(0);
    expect([...frontend].sort()).toEqual([...backend].sort());
  });

  it('每个选项都有 label 和 hint', () => {
    for (const option of SORT_OPTIONS) {
      expect(option.label, `${option.field} 缺 label`).toBeTruthy();
      expect(option.hint, `${option.field} 缺 hint`).toBeTruthy();
    }
  });

  it('没有重复字段', () => {
    const fields = SORT_OPTIONS.map((o) => o.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('不再提供「格式」排序（和「文件类型」重复，已移除）', () => {
    expect(SORT_OPTIONS.some((o) => o.field === 'format')).toBe(false);
    expect(backendSortFields()).not.toContain('format');
    // 「文件类型」要留着
    expect(SORT_OPTIONS.some((o) => o.field === 'type')).toBe(true);
  });
});

describe('旧排序偏好（localStorage）', () => {
  let original;

  beforeEach(() => {
    original = globalThis.localStorage;
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear()
    };
  });

  afterEach(() => {
    globalThis.localStorage = original;
  });

  it('存着已下线的 format 时退回默认排序，而不是让界面空掉', () => {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ field: 'format', order: 'asc', seed: 0 }));
    const sort = loadSortPref();
    expect(sort.field).toBe(DEFAULT_SORT.field);
    expect(sort.order).toBe(DEFAULT_SORT.order);
  });

  it('存着仍然有效的字段时原样读回', () => {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ field: 'type', order: 'asc', seed: 7 }));
    const sort = loadSortPref();
    expect(sort.field).toBe('type');
    expect(sort.order).toBe('asc');
    expect(sort.seed).toBe(7);
  });

  it('偏好被写坏也不炸', () => {
    localStorage.setItem(SORT_STORAGE_KEY, '{不是 JSON');
    expect(loadSortPref().field).toBe(DEFAULT_SORT.field);
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ field: 42, order: 'sideways' }));
    const sort = loadSortPref();
    expect(sort.field).toBe(DEFAULT_SORT.field);
    expect(sort.order).toBe(DEFAULT_SORT.order);
  });
});
