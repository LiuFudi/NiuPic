// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 格式清单的唯一真源：src/config/formats.js
 *
 * 这一批用例钉住的是"清单不许再各写一份"：
 *   · 几张表之间不能自相矛盾（说了是图片却没有解码器、既算图片又算视频…）
 *   · 分类与解码器的判断必须来自同一处
 *   · 明确写下来哪些格式**不支持**（jxl/jxr/wp2/blp），免得以后有人以为漏了
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const formats = require('../src/config/formats');

test('每个"图片"扩展名都得有解码器，反之亦然', () => {
  const noDecoder = formats.IMAGE_EXT.filter((e) => formats.getImageDecoder(e) === 'unsupported');
  assert.deepStrictEqual(noDecoder, [], `这些扩展名被当成图片却没人能解：${noDecoder.join(',')}`);
});

test('各分类之间不重叠（一个扩展名只能属于一类）', () => {
  const groups = {
    image: formats.IMAGE_EXT,
    video: formats.VIDEO_EXT,
    audio: formats.AUDIO_EXT,
    document: formats.DOCUMENT_EXT,
    design: formats.DESIGN_EXT,
  };
  const seen = new Map();
  const clashes = [];

  for (const [name, list] of Object.entries(groups)) {
    for (const ext of list) {
      if (seen.has(ext)) clashes.push(`${ext}: ${seen.get(ext)} / ${name}`);
      else seen.set(ext, name);
    }
  }

  assert.deepStrictEqual(clashes, [], `重复归类：${clashes.join('，')}`);
});

test('同一张表内部没有重复项（拼错/粘贴重复很容易发生）', () => {
  for (const [name, list] of Object.entries({
    SHARP_EXT: formats.SHARP_EXT,
    FFMPEG_EXT: formats.FFMPEG_EXT,
    RAW_EXT: formats.RAW_EXT,
    VIDEO_EXT: formats.VIDEO_EXT,
    AUDIO_EXT: formats.AUDIO_EXT,
    DOCUMENT_EXT: formats.DOCUMENT_EXT,
    DESIGN_EXT: formats.DESIGN_EXT,
  })) {
    const dup = list.filter((e, i) => list.indexOf(e) !== i);
    assert.deepStrictEqual(dup, [], `${name} 里有重复：${dup.join(',')}`);
  }
});

test('扩展名一律小写、不带点（否则 getImageDecoder 大小写敏感会漏）', () => {
  for (const ext of formats.ALL_EXT) {
    assert.strictEqual(ext, ext.toLowerCase(), `${ext} 不是小写`);
    assert.ok(!ext.startsWith('.'), `${ext} 带了点`);
  }
});

test('getImageDecoder 的判定与三张表一致', () => {
  for (const ext of formats.SHARP_EXT) assert.strictEqual(formats.getImageDecoder(ext), 'sharp', ext);
  for (const ext of formats.FFMPEG_EXT) assert.strictEqual(formats.getImageDecoder(ext), 'ffmpeg', ext);
  for (const ext of formats.RAW_EXT) assert.strictEqual(formats.getImageDecoder(ext), 'raw', ext);
});

test('大小写与点号都容得下（.JPG / .Heic 也要认）', () => {
  assert.strictEqual(formats.getImageDecoder('.JPG'), 'sharp');
  assert.strictEqual(formats.getImageDecoder('Heic'), 'sharp');
  assert.strictEqual(formats.getCategory('.CR3'), 'image');
  assert.strictEqual(formats.extOf('/a/b/Photo.JPEG'), 'jpeg');
});

