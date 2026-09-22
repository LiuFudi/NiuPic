// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 重扫相关的两个修复
 *
 * 1. 全量重扫跳过"没变过"的文件
 *    用户报：相机库 15000 多张在机械硬盘上，全量重扫要 30 分钟以上。
 *    原来对每个文件都 processImage(force) —— 重读元数据 + 重画缩略图，
 *    而其中绝大多数根本没变。现在先比"大小+修改时间"的哈希，没变且缩略图在就跳过。
 *    （缩略图缺了仍然会补生成 —— 用户库里那批 404 的封面就是这么补回来的。）
 *
 * 2. fixFolderPaths：只按数据库重建文件夹结构与计数（不读磁盘）
 *    文件夹显示 0 张时不用重扫整个库，数据库里 images.folder 已经写清楚了。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let LibraryDatabase = null;
let sharp = null;
let scanner = null;
try {
  LibraryDatabase = require('../database/db.js');
  sharp = require('sharp');
  scanner = require('../utils/scanner.js');
} catch {
  /* 裸仓库没装依赖，下面的用例 skip */
}

const ready = Boolean(LibraryDatabase && sharp && scanner);

async function makeLibrary(count = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-rescan-'));
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const buf = await sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 30, g: 90, b: 160 } }
  }).jpeg().toBuffer();

  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, i < count - 1 ? `p-${i}.jpg` : 'sub/s.jpg'), buf);
  }
  return dir;
}

test('全量重扫：没变过的文件全部跳过（不再逐张重画缩略图）', async (t) => {
  if (!ready) { t.skip('没装 better-sqlite3 / sharp'); return; }
  const dir = await makeLibrary(4);
  const db = new LibraryDatabase(dir);
  try {
    const first = await scanner.scanLibrary(dir, db, null, null);
    assert.strictEqual(first.total, 4, '首次扫描应该找到 4 个文件');
    assert.strictEqual(first.processed, 4, '首次扫描应该处理 4 个（生成缩略图）');

    const t0 = Date.now();
    const second = await scanner.rescanLibrary(dir, db, null, null);
    const cost = Date.now() - t0;

    assert.strictEqual(second.total, 4, '重扫仍然看到 4 个文件');
    assert.strictEqual(second.skipped, 4, '**4 个都没变 → 全部跳过**');
    assert.strictEqual(second.processed, 0, '没有文件需要重新处理');
    assert.ok(cost < 2000, `跳过逻辑应该很快（实测 ${cost}ms）`);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('全量重扫：文件变了就重新处理', async (t) => {
  if (!ready) { t.skip('没装 better-sqlite3 / sharp'); return; }
  const dir = await makeLibrary(3);
  const db = new LibraryDatabase(dir);
  try {
    await scanner.scanLibrary(dir, db, null, null);

    // 改一张图（大小/修改时间都会变）
    const big = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 40, b: 40 } }
    }).jpeg({ quality: 95 }).toBuffer();
    fs.writeFileSync(path.join(dir, 'p-0.jpg'), big);

    const res = await scanner.rescanLibrary(dir, db, null, null);
    assert.strictEqual(res.processed, 1, '只有改动的那一张被重新处理');
    assert.strictEqual(res.skipped, 2, '另外两张跳过');

    const row = db.getImageByPath('p-0.jpg');
    assert.strictEqual(row.width, 400, '改动的文件元数据被更新了');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('全量重扫：缩略图丢了要补回来（哪怕文件没变）', async (t) => {
  if (!ready) { t.skip('没装 better-sqlite3 / sharp'); return; }
  const dir = await makeLibrary(3);
  const db = new LibraryDatabase(dir);
  try {
    await scanner.scanLibrary(dir, db, null, null);

    // 删掉一张的缩略图，模拟"封面 404"
    const row = db.getImageByPath('p-0.jpg');
    const thumb = path.join(dir, row.thumbnail_path);
    assert.ok(fs.existsSync(thumb), '缩略图本来存在');
    fs.unlinkSync(thumb);

    const res = await scanner.rescanLibrary(dir, db, null, null);
    assert.strictEqual(res.processed, 1, '**少了缩略图的那一张会被重新处理**');
    assert.ok(fs.existsSync(thumb), '缩略图补回来了');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fixFolderPaths：只按数据库重建文件夹和计数（不读磁盘）', async (t) => {
  if (!ready) { t.skip('没装 better-sqlite3 / sharp'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-fixfolders-'));
  const db = new LibraryDatabase(dir);
  try {
    for (const [p, folder] of [
      ['a/b/c/x.jpg', 'a/b/c'],
      ['a/b/c/y.jpg', 'a/b/c'],
      ['a/m.jpg', 'a'],
      ['top.jpg', ''],
    ]) {
      db.insertImage({
        path: p, filename: path.basename(p), folder, size: 100,
        width: 10, height: 10, format: 'jpg', file_type: 'image',
      });
    }

    const res = await scanner.fixFolderPaths(dir, db);
    assert.strictEqual(res.folders, 3, '从 images.folder 推出 3 个文件夹');
    assert.strictEqual(res.images, 4);

    const counts = Object.fromEntries(db.getAllFolders().map((f) => [f.path, f.image_count]));
    assert.strictEqual(counts.a, 3, 'a 含子文件夹共 3 张');
    assert.strictEqual(counts['a/b'], 2);
    assert.strictEqual(counts['a/b/c'], 2);
    assert.strictEqual(counts[''], undefined, '空 folder（库根目录的图片）不该建出一个空路径文件夹');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fixFolderPaths：把"计数为 0"的旧数据修回来', async (t) => {
  if (!ready) { t.skip('没装 better-sqlite3 / sharp'); return; }
  const dir = await makeLibrary(4);
  const db = new LibraryDatabase(dir);
  try {
    await scanner.scanLibrary(dir, db, null, null);

    // 模拟用户遇到的情况：文件夹行还在，但计数被重置成 0
    db.db.prepare('UPDATE folders SET image_count = 0').run();
    assert.ok(db.getAllFolders().every((f) => f.image_count === 0), '先做成一片 0');

    await scanner.fixFolderPaths(dir, db);
    const withImages = db.getAllFolders().filter((f) => f.image_count > 0);
    assert.ok(withImages.length > 0, '**修完之后有文件夹的计数不再是 0**');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
