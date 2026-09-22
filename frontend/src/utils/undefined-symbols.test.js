// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 「用了某个符号，但根本没定义/没 import」的静态检查
 *
 * 为什么要有这条：这类错误**构建不会报**（esbuild/Vite 遇到不认识的标识符会当成全局变量），
 * 单测也覆盖不到（要走到那一行才会炸），而 React 一炸就是整页白屏。
 * 这个项目已经栽过三次：
 *
 *   1. `filterOptions is not defined`          —— 删代码时留了个引用
 *   2. `useMemo is not defined`                —— 加 hook 时忘了改 import 行
 *   3. `buildImageQueryParams is not defined`  —— 用工具函数时忘了 import
 *
 * 前两条被端到端抓到（跑起来白屏），第三条也是。所以这里做一层静态兜底：
 * 把 src 下所有 export 出来的名字收集起来，然后逐个文件检查
 * ——「以裸标识符形式调用（前面不是点号）但本地既没定义也没 import」的，就是问题。
 *
 * 说明：只查跨模块的导出符号（长度 ≥ 6，减少误报）；注释里的内容会被剔掉，
 * 命名空间导入（`import * as x`）和同文件的定义都算"已声明"。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs)$/.test(name) && !/\.test\.jsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** 去掉行注释和块注释（注释里提到某个函数名不该算"用了"） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function exportedNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return out;
}

/** 文件里"已经声明过"的名字：import 进来的 + 自己定义的 */
function declaredNames(src) {
  const out = new Set();

  // import 子句（可能跨行）：import a, { b, c as d } from '...'
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    for (const nm of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (nm[0] !== 'as') out.add(nm[0]);
    }
  }
  // import 'x.css'（没有子句）不影响

  for (const m of src.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/(?:^|\s)class\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  // const { a, b } = ...（解构）
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const nm of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) out.add(nm[0]);
  }

  // 函数/箭头函数的参数（含解构的 props）：
  //   function X({ a, b }) / ({ a, b }) => / ({ a }) => ...
  const paramLists = [
    ...src.matchAll(/function\s*[A-Za-z_$]*\s*\(([^)]*)\)/g),
    ...src.matchAll(/\(([^)]*)\)\s*=>/g),
  ];
  for (const m of paramLists) {
    for (const nm of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) out.add(nm[0]);
  }

  // 对象/类里的方法简写：getStatus() { ... }
  for (const m of src.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) out.add(m[1]);

  return out;
}

describe('没有"用了却没定义"的符号', () => {
  const files = walk(SRC);
  const allExports = new Set();
  for (const file of files) {
    for (const name of exportedNames(readFileSync(file, 'utf8'))) allExports.add(name);
  }

  it('每个跨模块调用的符号都能在本文件里找到来源', () => {
    const problems = [];

    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      const src = stripComments(raw);
      const declared = declaredNames(src);
      const own = exportedNames(src);

      for (const name of allExports) {
        if (name.length < 6 || declared.has(name) || own.has(name)) continue;
        // 裸标识符调用：前面不是点号也不是标识符字符
        const used = new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(src);
        if (used) problems.push(`${relative(SRC, file)}: 用了 ${name}，但既没定义也没 import`);
      }
    }

    expect(problems, `\n${problems.join('\n')}`).toEqual([]);
  });
});
