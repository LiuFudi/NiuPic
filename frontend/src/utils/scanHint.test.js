// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 扫描结果提示（utils/scanHint.js）
 *
 * 这一句话是用户唯一能看到的"扫描到底干了什么"。真机上的教训是：
 * 色图库 10 个文件没入库，界面却说"跳过 6279（没变过）、0 失败" ——
 * 把"跳过（没变过）"和"处理失败"混在了一起说。
 */

import { describe, it, expect } from 'vitest';
import { scanHint } from './scanHint';

describe('scanHint', () => {
  it('没有任何结果时不显示', () => {
    expect(scanHint(null, null)).toBeNull();
  });

  it('扫描直接失败时如实说失败', () => {
    const hint = scanHint(null, '磁盘满了');
    expect(hint.tone).toBe('error');
    expect(hint.text).toContain('磁盘满了');
  });

  it('不是当前素材库的结果不显示（切库后不串台）', () => {
    expect(scanHint({ libraryId: 'A', total: 5 }, null, 'B')).toBeNull();
    expect(scanHint({ libraryId: 'A', total: 5 }, null, 'A')).not.toBeNull();
  });

  it('一个文件都没找到时给排查方向（权限/路径）', () => {
    const hint = scanHint({ libraryId: 'A', total: 0 }, null, 'A');
    expect(hint.tone).toBe('error');
    expect(hint.text).toContain('一个文件都没找到');
    expect(hint.text).toContain('权限');
  });

  it('跳过与处理分开说：跳过的说"未改动"，不冒充失败', () => {
    const hint = scanHint({ libraryId: 'A', total: 15249, processed: 0, skipped: 15239, errors: 0 }, null, 'A');
    expect(hint.tone).toBe('ok');
    expect(hint.text).toContain('找到 15249 个文件');
    expect(hint.text).toContain('跳过 15239 个未改动');
    expect(hint.text).not.toContain('失败');
  });

  it('有失败时：计数写出来、语气变红、并给出文件名', () => {
    const hint = scanHint({
      libraryId: 'A',
      total: 6279,
      processed: 0,
      skipped: 6269,
      errors: 10,
      failed: [
        { path: 'x/aerith1-4k.bmp', error: 'Input buffer contains unsupported image format' },
        { path: 'y/49.png', error: 'pngload_buffer: libspng read error' },
      ],
    }, null, 'A');

    expect(hint.tone).toBe('error');
    expect(hint.text).toContain('10 个处理失败');
    expect(hint.title).toContain('aerith1-4k.bmp');
    expect(hint.title).toContain('libspng read error');
    expect(hint.title).toContain('这些文件不在库里');
  });

  it('失败明细超过 8 条时提示"另有 N 个"，不把提示撑爆', () => {
    const failed = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.png`, error: 'x' }));
    const hint = scanHint({ libraryId: 'A', total: 100, errors: 20, failed }, null, 'A');
    expect(hint.title).toContain('另有 12 个');
  });

  it('没有失败明细时不给悬停内容（不给用户空的 tooltip）', () => {
    const hint = scanHint({ libraryId: 'A', total: 10, processed: 10, errors: 0 }, null, 'A');
    expect(hint.title).toBeUndefined();
  });

  it('只有总数也能正常显示', () => {
    const hint = scanHint({ libraryId: 'A', total: 5 }, null, 'A');
    expect(hint.text).toContain('找到 5 个文件');
    expect(hint.tone).toBe('ok');
  });

  it('新增/删除这类统计也会写进提示（增量同步用）', () => {
    const hint = scanHint({ libraryId: 'A', total: 100, added: 3, deleted: 1 }, null, 'A');
    expect(hint.text).toContain('处理 3');
  });
});
