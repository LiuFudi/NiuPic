// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
//
// 格式清单的**唯一真源**。
//
// 为什么必须收敛：这几张清单原来分散在三处 ——
//   constants.js 的 SUPPORTED_FORMATS、utils/thumbnail.js 的 IMAGE_FORMATS +
//   FILE_CATEGORIES、utils/rawPreview.js 的 RAW_EXTENSIONS。
// 同一件事写三遍，改一处忘一处是必然的（本项目已经因为"两处各写一遍"栽过好几次：
// 排序字段、筛选参数、版本号、图片 URL）。现在只在这里定义，别处一律 require 引用。
//
// 清单只写**真的能处理**的格式：能不能出缩略图、能不能在浏览器里看，都由
// `getImageDecoder()` 与 `BROWSER_RENDERABLE` 明确表态，不靠"看起来像图片"猜。
// 判断依据是在真机上实测过的（sharp/libvips 8.15.3 与 ffmpeg 8.1.1 的实际解码器列表）。

'use strict';

const path = require('path');

/** 取小写扩展名（不带点）；没有扩展名返回空串 */
function extOf(filePath) {
  return path.extname(String(filePath || '')).toLowerCase().slice(1);
}

// ---------------------------------------------------------------------------
// 图片：按"谁来解码"分组
// ---------------------------------------------------------------------------

/** sharp（libvips）能直接解 —— 实测输入格式：jpeg png webp tiff gif svg heif vips raw */
const SHARP_EXT = [
  // jpeg 家族（jpe/jfif 都是 JPEG 的其它后缀，libvips 按内容识别）
  'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg',
  // png 家族（apng 是带动画块的 png；缩略图取首帧）
  'png', 'apng',
  'webp', 'gif', 'tif', 'tiff',
  'svg',
  // heif 容器：heic/heif 是 HEVC 编码，avif/avifs 是 AV1 编码，libheif 一起解
  'heic', 'heif', 'hif', 'avif', 'avifs',
];

/**
 * sharp 解不了、但 ffmpeg 能解 —— 在真机上逐个试出来的（ffmpeg 8.1.1）：
 * bmp dib psd tga 家族 exr hdr pic jp2 家族 qoi dds dpx pnm 家族
 * pcx pam pfm sun/ras xbm xpm xwd wbmp ico/icon
 *
 * 这里没有的：jxl（JPEG XL）/ jxr / wp2 / blp / cur —— 这套 sharp 与 ffmpeg
 * 都不带这些解码器，写进来只会让"支持"变成"点了打不开"。
 */
const FFMPEG_EXT = [
  'bmp', 'dib',
  'psd',
  'tga', 'targa', 'icb', 'vda', 'vst',
  'exr', 'hdr', 'pic',
  'jp2', 'j2k', 'jpf', 'jpx', 'jpc',
  'qoi', 'dds', 'dpx',
  'pnm', 'ppm', 'pgm', 'pbm', 'pam', 'pfm', 'pxm',
  'pcx', 'xbm', 'xpm', 'xwd', 'wbmp',
  'sun', 'ras', 'rs',
  'ico', 'icon',
];

/**
 * ffmpeg 的 image2 解复用器**靠扩展名认格式**：没有 magic 的格式（TGA 就是）
 * 换个后缀就认不出来了 —— 实测 `x.targa` / `x.icb` / `x.vda` / `x.vst`
 * 直接报 "Invalid data found"，加 `-c:v targa` 就能解。
 * 这张表就是"认不出来时显式指定解码器"用的。
 * （ico 有自己的 magic，ffmpeg 直接就能认，所以不在这里。）
 */
const FFMPEG_CODEC_HINT = {
  tga: 'targa', targa: 'targa', icb: 'targa', vda: 'targa', vst: 'targa',
  pcx: 'pcx', xbm: 'xbm', xpm: 'xpm', xwd: 'xwd', wbmp: 'wbmp',
  sun: 'sunrast', ras: 'sunrast', rs: 'sunrast',
  pam: 'pam', pfm: 'pfm', pxm: 'ppm',
  pic: 'hdr',
};

/** 认不出来时该用什么解码器；返回 null = 不需要提示（有 magic，ffmpeg 自己认） */
function getFfmpegCodecHint(ext) {
  return FFMPEG_CODEC_HINT[String(ext || '').toLowerCase().replace(/^\./, '')] || null;
}

