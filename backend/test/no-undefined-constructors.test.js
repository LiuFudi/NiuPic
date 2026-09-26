// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 「`new X()` 里的 X 既没导入也没定义」的静态检查。
 *
 * 为什么要有这条：这类错误**构建不报、单测也覆盖不到**（要走到那一行才炸），
 * 而炸出来的样子和真相差得很远 —— 真实案例就在 2.5.4 里：
 * `backend/src/routes/file.js` 的 `/restore` 用了 `ValidationError` 但没导入，
 * 抛的是 ReferenceError，被 asyncHandler 交给错误中间件后返回 **500「服务器内部错误」**；
 * 用户以为服务挂了，实际只是"参数不对，本该 400"。前端早就有同类检查
 * （见 frontend/src/utils/undefined-symbols.test.js），后端一直没有。
 *
 * 规则刻意收得很窄：**只看 `new <首字母大写的标识符>(`**。
 * 这样既覆盖了真正的痛点（忘记导入的类），又几乎不可能误报 ——
 * 大写开头的裸标识符出现在 new 后面，要么是本文件的定义/参数，要么就是漏导入。
 * 不要顺手扩成"所有裸调用"，那类检查需要更复杂的启发式，误报会变成噪音。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'utils', 'database'];
const SCAN_FILES = ['server.js'];

/** JS 自带的、可以出现在 new 后面的全局构造器 */
const BUILTIN_CONSTRUCTORS = new Set([
  'Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean',
  'DataView', 'Date', 'Error', 'EvalError', 'Float32Array', 'Float64Array',
  'Function', 'Int16Array', 'Int32Array', 'Int8Array', 'Map', 'Number', 'Object',
  'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'RegExp', 'Set', 'String',
  'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'URL', 'URLSearchParams',
  'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap',
  'WeakSet', 'AbortController', 'TextDecoder', 'TextEncoder',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 去掉行注释与块注释：注释里提到某个类名不该算"用了" */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** 本文件里"已经声明过"的名字：require 解构、const/let/var、class、function、函数参数 */
function declaredNames(src) {
  const out = new Set();

  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);

  // const { A, B: alias } = require(...)
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }

  for (const m of src.matchAll(/(?:^|\s)class\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);

  // 函数/箭头函数的参数（构造器注入、解构参数都在这里）
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

test('没有"new 了一个既没导入也没定义的类"', () => {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const full = path.join(BACKEND, dir);
    if (fs.existsSync(full)) files.push(...walk(full));
  }
  for (const name of SCAN_FILES) {
    const full = path.join(BACKEND, name);
    if (fs.existsSync(full)) files.push(full);
  }

  const problems = [];

  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const declared = declaredNames(src);

    for (const m of src.matchAll(/(?<![.\w$])new\s+([A-Z][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (BUILTIN_CONSTRUCTORS.has(name) || declared.has(name)) continue;
      problems.push(`${path.relative(BACKEND, file)}: new ${name}(…) —— ${name} 既没导入也没定义`);
    }
  }

  assert.deepStrictEqual(problems, [], `\n${problems.join('\n')}\n`);
});
