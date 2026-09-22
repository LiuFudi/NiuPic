// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 图片 upsert 必须保住用户数据
 *
 * 背景：入库用的是 `INSERT OR REPLACE INTO images (...)`，而 `path` 是 UNIQUE。
 * SQLite 的 REPLACE 语义是「撞了就删掉旧行再插新行」，于是没列进 INSERT 的列
 * （rating / favorite / tags）全部回到默认值 ——
 * 表现就是「重新扫一次库，用户打的星标和收藏全没了」。
 *
 * 全量重扫、图片被编辑后重扫、移动/复制文件都会走到这条路径，所以必须钉死。
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// better-sqlite3 是原生模块，没装依赖的裸仓库里跑不了。
// 这里做降级：依赖不在就跳过（并说明原因），而不是把整个测试套件跑挂。
let LibraryDatabase = null;
let loadError = null;
try {
  LibraryDatabase = require('../database/db.js');
} catch (error) {
  loadError = error;
}

if (!LibraryDatabase) {
  console.log(`  ⚠️  跳过 upsert 测试：加载 better-sqlite3 失败（${loadError.message.split('\n')[0]}）`);
  console.log('     装上依赖后即可运行：cd backend && npm install');
}

/** 依赖缺失时整组跳过 */
const dbTest = LibraryDatabase ? test : test.skip;

let libraryDir;
let db;

/** 造一条最小可用的图片记录 */
const record = (overrides = {}) => ({
  path: 'sub/photo.jpg',
  filename: 'photo.jpg',
  folder: 'sub',
  size: 1024,
  width: 1920,
  height: 1080,
  format: 'jpeg',
  file_type: 'image',
  created_at: 1700000000000,
  modified_at: 1700000000000,
  file_hash: 'hash-v1',
  thumbnail_path: 'thumbnails/ab/hash-v1.webp',
  thumbnail_size: 1234,
  ...overrides
});

before(() => {
  if (!LibraryDatabase) return;
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-upsert-'));
  db = new LibraryDatabase(libraryDir);
});

after(() => {
  try {
    if (db && db.walCheckpointInterval) clearInterval(db.walCheckpointInterval);
    if (db && db.db) db.db.close();
  } catch { /* ignore */ }
  if (libraryDir) fs.rmSync(libraryDir, { recursive: true, force: true });
});

dbTest('第一次写入会落库', () => {
  db.insertImage(record());
  const row = db.getImageByPath('sub/photo.jpg');
  assert.ok(row, '应该插进去了');
  assert.strictEqual(row.width, 1920);
  assert.strictEqual(row.rating, 0);
  assert.strictEqual(row.favorite, 0);
});

dbTest('用户打了分、收藏、打了标签', () => {
  db.db.prepare('UPDATE images SET rating = ?, favorite = ?, tags = ? WHERE path = ?')
    .run(5, 1, '风景,夜景', 'sub/photo.jpg');

  const row = db.getImageByPath('sub/photo.jpg');
  assert.strictEqual(row.rating, 5);
  assert.strictEqual(row.favorite, 1);
  assert.strictEqual(row.tags, '风景,夜景');
});

dbTest('**重新入库同一张图（= 重扫）后，评分/收藏/标签必须还在**', () => {
  const before = db.getImageByPath('sub/photo.jpg');

  // 模拟重新扫描：同一个 path，元数据有更新
  db.insertImage(record({ size: 2048, width: 3840, height: 2160, file_hash: 'hash-v2' }));

  const after = db.getImageByPath('sub/photo.jpg');

  // 用户数据一个都不能少 —— 这就是这次的回归点
  assert.strictEqual(after.rating, 5, '评分被清掉了（INSERT OR REPLACE 的老毛病）');
  assert.strictEqual(after.favorite, 1, '收藏被清掉了');
  assert.strictEqual(after.tags, '风景,夜景', '标签被清掉了');

  // 元数据要更新成新的
  assert.strictEqual(after.size, 2048, '文件大小没更新');
  assert.strictEqual(after.width, 3840, '宽度没更新');
  assert.strictEqual(after.height, 2160, '高度没更新');
  assert.strictEqual(after.file_hash, 'hash-v2', '哈希没更新');

  // id 不能变（随机排序的种子、前端 key 都依赖它稳定）
  assert.strictEqual(after.id, before.id, 'id 变了，说明走的还是删旧行插新行');
});

dbTest('重扫不会覆盖「添加时间」（否则按添加时间排序会乱）', () => {
  const before = db.getImageByPath('sub/photo.jpg');
  const indexedAt = before.indexed_at;

  db.insertImage(record({ size: 4096, file_hash: 'hash-v3' }));

  const after = db.getImageByPath('sub/photo.jpg');
  assert.strictEqual(after.indexed_at, indexedAt, 'indexed_at 被刷新了');
  assert.strictEqual(after.size, 4096, '其它字段照常更新');
});

dbTest('重扫之后评分排序还能用', () => {
  db.insertImage(record({ path: 'sub/other.jpg', filename: 'other.jpg' }));
  db.db.prepare('UPDATE images SET rating = ? WHERE path = ?').run(2, 'sub/other.jpg');

  const rated = db.db.prepare('SELECT path, rating FROM images ORDER BY rating DESC, id ASC').all();
  assert.strictEqual(rated[0].path, 'sub/photo.jpg');
  assert.strictEqual(rated[0].rating, 5);
});

dbTest('文件大小写 / 路径写法不同就是两条记录（不误伤）', () => {
  db.insertImage(record({ path: 'sub/Photo.jpg', filename: 'Photo.jpg' }));
  const rows = db.db.prepare('SELECT path FROM images WHERE folder = ? ORDER BY path').all('sub');
  assert.strictEqual(rows.length, 3);
});
