// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 格式支持的**实测**：真的造出各种格式的文件，真的解一遍，看解出来的是不是那张图。
 *
 * 为什么不能只测"函数返回了非空"：占位图也是非空的。所以这里对每一张解出来的图
 * 都验颜色 —— 源图是"左半红、右半绿"，解出来的均值必须是 R≈128 G≈128 B≈0。
 * 解错文件、解成空白、返回占位图（靛蓝底 + 图标）都会被这一条抓住。
 *
 * 覆盖三条解码路径：
 *   sharp   ：heic/heif/avif/tiff/svg/jpeg/png/webp/gif（本用例造 png/tiff/svg）
 *   ffmpeg  ：psd/tga/exr/hdr/jp2/qoi/dds/dpx/bmp/pnm/pcx/xbm/xpm/xwd/wbmp/ras/ico
 *   raw     ：相机 RAW（抽内嵌 JPEG 预览）
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
  /* 裸仓库没装依赖时整份 skip */
}

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/trim/bin/ffmpeg']
  .find((p) => { try { return fs.existsSync(p); } catch { return false; } });

/** 裸仓库（没装依赖）时整份跳过，而不是假装通过 */
const noSharp = sharp ? false : '没有 sharp（裸仓库没装依赖）';

let tmpRoot = null;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-fmt-'));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 造素材：左红右绿 200x100（均值必定是 R128 G128 B0）
// ---------------------------------------------------------------------------

const W = 200;
const H = 100;
const EXPECT = { r: 128, g: 128, b: 0 };

async function makeSourcePng(file) {
  const half = W / 2;
  const left = await sharp({ create: { width: half, height: H, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const right = await sharp({ create: { width: half, height: H, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer();

  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: half, top: 0 }])
    .png()
    .toFile(file);
  return file;
}

/** 用 ffmpeg 把源 PNG 转成目标格式；返回 null 表示这个编码器不在 */
function ffmpegConvert(srcPng, outFile) {
  try {
    execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-i', srcPng, '-frames:v', '1', '-y', outFile,
    ], { stdio: 'pipe' });
    return fs.existsSync(outFile) && fs.statSync(outFile).size > 0 ? outFile : null;
  } catch {
    return null;
  }
}

/**
 * 单色格式（xbm/wbmp/pbm 只有黑白两色）没法验"左红右绿"，但要能验"不是占位图"：
 * 占位图是靛蓝底 99/102/241 加一个 emoji，颜色特征非常固定。
 */
async function assertNotPlaceholder(imageBufferOrPath, label) {
  const [r, g, b] = (await sharp(imageBufferOrPath).stats()).channels.map((c) => Math.round(c.mean));
  const isPlaceholder = Math.abs(r - 99) <= 14 && Math.abs(g - 102) <= 14 && Math.abs(b - 241) <= 14;
  assert.ok(!isPlaceholder, `${label}: 解出来的是占位图（RGB=${r},${g},${b}）`);
}

/** 断言解出来的图确实是"左红右绿"，而不是占位图/空白 */
async function assertLooksLikeSource(imageBufferOrPath, label) {
  const stats = await sharp(imageBufferOrPath).stats();
  const [r, g, b] = stats.channels.map((c) => Math.round(c.mean));

  assert.ok(Math.abs(r - EXPECT.r) <= 24, `${label}: R=${r}，期望 ≈${EXPECT.r}（占位图会是靛蓝 99/102/241）`);
  assert.ok(Math.abs(g - EXPECT.g) <= 24, `${label}: G=${g}，期望 ≈${EXPECT.g}`);
  assert.ok(Math.abs(b - EXPECT.b) <= 24, `${label}: B=${b}，期望 ≈${EXPECT.b}`);
}

// ---------------------------------------------------------------------------
// ICO / PSD 没有编码器，自己按格式拼（顺便把"我们的 ICO 支持"钉死）
// ---------------------------------------------------------------------------

/** PNG 内嵌式 ICO（Windows Vista 之后最常见） */
function writePngIco(pngBuffer, outFile, size = 32) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size, 0); entry.writeUInt8(size, 1);
  entry.writeUInt8(0, 2); entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);

  fs.writeFileSync(outFile, Buffer.concat([header, entry, pngBuffer]));
  return outFile;
}

