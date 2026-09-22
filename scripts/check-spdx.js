//
// 为什么要有这个脚本：SPDX 头要求"每个源文件都有"，但新增文件时一定会漏，
// 重写文件时也会丢。人工核对 100 多个文件不现实，所以发版前拿脚本扫一遍兜底。
// 用 SPDX 标识符而不是自由文本，是为了让 REUSE / 扫描器 / GitHub 能自动识别。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARKER = 'SPDX-License-Identifier: GPL-3.0-or-later';
const YEAR = '2026';
const HOLDER = 'LiuFudi';
const PROJECT = 'NiuPic';

// 扫描目标：仓库里所有"人写的"源文件。刻意不含 niupic/app/**（构建产物）
// 与 build/prebuilt/**（预编译二进制），它们由构建脚本生成，改了也没意义。
const TARGETS = [
  'backend',
  'frontend/src',
  'frontend/index.html',
  'frontend/vite.config.js',
  'frontend/vite.config.alternative.js',
  'frontend/vitest.config.js',
  'frontend/postcss.config.js',
  'frontend/tailwind.config.js',
  'scripts',
  'website',
  'niupic/cmd',
  'niupic/wizard',
];

// 一律跳过的目录名
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', '.vite', 'logs', 'data',
]);

// 带扩展名的处理表
const BY_EXT = {
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.css': 'css',
  '.html': 'html',
  '.sh': 'sh',
};

const HEADER_LINES = (kind) => {
  const lines = [
    `SPDX-License-Identifier: GPL-3.0-or-later`,
    `Copyright (C) ${YEAR} ${HOLDER}`,
    ``,
    `This file is part of ${PROJECT}, licensed under the GNU General Public`,
    `License version 3 or (at your option) any later version.`,
    `See the LICENSE file for the full text.`,
  ];
  if (kind === 'js') return lines.map((l) => (l ? `// ${l}` : '//')).join('\n') + '\n\n';
  if (kind === 'sh') return lines.map((l) => (l ? `# ${l}` : '#')).join('\n') + '\n\n';
  // CSS 用 " * " 续行（社区习惯），不要用空格缩进——眼睛不好对齐，还容易留尾随空格
  if (kind === 'css') {
    const body = lines.map((l, i) => (i === 0 ? `/* ${l}` : l ? ` * ${l}` : ' *')).join('\n');
    return body + '\n */\n\n';
  }
  if (kind === 'html') {
    const body = lines.map((l, i) => (i === 0 ? `<!-- ${l}` : l ? `     ${l}` : '')).join('\n');
    return body + ' -->\n';
  }
  throw new Error(`未知的头类型: ${kind}`);
};

function walk(target, out = []) {
  const abs = path.join(ROOT, target);
  if (!fs.existsSync(abs)) return out;
  const st = fs.statSync(abs);
  if (st.isFile()) {
    out.push(abs);
    return out;
  }
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(target, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(abs, entry.name));
    }
  }
  return out;
}

// 判断一个文件该不该管、按哪种注释语法加头
function classify(file) {
  const ext = path.extname(file).toLowerCase();
  if (BY_EXT[ext]) return BY_EXT[ext];
  // 无扩展名：只有带 shebang 的才当脚本（例如 fnOS 生命周期钩子 niupic/cmd/*）
  if (ext === '') {
    let head = '';
    try {
      head = fs.readFileSync(file, 'utf8').slice(0, 200);
    } catch {
      return null;
    }
    if (head.startsWith('#!')) {
      if (/python/.test(head.split('\n')[0])) return 'sh'; // 用 # 注释，语法一致
      return 'sh';
    }
  }
  return null; // json / 二进制 / 图片 —— 加不了注释，跳过
}

// 头要插在 shebang 之后（sh/python），HTML 插在 <!DOCTYPE> 之后，其余插在文件开头
function insertAt(lines, kind) {
  if (kind === 'sh' && lines[0] && lines[0].startsWith('#!')) return 1;
  if (kind === 'js' && lines[0] && lines[0].startsWith('#!')) return 1;
  if (kind === 'html') {
    const i = lines.findIndex((l) => /<!DOCTYPE/i.test(l));
    return i === -1 ? 0 : i + 1;
  }
  return 0;
}

// 头必须在文件靠前的位置才算数：有的文件上面是 license 注释块，
// 所以给 15 行余量，但也不能整篇随便出现（否则挪到文件中间也算通过了）。
function hasHeader(text) {
  return text.split('\n', 15).join('\n').includes(MARKER);
}

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const RESTYLE = args.includes('--restyle');
const files = [...new Set(TARGETS.flatMap((t) => walk(t)))].sort();

// --restyle 用：把自动生成过的旧样式头整块摘掉，交给后面的 --fix 重新写。
// （只在改过头的排版样式时需要，正常发版用不到。）
function stripAutoHeader(text, kind) {
  const open = kind === 'js' || kind === 'sh' ? (kind === 'js' ? '// ' : '# ') : kind === 'css' ? '/* ' : '<!-- ';
  const close = kind === 'html' ? ' -->' : kind === 'css' ? ' */' : '';
  const idx = text.indexOf(open + 'SPDX-License-Identifier');
  if (idx === -1) return text;
  const endMarker = `See the LICENSE file for the full text.${close}`;
  const end = text.indexOf(endMarker, idx);
  if (end === -1) return text;
  let after = end + endMarker.length;
  while (text[after] === '\n') after++; // 连同后面的空行一起吃掉
  return text.slice(0, idx) + text.slice(after);
}

const missing = [];
const fixed = [];
let scanned = 0;

for (const file of files) {
  const kind = classify(file);
  if (!kind) continue;
  scanned++;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (RESTYLE) {
    const stripped = stripAutoHeader(text, kind);
    if (stripped !== text) {
      text = stripped;
      fs.writeFileSync(file, text);
    }
  }
  if (hasHeader(text)) continue;
  const rel = path.relative(ROOT, file);
  if (!FIX && !RESTYLE) {
    missing.push(rel);
    continue;
  }
  const lines = text.split('\n');
  const at = insertAt(lines, kind);
  const header = HEADER_LINES(kind);
  const head = lines.slice(0, at).join('\n');
  const rest = lines.slice(at).join('\n');
  const next = (at > 0 ? head + '\n' : '') + header + (at > 0 ? '' : '') + rest;
  fs.writeFileSync(file, next);
  fixed.push(rel);
}

if (FIX) {
  console.log(`扫描 ${scanned} 个源文件，补写 SPDX 头 ${fixed.length} 个`);
  for (const f of fixed) console.log(`  + ${f}`);
  process.exit(0);
}

console.log(`扫描 ${scanned} 个源文件，缺失 SPDX 头 ${missing.length} 个`);
if (missing.length) {
  for (const f of missing) console.log(`  ✗ ${f}`);
  console.log('\n修复：node scripts/check-spdx.js --fix');
  process.exit(1);
}
console.log('✅ 全部源文件都有 SPDX 头');
