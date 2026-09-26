// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 「显示用 URL」只有这一处判断，别在组件里各写一份。
 *
 * 以前是反过来的：每个组件自己拿一份"能显示的格式"清单 ——
 * RightPanel 里那份是 `['jpg','jpeg','png','webp','gif']`，
 * 于是 HEIC、TIFF、AVIF、BMP、SVG 在右侧面板里永远只显示缩略图，
 * 而加到 AVIF 的时候没人记得去改它。
 *
 * 现在：图片一律走后端的预览路由，认不认这个格式由后端（formats.js）说了算。
 */

import { imageAPI } from '../api';

/** 文件类型：后端字段有新老两种写法 */
export function fileTypeOf(file) {
  return file?.fileType || file?.file_type || 'image';
}

/** 是不是"图片"（视频/音频/文档各有自己的播放器，不走这里） */
export function isDisplayableImage(file) {
  return fileTypeOf(file) === 'image';
}

/**
 * 显示这个文件该用哪个 URL
 * @param {number|string} libraryId
 * @param {object} file 至少要有 path
 * @param {number} [size] 预览最长边，不传用后端默认 4096
 */
export function displayUrlFor(libraryId, file, size) {
  if (!libraryId || !file?.path) return '';

  // 非图片：交给对应的查看器去用原始字节（视频播放、PDF iframe…）
  if (!isDisplayableImage(file)) {
    return imageAPI.getOriginalUrl(libraryId, file.path);
  }

  return imageAPI.getPreviewUrl(libraryId, file.path, size);
}
