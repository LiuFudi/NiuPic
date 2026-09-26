// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 预览转码服务（utils/preview.js）：把浏览器不认的图变成能看的图。
 *
 * 缩略图能出、点开却是白屏，是最容易漏的一种"半成品支持"。
 * 这里钉住的是预览这一层：
 *   · 浏览器认的格式不转码（原样发原图，保留动图）
 *   · 不认的格式真的转出正确的画面（验颜色，不只看文件存在）
 *   · 缓存能用、能自愈（源文件改了要重转）
 *   · 转不出来的老实返回 null（路由据此回 422，而不是发一张空白图）
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  /* 裸仓库跳过 */
}

const noSharp = sharp ? false : '没有 sharp（裸仓库没装依赖）';

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/trim/bin/ffmpeg']
  .find((p) => { try { return fs.existsSync(p); } catch { return false; } });

const preview = require('../utils/preview');
const formats = require('../src/config/formats');

let tmpRoot = null;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-preview-'));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const W = 400;
const H = 200;

/** 造一张左红右绿的图（均值必定 R≈128 G≈128 B≈0） */
async function makeSource(file, format = 'png') {
  const half = W / 2;
  const left = await sharp({ create: { width: half, height: H, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const right = await sharp({ create: { width: half, height: H, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer();

  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: half, top: 0 }])
    .toFormat(format)
    .toFile(file);

  return file;
}

async function assertRedGreen(file, label) {
  const [r, g, b] = (await sharp(file).stats()).channels.map((c) => Math.round(c.mean));
  assert.ok(Math.abs(r - 128) <= 24 && Math.abs(g - 128) <= 24 && Math.abs(b) <= 24,
    `${label}: 解出来 RGB=${r},${g},${b}，期望 ≈128,128,0（占位/空白图会是别的值）`);
}

/**
 * 手写一个**未压缩** DDS（A8R8G8B8，左红右绿，行自上而下）。
 * 为什么自己拼：ffmpeg 有 dds 解码器但没有 dds 编码器 ——
 * 不自己造夹具，这条"支持 dds"就只能靠嘴说。
 */
function writeDds(outFile, width = 64, height = 32, pixel = (x, y) => {
  void y;
  return x < width / 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]; // RGBA
}) {
  const HEADER = 128;
  const header = Buffer.alloc(HEADER);
  header.write('DDS ', 0, 'latin1');
  header.writeUInt32LE(124, 4);              // dwSize
  header.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x1000 | 0x8, 8); // CAPS|HEIGHT|WIDTH|PIXELFORMAT|PITCH
  header.writeUInt32LE(height, 12);
  header.writeUInt32LE(width, 16);
  header.writeUInt32LE(width * 4, 20);       // pitch
  header.writeUInt32LE(0, 24);               // depth
  header.writeUInt32LE(0, 28);               // mipmap count
  // DDS_PIXELFORMAT：32 字节，A8R8G8B8
  header.writeUInt32LE(32, 76);
  header.writeUInt32LE(0x41, 80);            // RGB | ALPHAPIXELS
  header.writeUInt32LE(0, 84);               // fourCC = 0 → 未压缩
  header.writeUInt32LE(32, 88);
  header.writeUInt32LE(0x00ff0000, 92);      // R
  header.writeUInt32LE(0x0000ff00, 96);      // G
  header.writeUInt32LE(0x000000ff, 100);     // B
  header.writeUInt32LE(0xff000000, 104);     // A
  header.writeUInt32LE(0x1000, 108);         // DDSCAPS_TEXTURE

  const pixels = Buffer.alloc(width * height * 4);
  let off = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      pixels.writeUInt8(b, off); pixels.writeUInt8(g, off + 1);
      pixels.writeUInt8(r, off + 2); pixels.writeUInt8(a, off + 3);
      off += 4;
    }
  }

  fs.writeFileSync(outFile, Buffer.concat([header, pixels]));
  return outFile;
}

