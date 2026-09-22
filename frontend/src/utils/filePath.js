// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 文件路径的显示与复制
 *
 * 飞牛（fnOS）是 Linux，素材库里的文件路径就是 `/vol1/1000/Photos/Camera/…`
 * 这种正斜杠写法。**但路径是服务器上的路径，不该因为"用户用 Windows 浏览器打开"
 * 就显示成反斜杠** —— 上一版就是这么做的（按 navigator.platform 判断），
 * 结果在 Windows 上复制出来的 `\vol5\1000\…` 粘到飞牛的终端里根本用不了。
 *
 * 现在的规矩：
 *   · 界面上**一律**显示 Linux 写法（真实路径）
 *   · 想复制成 Windows 写法也可以，但那是另一个按钮的事（toWindowsPath）
 */

/** 统一成 Linux（正斜杠）写法 */
export function toLinuxPath(path) {
  if (!path) return '';
  return String(path).replace(/[\\/]+/g, '/');
}

/** 转成 Windows（反斜杠）写法，给需要在 Windows 上粘贴的场景 */
export function toWindowsPath(path) {
  if (!path) return '';
  return toLinuxPath(path).replace(/\//g, '\\');
}

/** 去掉末尾斜杠 */
export function stripTrailingSlash(path) {
  return toLinuxPath(path).replace(/\/+$/, '');
}

/**
 * 素材库路径 + 图片相对路径 → 完整路径（始终 Linux 写法）
 *
 * @param {string} libraryPath 素材库根目录（服务器上的绝对路径）
 * @param {string} relativePath 图片相对路径（数据库里存的，正反斜杠都可能有）
 */
export function joinLibraryPath(libraryPath, relativePath) {
  if (!libraryPath || !relativePath) return toLinuxPath(relativePath || libraryPath || '');
  const base = stripTrailingSlash(libraryPath);
  const rel = toLinuxPath(relativePath).replace(/^\/+/, '');
  return toLinuxPath(`${base}/${rel}`);
}

export default { toLinuxPath, toWindowsPath, stripTrailingSlash, joinLibraryPath };
