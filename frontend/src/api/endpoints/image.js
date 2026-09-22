// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 图片 API
 */

import { api } from '../client';

/**
 * 搜索图片
 */
export async function search(libraryId, params = {}, options = {}) {
  const query = new URLSearchParams({
    libraryId,
    ...params
  });
  
  return api.get(`/image?${query}`, options);
}

/**
 * 当前范围内的筛选选项
 * 只列出当前文件夹里实际存在的格式 / 大小范围 / 方向 / 评分
 * @param {string} libraryId
 * @param {object} params - { folder?, keywords? }
 */
export async function getFilterOptions(libraryId, params = {}) {
  const query = new URLSearchParams({ libraryId, ...params });
  return api.get(`/image/filter-options?${query}`);
}

/**
 * 获取图片总数
 */
export async function getCount(libraryId) {
  return api.get(`/image/count?libraryId=${libraryId}`);
}

/**
 * 获取统计信息
 */
export async function getStats(libraryId) {
  return api.get(`/image/stats?libraryId=${libraryId}`);
}

/**
 * 获取文件夹列表
 */
export async function getFolders(libraryId) {
  return api.get(`/image/folders?libraryId=${libraryId}`);
}

/**
 * 获取缓存元数据
 */
export async function getCacheMeta(libraryId) {
  return api.get(`/image/cache-meta?libraryId=${libraryId}`);
}

/**
 * 获取缩略图 URL
 * 使用分片结构，不再需要 size 参数
 */
export function getThumbnailUrl(libraryId, filename) {
  return `/api/image/thumbnail/${libraryId}/${filename}`;
}

/**
 * 获取原图 URL
 */
export function getOriginalUrl(libraryId, path) {
  return `/api/image/original/${libraryId}/${path}`;
}

/**
 * 在文件管理器中打开
 */
export async function openInExplorer(libraryId, path) {
  return api.post(`/image/${libraryId}/open-file`, { path });
}

/**
 * 更新图片评分（支持批量）
 */
export async function updateRating(libraryId, paths, rating) {
  return api.put('/image/rating', {
    libraryId,
    paths: Array.isArray(paths) ? paths : [paths],
    rating
  });
}