/**
 * 手写一个**不带内嵌缩略图**的最小 PSD（8BPS，RGB，非压缩）。
 * 这条路径要走 ffmpeg 兜底解码：真实 PSD 大多带内嵌预览，不带的时候以前就是一张占位图。
 */
function writeBarePsd(outFile, width = 64, height = 32) {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'latin1');
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(3, 12);
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(8, 22);
  header.writeUInt16BE(3, 24);

  const pixels = width * height;
  const red = Buffer.alloc(pixels, 255);
  const green = Buffer.alloc(pixels, 0);
  const blue = Buffer.alloc(pixels, 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = Math.floor(width / 2); x < width; x += 1) blue[y * width + x] = 255;
  }

  const zero = Buffer.alloc(4);
  fs.writeFileSync(outFile, Buffer.concat([
    header, zero, zero, zero, Buffer.from([0, 0]), red, green, blue,
  ]));
  return outFile;
}

/**
 * 带内嵌预览、但**图像数据是坏的** PSD。
 *
 * 用来验"ffmpeg 解不动时的退路"：真实 PSD 的压缩变体很多（RLE/ZIP/预测），
 * ffmpeg 偶尔吃不下。这时候如果只回 422，用户看到的是"打不开"，
 * 而文件里明明存着一张作者自己写的预览图。
 */
