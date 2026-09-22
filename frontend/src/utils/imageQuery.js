// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 取图请求参数构造（唯一出口）
 *
 * 首屏加载（MainContent）和翻页加载（useInfiniteScroll）**必须**用同一个函数拼参数。
 *
 * 之前是两处各写一份，翻页那份漏了 sort / order / seed —— 结果就是
 * 「第一页按你选的排，第二页开始全按默认的创建时间倒序」，
 * 看起来像排序完全没生效。这类「同一份逻辑写两处」的坑这个项目已经踩过好几次了
 * （server.js 的 configManager 白名单、前后端各一份的 SORT.FIELDS），
 * 所以这里收成一个出口，并配单测钉死。
 */

/**
 * @param {object} options
 * @param {string} [options.folder]           选中的文件夹（空 = 全部层级）
 * @param {string} [options.keywords]         搜索关键词
 * @param {object} [options.filters]          { formats: string[] }
 * @param {object} [options.sort]             { field, order, seed }
 * @param {number} [options.offset=0]
 * @param {number} [options.limit=100]
 * @returns {object} 可直接交给 imageAPI.search 的参数
 */
export function buildImageQueryParams(options = {}) {
  const {
    folder,
    keywords,
    filters,
    sort,
    offset = 0,
    limit = 100,
  } = options;

  const params = {
    offset: Math.max(0, Number(offset) || 0),
    limit: Number(limit) > 0 ? Number(limit) : 100,
  };

  if (folder) params.folder = folder;
  if (keywords) params.keywords = keywords;

  // 筛选条件全部交给后端（前端只拿一页，本地筛会漏掉没加载的图）
  if (filters) {
    if (filters.mode === 'exclude') params.filterMode = 'exclude';

    if (Array.isArray(filters.formats) && filters.formats.length > 0) {
      params.formats = filters.formats.join(',');
    }
    // 文件大小：字节。只有用户真的拖动过滑块才传（等于全范围时不传，避免无谓的 SQL 条件）
    if (Number.isFinite(filters.minSize) && filters.minSize > 0) params.minSize = Math.round(filters.minSize);
    if (Number.isFinite(filters.maxSize) && filters.maxSize > 0) params.maxSize = Math.round(filters.maxSize);

    if (Array.isArray(filters.orientations) && filters.orientations.length > 0) {
      params.orientations = filters.orientations.join(',');
    }
    if (Array.isArray(filters.ratings) && filters.ratings.length > 0) {
      params.ratings = filters.ratings.join(',');
    }
  }

  // 排序一律交给后端做（前端只拿到一页，本地排会把翻页顺序弄乱）。
  // 每个字段白名单都在 backend/src/config/constants.js 的 SORT.FIELDS 里。
  if (sort && sort.field) {
    params.sort = sort.field;
    params.order = sort.order === 'asc' ? 'asc' : 'desc';
    if (sort.field === 'random') {
      params.seed = Number.isFinite(Number(sort.seed)) ? Math.floor(Number(sort.seed)) : 0;
    }
  }

  return params;
}

export default buildImageQueryParams;
