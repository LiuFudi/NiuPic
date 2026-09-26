// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 扫描统计要如实区分"跳过""入库（带占位图）""失败"（2.5.1 修的）
 *
 * 起因是真机上的一次核对：色图库磁盘 6279 个文件、库里只有 6269 行，少 10 个
 * （9 张 4K BMP + 1 张损坏 PNG）。日志里它们每次扫描都报错，而汇总行写着：
 *
 *   全量重扫完成: 0 更新 / 6279 跳过（没变过） / 0 清理 / 0 失败
 *
 * 因为重扫只区分 processed 和"其它一律 skipped"：`processImage` 返回的
 * `{status:'error'}` 被算进了"跳过（没变过）"。用户在界面上完全看不出有文件没进来。
 *
 * 2.5.1 起三种结果分开：
 *   · processed —— 入库（解不开的图也会入库，缩略图是占位图：文件不丢、用户看得见）
 *   · skipped   —— 文件没变过、缩略图也在（**跳过是对的**）
 *   · errors    —— 真失败（文件读不了、缩略图写不下去等），带文件名与原因的明细
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  /* 裸仓库跳过 */
}

const noSharp = sharp ? false : '没有 sharp（裸仓库没装依赖）';

const scanner = require('../utils/scanner');

let tmpRoot = null;
const openDbs = [];

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-scanstats-'));
});

after(() => {
  // 先关数据库再删目录：Windows 会锁住 metadata.db（unlink 时报 EBUSY），
  // 而 Linux 允许删掉正在使用的文件 —— 不显式关的话，这个 after 只会在 Windows 上炸。
  for (const db of openDbs) {
    try { db.close(); } catch { /* 已经关了 */ }
  }
  if (!tmpRoot) return;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // 还有句柄没放（比如某个用例里另开的连接）：留给系统清理临时目录，别让用例失败
  }
});

/** 造一个小库：N 张能解的 jpg + 1 个解不开的"假图" */
async function makeLibrary(name, goodCount = 3) {
  const library = path.join(tmpRoot, name);
  fs.mkdirSync(library, { recursive: true });

  const jpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 20, g: 120, b: 200 } } })
    .jpeg().toBuffer();
  for (let i = 0; i < goodCount; i += 1) {
    fs.writeFileSync(path.join(library, `good${i}.jpg`), jpeg);
  }
  // 后缀说是 PNG，内容是垃圾 —— sharp 必然报错（等价于真机上那张 libspng read error 的 49.png）
  fs.writeFileSync(path.join(library, 'broken.png'), '这不是 PNG，是一段文本');

  const LibraryDatabase = require('../database/db');
  const db = new LibraryDatabase(library);
  // 每个库都挂上"用完关掉"：LibraryDatabase 里有 WAL checkpoint 定时器，
  // 不 close 的话 node --test 会一直等事件循环 —— 表现是"测试卡住不动"，
  // 而不是报错（第一次写这份用例就踩了）。
  openDbs.push(db);
  return { library, db, goodCount };
}

test('解不开的图仍然入库（占位图），不会被当成"跳过"丢掉', { skip: noSharp }, async () => {
  const { library, db, goodCount } = await makeLibrary('lib-broken');

  const first = await scanner.rescanLibrary(library, db);
  assert.strictEqual(first.total, goodCount + 1, `一共 ${goodCount + 1} 个文件（含 1 个坏的）`);
  assert.strictEqual(first.processed, goodCount + 1, '坏的也要入库（缩略图是占位图），文件不能从库里消失');
  assert.strictEqual(first.skipped, 0, '首次扫描不该有"没变过"的');

  const rows = db.db.prepare('SELECT COUNT(*) c FROM images').get().c;
  assert.strictEqual(rows, goodCount + 1, '数据库里应当有全部文件');
  const broken = db.db.prepare('SELECT * FROM images WHERE path = ?').get('broken.png');
  assert.ok(broken, '坏文件也要有一行记录');
  assert.ok(broken.thumbnail_path, '坏文件要有缩略图（占位图）');

  // 第二遍：好的跳过，坏的继续"处理"（它的占位图在、没变过 → 也会跳过）
  const second = await scanner.rescanLibrary(library, db);
  assert.strictEqual(second.processed, 0);
  assert.strictEqual(second.skipped, goodCount + 1);
  assert.strictEqual(second.errors, 0);
});