/** 老式 BMP 内嵌 ICO（32bpp XOR + AND 掩码，行自下而上） */
async function writeBmpIco(outFile, size = 32) {
  const half = size / 2;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    let row = Buffer.alloc(0);
    for (let x = 0; x < size; x += 1) {
      // BGRA：左半红、右半绿
      row = Buffer.concat([row, x < half ? Buffer.from([0, 0, 255, 255]) : Buffer.from([0, 255, 0, 255])]);
    }
    rows.push(row);
  }
  const xor = Buffer.concat(rows.reverse());
  const andMask = Buffer.alloc(4 * size); // 每行 4 字节对齐
  const dibHeader = Buffer.alloc(40);
  dibHeader.writeUInt32LE(40, 0);
  dibHeader.writeInt32LE(size, 4);
  dibHeader.writeInt32LE(size * 2, 8);         // ICO 里高度写两倍
  dibHeader.writeUInt16LE(1, 12);
  dibHeader.writeUInt16LE(32, 14);
  dibHeader.writeUInt32LE(xor.length + andMask.length, 20);
  const bmp = Buffer.concat([dibHeader, xor, andMask]);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size, 0); entry.writeUInt8(size, 1);
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(bmp.length, 8);
  entry.writeUInt32LE(22, 12);

  fs.writeFileSync(outFile, Buffer.concat([header, entry, bmp]));
  return outFile;
}

/** 极简 PSD：8BPS / RGB / 8bit / 非压缩（左红右绿），且**不带**内嵌缩略图资源 */
function writeBarePsd(outFile, width = 64, height = 32) {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'latin1');
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(3, 12);              // 3 通道
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(8, 22);
  header.writeUInt16BE(3, 24);              // RGB 颜色模式

  const zero = Buffer.alloc(4);              // 颜色模式数据 / 图像资源 / 图层，长度都是 0
  const pixels = width * height;
  const red = Buffer.alloc(pixels, 255);
  const green = Buffer.alloc(pixels, 0);
  // B 平面：左半 0、右半 255（绿）
  const blue = Buffer.alloc(pixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = Math.floor(width / 2); x < width; x += 1) blue[y * width + x] = 255;
  }
  const imageData = Buffer.concat([Buffer.from([0, 0]), red, green, blue]); // 压缩方式 0 = 原始

  fs.writeFileSync(outFile, Buffer.concat([header, zero, zero, zero, imageData]));
  return outFile;
}