async function writePsdWithEmbeddedThumb(outFile, width = 96, height = 48) {
  const half = width / 2;
  const left = await sharp({ create: { width: half, height, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const right = await sharp({ create: { width: half, height, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer();
  const thumbJpeg = await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: half, top: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();

  const head28 = Buffer.alloc(28);
  head28.writeUInt32BE(1, 0);
  head28.writeUInt32BE(width, 4);
  head28.writeUInt32BE(height, 8);
  head28.writeUInt32BE(width * 3, 12);
  head28.writeUInt32BE(28 + thumbJpeg.length, 16);
  head28.writeUInt32BE(thumbJpeg.length, 20);
  head28.writeUInt16BE(24, 24);
  head28.writeUInt16BE(1, 26);
  const resourceData = Buffer.concat([head28, thumbJpeg]);
  const pad = (b) => (b.length % 2 === 0 ? b : Buffer.concat([b, Buffer.alloc(1)]));
  const sizeField = Buffer.alloc(4);
  sizeField.writeUInt32BE(resourceData.length, 0);
  const block = Buffer.concat([
    Buffer.from('8BIM', 'latin1'), Buffer.from([0x04, 0x0c]), Buffer.from([0x00, 0x00]),
    sizeField, pad(resourceData),
  ]);

  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'latin1');
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(3, 12);
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(8, 22);
  header.writeUInt16BE(3, 24);

  const zero = Buffer.alloc(4);
  const irLen = Buffer.alloc(4);
  irLen.writeUInt32BE(block.length, 0);

  // 图像数据：声明 RLE 压缩，但后面不给数据 —— ffmpeg 必然解不出来
  const brokenImageData = Buffer.from([0x00, 0x01]);

  fs.writeFileSync(outFile, Buffer.concat([header, zero, irLen, block, zero, brokenImageData]));
  return outFile;
}

function ffmpegTo(src, out) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', src, '-frames:v', '1', '-y', out], { stdio: 'pipe' });
  return out;
}

// ---------------------------------------------------------------------------

test('浏览器认的格式不转码（jpg/png/webp/gif/avif/bmp/svg）', { skip: noSharp }, () => {
  for (const name of ['a.jpg', 'a.jpeg', 'a.png', 'a.webp', 'a.gif', 'a.avif', 'a.bmp', 'a.svg', 'a.JPG']) {
    assert.strictEqual(preview.needsConversion(`/lib/${name}`), false, `${name} 不该转码`);
  }
  // 这些浏览器不认，必须转
  for (const name of ['a.heic', 'a.heif', 'a.tiff', 'a.psd', 'a.tga', 'a.qoi', 'a.exr', 'a.ico', 'a.cr3', 'a.dng']) {
    assert.strictEqual(preview.needsConversion(`/lib/${name}`), true, `${name} 必须转码`);
  }
});

test('只有"图片"类别才转码（视频/文档/设计稿不在这里处理）', { skip: noSharp }, () => {
  assert.ok(preview.isConvertible('/lib/a.heic'));
  assert.ok(preview.isConvertible('/lib/a.psd'));
  assert.ok(preview.isConvertible('/lib/a.cr3'));

  assert.ok(!preview.isConvertible('/lib/a.mp4'), '视频不该走图片预览转码');
  assert.ok(!preview.isConvertible('/lib/a.pdf'));
  assert.ok(!preview.isConvertible('/lib/a.psd.bak'));
  // 没有解码器的格式（jxl）也不能假装能转
  assert.ok(!preview.isConvertible('/lib/a.jxl'));
});

test('ffmpeg 解的格式：真的转出正确的画面（psd/tga/icb/exr/qoi/ico/dds…）', { skip: noSharp || !FFMPEG ? '需要 sharp + ffmpeg' : false }, async () => {
  const library = path.join(tmpRoot, 'lib-ffmpeg');
  fs.mkdirSync(library, { recursive: true });
  const src = await makeSource(path.join(library, 'src.png'));

  const cases = ['tga', 'exr', 'qoi', 'dds', 'dpx', 'pcx', 'ppm', 'pfm', 'xwd', 'bmp', 'jp2'];
  const done = [];
  const missing = [];

  for (const ext of cases) {
    const target = path.join(library, `pic.${ext}`);
    try {
      ffmpegTo(src, target);
    } catch {
      missing.push(ext);
      continue;
    }

    const result = await preview.ensurePreview(target, library);
    assert.ok(result, `${ext}: 预览没转出来`);
    assert.ok(fs.existsSync(result.path), `${ext}: 预览文件不存在`);
    await assertRedGreen(result.path, `.${ext} 预览`);
    done.push(ext);
  }

  // 这两个 ffmpeg 只会解、不会编码，用例自己拼文件
  const dds = writeDds(path.join(library, 'hand.dds'));
  const ddsPreview = await preview.ensurePreview(dds, library);
  assert.ok(ddsPreview, 'dds: 预览没转出来');
  await assertRedGreen(ddsPreview.path, '.dds 预览');
  done.push('dds');

  const psd = writeBarePsd(path.join(library, 'hand.psd'));
  const psdPreview = await preview.ensurePreview(psd, library);
  assert.ok(psdPreview, 'psd: 预览没转出来');
  {
    // PSD 三个平面：R 全 255、G 全 0、B 左 0 右 255 → 均值 (255,0,128)
    const [r, g, b] = (await sharp(psdPreview.path).stats()).channels.map((c) => Math.round(c.mean));
    assert.ok(Math.abs(r - 255) <= 20 && g <= 24 && Math.abs(b - 128) <= 24,
      `psd 预览颜色不对：RGB=${r},${g},${b}，期望 ≈255,0,128`);
  }
  done.push('psd');

  console.log(`    预览实测通过：${done.join(' ')}${missing.length ? '（本机编码器缺失：' + missing.join(' ') + '）' : ''}`);
  assert.ok(done.length >= 10, `真正测到的格式太少：${done.join(',')}`);
});

test('TGA 别名后缀（targa/icb/vda/vst）也要能转（image2 认不出扩展名时显式给解码器）', { skip: noSharp || !FFMPEG ? '需要 sharp + ffmpeg' : false }, async () => {
  const library = path.join(tmpRoot, 'lib-alias');
  fs.mkdirSync(library, { recursive: true });
  const src = await makeSource(path.join(library, 'src.png'));
  const tga = ffmpegTo(src, path.join(library, 'real.tga'));
  const buffer = fs.readFileSync(tga);

  for (const alias of ['targa', 'icb', 'vda', 'vst']) {
    const file = path.join(library, `alias.${alias}`);
    fs.writeFileSync(file, buffer);

    const result = await preview.ensurePreview(file, library);
    assert.ok(result, `.${alias}: 预览没转出来`);
    await assertRedGreen(result.path, `.${alias} 预览`);
  }
});

test('ICO：PNG 内嵌与 BMP 内嵌两种容器都能转出预览', { skip: noSharp || !FFMPEG ? '需要 sharp + ffmpeg' : false }, async () => {
  const library = path.join(tmpRoot, 'lib-ico');
  fs.mkdirSync(library, { recursive: true });

  // PNG 内嵌
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 20, g: 40, b: 220, alpha: 1 } } })
    .png().toBuffer();
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(64, 0); entry.writeUInt8(64, 1);
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
  const pngIco = path.join(library, 'png.ico');
  fs.writeFileSync(pngIco, Buffer.concat([header, entry, png]));

  const r1 = await preview.ensurePreview(pngIco, library);
  assert.ok(r1, 'PNG 内嵌 ICO 没转出来');
  const [r, g, b] = (await sharp(r1.path).stats()).channels.map((c) => Math.round(c.mean));
  assert.ok(b > 180 && r < 80 && g < 90, `ICO 解出来颜色不对：RGB=${r},${g},${b}`);

  // BMP 内嵌（左红右绿，自下而上）
  const size = 32;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    let row = Buffer.alloc(0);
    for (let x = 0; x < size; x += 1) {
      row = Buffer.concat([row, x < size / 2 ? Buffer.from([0, 0, 255, 255]) : Buffer.from([0, 255, 0, 255])]);
    }
    rows.push(row);
  }
  const xor = Buffer.concat(rows.reverse());
  const andMask = Buffer.alloc(4 * size);
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0); dib.writeInt32LE(size, 4); dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(xor.length + andMask.length, 20);
  const bmp = Buffer.concat([dib, xor, andMask]);
  const h2 = Buffer.alloc(6);
  h2.writeUInt16LE(0, 0); h2.writeUInt16LE(1, 2); h2.writeUInt16LE(1, 4);
  const e2 = Buffer.alloc(16);
  e2.writeUInt8(size, 0); e2.writeUInt8(size, 1);
  e2.writeUInt16LE(1, 4); e2.writeUInt16LE(32, 6);
  e2.writeUInt32LE(bmp.length, 8); e2.writeUInt32LE(22, 12);
  const bmpIco = path.join(library, 'bmp.ico');
  fs.writeFileSync(bmpIco, Buffer.concat([h2, e2, bmp]));

  const r2 = await preview.ensurePreview(bmpIco, library);
  assert.ok(r2, 'BMP 内嵌 ICO 没转出来');
  await assertRedGreen(r2.path, 'BMP 内嵌 ICO 预览');
});

