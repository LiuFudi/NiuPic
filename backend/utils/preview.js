// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
//
// 「看得到」这一层：把浏览器不认的图片转成浏览器认的。
//
// 为什么需要它：缩略图再好看，双击进去是白屏也没用。浏览器的 <img> 只认
// jpeg/png/webp/gif/avif/bmp/svg；HEIC（iPhone 拍的原图）、相机 RAW（cr3/nef/arw…）、
// TIFF、PSD、TGA、EXR、QOI 这些它一律不认 —— 用户看到的就是一整屏白。
// 这里把它们转成 webp 再发给前端。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const formats = require('../src/config/formats');
const logger = require('../src/utils/logger');

/** 预览最长边默认 4096：再大对屏幕没意义，编码时间和内存却成倍涨 */
const DEFAULT_MAX_SIZE = 4096;
const MIN_MAX_SIZE = 256;
const MAX_MAX_SIZE = 8192;

let sharp = null;
function getSharp() {
  if (!sharp) sharp = require('sharp');
  return sharp;
}

/**
 * 缓存文件路径：`.niupic/previews/<散列前 2 位>/<md5(相对路径)>_<最长边>.webp`
 *
 * 把尺寸写进文件名（而不是另存一个 `.size` 标记文件）：同一张图被以不同 size
 * 请求时各存各的，缓存是否有效只看"这个文件在不在、比源文件新不新"——
 * 少一份需要和内容同步的状态，就少一类"标记说 4096、文件其实是 256"的错。
 */
function cachePathFor(imagePath, libraryPath, maxSize = DEFAULT_MAX_SIZE) {
  const rel = path.relative(libraryPath, imagePath).split(path.sep).join('/');
  const hash = crypto.createHash('md5').update(rel).digest('hex');
  return path.join(libraryPath, '.niupic', 'previews', hash.slice(0, 2), `${hash}_${maxSize}.webp`);
}

function clampSize(size) {
  const n = Number.parseInt(size, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_SIZE;
  return Math.min(MAX_MAX_SIZE, Math.max(MIN_MAX_SIZE, n));
}

/**
 * 这个文件浏览器能不能直接显示？能就直接发原图（不转码、不失真、保留动图）。
 */
function needsConversion(filePath) {
  return !formats.isBrowserRenderable(formats.extOf(filePath));
}

/**
 * 这个文件值不值得转码（只有"图片"类别才转；视频/文档/设计稿不在这里处理）
 */
function isConvertible(filePath) {
  const ext = formats.extOf(filePath);
  return formats.getCategory(ext) === 'image' && formats.getImageDecoder(ext) !== 'unsupported';
}

/** 生成一张 webp 预览。返回 null 表示这次转不出来（调用方回 404/占位） */
async function convertToPreview(imagePath, outPath, maxSize) {
  const ext = formats.extOf(imagePath);
  const decoder = formats.getImageDecoder(ext);
  const lib = getSharp();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (decoder === 'sharp') {
    // HEIC/HEIF/AVIF/TIFF/SVG/PNG(含 APNG 取首帧)…
    const info = await lib(imagePath)
      .rotate()                                     // 按 EXIF 摆正
      .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 92 })
      .toFile(outPath);
    return { width: info.width, height: info.height, decoder };
  }

  // RAW：先抠出内嵌的 JPEG 预览（见 utils/rawPreview.js）
  if (decoder === 'raw') {
    const { extractRawPreview } = require('./rawPreview');
    const preview = extractRawPreview(imagePath);
    if (!preview || !preview.buffer) return null;

    const info = await lib(preview.buffer)
      .rotate()
      .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 92 })
      .toFile(outPath);
    return { width: info.width, height: info.height, decoder, from: preview.source };
  }

  // 其余交给 ffmpeg（psd/tga/exr/hdr/jp2/qoi/dds/dpx/pnm/pcx/ico…）
  const viaFfmpeg = await convertWithFfmpeg(imagePath, outPath, maxSize);
  if (viaFfmpeg) return viaFfmpeg;

  // ffmpeg 解不动时，PSD 还有一条退路：文件里作者自己存的预览图。
  // 现实里 PSD 的 RLE/ZIP 压缩变体多，ffmpeg 偶尔吃不下，
  // 而"能看"比"解的是最新图层"重要 —— 缩略图那条路一直就是这么做的。
  if (ext === 'psd' || ext === 'psb') {
    const embedded = await convertPsdEmbedded(imagePath, outPath, maxSize);
    if (embedded) return embedded;
  }

  return null;
}

