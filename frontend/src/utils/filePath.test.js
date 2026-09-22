// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 文件路径的写法与复制
 *
 * 用户报的问题：界面上显示的路径是 `\vol1\1000\Photos-Backup\Camera\…`（反斜杠）。
 * 原因是代码按**浏览器所在系统**决定分隔符 —— 用户用 Windows 打开网页，
 * 就把飞牛（Linux）上的真实路径显示成了 Windows 写法，复制出来根本用不了。
 *
 * 现在的规矩：界面一律 Linux 写法；Windows 写法由单独的复制按钮提供。
 */

import { describe, it, expect } from 'vitest';
import { toLinuxPath, toWindowsPath, stripTrailingSlash, joinLibraryPath } from './filePath.js';

describe('toLinuxPath / toWindowsPath', () => {
  it('统一成正斜杠 / 反斜杠', () => {
    expect(toLinuxPath('\\vol1\\1000\\Photos-Backup\\Camera\\a.jpg')).toBe('/vol1/1000/Photos-Backup/Camera/a.jpg');
    expect(toWindowsPath('/vol1/1000/Photos-Backup/Camera/a.jpg')).toBe('\\vol1\\1000\\Photos-Backup\\Camera\\a.jpg');
  });

  it('混着写的也能归一', () => {
    expect(toLinuxPath('/vol1\\1000/Photos-Backup\\Camera//a.jpg')).toBe('/vol1/1000/Photos-Backup/Camera/a.jpg');
    expect(toWindowsPath('/vol1\\1000/Photos-Backup')).toBe('\\vol1\\1000\\Photos-Backup');
  });

  it('空值给空串，不会变成 "undefined"', () => {
    expect(toLinuxPath(null)).toBe('');
    expect(toLinuxPath(undefined)).toBe('');
    expect(toLinuxPath('')).toBe('');
    expect(toWindowsPath('')).toBe('');
  });

  it('中文、空格、圆括号都不动', () => {
    const p = '/vol1/1000/Photos-Backup/Camera/照片 01 (1).JPG';
    expect(toLinuxPath(p)).toBe(p);
    expect(toWindowsPath(p)).toBe('\\vol1\\1000\\Photos-Backup\\Camera\\照片 01 (1).JPG');
  });
});

describe('joinLibraryPath', () => {
  it('库路径 + 相对路径 = 完整 Linux 路径', () => {
    expect(joinLibraryPath('/vol1/1000/Photos-Backup/Camera', 'S5M2X/1.1/PANA0047.MOV'))
      .toBe('/vol1/1000/Photos-Backup/Camera/S5M2X/1.1/PANA0047.MOV');
  });

  it('两边的斜杠怎么写都不会出双斜杠', () => {
    expect(joinLibraryPath('/vol1/1000/Photos-Backup/Camera/', '/S5M2X/1.1/a.jpg'))
      .toBe('/vol1/1000/Photos-Backup/Camera/S5M2X/1.1/a.jpg');
    expect(joinLibraryPath('\\vol1\\1000\\Photos-Backup\\Camera\\', '\\S5M2X\\a.jpg'))
      .toBe('/vol1/1000/Photos-Backup/Camera/S5M2X/a.jpg');
  });

  it('缺一半就把另一半原样给出（不拼出怪路径）', () => {
    expect(joinLibraryPath('', 'a/b.jpg')).toBe('a/b.jpg');
    expect(joinLibraryPath('/vol1/lib', '')).toBe('/vol1/lib');
    expect(joinLibraryPath(null, null)).toBe('');
  });
});

describe('stripTrailingSlash', () => {
  it('去掉末尾斜杠（多个也去）', () => {
    expect(stripTrailingSlash('/vol1/1000/')).toBe('/vol1/1000');
    expect(stripTrailingSlash('/vol1/1000///')).toBe('/vol1/1000');
    expect(stripTrailingSlash('/vol1/1000')).toBe('/vol1/1000');
  });
});