test('本次新纳入的格式（对着 JarkViewer 的支持列表补齐）', () => {
  const expected = {
    // sharp 直接解
    heic: 'sharp', heif: 'sharp', avif: 'sharp', tiff: 'sharp', svg: 'sharp',
    // ffmpeg 解：静态图
    psd: 'ffmpeg', tga: 'ffmpeg', targa: 'ffmpeg', icb: 'ffmpeg', vda: 'ffmpeg',
    exr: 'ffmpeg', hdr: 'ffmpeg', jp2: 'ffmpeg', j2k: 'ffmpeg', qoi: 'ffmpeg',
    dds: 'ffmpeg', dpx: 'ffmpeg', bmp: 'ffmpeg', dib: 'ffmpeg',
    pcx: 'ffmpeg', pam: 'ffmpeg', pfm: 'ffmpeg', pxm: 'ffmpeg', pnm: 'ffmpeg',
    xbm: 'ffmpeg', xpm: 'ffmpeg', xwd: 'ffmpeg', wbmp: 'ffmpeg',
    sun: 'ffmpeg', ras: 'ffmpeg', rs: 'ffmpeg', ico: 'ffmpeg', icon: 'ffmpeg',
    // 相机 RAW：抽内嵌预览
    cr3: 'raw', nef: 'raw', arw: 'raw', dng: 'raw', raf: 'raw', r3d: 'raw',
  };

  const wrong = Object.entries(expected)
    .filter(([ext, want]) => formats.getImageDecoder(ext) !== want)
    .map(([ext, want]) => `${ext}: 期望 ${want}，实际 ${formats.getImageDecoder(ext)}`);

  assert.deepStrictEqual(wrong, [], wrong.join('；'));
});

test('明确不支持的格式要老实说不支持，不能靠看起来像图片来猜', () => {
  // 这套 sharp(libvips 8.15.3) 与 ffmpeg 8.1.1 都没有这些解码器。
  // 写进支持列表的后果是"点了打不开"，比不支持更糟。
  for (const ext of ['jxl', 'jxr', 'wp2', 'blp', 'cur', 'livp']) {
    assert.strictEqual(formats.getImageDecoder(ext), 'unsupported', `${ext} 不该出现在支持列表里`);
    assert.strictEqual(formats.getCategory(ext), 'other', `${ext} 不该被当成图片`);
  }
});

test('浏览器直显清单是图片清单的子集，且不含需要转码的格式', () => {
  for (const ext of formats.BROWSER_RENDERABLE) {
    assert.ok(formats.isImageExt(ext), `${ext} 不在图片清单里`);
    assert.ok(formats.isBrowserRenderable(ext));
  }
  // 这些浏览器不认，必须走转码，一个都不能漏进来
  for (const ext of ['heic', 'heif', 'tiff', 'psd', 'tga', 'exr', 'qoi', 'dds', 'ico', 'cr3', 'nef']) {
    assert.ok(!formats.isBrowserRenderable(ext), `${ext} 不该被当成浏览器直显格式`);
  }
});

test('需要显式解码器提示的格式都给了提示（TGA 家族没有 magic）', () => {
  for (const ext of ['targa', 'icb', 'vda', 'vst']) {
    assert.strictEqual(formats.getFfmpegCodecHint(ext), 'targa', ext);
  }
  assert.strictEqual(formats.getFfmpegCodecHint('.PCX'), 'pcx');
  assert.strictEqual(formats.getFfmpegCodecHint('ras'), 'sunrast');
  // 有 magic 的格式不需要提示
  assert.strictEqual(formats.getFfmpegCodecHint('ico'), null);
  assert.strictEqual(formats.getFfmpegCodecHint('jpg'), null);
});

test('ALL_EXT 覆盖所有分类，且新旧引用都能拿到', () => {
  const total = formats.IMAGE_EXT.length + formats.VIDEO_EXT.length + formats.AUDIO_EXT.length
    + formats.DOCUMENT_EXT.length + formats.DESIGN_EXT.length;
  assert.strictEqual(formats.ALL_EXT.length, total);
  assert.ok(formats.ALL_EXT.includes('mp4') && formats.ALL_EXT.includes('pdf') && formats.ALL_EXT.includes('cr3'));
});
