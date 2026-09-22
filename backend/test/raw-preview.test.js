// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 相机 RAW 的支持：从 RAW 里抠内嵌 JPEG 预览
 *
 * 背景：RAW（DNG / CR2 / CR3 / NEF / ARW / RW2 / ORF / RAF…）是各家自己的格式，
 * sharp（libvips）读不了，于是"没有缩略图 + 宽高固定 640×480 占位"。
 * 但相机一定会在 RAW 里塞一张 JPEG 预览，抠出来就能有缩略图和真实宽高。
 *
 * 这里造两种"像 RAW 的文件"来钉住两条路：
 *   · 标准 TIFF 容器（DNG/CR2/NEF/ARW/RW2 都是）：走 IFD 找 0x0201/0x0202
 *   · 结构不认识（CR3 是 ISO BMFF、RAF 是富士自己的容器）：扫最大的一段 JPEG 兜底
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractRawPreview, isRawFile, jpegSize } = require('../utils/rawPreview');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  /* 裸仓库没装依赖时下面的用例会 skip */
}

/** 造一张指定尺寸的 JPEG */
async function makeJpeg(width, height) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 220 } }
  }).jpeg({ quality: 80 }).toBuffer();
}

/** 把一段 JPEG 包进一个最小可用的 TIFF/DNG 容器里 */
function wrapInTiff(jpeg, { width = 0, height = 0, littleEndian = true } = {}) {
  const entries = [];
  const header = Buffer.alloc(8);
  if (littleEndian) {
    header.write('II', 0, 'latin1');
    header.writeUInt16LE(42, 2);
    header.writeUInt32LE(8, 4);
  } else {
    header.write('MM', 0, 'latin1');
    header.writeUInt16BE(42, 2);
    header.writeUInt32BE(8, 4);
  }

  const entryCount = 4;
  const ifdSize = 2 + entryCount * 12 + 4;
  const jpegOffset = 8 + ifdSize + 16;      // 留一点空隙，让偏移不是紧挨着

  const entry = (tag, type, count, value) => {
    const b = Buffer.alloc(12);
    if (littleEndian) {
      b.writeUInt16LE(tag, 0); b.writeUInt16LE(type, 2); b.writeUInt32LE(count, 4); b.writeUInt32LE(value, 8);
    } else {
      b.writeUInt16BE(tag, 0); b.writeUInt16BE(type, 2); b.writeUInt32BE(count, 4); b.writeUInt32BE(value, 8);
    }
    return b;
  };

  entries.push(entry(0x0100, 4, 1, width));            // ImageWidth
  entries.push(entry(0x0101, 4, 1, height));           // ImageLength
  entries.push(entry(0x0201, 4, 1, jpegOffset));       // JPEGInterchangeFormat
  entries.push(entry(0x0202, 4, 1, jpeg.length));      // JPEGInterchangeFormatLength

  const ifdCount = Buffer.alloc(2);
  if (littleEndian) ifdCount.writeUInt16LE(entryCount, 0); else ifdCount.writeUInt16BE(entryCount, 0);
  const nextIfd = Buffer.alloc(4);                      // 0 = 没有下一个 IFD

  return Buffer.concat([header, ifdCount, ...entries, nextIfd, Buffer.alloc(16), jpeg]);
}

function tmpFile(name, buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-raw-'));
  const full = path.join(dir, name);
  fs.writeFileSync(full, buffer);
  return full;
}

test('认得 RAW 扩展名', () => {
  for (const name of ['a.DNG', 'b.rw2', 'c.CR2', 'd.CR3', 'e.NEF', 'f.ARW', 'g.ORF', 'h.RAF']) {
    assert.ok(isRawFile(name), `${name} 应该被认成 RAW`);
  }
  assert.ok(!isRawFile('a.jpg'), 'jpg 不是 RAW');
  assert.ok(!isRawFile('a.mp4'), 'mp4 不是 RAW');
});

test('从 TIFF/DNG 容器里按 IFD 抠出内嵌 JPEG 预览（大端小端都要行）', async (t) => {
  if (!sharp) { t.skip('没装 sharp'); return; }

  for (const littleEndian of [true, false]) {
    const jpeg = await makeJpeg(1600, 1200);
    const file = tmpFile(`test${littleEndian ? 'le' : 'be'}.dng`, wrapInTiff(jpeg, { width: 6000, height: 4000, littleEndian }));

    const preview = extractRawPreview(file);
    assert.ok(preview, `${littleEndian ? '小端' : '大端'}容器里应该能找到预览`);
    assert.strictEqual(preview.source, 'tiff');
    assert.strictEqual(preview.width, 1600, '预览宽高要能解析出来');
    assert.strictEqual(preview.height, 1200);
    assert.strictEqual(preview.buffer.length, jpeg.length, '抠出来的就是那段 JPEG');
    assert.deepStrictEqual(preview.buffer.subarray(0, 2), Buffer.from([0xff, 0xd8]));
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('结构不认识时（CR3/RAF 这类）扫最大的一段 JPEG 兜底', async (t) => {
  if (!sharp) { t.skip('没装 sharp'); return; }

  const small = await makeJpeg(320, 240);
  const big = await makeJpeg(1600, 1200);
  // 前面是"看不懂的头部"，中间夹一张小预览、后面一张大预览
  const file = tmpFile('unknown.cr3', Buffer.concat([
    Buffer.alloc(2048, 0x11),
    small,
    Buffer.alloc(1024, 0x22),
    big,
    Buffer.alloc(512, 0x33),
  ]));

  const preview = extractRawPreview(file);
  assert.ok(preview, '兜底扫描应该能找到 JPEG');
  assert.strictEqual(preview.source, 'scan');
  assert.strictEqual(preview.width, 1600, '应该挑最大的那段（不是前面那张小图）');
  assert.strictEqual(preview.height, 1200);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('完全没有 JPEG 的文件返回 null（不抛异常）', () => {
  const file = tmpFile('empty.dng', Buffer.alloc(4096, 0x5a));
  assert.strictEqual(extractRawPreview(file), null);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('文件不存在也返回 null（扫描时不能因为一个坏文件就崩）', () => {
  assert.strictEqual(extractRawPreview('/tmp/niupic-not-exists-9f3a.rw2'), null);
});

test('jpegSize 解析 SOF 段拿到宽高', async (t) => {
  if (!sharp) { t.skip('没装 sharp'); return; }
  const jpeg = await makeJpeg(1234, 567);
  const size = jpegSize(jpeg);
  assert.deepStrictEqual(size, { width: 1234, height: 567 });
  assert.strictEqual(jpegSize(Buffer.from([1, 2, 3])), null);
});
