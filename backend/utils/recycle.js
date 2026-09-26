// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
//
// 删除文件的"后半程"：临时文件夹（5 分钟可撤销）过期之后，把文件挪到哪儿去。
//
// 为什么不再用 trash 这个包（2.5.1 改的）：
//   trash 走 freedesktop 规范，先找 $XDG_DATA_HOME/Trash（默认 ~/.local/share/Trash）。
//   飞牛的应用账号**没有家目录**（真机实测：/home/niupic 不存在，应用也建不了），
//   于是它去 mkdir /home/niupic 被拒 —— 每一次都失败，日志里每分钟一条 ERROR，
//   文件永远卡在素材库的 .niupic/temp_backup 里。实测证据（2.5.0 的机器上）：
//     ❌ 清理失败 __scan_probe__.jpg: EACCES: permission denied, mkdir '/home/niupic'
//     累计 8052 条；另有 6 个文件各 1.1 万+ 条
//   就算硬把 HOME 指到可写目录，跨设备时 trash 会**复制**文件（删一个 100GB 的目录
//   就得往系统盘拷 100GB），对 NAS 应用是更糟的坑。
//
// 现在的做法（两种目的地，都是**同设备改名**，不复制、不占额外空间）：
//   ① 平台的回收站：从素材库往上找 `#recycle`（群晖/威联通/飞牛这类 NAS 的惯例名）。
//      有就放进去 —— 用户能在「文件管理」里看见、自己恢复。本机当前没有（未启用）。
//   ② 素材库自己的回收目录：`<素材库>/.niupic/trash/<日期>/`，旁边放一份
//      `.trashinfo.json` 记着原始路径，方便日后做"应用内回收站"或手工恢复。
//
// 两条路都不动用户的文件内容，也不会有"自动清理"这种悄悄删数据的动作。

'use strict';

const fs = require('fs');
const path = require('path');

/** NAS 平台回收站的惯例目录名（放在共享文件夹根上一级或同级） */
const PLATFORM_RECYCLE_NAMES = ['#recycle'];

/** 素材库自己的回收目录（相对素材库根） */
const LIBRARY_TRASH_DIR = path.join('.niupic', 'trash');

/**
 * 从素材库目录往上找平台的回收站目录。
 *
 * 只往上找到挂载点为止（`path.dirname` 到头即停），避免跑到别的卷上去；
 * 素材库自己就在回收站里时直接返回 null（那种情况不该再往里塞）。
 *
 * @returns {string|null} 回收站目录的绝对路径
 */
function findPlatformRecycleDir(libraryPath) {
  let dir = path.resolve(libraryPath);
  const start = dir;
  let guard = 0;

  while (guard < 32) {
    guard += 1;
    const parent = path.dirname(dir);
    if (parent === dir) break;                      // 到根了

    for (const name of PLATFORM_RECYCLE_NAMES) {
      const candidate = path.join(parent, name);
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch { /* 不存在就继续往上 */ }
    }

    // 已经到挂载点（父目录与子目录的设备号不同）就停
    try {
      if (fs.statSync(parent).dev !== fs.statSync(start).dev) break;
    } catch { /* 读不到就继续 */ }

    dir = parent;
  }

  return null;
}

/** 素材库自己的回收目录（绝对路径） */
function libraryTrashDir(libraryPath) {
  return path.join(libraryPath, LIBRARY_TRASH_DIR);
}

/** 同目录里不重名：name.jpg → name-1.jpg → name-2.jpg */
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

/** 同设备用 rename（瞬间、不占空间）；跨设备才退回复制 + 删除 */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
    return 'rename';
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
    return 'copy';
  }
}

/**
 * 把文件挪进回收站。
 *
 * @param {string} filePath 要挪的文件（绝对路径）
 * @param {string} libraryPath 素材库根目录
 * @param {object} [options]
 * @param {string} [options.originalRelative] 原始相对路径（写进 .trashinfo.json，便于恢复）
 * @param {number} [options.deletedAt] 删除时间（默认取文件 mtime）
 * @returns {{destPath: string, kind: 'platform'|'library', how: 'rename'|'copy'}}
 */
function moveToRecycle(filePath, libraryPath, options = {}) {
  const originalRelative = options.originalRelative
    || path.relative(libraryPath, filePath).split(path.sep).join('/');

  const platformDir = findPlatformRecycleDir(libraryPath);
  let destPath;

  if (platformDir) {
    // 平台回收站：按「素材库名/原始相对路径」摆好，用户在文件管理里能一眼认出
    const libraryName = path.basename(path.resolve(libraryPath).replace(/[/\\]+$/, ''));
    const destDir = path.join(platformDir, libraryName, path.dirname(originalRelative));
    fs.mkdirSync(destDir, { recursive: true });
    destPath = uniquePath(destDir, path.basename(filePath));

    const how = moveFile(filePath, destPath);
    return { destPath, kind: 'platform', how };
  }

  // 素材库自己的回收目录
  const day = new Date().toISOString().slice(0, 10);
  const destDir = path.join(libraryTrashDir(libraryPath), day);
  fs.mkdirSync(destDir, { recursive: true });
  destPath = uniquePath(destDir, path.basename(filePath));

  const how = moveFile(filePath, destPath);

  // 记一份来源：日后要做"应用内回收站"或者手工恢复，都靠这份信息
  try {
    const info = {
      originalPath: originalRelative,
      libraryPath,
      deletedAt: options.deletedAt || null,
      movedAt: Date.now(),
      size: fs.statSync(destPath).size,
    };
    fs.writeFileSync(`${destPath}.trashinfo.json`, JSON.stringify(info, null, 2));
  } catch { /* 记不下来源不影响"文件已经挪走"这件事 */ }

  return { destPath, kind: 'library', how };
}

module.exports = {
  PLATFORM_RECYCLE_NAMES,
  LIBRARY_TRASH_DIR,
  findPlatformRecycleDir,
  libraryTrashDir,
  moveToRecycle,
};
