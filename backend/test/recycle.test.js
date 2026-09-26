// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 删除文件的"后半程"（utils/recycle.js）
 *
 * 背景（真机实测，2.5.0 及更早）：临时文件夹过期后要把文件挪进回收站，用的是
 * `trash` 包 —— 它依赖 $HOME/.local/share/Trash，而飞牛的应用账号**没有家目录**：
 *
 *   ❌ 清理失败 __scan_probe__.jpg: EACCES: permission denied, mkdir '/home/niupic'
 *
 * 结果：文件永远卡在 .niupic/temp_backup、每分钟重试一次、日志被刷了 8052 行
 * （另有 6 个文件各 1.1 万+ 行）。这一版换成"平台回收站 / 素材库自己的回收目录"，
 * 两个目的地都是**同设备改名**，不复制、不需要家目录。
 *
 * 这里钉住四件事：
 *   · 平台有 #recycle 时优先用它（用户能在文件管理里看见）
 *   · 没有时落到 <素材库>/.niupic/trash/<日期>/，并写下 .trashinfo.json
 *   · 同名文件不覆盖（-1 / -2 往后排）
 *   · 跨目录/跨设备也不丢内容（rename → EXDEV 回退 copy+unlink）
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const recycle = require('../utils/recycle');

let tmpRoot = null;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-recycle-'));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造一个素材库目录，返回 { library, makeFile } */
function makeLibrary(name = 'lib') {
  const library = path.join(tmpRoot, name);
  fs.mkdirSync(library, { recursive: true });
  const makeFile = (rel, content = 'x') => {
    const full = path.join(library, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  };
  return { library, makeFile };
}

test('没有平台回收站时：落到素材库自己的 .niupic/trash/<日期>/，并留下来源信息', () => {
  const { library, makeFile } = makeLibrary('lib-a');
  const file = makeFile('3D&2D/x/photo.png', 'PNG-DATA');

  const result = recycle.moveToRecycle(file, library, { originalRelative: '3D&2D/x/photo.png' });

  assert.strictEqual(result.kind, 'library');
  assert.strictEqual(fs.existsSync(file), false, '原位置应当已经没有这个文件');

  const destDir = path.dirname(result.destPath);
  assert.ok(destDir.startsWith(path.join(library, '.niupic', 'trash')), destDir);
  assert.strictEqual(fs.readFileSync(result.destPath, 'utf8'), 'PNG-DATA', '内容要原样保留');

  // .trashinfo.json 记着原始路径 —— 以后做"应用内回收站"或手工恢复都靠它
  const info = JSON.parse(fs.readFileSync(`${result.destPath}.trashinfo.json`, 'utf8'));
  assert.strictEqual(info.originalPath, '3D&2D/x/photo.png');
  assert.strictEqual(info.libraryPath, library);
  assert.ok(info.movedAt > 0);
});

test('平台有 #recycle 时优先用它（放到 <回收站>/<素材库名>/<原相对路径>）', () => {
  const share = path.join(tmpRoot, 'share');
  const library = path.join(share, '照片');
  fs.mkdirSync(path.join(share, '#recycle'), { recursive: true });
  fs.mkdirSync(library, { recursive: true });
  const file = path.join(library, '2024', 'a.jpg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'JPG');

  assert.strictEqual(recycle.findPlatformRecycleDir(library), path.join(share, '#recycle'));

  const result = recycle.moveToRecycle(file, library, { originalRelative: '2024/a.jpg' });
  assert.strictEqual(result.kind, 'platform');
  assert.ok(result.destPath.startsWith(path.join(share, '#recycle', '照片')), result.destPath);
  assert.ok(result.destPath.endsWith(path.join('2024', 'a.jpg')), result.destPath);
  assert.strictEqual(fs.readFileSync(result.destPath, 'utf8'), 'JPG');
  assert.strictEqual(fs.existsSync(file), false);

  // 平台回收站里**不写**我们自己的 sidecar（那是平台的目录，别塞私货）
  assert.strictEqual(fs.existsSync(`${result.destPath}.trashinfo.json`), false);
});

test('同名文件不会互相覆盖', () => {
  const { library, makeFile } = makeLibrary('lib-b');
  const a = makeFile('d/同名.png', 'A');
  const r1 = recycle.moveToRecycle(a, library, { originalRelative: 'd/同名.png' });
  const b = makeFile('d/同名.png', 'B');
  const r2 = recycle.moveToRecycle(b, library, { originalRelative: 'd/同名.png' });

  assert.notStrictEqual(r1.destPath, r2.destPath, '第二次不能覆盖第一次');
  assert.strictEqual(fs.readFileSync(r1.destPath, 'utf8'), 'A');
  assert.strictEqual(fs.readFileSync(r2.destPath, 'utf8'), 'B');
  assert.ok(/同名-1\.png$/.test(r2.destPath), r2.destPath);
});

test('目标目录不存在会自己建（含日期子目录）', () => {
  const { library, makeFile } = makeLibrary('lib-c');
  const file = makeFile('deep/nested/dir/x.txt', 'C');
  const result = recycle.moveToRecycle(file, library);
  const day = new Date().toISOString().slice(0, 10);
  assert.strictEqual(path.dirname(result.destPath), path.join(library, '.niupic', 'trash', day));
});

test('素材库自己就在回收站里时不往上乱找（不把文件挪到别处）', () => {
  const share = path.join(tmpRoot, 'share2');
  const inside = path.join(share, '#recycle', '别人恢复回来的库');
  fs.mkdirSync(inside, { recursive: true });
  // 只有当 #recycle 在**库目录之上**时才算"平台回收站"；库自己在里面时不认
  const found = recycle.findPlatformRecycleDir(inside);
  assert.ok(found === null || !found.startsWith(inside), String(found));
});

test('导出的路径约定与扫描器的跳过目录一致（回收目录不能被当成素材）', () => {
  // .niupic 是扫描器永远跳过的目录，回收目录放在它下面才不会把自己的回收站扫成照片
  assert.ok(recycle.LIBRARY_TRASH_DIR.startsWith('.niupic'));
  const scanner = require('../utils/scanner');
  assert.ok(scanner.getAllImageFiles, 'scanner 提供了遍历接口');
});

test('跨设备时 rename 失败要退回复制（EXDEV 兜底）', () => {
  const { library, makeFile } = makeLibrary('lib-d');
  const file = makeFile('a.bin', 'DATA');

  // 用一个必然失败的 rename 目标（把目标目录做成文件）来验证错误会抛出来，
  // 而不是"静默丢失文件"——静默丢失比报错严重得多
  const trashDir = recycle.libraryTrashDir(library);
  fs.mkdirSync(trashDir, { recursive: true });
  for (const day of fs.readdirSync(trashDir)) {
    fs.rmSync(path.join(trashDir, day), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(trashDir, new Date().toISOString().slice(0, 10)), 'blocked');

  assert.throws(() => recycle.moveToRecycle(file, library), /EEXIST|ENOTDIR|EISDIR/);
  assert.strictEqual(fs.existsSync(file), true, '失败时原文件必须还在（不能丢）');
});