test('相机 RAW：预览用的是内嵌 JPEG（不再是空白）', { skip: noSharp }, async () => {
  const library = path.join(tmpRoot, 'lib-raw');
  fs.mkdirSync(library, { recursive: true });

  // 内嵌预览要超过 4KB，否则会被 rawPreview 当成图标丢掉
  const big = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 0, g: 128, b: 128 } } })
    .png().toBuffer();
  const jpeg = await sharp(big).jpeg({ quality: 92 }).toBuffer();
  const jpegBig = jpeg.length > 4096
    ? jpeg
    : await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 0, g: 128, b: 128 } } })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();

  const header = Buffer.alloc(64);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  const raw = path.join(library, 'shot.dng');
  fs.writeFileSync(raw, Buffer.concat([header, jpegBig]));

  assert.strictEqual(preview.needsConversion(raw), true);
  const result = await preview.ensurePreview(raw, library);
  assert.ok(result, 'RAW 预览没转出来');

  const [r, g, b] = (await sharp(result.path).stats()).channels.map((c) => Math.round(c.mean));
  assert.ok(g > 90 && b > 90 && r < 60, `RAW 预览颜色不对（期望青绿色）：RGB=${r},${g},${b}`);
});

test('缓存：第二次直接用缓存，源文件改了会自愈重转', { skip: noSharp || !FFMPEG ? '需要 sharp + ffmpeg' : false }, async () => {
  const library = path.join(tmpRoot, 'lib-cache');
  fs.mkdirSync(library, { recursive: true });
  const src = await makeSource(path.join(library, 'src.png'));
  const target = ffmpegTo(src, path.join(library, 'cache-me.qoi'));

  const first = await preview.ensurePreview(target, library);
  assert.ok(first && first.cached === false, '第一次应该是新生成的');

  const second = await preview.ensurePreview(target, library);
  assert.ok(second && second.cached === true, '第二次应该命中缓存');
  assert.strictEqual(second.path, first.path);

  // 把源文件改新（模拟"同名文件被替换"）→ 必须重转
  const stat = fs.statSync(target);
  fs.utimesSync(target, new Date(), new Date(stat.mtimeMs + 5000));
  const third = await preview.ensurePreview(target, library);
  assert.ok(third && third.cached === false, '源文件更新后应该重转，而不是继续用旧缓存');
});

