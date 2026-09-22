// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
//
// 把收款码原图编译成"内嵌 data URI 的 JS 模块"（构建期执行，见《打赏功能规范》5.2）。
//
// 为什么不让界面直接引一张图片文件：包内（甚至已安装目录里）一个独立图片文件，
// 拆包覆盖一张就能换成别人的收款码，一行代码都不用改 —— 用户以为在支持原作者，
// 实际打给了别人。内嵌成数据之后想换就必须改代码、重新构建，那已经等于自己 fork
// 一份，受开源协议约束（GPL-3.0 §5 要求修改版显著标注已修改）。
//
// 边界要说清楚：这只堵住"换图片"这条路。开源协议下没有任何技术手段能阻止别人
// 改代码重新构建，真正的约束是协议本身。
//
// 原图放在打包目录之外（assets/donate/），生成物进仓库（前端源码里），
// 所以直接 clone 也能构建，不必先跑这个脚本。
//
// 用法: node scripts/make-donate-qr.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSET_DIR = path.join(ROOT, 'assets', 'donate');
const OUTPUT = path.join(ROOT, 'frontend', 'src', 'assets', 'donateQr.js');

// key 与 donate.json 里 qrcodes[].key 对应
const IMAGES = { wechat: 'wechat.png', alipay: 'alipay.png' };

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const HEADER = `// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
//
// 本文件由 scripts/make-donate-qr.js 生成，请勿手改。
// 收款码以 data URI 形式内嵌在这里：安装包内与安装后的目录里都不存在
// 一个"覆盖掉就能换成别人的收款码"的独立图片文件。`;

function build() {
  const entries = [];
  for (const key of Object.keys(IMAGES).sort()) {
    const file = path.join(ASSET_DIR, IMAGES[key]);
    if (!fs.existsSync(file)) {
      throw new Error(`缺少收款码原图: ${path.relative(ROOT, file)}`);
    }
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const base64 = fs.readFileSync(file).toString('base64');
    entries.push(`  ${key}: 'data:${mime};base64,${base64}',`);
  }
  return `${HEADER}\nexport const DONATE_QR = {\n${entries.join('\n')}\n};\n\nexport default DONATE_QR;\n`;
}

function main() {
  let text;
  try {
    text = build();
  } catch (err) {
    console.error(`make-donate-qr: ${err.message}`);
    process.exit(1);
  }

  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : null;
  if (current === text) {
    console.log(`make-donate-qr: ${path.relative(ROOT, OUTPUT)} 已是最新`);
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, text);
  console.log(`make-donate-qr: 写入 ${path.relative(ROOT, OUTPUT)}（${text.length} 字节）`);
}

main();
