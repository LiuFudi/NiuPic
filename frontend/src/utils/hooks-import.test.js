// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 用了 hook 就必须真的 import 进来
 *
 * 为什么单独钉这一条：`useMemo is not defined` 这类错误**构建不会报**（Vite/esbuild
 * 不做全局变量的未定义检查），只有页面跑到那一行才炸 —— 而 React 一炸就是整页白屏，
 * 用户看到的是"打开就是空白"。
 *
 * 这一轮就这么炸过一次：给 ScanMenu 加 useMemo 时 import 那行没改对，
 * 构建成功、单测全绿，端到端一跑就白屏（`ReferenceError: useMemo is not defined`）。
 * 所以这里直接扫源码：用到哪个 hook，就必须在 react 的 import 里出现。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs)$/.test(name) && !/\.test\.jsx?$/.test(name)) out.push(full);
  }
  return out;
}

const HOOKS = ['useState', 'useEffect', 'useMemo', 'useRef', 'useCallback', 'useLayoutEffect', 'useContext'];

describe('React hook 的 import 完整性', () => {
  it('每个用到 hook 的文件都从 react 里 import 了它', () => {
    const problems = [];

    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      const reactImport = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]react['"]/);
      const imported = reactImport
        ? reactImport[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0])
        : [];

      for (const hook of HOOKS) {
        // 只看真正的调用：hook 名后面跟左括号
        const used = new RegExp(`\\b${hook}\\s*\\(`).test(src);
        if (used && !imported.includes(hook)) {
          problems.push(`${file.replace(SRC + '/', '')}: 用了 ${hook} 但没从 react import`);
        }
      }
    }

    expect(problems, `\n${problems.join('\n')}`).toEqual([]);
  });
});
