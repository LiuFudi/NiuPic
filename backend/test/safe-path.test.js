// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full license text.
//
// 库内安全路径的回归用例。
//
// 为什么必须要这组用例：2026-09 上架自查时实测发现
//   GET /api/image/original/<库id>/../../../../etc/passwd  → 200，读到系统文件
//   GET /api/image/original/<库id>/../../@appdata/niupic/config.json → 泄露 jwtSecret
// 而且那两个路由当时免鉴权。这类问题只要有人"顺手简化"一次就会回来。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveInside, assertInside, PathEscapeError } = require('../src/utils/safePath');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-safepath-'));
const LIB = path.join(tmp, 'lib');
fs.mkdirSync(path.join(LIB, 'album', '2024'), { recursive: true });
fs.writeFileSync(path.join(LIB, 'album', '2024', 'a.jpg'), 'x');
fs.writeFileSync(path.join(tmp, 'outside.txt'), 'secret');

// 建一个"库内软链指向库外"的陷阱。Windows 上创建符号链接需要管理员或"开发者模式"
// （普通账户直接 EPERM），所以这里退化成"跳过那一条用例"，而不是让整个文件加载失败。
let canSymlink = true;
try {
  fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(LIB, 'link.txt'));
} catch {
  canSymlink = false;
}
const NO_SYMLINK = canSymlink
  ? false
  : 'Windows 上创建符号链接需要管理员或开发者模式（EPERM）；在 Linux/fnOS 上会真正执行';

test('正常路径：库内相对路径能拼出来', () => {
  assert.strictEqual(resolveInside(LIB, 'album/2024/a.jpg'), path.join(LIB, 'album/2024/a.jpg'));
  assert.strictEqual(resolveInside(LIB, './album'), path.join(LIB, 'album'));
  assert.strictEqual(resolveInside(LIB, ''), path.resolve(LIB));
});

test('中文与空格路径正常', () => {
  fs.mkdirSync(path.join(LIB, '我的 相册'), { recursive: true });
  assert.ok(resolveInside(LIB, '我的 相册').endsWith('我的 相册'));
});

test('拒绝 .. 逃逸（各种写法）', () => {
  for (const bad of ['../outside.txt', '../../etc/passwd', 'album/../../outside.txt',
    '..\\..\\outside.txt', '....//....//outside.txt', 'album/2024/../../../outside.txt']) {
    assert.throws(() => resolveInside(LIB, bad), PathEscapeError, `应拒绝: ${bad}`);
  }
});

test('拒绝绝对路径与盘符', () => {
  for (const bad of ['/etc/passwd', '/', 'C:\\Windows\\system.ini', 'D:/x']) {
    assert.throws(() => resolveInside(LIB, bad), PathEscapeError, `应拒绝: ${bad}`);
  }
});

test('拒绝 NUL 字节（截断攻击）', () => {
  assert.throws(() => resolveInside(LIB, 'album/a.jpg\0.png'), PathEscapeError);
});

test('同前缀的兄弟目录不能蒙混过关（/lib 与 /lib2）', () => {
  const lib2 = path.join(tmp, 'lib2');
  fs.mkdirSync(lib2, { recursive: true });
  assert.throws(() => resolveInside(LIB, '../lib2'), PathEscapeError);
});

test('符号链接不能当跳板（库内软链指向库外）', { skip: NO_SYMLINK }, () => {
  assert.throws(() => resolveInside(LIB, 'link.txt'), PathEscapeError);
});

test('assertInside：已存在的绝对路径也要判在库内', () => {
  assert.strictEqual(assertInside(LIB, path.join(LIB, 'album')), path.join(LIB, 'album'));
  assert.throws(() => assertInside(LIB, path.join(tmp, 'outside.txt')), PathEscapeError);
});

test('不存在的路径也允许（新建文件夹/上传要用）', () => {
  assert.strictEqual(resolveInside(LIB, 'album/new-folder'), path.join(LIB, 'album/new-folder'));
  assert.throws(() => resolveInside(LIB, '../new-folder'), PathEscapeError);
});
