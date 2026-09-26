// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
//
// 应用基路径 —— 只在这里算一次，其它地方都从这里取。
//
// 为什么必须统一：飞牛统一网关把应用挂在 `/app/<appname>/` 之后，
// 此时任何写死的 `/api/...` 都会打到平台自己的根路径上（404 或落到别的服务）。
// 之前"图片 URL""复制图片""socket.io 路径""接口请求"四处各写一遍，
// 改网关形态时一定会漏掉某一处 —— 而漏掉的那处表现为"图片加载失败"，
// 排查起来完全看不出是路径问题。所以：**一处计算，处处引用**。
//
// 直接开端口访问时（pathname 为 `/`）基路径是空串，两种形态都能工作。

/** 应用基路径，例如 `/app/niupic`；直接访问端口时为空串 */
export function appBase() {
  if (typeof window === 'undefined') return '';
  const m = window.location.pathname.match(/^\/app\/[^/]+/);
  return m ? m[0] : '';
}

/** 带基路径的接口地址：appBase() + '/api' */
export function apiBase() {
  return `${appBase()}/api`;
}

/** 把应用内的绝对路径（以 / 开头）补上基路径 */
export function withBase(pathname) {
  if (!pathname) return pathname;
  if (!pathname.startsWith('/')) return pathname;
  return `${appBase()}${pathname}`;
}
