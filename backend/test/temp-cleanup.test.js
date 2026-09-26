// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 临时文件夹清理（FileService.cleanExpiredTempFiles）
 *
 * 这条链在真机上一直是坏的：删除的文件 5 分钟后要"移入系统回收站"，
 * 而 trash 包需要家目录（/home/niupic 不存在）→ 每次都 EACCES →
 * **文件永远留在 temp_backup，且每分钟重试、每分钟刷一条 ERROR**（单文件 8052 条）。
 *
 * 2.5.1 起：
 *   · 移入"平台回收站 / 素材库回收目录"（见 utils/recycle.js）
 *   · 挪不动时**只记一次**，把原因写进 meta，之后不再重试（日志不再刷屏）
 *   · 返回值与日志能说清"移走几个、还剩几个没挪走"
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let ready = true;
let FileService = null;
let dbPool = null;
try {
  FileService = require('../src/services/FileService');
  dbPool = require('../database/dbPool');
} catch {
  ready = false;
}
if (!ready) {
  test('跳过：依赖不齐（裸仓库）', { skip: '缺少依赖' }, () => {});
}

let tmpRoot = null;
const created = [];

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-cleanup-'));
});

after(() => {
  // dbPool 是单例：关掉它，测试进程才会退出（不然跑完还挂着，看起来像卡死）
  try { dbPool && dbPool.closeAll(); } catch { /* 忽略 */ }
  for (const db of created) {
    try { db.close(); } catch { /* 已关 */ }
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 造一个"删除后 10 分钟"的现场：
 *   <库>/ 目录里文件已经不在（删掉了）
 *   <库>/.niupic/temp_backup/x.jpg + x.jpg.meta.json（deletedAt 是 10 分钟前）
 */
function makeScene(name, { expired = true } = {}) {
  const library = path.join(tmpRoot, name);
  const backupDir = path.join(library, '.niupic', 'temp_backup');
  fs.mkdirSync(backupDir, { recursive: true });

  // 数据库（FileService._getDatabase 会经 dbPool 打开它）
  const LibraryDatabase = require('../database/db');
  const db = new LibraryDatabase(library);
  created.push(db);

  const file = path.join(backupDir, 'deleted.jpg');
  fs.writeFileSync(file, 'JPEG-BYTES');
  const meta = {
    originalPath: '2024/相册/deleted.jpg',
    deletedAt: Date.now() - (expired ? 10 * 60 * 1000 : 60 * 1000),
    type: 'file',
  };
  fs.writeFileSync(`${file}.meta.json`, JSON.stringify(meta, null, 2));

  // FileService 需要 (dbPool, configManager)
  const configManager = { load: () => ({ libraries: [{ id: 'lib-1', name: name, path: library }] }) };
  const service = new FileService(dbPool, configManager);

  return { library, backupDir, file, service };
}

test('过期文件被移进回收目录（不再需要家目录），meta 一起清掉', { skip: ready ? false : '依赖不齐' }, async () => {
  const { library, backupDir, file, service } = makeScene('scene-ok');

  const result = await service.cleanExpiredTempFiles('lib-1');

  assert.strictEqual(result.cleaned, 1, '应当移走 1 个');
  assert.strictEqual(result.recycleFailed, 0, '不该有挪不走的');
  assert.strictEqual(fs.existsSync(file), false, '原文件应当已经从 temp_backup 消失');
  assert.strictEqual(fs.existsSync(`${file}.meta.json`), false, 'meta 应当删掉');

  // 文件进了素材库自己的回收目录，内容原样还在
  const trashRoot = path.join(library, '.niupic', 'trash');
  const days = fs.readdirSync(trashRoot);
  assert.strictEqual(days.length, 1, `应当有一个日期目录：${days.join(',')}`);
  const moved = fs.readdirSync(path.join(trashRoot, days[0])).filter((f) => !f.endsWith('.trashinfo.json'));
  assert.deepStrictEqual(moved, ['deleted.jpg']);
  assert.strictEqual(fs.readFileSync(path.join(trashRoot, days[0], 'deleted.jpg'), 'utf8'), 'JPEG-BYTES');

  // 来源信息保留（日后做应用内回收站 / 手工恢复要靠它）
  const info = JSON.parse(fs.readFileSync(path.join(trashRoot, days[0], 'deleted.jpg.trashinfo.json'), 'utf8'));
  assert.strictEqual(info.originalPath, '2024/相册/deleted.jpg');

  // temp_backup 空了就该被删掉
  assert.strictEqual(fs.existsSync(backupDir), false, '空的 temp_backup 目录应当被清掉');
});

test('还没到期的不动（5 分钟内可撤销）', { skip: ready ? false : '依赖不齐' }, async () => {
  const { file, service } = makeScene('scene-fresh', { expired: false });
  const result = await service.cleanExpiredTempFiles('lib-1');

  assert.strictEqual(result.cleaned, 0);
  assert.strictEqual(fs.existsSync(file), true, '没到期的文件必须原地不动');
});

test('挪不动时只记一次、之后不再重试（这就是当年每分钟刷屏的那条）', { skip: ready ? false : '依赖不齐' }, async () => {
  const { library, file, service } = makeScene('scene-fail');

  // 让目标目录无法创建：把 .niupic/trash 先做成一个**文件**
  fs.mkdirSync(path.join(library, '.niupic'), { recursive: true });
  fs.writeFileSync(path.join(library, '.niupic', 'trash'), 'blocked');

  const first = await service.cleanExpiredTempFiles('lib-1');
  assert.strictEqual(first.cleaned, 0);
  assert.strictEqual(first.recycleFailed, 1, '挪不动要如实报数');
  assert.strictEqual(fs.existsSync(file), true, '挪不动时文件必须还在（不能悄悄删掉）');

  // meta 里记下了失败，第二轮直接跳过（不再每分钟重试、不再刷日志）
  const meta = JSON.parse(fs.readFileSync(`${file}.meta.json`, 'utf8'));
  assert.ok(meta.recycleFailedAt > 0, 'meta 里要记下失败时间');
  assert.ok(String(meta.recycleError).length > 0, '要记下失败原因');

  const second = await service.cleanExpiredTempFiles('lib-1');
  assert.strictEqual(second.recycleFailed, 1, '仍然算"没挪走"（这样界面/日志能报出来）');
  assert.strictEqual(second.cleaned, 0);
});

test('库里没有 temp_backup 时不动任何东西', { skip: ready ? false : '依赖不齐' }, async () => {
  const library = path.join(tmpRoot, 'scene-empty');
  fs.mkdirSync(library, { recursive: true });
  const LibraryDatabase = require('../database/db');
  created.push(new LibraryDatabase(library));
  const configManager = { load: () => ({ libraries: [{ id: 'lib-x', name: 'empty', path: library }] }) };
  const service = new FileService(dbPool, configManager);

  const result = await service.cleanExpiredTempFiles('lib-x');
  assert.deepStrictEqual(result, { cleaned: 0, failed: 0, thumbnailsCleaned: 0, recycleFailed: 0 });
});