test('size 参数：最长边被限制住', { skip: noSharp || !FFMPEG ? '需要 sharp + ffmpeg' : false }, async () => {
  const library = path.join(tmpRoot, 'lib-size');
  fs.mkdirSync(library, { recursive: true });
  const src = await makeSource(path.join(library, 'src.png'));
  const target = ffmpegTo(src, path.join(library, 'small.qoi'));

  const result = await preview.ensurePreview(target, library, { size: 256 });
  assert.ok(result, '预览没转出来');
  const meta = await sharp(result.path).metadata();
  assert.ok(meta.width <= 256 && meta.height <= 256, `尺寸没被限制：${meta.width}x${meta.height}`);
  assert.strictEqual(meta.width, 256, '400x200 按最长边 256 应该正好是 256x128');

  // 越界的 size 要被夹到合理范围，而不是照着执行
  assert.strictEqual(preview.clampSize(0), preview.DEFAULT_MAX_SIZE);
  assert.strictEqual(preview.clampSize('abc'), preview.DEFAULT_MAX_SIZE);
  assert.strictEqual(preview.clampSize(1), preview.MIN_MAX_SIZE);
  assert.strictEqual(preview.clampSize(999999), preview.MAX_MAX_SIZE);
});

test('转不出来的老实返回 null（路由据此回 422，而不是发一张空白图）', { skip: noSharp }, async () => {
  const library = path.join(tmpRoot, 'lib-bad');
  fs.mkdirSync(library, { recursive: true });

  // 后缀是图片但内容是垃圾
  const junk = path.join(library, 'broken.psd');
  fs.writeFileSync(junk, Buffer.from('这不是 PSD，是一堆垃圾字节'));

  const result = await preview.ensurePreview(junk, library);
  assert.strictEqual(result, null, '解不出来必须返回 null');

  // 空文件
  const empty = path.join(library, 'empty.tga');
  fs.writeFileSync(empty, Buffer.alloc(0));
  assert.strictEqual(await preview.ensurePreview(empty, library), null);
});

test('小图不会被放大（ffmpeg 的 scale 天然会把小图吹到目标尺寸）', { skip: noSharp || !FFMPEG ? '需要 sharp + ffmpeg' : false }, async () => {
  const library = path.join(tmpRoot, 'lib-noscale');
  fs.mkdirSync(library, { recursive: true });
  const src = await makeSource(path.join(library, 'src.png'));   // 400x200
  const target = ffmpegTo(src, path.join(library, 'small.qoi'));

  const result = await preview.ensurePreview(target, library);
  assert.ok(result, '预览没转出来');
  const meta = await sharp(result.path).metadata();

  // 实测过：`scale=4096:4096:force_original_aspect_ratio=decrease` 会把 400x200
  // 放大成 4096x2048，缓存里凭空多出几十倍体积的"放大版缩略图"。
  assert.strictEqual(meta.width, 400, `被放大了：${meta.width}x${meta.height}`);
  assert.strictEqual(meta.height, 200);
  assert.ok(fs.statSync(result.path).size < 200 * 1024, `小图的预览不该这么大：${fs.statSync(result.path).size}B`);
});