/**
 * ffmpeg → 临时 PNG → sharp → webp。
 *
 * 解码那一半用的是 utils/thumbnail.js 的 decodeStillWithFfmpeg —— 缩略图和预览
 * 共用同一套"认不出来就显式指定解码器"的逻辑，不各写一份。
 */
async function convertWithFfmpeg(imagePath, outPath, maxSize) {
  const { decodeStillWithFfmpeg } = require('./thumbnail');

  const tempPng = `${outPath}.tmp.png`;

  try {
    const ok = await decodeStillWithFfmpeg(imagePath, tempPng, { maxSize });
    if (!ok) return null;

    const lib = getSharp();
    const info = await lib(tempPng)
      .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 92 })
      .toFile(outPath);

    return { width: info.width, height: info.height, decoder: 'ffmpeg' };
  } finally {
    if (fs.existsSync(tempPng)) {
      try { fs.unlinkSync(tempPng); } catch { /* 忽略 */ }
    }
  }
}

/**
 * PSD 的退路：ffmpeg 解不动时，用文件里作者自己存的预览图。
 *
 * 现实里 PSD 的压缩变体很多（RLE / ZIP / ZIP-with-prediction），ffmpeg 偶尔吃不下；
 * 而"能看见画面"比"解的一定是最新图层"重要。解析只做一份 ——
 * 用的是 thumbnail.js 里那套 Image Resources 解析（extractPsdEmbeddedJpeg）。
 */
async function convertPsdEmbedded(imagePath, outPath, maxSize) {
  const { extractPsdEmbeddedJpeg } = require('./thumbnail');

  const jpeg = await extractPsdEmbeddedJpeg(imagePath);
  if (!jpeg || !jpeg.buffer) return null;

  const lib = getSharp();
  const info = await lib(jpeg.buffer)
    .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 92 })
    .toFile(outPath);

  return { width: info.width, height: info.height, decoder: 'psd-embedded' };
}

/**
 * 拿到（必要时生成）预览文件。
 *
 * 缓存失效用的是"比原文件新"这条朴素规则：缓存比源文件旧就重转。
 * 不用把 mtime 编进文件名，省掉一份需要清理的垃圾，也自然处理了
 * "同一个文件名、内容被替换"的情况。
 *
 * @returns {Promise<{path: string, width: number, height: number, cached: boolean}|null>}
 */
async function ensurePreview(imagePath, libraryPath, options = {}) {
  const maxSize = clampSize(options.size);
  const outPath = cachePathFor(imagePath, libraryPath, maxSize);

  try {
    if (fs.existsSync(outPath)) {
      const cacheStat = fs.statSync(outPath);
      const srcStat = fs.statSync(imagePath);
      if (cacheStat.mtimeMs >= srcStat.mtimeMs && cacheStat.size > 0) {
        return { path: outPath, width: null, height: null, cached: true };
      }
    }

    const result = await convertToPreview(imagePath, outPath, maxSize);
    if (!result) return null;

    logger.debug(`预览已生成 ${path.basename(imagePath)} → ${result.width}x${result.height}`);
    return { path: outPath, width: result.width, height: result.height, cached: false };
  } catch (error) {
    logger.warn(`预览生成失败 ${path.basename(imagePath)}: ${error.message}`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size === 0) {
      try { fs.unlinkSync(outPath); } catch { /* 忽略 */ }
    }
    return null;
  }
}

/**
 * 删掉某个文件的**所有尺寸**的预览缓存。
 * 文件被删除 / 移入回收站时调用，别让缓存永远躺在那儿。
 * @returns {number} 删掉的文件数
 */
function removePreviewsFor(imagePath, libraryPath) {
  const rel = path.relative(libraryPath, imagePath).split(path.sep).join('/');
  const hash = crypto.createHash('md5').update(rel).digest('hex');
  const dir = path.join(libraryPath, '.niupic', 'previews', hash.slice(0, 2));

  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${hash}_`)) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
        removed++;
      } catch { /* 忽略单个文件失败 */ }
    }
  } catch (error) {
    logger.warn(`清理预览缓存失败 ${dir}: ${error.message}`);
  }
  return removed;
}

/** 清理整个素材库的预览缓存（重建索引/删除素材库时用） */
function clearPreviews(libraryPath) {
  const dir = path.join(libraryPath, '.niupic', 'previews');
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (error) {
    logger.warn(`清理预览缓存失败 ${dir}: ${error.message}`);
    return false;
  }
}

module.exports = {
  DEFAULT_MAX_SIZE,
  MIN_MAX_SIZE,
  MAX_MAX_SIZE,
  needsConversion,
  isConvertible,
  ensurePreview,
  removePreviewsFor,
  clearPreviews,
  cachePathFor,
  clampSize,
};
