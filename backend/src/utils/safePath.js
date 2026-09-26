// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
//
// 库内安全路径：所有"用户给的相对路径"必须经过这里再拼到库根上。
//
// 为什么必须有这个文件（不是"顺手加个校验"）：
//   原来各处都是 `path.join(libraryPath, userPath)` 直接用。`path.join` 会老老实实
//   处理 `..`，于是 `/api/image/original/<库id>/../../../../etc/passwd` 这种请求
//   真的能把系统文件读出来，而且那两个路由当时还挂着"免鉴权"白名单。
//   实测在真机上读到过 /etc/passwd 与应用自己的 config.json（含 jwtSecret）。
//
// 这里守三件事：
//   1. 结果必须落在库根之内（resolve 之后用 relative 判断，而不是字符串前缀 ——
//      前缀比较会被 `/lib2` 这种"同前缀的兄弟目录"骗过）；
//   2. 拒绝绝对路径、盘符、NUL 字节；反斜杠一律当分隔符（Windows 客户端会传 `..\..`）；
//   3. **符号链接不能当跳板**：库里的软链接指向库外时也要拦住 —— 只看 resolve 的结果
//      是不够的，得把已存在的部分做一次 realpath 再比。

'use strict';

const fs = require('fs');
const path = require('path');

class PathEscapeError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'PathEscapeError';
    this.code = 'PATH_ESCAPE';
    this.status = 403;
    this.detail = detail;
  }
}

/** 把用户输入规范化成"相对路径"的形态，顺手拦掉明显非法的写法 */
function normalizeUserPath(input) {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') {
    throw new PathEscapeError('路径必须是字符串');
  }
  if (input.includes('\0')) {
    throw new PathEscapeError('路径包含非法字符');
  }
  // 反斜杠当分隔符：Windows 上复制出来的路径是 `a\b\c`，`..\..\etc` 也要能被识破
  let p = input.replace(/\\/g, '/');
  if (/^([a-zA-Z]:|\/)/.test(p)) {
    throw new PathEscapeError('不接受绝对路径');
  }
  // 去掉开头多余的 ./ 与 /，保留中间部分交给 resolve 处理
  p = p.replace(/^\.\/+/, '').replace(/^\/+/, '');
  return p;
}

function realRootOf(root) {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

/** target 是否在 root 之内（用 relative 判断，避免 /lib 与 /lib2 的前缀误判） */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 把用户给的相对路径拼到库根上，并确保结果仍在库内。
 * @param {string} root 库根（绝对路径）
 * @param {string} userPath 用户给的相对路径
 * @returns {string} 库内的绝对路径
 * @throws {PathEscapeError} 越界、绝对路径、经符号链接逃逸
 */
function resolveInside(root, userPath) {
  const base = realRootOf(root);
  const rel = normalizeUserPath(userPath);
  const target = path.resolve(base, rel);

  if (!isInside(base, target)) {
    throw new PathEscapeError('路径超出素材库范围', { root: base, target });
  }

  // 符号链接检查：从目标往上找第一个"已存在"的祖先，做 realpath 再比一次。
  // （直接对不存在的路径 realpath 会抛错；新建文件/文件夹的场景必须能通过。）
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;          // 到根了
    probe = parent;
  }
  if (fs.existsSync(probe)) {
    const real = fs.realpathSync(probe);
    if (!isInside(base, real)) {
      throw new PathEscapeError('路径经符号链接指向素材库之外', { root: base, real });
    }
  }

  return target;
}

/** 只校验不拼接：给"已经拿到绝对路径、只想确认它在库内"的地方用 */
function assertInside(root, absolutePath) {
  const base = realRootOf(root);
  const target = path.resolve(absolutePath);
  if (!isInside(base, target)) {
    throw new PathEscapeError('路径超出素材库范围', { root: base, target });
  }
  return target;
}

module.exports = { resolveInside, assertInside, isInside, normalizeUserPath, PathEscapeError };
