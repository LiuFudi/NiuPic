// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 扫描素材库：目录遍历必须找得到文件
 *
 * 背景（用户报的 bug）：新建了一个图库之后扫描不出来任何图片。
 * 查下来是遍历用的 `glob('**\/*.*', { nocase: true })`：
 *
 *   glob('/vol1/.../frontend/src/**\/*.js', { nodir: true })              → 47 个
 *   glob('/vol1/.../frontend/src/**\/*.js', { nodir: true, nocase: true }) →  0 个
 *   glob('/vol1/.../package.json',           { nocase: true })             →  0 个（文件明明存在！）
 *
 * 也就是 **btrfs 上带 nocase 的 glob 一个都匹配不到**（飞牛的数据盘就是 btrfs），
 * 而同样的调用放在 /tmp（ext4/tmpfs）上完全正常 —— 所以本地测试和端到端一直是绿的，
 * 只有真机上「扫描完成，0 个文件」。那个库的路径里恰好带大写（Photos-Backup），
 * 但这纯属巧合 —— 换任何路径都一样扫不出来。
 *
 * 现在改成自己 readdir 递归，不依赖 glob 的大小写匹配。这里钉住三件事：
 *   1. 各种"刁钻"的文件名都能找到（大写扩展名、中文、空格、深层目录、纯大写路径）
 *   2. 应用自己的目录（.niupic / .flypic / node_modules）要跳过
 *   3. 根目录读不了要抛出能看懂的错，而不是静悄悄返回空数组
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getAllImageFiles } = require('../utils/scanner');

/** 造一棵像相机卡一样的目录树 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-walk-'));
  const write = (rel) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
    return full;
  };

  write('S5M2X/2.20/103_PANA/P1000001.JPG');       // 大写扩展名
  write('S5M2X/2.20/103_PANA/P1000002.RW2');       // 相机 RAW
  write('S5M2X/2.20/103_PANA/图/P1000003.jpg');    // 中文目录
  write('Photos-Backup/Camera/a.JPG');             // 路径里带大写 + 横杠
  write('佳能5D3/25.4.5/筛选/IMG 0001.CR2');         // 中文 + 空格
  write('顶层小写.jpg');
  write('noext');                                  // 没有扩展名的文件
  write('.hidden.jpg');                            // 隐藏文件
  write('.niupic/metadata.db');                    // 应用自己的目录
  write('.niupic/thumbnails/ab/xx.webp');
  write('.flypic/old.db');
  write('node_modules/pkg/index.js');
  write('sub/node_modules/inner/x.png');

  return root;
}

test('递归遍历能找到各种名字的文件（大小写、中文、空格、深层）', async () => {
  const root = makeFixture();
  try {
    const files = await getAllImageFiles(root);
    const rel = files.map((f) => path.relative(root, f)).sort();

    for (const want of [
      'S5M2X/2.20/103_PANA/P1000001.JPG',
      'S5M2X/2.20/103_PANA/P1000002.RW2',
      'S5M2X/2.20/103_PANA/图/P1000003.jpg',
      'Photos-Backup/Camera/a.JPG',
      '佳能5D3/25.4.5/筛选/IMG 0001.CR2',
      '顶层小写.jpg',
      '.hidden.jpg',
    ]) {
      assert.ok(rel.includes(want), `应该找到 ${want}（实际找到 ${rel.length} 个：${rel.join(', ')}）`);
    }
    // 没有扩展名的也照样收（老行为是 *.* 匹配"带点的名字"，这里放宽到"所有文件"，
    // 反正真正是不是图片由后面的 processImage 判断）
    assert.ok(rel.includes('noext'), '没有扩展名的文件也应该被列出来');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('跳过应用自己的目录和 node_modules', async () => {
  const root = makeFixture();
  try {
    const rel = (await getAllImageFiles(root)).map((f) => path.relative(root, f));
    assert.ok(!rel.some((p) => p.includes('.niupic')), `.niupic 里的东西不该被扫进来：${rel.join(', ')}`);
    assert.ok(!rel.some((p) => p.includes('.flypic')), '.flypic 同理');
    assert.ok(!rel.some((p) => p.includes('node_modules')), 'node_modules 同理');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('空目录返回空数组（这是"真的没有文件"，不是出错）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-empty-'));
  try {
    assert.deepStrictEqual(await getAllImageFiles(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('根目录读不了时抛出能看懂的错，而不是静悄悄返回空', async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('root 无视权限位，跳过');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-noperm-'));
  fs.writeFileSync(path.join(root, 'a.jpg'), 'x');
  fs.chmodSync(root, 0o000);
  try {
    await assert.rejects(
      () => getAllImageFiles(root),
      (error) => {
        assert.strictEqual(error.name, 'ScanPathError');
        assert.match(error.message, /无法读取素材库目录/);
        assert.match(error.message, /可访问文件夹/);
        assert.strictEqual(error.dirPath, root);
        return true;
      }
    );
  } finally {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('源码里不许再用 glob 的 nocase 匹配（btrfs 上会全空）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'scanner.js'), 'utf8');
  // 注释里会提到 nocase（解释为什么不能用），所以先把注释去掉再查代码
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  assert.ok(!/nocase/.test(code), 'scanner.js 的代码里又出现 nocase 了 —— btrfs 上会让扫描结果为空');
  assert.ok(
    !/require\(['"]glob['"]\)/.test(code),
    'scanner.js 又 require 了 glob —— 目录遍历请用 readdir（见 getAllImageFiles 的注释）'
  );
});
