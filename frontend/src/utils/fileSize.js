// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 文件大小的显示换算
 *
 * 后端一律用**字节**，界面上一律显示成人看的单位 ——
 * 中间这层换算只此一份，别在组件里再写一遍（容易一边用 KB 一边用字节）。
 *
 * 大小筛选现在是固定挡位（见后端 constants.SIZE_BRACKETS），
 * 不需要"位置 ↔ 大小"的对数换算了。
 */

/** 1024 进制，保留一位小数（去掉多余的 .0） */
export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 KB';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  // 整数就不带小数点（"1 KB" 比 "1.0 KB" 好看），小数只留一位
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

export default { formatFileSize };