test('PSD：ffmpeg 解不动时退回到文件内的嵌预览（而不是回 422）', { skip: noSharp }, async () => {
  const library = path.join(tmpRoot, 'lib-psd-fallback');
  fs.mkdirSync(library, { recursive: true });

  const psd = await writePsdWithEmbeddedThumb(path.join(library, 'broken-data.psd'));
  const result = await preview.ensurePreview(psd, library);
  assert.ok(result, '有内嵌预览的 PSD 不该转不出来');

  // 内嵌预览本身就是左红右绿
  const [r, g, b] = (await sharp(result.path).stats()).channels.map((c) => Math.round(c.mean));
  assert.ok(Math.abs(r - 128) <= 24 && Math.abs(g - 128) <= 24 && b <= 24,
    `内嵌预览没被用上：RGB=${r},${g},${b}`);
});

test('缓存目录放在素材库的 .niupic/previews 下（不会污染用户的照片目录）', { skip: noSharp }, () => {
  const p = preview.cachePathFor('/vol1/photos/2024/a.psd', '/vol1/photos');
  assert.ok(p.startsWith(path.join('/vol1/photos', '.niupic', 'previews')), p);
  assert.ok(p.endsWith('.webp'));

  // 同一个相对路径 + 同一个尺寸 → 同一个缓存文件（缓存命中靠它）
  assert.strictEqual(p, preview.cachePathFor('/vol1/photos/2024/a.psd', '/vol1/photos'));
  assert.notStrictEqual(p, preview.cachePathFor('/vol1/photos/2024/b.psd', '/vol1/photos'));
  // 尺寸不同 → 各存各的（文件名里带尺寸，不需要额外的标记文件）
  assert.notStrictEqual(p, preview.cachePathFor('/vol1/photos/2024/a.psd', '/vol1/photos', 256));
  assert.ok(preview.cachePathFor('/vol1/photos/2024/a.psd', '/vol1/photos', 256).endsWith('_256.webp'));

  // clearPreviews 能把整个缓存目录删掉
  const root = path.join(tmpRoot, 'lib-clear');
  fs.mkdirSync(path.join(root, '.niupic', 'previews', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(root, '.niupic', 'previews', 'ab', 'x.webp'), 'x');
  assert.strictEqual(preview.clearPreviews(root), true);
  assert.ok(!fs.existsSync(path.join(root, '.niupic', 'previews')));
});

test('删掉文件时能按路径清掉它的全部预览缓存（不同尺寸一起清）', { skip: noSharp }, () => {
  const library = path.join(tmpRoot, 'lib-remove');
  const src = path.join(library, '2024', 'a.heic');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, 'x');

  const sizes = [256, 1024, 4096];
  const files = sizes.map((s) => preview.cachePathFor(src, library, s));
  for (const f of files) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'cache');
  }
  // 另一个文件的缓存不能被误删
  const otherFile = preview.cachePathFor(path.join(library, '2024', 'b.heic'), library, 4096);
  fs.mkdirSync(path.dirname(otherFile), { recursive: true });
  fs.writeFileSync(otherFile, 'cache');

  const removed = preview.removePreviewsFor(src, library);
  assert.strictEqual(removed, 3, `应该删掉 3 个尺寸，实际 ${removed}`);
  for (const f of files) assert.ok(!fs.existsSync(f), `没删掉 ${f}`);
  assert.ok(fs.existsSync(otherFile), '别的文件的缓存被误删了');

  // 再删一次不该报错（幂等）
  assert.strictEqual(preview.removePreviewsFor(src, library), 0);
});

test('预览的格式清单与 formats.js 保持一致（不另立一份）', { skip: noSharp }, () => {
  // 每个"有解码器"的图片格式，要么浏览器直显、要么可转码，不能两头都不占
  const dead = formats.IMAGE_EXT.filter((ext) => {
    const fake = `/lib/x.${ext}`;
    return !preview.needsConversion(fake) === false && !preview.isConvertible(fake);
  });
  assert.deepStrictEqual(dead, [], `这些格式既不能直显也不能转码：${dead.join(',')}`);
});
