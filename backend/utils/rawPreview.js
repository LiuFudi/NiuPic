// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * RAW 支持：从相机 RAW 文件里把内嵌的 JPEG 预览抠出来
 *
 * 为什么需要这个：相机 RAW（DNG / CR2 / CR3 / NEF / ARW / RW2 / ORF / RAF …）
 * 是各家自己的二进制格式，sharp（libvips）默认读不了。于是这些文件：
 *   · 没有缩略图 —— 网格里只能显示一张灰色占位图
 *   · 宽高是占位尺寸（640×480）—— 排版比例全是错的（竖拍的片子被当成横图）
 *
 * 但几乎所有 RAW 都在文件里**内嵌了一张 JPEG 预览**（就是相机屏幕上给你看的那张，
 * 通常有 1600×1200 到全尺寸不等）。把这张抠出来，缩略图和宽高就都有了，
 * 不用依赖 libraw / dcraw（飞牛上不一定装得出来）。
 *
 * 两条路，先精确后兜底：
 *   1. 按 TIFF 结构走 IFD（DNG / CR2 / NEF / ARW / RW2 都是 TIFF 容器），
 *      找 JPEGInterchangeFormat(0x0201)/Length(0x0202) 这对标签 —— 这是标准做法
 *   2. 结构不认识（CR3 是 ISO BMFF、RAF 是富士自己的容器）或者标签缺失时，
 *      在文件里扫 JPEG 的 SOI(FFD8FF)…EOI(FFD9)，取最大的那一段
 *
 * 只读文件头部的一段（默认 64MB），不会把整个大文件读进内存。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 读文件头部多少字节（RAW 的预览一般在前面；CR3 的预览也在前部 box 里） */
const DEFAULT_SCAN_BYTES = 64 * 1024 * 1024;

/** 认得出来的 RAW 扩展名 */
const RAW_EXTENSIONS = new Set([
  'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'rw2', 'rwl',
  'orf', 'raf', 'srw', 'pef', 'ptx', '3fr', 'fff', 'iiq', 'mrw', 'x3f', 'erf', 'kdc', 'mef',
]);

function isRawFile(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return RAW_EXTENSIONS.has(ext);
}

/** 从 JPEG 数据里读宽高（SOF0/SOF1/SOF2 段） */
function jpegSize(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) { i += 1; continue; }
    const marker = buffer[i + 1];
    // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15（不含 DHT=C4 / JPG=C8 / DAC=CC）
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const len = buffer.readUInt16BE(i + 2);
    if (isSof) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    i += 2 + len;
  }
  return null;
}

/** TIFF 的 IFD 遍历：找 0x0201/0x0202 指到的内嵌 JPEG */
function tiffPreview(buffer) {
  if (buffer.length < 8) return null;
  const order = buffer.toString('latin1', 0, 2);
  let le;
  if (order === 'II') le = true;
  else if (order === 'MM') le = false;
  else return null;

  const u16 = (o) => (le ? buffer.readUInt16LE(o) : buffer.readUInt16BE(o));
  const u32 = (o) => (le ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));
  if (u16(2) !== 42) return null;

  const seen = new Set();
  const queue = [u32(4)];
  let best = null;

  while (queue.length > 0) {
    const ifdOffset = queue.shift();
    if (!ifdOffset || seen.has(ifdOffset) || ifdOffset + 2 > buffer.length) continue;
    seen.add(ifdOffset);
    if (seen.size > 64) break; // 防御：畸形文件里 IFD 可能成环

    const count = u16(ifdOffset);
    if (count === 0 || count > 512) continue;

    for (let i = 0; i < count; i += 1) {
      const entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > buffer.length) break;
      const tag = u16(entry);
      const valueSize = u32(entry + 4);

      if (tag === 0x0201) {                     // JPEGInterchangeFormat：预览的偏移
        const offset = u32(entry + 8);
        // 长度在上一条/下一条 0x0202 里，先记下来
        best = best || {};
        best.offset = offset;
      } else if (tag === 0x0202) {              // JPEGInterchangeFormatLength
        best = best || {};
        best.length = u32(entry + 8);
      } else if (tag === 0x014a) {              // SubIFDs
        const n = valueSize;
        const base = n === 1 ? entry + 8 : u32(entry + 8);
        for (let k = 0; k < Math.min(n, 8); k += 1) {
          const off = n === 1 ? u32(entry + 8) : u32(base + k * 4);
          if (off) queue.push(off);
        }
      }
    }

    const next = u32(ifdOffset + 2 + count * 12);
    if (next) queue.push(next);
  }

  if (best && best.offset && best.length && best.offset + best.length <= buffer.length) {
    const slice = buffer.subarray(best.offset, best.offset + best.length);
    if (slice[0] === 0xff && slice[1] === 0xd8) return slice;
  }
  return null;
}

/** 兜底：在文件里扫最大的那段 JPEG（SOI…EOI） */
function scanLargestJpeg(buffer) {
  let best = null;
  let i = 0;
  while (i + 3 < buffer.length) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
      // 往后找 EOI
      let j = i + 3;
      let end = -1;
      while (j + 1 < buffer.length) {
        if (buffer[j] === 0xff && buffer[j + 1] === 0xd9) { end = j + 2; break; }
        j += 1;
      }
      if (end > 0) {
        const size = end - i;
        if (!best || size > best.size) best = { start: i, size };
        i = end;
        continue;
      }
    }
    i += 1;
  }
  if (!best || best.size < 4096) return null;   // 太小的多半是缩略图图标，不要
  return buffer.subarray(best.start, best.start + best.size);
}

/**
 * 抠出 RAW 里的 JPEG 预览
 *
 * @param {string} filePath
 * @returns {{ buffer: Buffer, width: number|null, height: number|null, source: 'tiff'|'scan' }|null}
 */
function extractRawPreview(filePath, { maxBytes = DEFAULT_SCAN_BYTES } = {}) {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(size);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, size, 0);

    let preview = tiffPreview(buffer);
    let source = 'tiff';
    if (!preview) {
      preview = scanLargestJpeg(buffer);
      source = 'scan';
    }
    if (!preview) return null;

    const dims = jpegSize(preview) || {};
    return {
      buffer: preview,
      width: dims.width || null,
      height: dims.height || null,
      source,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * 只要尺寸（能省掉把预览整段读出来的开销 —— 这里其实也要读，但只解析尺寸）
 */
function readRawDimensions(filePath) {
  const preview = extractRawPreview(filePath);
  if (!preview || !preview.width || !preview.height) return null;

  // 预览是"相机屏幕那张"，比例和原片一致（各家都是按原片缩放生成的），
  // 所以宽高比可直接用；绝对像素按 EXIF 的旋转信息决定要不要对调
  return { width: preview.width, height: preview.height, preview: preview.buffer };
}

module.exports = {
  RAW_EXTENSIONS,
  isRawFile,
  extractRawPreview,
  readRawDimensions,
  jpegSize,
  tiffPreview,
  scanLargestJpeg,
};
