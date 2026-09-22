// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 文件名自然排序键
 *
 * SQLite 的 ORDER BY 用的是 BINARY 比较，直接按 filename 排会得到
 *   img1.jpg, img10.jpg, img100.jpg, img2.jpg ...
 * 这显然不是人想要的顺序。所以这里把文件名预处理成一个「按字典序比较就等于按自然序比较」的键，
 * 存进 images.name_sort 列并建索引 —— 排序时直接 ORDER BY name_sort，既正确又能走索引。
 *
 * 做法：把每一段连续数字替换成「长度(3位补零) + 原数字」。
 *   img2.jpg   -> img0022.jpg
 *   img10.jpg  -> img00210.jpg
 *   img100.jpg -> img003100.jpg
 * 字典序比较得到 img2 < img10 < img100 ✓
 *
 * 为什么先放长度而不是直接左侧补零：
 *   左侧补零在数字位数超过补零宽度时就会失效（例如 12 位的 "999999999999"
 *   和 13 位的 "1000000000000"），而先比长度再比数字对任意位数都成立。
 */

/**
 * @param {string} filename
 * @returns {string} 排序键（小写，数字段带长度前缀）
 */
function buildNameSortKey(filename) {
  if (filename === null || filename === undefined) return '';
  return String(filename)
    .toLowerCase()
    .replace(/\d+/g, (digits) => `${String(digits.length).padStart(3, '0')}${digits}`);
}

module.exports = { buildNameSortKey };
