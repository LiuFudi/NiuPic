// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 网关会话失效时的自救动作（utils/gatewayRecovery.js）
 *
 * 真机上用户是靠"手动清 Cookie + 完整重新登录"才恢复的 —— 对普通用户太重。
 * 这一组用例把"能自动做的"和"该引导用户做的"钉住：
 *   · 地址里带着平台一次性凭据 → 自动重载一次（可能就此恢复），但**只试一次**，不许刷屏；
 *   · 没有凭据 / 已经试过 → 不到处跳，交给界面引导；
 *   · 清本机登录信息时，localStorage 与非 HttpOnly Cookie 都要清，且常见 Path 都覆盖到。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  hasUrlToken,
  shouldAutoReload,
  markRetried,
  hasRetried,
  clearLocalSession,
  platformLoginUrl,
} from './gatewayRecovery';

/** 造一个假的 sessionStorage */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

describe('hasUrlToken', () => {
  it('认得出桌面带过来的一次性凭据', () => {
    expect(hasUrlToken('?token=abc123')).toBe(true);
    expect(hasUrlToken('?foo=1&token=abc')).toBe(true);
  });

  it('没有凭据时为 false（不要凭这个到处跳转）', () => {
    expect(hasUrlToken('')).toBe(false);
    expect(hasUrlToken('?foo=1')).toBe(false);
    expect(hasUrlToken('?token=')).toBe(false);
  });
});

describe('shouldAutoReload', () => {
  it('地址里有凭据且没试过 → 试一次', () => {
    const s = fakeStorage();
    expect(shouldAutoReload('?token=abc', s)).toBe(true);
  });

  it('试过就不再试（否则会无限刷新）', () => {
    const s = fakeStorage();
    markRetried(s);
    expect(hasRetried(s)).toBe(true);
    expect(shouldAutoReload('?token=abc', s)).toBe(false);
  });

  it('地址里没有凭据 → 不自动重载（重载也没用，直接引导用户）', () => {
    const s = fakeStorage();
    expect(shouldAutoReload('', s)).toBe(false);
  });

  it('拿不到 sessionStorage（隐私模式）时按"已试过"处理，宁可不跳', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(hasRetried(broken)).toBe(true);
    expect(shouldAutoReload('?token=abc', broken)).toBe(false);
  });
});

describe('clearLocalSession', () => {
  beforeEach(() => {
    const store = new Map([['niupic_token', 'stale']]);
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    globalThis.__store = store;
  });

  it('清掉本应用 token，并把每个 Cookie 在常见 Path 上清一遍', () => {
    const written = [];
    globalThis.document = {
      get cookie() { return 'niupic_token=stale; trim_session=xyz'; },
      set cookie(v) { written.push(v); },
    };

    const cleared = clearLocalSession();

    expect(globalThis.__store.has('niupic_token')).toBe(false);
    expect(cleared).toBe(2);                        // 两个 Cookie 名
    expect(written.length).toBe(6);                 // 每个名字 3 条 Path
    expect(written.some((w) => w.startsWith('trim_session=; Path=/;'))).toBe(true);
    expect(written.some((w) => w.includes('Path=/app/niupic'))).toBe(true);
    expect(written.every((w) => w.includes('Max-Age=0'))).toBe(true);
  });

  it('没有 Cookie 时也不报错', () => {
    globalThis.document = { get cookie() { return ''; }, set cookie(_v) {} };
    expect(clearLocalSession()).toBe(0);
  });
});

describe('platformLoginUrl', () => {
  it('指向平台的登录页（而不是桌面首页）—— 会话卡住时桌面首页可能还显示"已登录"', () => {
    // 用通用示例地址：测试夹具同样不该带真实内网 IP（规范 6.1）
    expect(platformLoginUrl('http://localhost:5666')).toBe('http://localhost:5666/login');
  });
});