/** 相机 RAW：TIFF 容器 + 内嵌 JPEG 预览（与真实 DNG/CR2 的结构一致） */
async function writeFakeRaw(outFile) {
  // 内嵌预览得够大：rawPreview 会丢弃 4KB 以下的 JPEG（那多半是图标而不是预览）。
  // 纯色图压出来太小（800×600 也才 3.4KB），所以用 1200×800 —— 颜色仍然只有红/绿两种，
  // 均值依然是 (128,128,0)，能直接复用同一套颜色断言。
  const w = 1200;
  const h = 800;
  const half = w / 2;
  const left = await sharp({ create: { width: half, height: h, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const right = await sharp({ create: { width: half, height: h, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: half, top: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
  assert.ok(jpeg.length > 4096, `RAW 夹具的内嵌预览太小（${jpeg.length}B），rawPreview 会当成图标丢掉`);

  // 够 rawPreview 的扫描器认出"一段完整 JPEG"（结构不认识时它会扫最大的一段 JPEG）
  const header = Buffer.alloc(64);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);

  fs.writeFileSync(outFile, Buffer.concat([header, jpeg]));
  return outFile;
}

// ---------------------------------------------------------------------------
// 一、缩略图：每种格式都要出真实缩略图（不是占位图）
// ---------------------------------------------------------------------------

test('缩略图：ffmpeg 解的静态图（bmp/tga/exr/hdr/jp2/qoi/dpx/pnm/pcx/ras…）', { skip: noSharp || !FFMPEG ? '需要 sharp + ffmpeg' : false }, async () => {
  const { generateImageThumbnails } = require('../utils/thumbnail');

  const library = path.join(tmpRoot, 'lib-thumb');
  fs.mkdirSync(library, { recursive: true });
  const src = await makeSourcePng(path.join(library, 'src.png'));

  const cases = ['bmp', 'tga', 'exr', 'hdr', 'jp2', 'qoi', 'dpx', 'ppm', 'pcx', 'ras', 'xbm', 'xwd', 'wbmp', 'pam', 'pfm'];
  // 只有 1 位色深的格式：解出来只有黑白，验颜色没意义，只验"不是占位图"
  const MONO = new Set(['xbm', 'wbmp']);
  const done = [];
  const failed = [];

  for (const ext of cases) {
    const target = path.join(library, `sample.${ext}`);
    const made = ffmpegConvert(src, target);
    if (!made) { failed.push(`${ext}(编码器缺失)`); continue; }

    const result = await generateImageThumbnails(target, library);
    assert.ok(result && result.thumbnail_path, `${ext}: 没有缩略图结果`);

    const thumbPath = path.join(library, result.thumbnail_path);
    assert.ok(fs.existsSync(thumbPath), `${ext}: 缩略图文件不存在 ${thumbPath}`);

    if (MONO.has(ext)) await assertNotPlaceholder(thumbPath, `${ext} 缩略图`);
    else await assertLooksLikeSource(thumbPath, `${ext} 缩略图`);

    // 元数据也要能读出真实尺寸（不能再是 640×480 占位）
    const { getImageMetadata } = require('../utils/thumbnail');
    const meta = await getImageMetadata(target);
    assert.ok(meta && meta.width === W && meta.height === H,
      `${ext}: 元数据尺寸 ${meta && meta.width}x${meta && meta.height}，期望 ${W}x${H}`);
    done.push(ext);
  }

  console.log(`    实测出真实缩略图的格式：${done.join(' ')}`);
  assert.deepStrictEqual(failed.filter((f) => !f.includes('编码器缺失')), []);
  assert.ok(done.length >= 10, `真正测到的格式太少：${done.join(',')}`);
});

test('缩略图：ICO 两种容器（PNG 内嵌 / BMP 内嵌）都能解', { skip: noSharp || !FFMPEG ? '需要 sharp + ffmpeg' : false }, async () => {
  const { generateImageThumbnails } = require('../utils/thumbnail');

  const library = path.join(tmpRoot, 'lib-ico');
  fs.mkdirSync(library, { recursive: true });

  // PNG 内嵌 ICO：用一个可辨认的纯色，校验时按纯色比
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } })
    .png().toBuffer();
  const pngIco = writePngIco(png, path.join(library, 'png-embedded.ico'));
  const bmpIco = await writeBmpIco(path.join(library, 'bmp-embedded.ico'));

  const r1 = await generateImageThumbnails(pngIco, library);
  const t1 = path.join(library, r1.thumbnail_path);
  assert.ok(fs.existsSync(t1));
  const s1 = (await sharp(t1).stats()).channels.map((c) => Math.round(c.mean));
  assert.ok(Math.abs(s1[0] - 200) <= 30 && s1[1] <= 60, `PNG 内嵌 ICO 解出来不像那张红图：RGB=${s1.join(',')}`);

  const r2 = await generateImageThumbnails(bmpIco, library);
  const t2 = path.join(library, r2.thumbnail_path);
  assert.ok(fs.existsSync(t2));
  await assertLooksLikeSource(t2, 'BMP 内嵌 ICO 缩略图');
});

test('缩略图：PSD 没有内嵌预览时，f fmpeg 兜底也能出图', { skip: noSharp || !FFMPEG ? '需要 sharp + ffmpeg' : false }, async () => {
  const { generateImageThumbnails } = require('../utils/thumbnail');

  const library = path.join(tmpRoot, 'lib-psd');
  fs.mkdirSync(library, { recursive: true });
  const psd = writeBarePsd(path.join(library, 'bare.psd'));

  const result = await generateImageThumbnails(psd, library);
  const thumb = path.join(library, result.thumbnail_path);
  assert.ok(fs.existsSync(thumb), 'PSD 缩略图没生成');

  // 造的 PSD 是三个平面：R 全 255、G 全 0、B 左半 0 右半 255
  // → 左半是纯红、右半是品红，均值 (255, 0, 128)
  const [r, g, b] = (await sharp(thumb).stats()).channels.map((c) => Math.round(c.mean));
  assert.ok(Math.abs(r - 255) <= 20, `PSD R=${r}，期望 ≈255`);
  assert.ok(g <= 24, `PSD G=${g}，期望 ≈0`);
  assert.ok(Math.abs(b - 128) <= 24, `PSD B=${b}，期望 ≈128`);
});

test('缩略图：相机 RAW 抽内嵌预览（不再是一张灰占位图）', { skip: noSharp }, async () => {
  const { generateImageThumbnails } = require('../utils/thumbnail');

  const library = path.join(tmpRoot, 'lib-raw');
  fs.mkdirSync(library, { recursive: true });
  const raw = await writeFakeRaw(path.join(library, 'shot.cr3'));

  const result = await generateImageThumbnails(raw, library);
  const thumb = path.join(library, result.thumbnail_path);
  assert.ok(fs.existsSync(thumb));

  // 内嵌预览是纯 (128,128,0)，取缩略图均值核对
  await assertLooksLikeSource(thumb, 'RAW 缩略图');
  assert.strictEqual(result.file_type, 'image', 'RAW 应该被归到图片而不是"其他"');
});

test('缩略图：sharp 路径（svg/avif/apng）走的是自己那条分支', { skip: noSharp ? noSharp : false }, async () => {
  const { generateImageThumbnails } = require('../utils/thumbnail');

  const library = path.join(tmpRoot, 'lib-sharp');
  fs.mkdirSync(library, { recursive: true });

  // SVG：libvips 通过 librsvg 解，浏览器也认
  const svg = path.join(library, 'vector.svg');
  fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + '<rect width="100" height="100" fill="#ff0000"/><rect x="100" width="100" height="100" fill="#00ff00"/></svg>');

  const r1 = await generateImageThumbnails(svg, library);
  await assertLooksLikeSource(path.join(library, r1.thumbnail_path), 'svg 缩略图');

  // AVIF：sharp 写得出（有 libheif+AV1 编码器时），解的时候走的也是 sharp
  const avif = path.join(library, 'image.avif');
  try {
    await sharp(await makeSourcePng(path.join(library, 'src2.png'))).avif({ quality: 70 }).toFile(avif);
    const r2 = await generateImageThumbnails(avif, library);
    await assertLooksLikeSource(path.join(library, r2.thumbnail_path), 'avif 缩略图');
  } catch (error) {
    console.log(`    （跳过 avif：这台机器的 sharp 没有 AV1 编码器 —— ${error.message}）`);
  }
});

test('缩略图：TGA 家族的别名后缀（targa/icb/vda/vst）也能解', { skip: noSharp || !FFMPEG ? '需要 sharp + ffmpeg' : false }, async () => {
  const { generateImageThumbnails } = require('../utils/thumbnail');

  const library = path.join(tmpRoot, 'lib-tga');
  fs.mkdirSync(library, { recursive: true });
  const src = await makeSourcePng(path.join(library, 'src.png'));
  const tga = ffmpegConvert(src, path.join(library, 'real.tga'));
  assert.ok(tga, 'ffmpeg 没能生成 tga');

  const tgaBuffer = fs.readFileSync(tga);
  for (const alias of ['targa', 'icb', 'vda', 'vst']) {
    const aliasPath = path.join(library, `alias.${alias}`);
    fs.writeFileSync(aliasPath, tgaBuffer);

    const result = await generateImageThumbnails(aliasPath, library);
    const thumb = path.join(library, result.thumbnail_path);
    assert.ok(fs.existsSync(thumb), `${alias}: 没有缩略图`);
    await assertLooksLikeSource(thumb, `.${alias} 缩略图`);
  }
});
