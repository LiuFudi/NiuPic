// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 图片 API
 */

import { withBase } from '../../utils/appBase.js';
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
  return `${withBase('/api')}/image/thumbnail/${libraryId}/${encodePathForUrl(filename)}`;
}

/**
 * 把素材库内的相对路径编成可以安全塞进 URL 的形态：**逐段** encodeURIComponent。
 *
 * 为什么必须编码（实测过的三类文件名）：
 *   · `照片#1.jpg` —— `#` 之后被浏览器当成锚点丢掉，请求变成 …/照片 → 404
 *   · `a?b.jpg`    —— `?` 之后变成查询串，路径被截断 → 404
 *   · `50%.jpg`    —— 非法转义，Express 解参数时抛 URIError → 400
 * 缩略图不受影响（文件名是 md5），所以现象是"网格里有图、双击却打不开"，
 * 排查时完全看不出是编码问题。
 *
 * 按段编码而不是整体编码：`/` 必须保留为路径分隔符，否则后端匹配不到通配路由。
 */
export function encodePathForUrl(relativePath) {
  return String(relativePath ?? '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * 获取原图 URL —— **原始字节**：导出、下载、打包 ZIP、交给系统应用打开用它。
 * 浏览器不认的格式（heic/raw/tiff/psd…）拿它做 <img> 是看不见的，显示请用 getPreviewUrl。
 */
export function getOriginalUrl(libraryId, path) {
  return `${withBase('/api')}/image/original/${libraryId}/${encodePathForUrl(path)}`;
}

/**
 * 获取预览 URL —— **能显示的图**：
 *   浏览器自己认的格式 → 后端原样发原图（不转码、保留动图）；
 *   不认的（heic / 各家 RAW / tiff / psd / tga / exr / qoi / dds / ico…）→ 后端转 webp 并缓存。
 * 前端因此不需要自己维护"哪些格式能显示"的清单（以前 RightPanel 里就有一份 5 个后缀的）。
 *
 * @param {number|string} libraryId
 * @param {string} path 相对素材库的路径
 * @param {number} [size] 最长边，默认后端取 4096
 */
export function getPreviewUrl(libraryId, path, size) {
  const base = `${withBase('/api')}/image/preview/${libraryId}/${encodePathForUrl(path)}`;
  return size ? `${base}?size=${encodeURIComponent(size)}` : base;
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
