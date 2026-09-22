// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 扫描 API（简化版）
 */

import { api } from '../client';

export async function fullScan(libraryId, wait = false) {
  return api.post('/scan/full', { libraryId, wait });
}

export async function sync(libraryId, wait = false) {
  return api.post('/scan/sync', { libraryId, wait });
}

/**
 * 全量重扫（扫描库文件）
 * 每个文件都重新读一遍，并清理磁盘上已不存在的记录。
 * 评分 / 收藏 / 标签会保留。
 */
export async function rescan(libraryId, wait = false, prune = true) {
  return api.post('/scan/rescan', { libraryId, wait, prune });
}

export async function getStatus(libraryId) {
  return api.get(`/scan/status/${libraryId}`);
}

export async function fixFolders(libraryId) {
  return api.post('/scan/fix-folders', { libraryId });
}