// chmod 在 Windows 上不改变写权限，造不出"写不进去的目录"；Linux/fnOS 上会真正执行
const NO_READONLY_DIR = process.platform === 'win32'
  ? 'Windows 上 chmod 不改变写权限，无法构造"写不出缩略图"的场景'
  : false;

test('真失败（写不了缩略图）要算 errors，不能混进 skipped', { skip: noSharp || NO_READONLY_DIR }, async () => {
  const { library, db, goodCount } = await makeLibrary('lib-ioerr');

  // 先正常扫一遍，让数据库里有记录
  await scanner.rescanLibrary(library, db);

  // 把缩略图目录设成只读，再放一个新文件进去 —— 它必然写不出缩略图
  const thumbDir = path.join(library, '.niupic', 'thumbnails');
  fs.chmodSync(thumbDir, 0o555);
  try {
    const jpeg = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg().toBuffer();
    fs.writeFileSync(path.join(library, 'new-one.jpg'), jpeg);

    const stats = await scanner.rescanLibrary(library, db);
    assert.strictEqual(stats.total, goodCount + 2, '总数要包含新文件');
    assert.strictEqual(stats.errors, 1, '写不出缩略图的那个必须算失败');
    assert.strictEqual(stats.skipped, goodCount + 1, '其它文件照旧跳过（坏的也算它跳过）');
    assert.strictEqual(stats.failed.length, 1, '失败要有明细');
    assert.ok(stats.failed[0].path.includes('new-one.jpg'), JSON.stringify(stats.failed));
    assert.ok(stats.failed[0].error.length > 0, '失败原因不能是空的');
  } finally {
    fs.chmodSync(thumbDir, 0o755);
  }
});

test('删掉缩略图后会被补回来（跳过的前提是缩略图真的在）', { skip: noSharp }, async () => {
  const { library, db, goodCount } = await makeLibrary('lib-thumb');
  const total = goodCount + 1;   // 好图 + 那张解不开的（也会入库，占位图）

  const first = await scanner.rescanLibrary(library, db);
  assert.strictEqual(first.processed, total);

  // 删掉一张缩略图
  const row = db.db.prepare('SELECT path, thumbnail_path FROM images LIMIT 1').get();
  const thumbFull = path.join(library, row.thumbnail_path);
  assert.ok(fs.existsSync(thumbFull), '缩略图应当存在');
  fs.unlinkSync(thumbFull);

  const second = await scanner.rescanLibrary(library, db);
  assert.strictEqual(second.skipped, total - 1, '只有缩略图还在的才算跳过');
  assert.strictEqual(second.processed, 1, '缩略图丢了的那张要重新处理');
  assert.ok(fs.existsSync(thumbFull), '缩略图要被补回来');
});

test('文件变了要被发现（大小或修改时间任一变化）', { skip: noSharp }, async () => {
  const { library, db, goodCount } = await makeLibrary('lib-change');

  await scanner.rescanLibrary(library, db);

  const target = path.join(library, 'good0.jpg');
  const st = fs.statSync(target);
  fs.utimesSync(target, new Date(), new Date(st.mtimeMs + 120000));   // 只动修改时间

  const second = await scanner.rescanLibrary(library, db);
  assert.strictEqual(second.processed, 1, '修改时间变了就要重新处理');
  assert.strictEqual(second.skipped, goodCount, '其余好图跳过（坏图这轮也在 processed 里）');
});

test('返回的统计字段齐全（界面要靠它说明白"跳过"和"失败"）', { skip: noSharp }, async () => {
  const { library, db } = await makeLibrary('lib-fields');
  const stats = await scanner.rescanLibrary(library, db);

  for (const key of ['total', 'processed', 'skipped', 'errors', 'removed']) {
    assert.strictEqual(typeof stats[key], 'number', `stats.${key} 应当是数字`);
  }
  assert.ok(Array.isArray(stats.failed), 'stats.failed 应当是数组');
});