/** 各家相机 RAW：sharp/ffmpeg 都解不了，靠抽内嵌 JPEG 预览（见 utils/rawPreview.js） */
const RAW_EXT = [
  'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'rw2', 'rwl',
  'orf', 'raf', 'srw', 'pef', 'ptx', '3fr', 'fff', 'iiq', 'mrw', 'x3f', 'erf',
  'kdc', 'mef', 'raw', 'ari', 'bay', 'cap', 'dcr', 'dcs', 'drf', 'eip', 'gpr',
  'k25', 'mdc', 'mos', 'rwz', 'sr', 'r3d',
];

/** 库里的"图片"= 上面三类（RAW 也算图片：它是照片原片，不该掉进"其他"） */
const IMAGE_EXT = [...SHARP_EXT, ...FFMPEG_EXT, ...RAW_EXT];

/**
 * 浏览器能直接渲染的图片格式 —— 这些用原图看最清楚，不需要转码。
 * 注意：heic/heif/tiff/psd/… 浏览器都不认，必须走 /api/image/preview 转码，
 * 否则双击打开是全屏白图（这个坑必修）。
 */
const BROWSER_RENDERABLE = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'png', 'apng', 'webp', 'gif',
  'avif', 'avifs', 'bmp', 'svg',
  // 注意：ico 能进这里也能出，但 Safari 不认（会显示空白），
  // 所以统一让它走转码预览，别让"能不能看"取决于用哪个浏览器。
]);

// ---------------------------------------------------------------------------
// 视频 / 音频 / 文档 / 设计稿（不进缩略图流程，只用于分类与占位图）
// ---------------------------------------------------------------------------

const VIDEO_EXT = [
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'wmv', 'asf',
  'mpg', 'mpeg', 'm2v', 'ts', 'm2ts', 'mts', 'vob', 'ogv', 'ogm',
  '3gp', '3g2', 'rm', 'rmvb', 'divx', 'f4v', 'mxf', 'amv', 'mpe', 'mpv',
];

const AUDIO_EXT = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'wma', 'ape', 'alac', 'opus', 'aiff', 'aif'];

const DOCUMENT_EXT = [
  'pdf', 'txt', 'md', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'rtf', 'odt', 'ods', 'odp', 'csv', 'pages', 'numbers', 'key',
];

const DESIGN_EXT = ['ai', 'sketch', 'xd', 'fig', 'figma', 'indd', 'eps', 'cdr', 'dwg'];

// ---------------------------------------------------------------------------
// 查询接口
// ---------------------------------------------------------------------------

/** 该扩展名用什么解码；'raw' = 抽内嵌预览，'unsupported' = 出不了缩略图 */
function getImageDecoder(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (SHARP_EXT.includes(e)) return 'sharp';
  if (FFMPEG_EXT.includes(e)) return 'ffmpeg';
  if (RAW_EXT.includes(e)) return 'raw';
  return 'unsupported';
}

/** 文件类型分类（用于筛选面板的分组与占位图） */
function getCategory(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (IMAGE_EXT.includes(e)) return 'image';
  if (VIDEO_EXT.includes(e)) return 'video';
  if (AUDIO_EXT.includes(e)) return 'audio';
  if (DOCUMENT_EXT.includes(e)) return 'document';
  if (DESIGN_EXT.includes(e)) return 'design';
  return 'other';
}

/** 是否是本库要收进来的"图片" */
function isImageExt(ext) {
  return getCategory(ext) === 'image';
}

/** 浏览器能不能直接显示（不需要转码） */
function isBrowserRenderable(ext) {
  return BROWSER_RENDERABLE.has(String(ext || '').toLowerCase().replace(/^\./, ''));
}

module.exports = {
  extOf,
  SHARP_EXT,
  FFMPEG_EXT,
  RAW_EXT,
  IMAGE_EXT,
  VIDEO_EXT,
  AUDIO_EXT,
  DOCUMENT_EXT,
  DESIGN_EXT,
  BROWSER_RENDERABLE,
  FFMPEG_CODEC_HINT,
  getImageDecoder,
  getFfmpegCodecHint,
  getCategory,
  isImageExt,
  isBrowserRenderable,
  // 兼容旧引用
  ALL_EXT: [...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT, ...DOCUMENT_EXT, ...DESIGN_EXT],
};
