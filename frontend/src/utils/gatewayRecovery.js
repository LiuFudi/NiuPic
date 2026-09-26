// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 平台网关把请求拦下时的自救动作。
 *
 * 背景（2026-09-23 真机）：飞牛桌面打开应用时会在地址后面带一次性凭据
 * （`/app/niupic?token=…`），网关用它建立会话。NAS 重启、会话过期之后，
 * 浏览器手里那份会话失效，网关就对所有 `/app/niupic*` 请求回
 * `HTTP 200 + 纯文本 invalid token`，而应用页面还在（缓存），于是全线失败。
 *
 * 用户当时的解法是"手动清 Cookie + 完整重新登录" —— 对普通用户太重。这里把能自动做的做掉：
 *
 *   1. 页面地址里**还带着 token** 时，先自动重载一次：那次请求由网关重新校验凭据，
 *      可能就把会话 Cookie 重新种上（能自动好的情况就不打扰用户）。只试一次。
 *   2. 需要用户出手时，直接把他送到**平台的登录页**（`/login`），而不是让他自己在桌面里找；
 *      重新登录会让平台换一份新的会话 —— 等价于"清 Cookie + 重新登录"，但不用手工清。
 *   3. 顺手清掉本页能清的登录痕迹（localStorage 里的 token、非 HttpOnly 的 Cookie）。
 *      HttpOnly 的平台会话 Cookie 页面清不掉（这是浏览器的规矩），所以才需要第 2 步兜底。
 */

const RETRY_FLAG = 'niupic_gateway_retry';

/** 本页地址里是否带着平台给的一次性凭据 */
export function hasUrlToken(search) {
  const q = typeof search === 'string' ? search : (typeof window !== 'undefined' ? window.location.search : '');
  try {
    return Boolean(new URLSearchParams(q).get('token'));
  } catch {
    return false;
  }
}

/** 这一次会话里是否已经自动重载过（避免来回刷新） */
export function hasRetried(storage) {
  const s = storage || (typeof window !== 'undefined' ? window.sessionStorage : null);
  if (!s) return true;
  try {
    return s.getItem(RETRY_FLAG) === '1';
  } catch {
    return true;
  }
}

/** 记下"已经自动重载过一次" */
export function markRetried(storage) {
  const s = storage || (typeof window !== 'undefined' ? window.sessionStorage : null);
  if (!s) return;
  try {
    s.setItem(RETRY_FLAG, '1');
  } catch { /* 隐私模式下写不了，忽略 */ }
}

/**
 * 该不该自动重载一次？两个条件：地址里有凭据，且这个标签页还没试过。
 */
export function shouldAutoReload(search, storage) {
  return hasUrlToken(search) && !hasRetried(storage);
}

/**
 * 清掉本页能清的登录痕迹。
 * 返回清掉的 Cookie 名数量 —— HttpOnly 的那些**清不掉**，界面上要说清楚。
 */
export function clearLocalSession() {
  let cleared = 0;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem('niupic_token');
  } catch { /* 忽略 */ }

  try {
    if (typeof document === 'undefined' || !document.cookie) return cleared;
    const names = document.cookie
      .split(';')
      .map((part) => part.split('=')[0].trim())
      .filter(Boolean);
    for (const name of names) {
      // 同一个名字可能挂在不同 Path 上，常见的几条都清一遍
      for (const path of ['/', '/app', '/app/niupic']) {
        document.cookie = `${name}=; Path=${path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      }
      cleared += 1;
    }
  } catch { /* 忽略 */ }

  return cleared;
}

/** 平台登录页地址（与当前页面同源） */
export function platformLoginUrl(origin) {
  const base = origin || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/login`;
}
