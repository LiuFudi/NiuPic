// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * HTTP 客户端：**不许假设响应是 JSON**
 *
 * 真机上踩到的：应用挂在飞牛统一网关后面，平台会话失效时网关回的是
 *
 *     HTTP/1.1 200 OK
 *     Content-Type: text/plain; charset=utf-8
 *
 *     invalid token
 *
 * 而客户端当时是 `await response.json()` —— 直接抛
 * `Unexpected token 'i', "invalid token" is not valid JSON`：用户看到这句天书，
 * 而且**后面判断状态码的代码根本不会执行**（401 该触发的登出、该给的提示全跳过）。
 * 200 + 非 JSON 更危险：会被当成"成功但数据为空"。
 *
 * 这一组用例把"遇到非 JSON 该怎么表现"钉死。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api, APIError, getToken, setToken } from './client';

/** 造一个 fetch 响应替身 */
function mockResponse({ status = 200, body = '', contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** 准备浏览器环境（node 环境下没有 window / localStorage） */
function setupBrowserEnv() {
  const store = new Map();
  const events = [];
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.window = {
    location: { pathname: '/', origin: 'http://nas:5666' },
    dispatchEvent: (e) => { events.push(e.type); return true; },
  };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  return { store, events };
}

describe('api client 对非 JSON 响应的处理', () => {
  let env;

  beforeEach(() => {
    env = setupBrowserEnv();
    vi.restoreAllMocks();
  });

  it('网关的 "invalid token"（HTTP 200 + 纯文本）要报成"会话失效"，而不是 JSON 解析错误', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({
      status: 200,
      body: 'invalid token',
      contentType: 'text/plain; charset=utf-8',
    }));

    const error = await api.get('/library').catch((e) => e);

    expect(error).toBeInstanceOf(APIError);
    expect(error.code).toBe('GATEWAY_SESSION_INVALID');
    expect(error.message).toContain('飞牛网关会话已失效');
    // 绝不能把 JS 引擎的解析报错原样抛给用户
    expect(error.message).not.toMatch(/is not valid JSON/);
    expect(error.message).not.toMatch(/Unexpected token/);
  });

  it('网关回了桌面网页（HTML）也算这一类，并给出"从桌面图标打开"的指引', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({
      status: 404,
      body: '<!doctype html><html lang="zh-CN"><head><title>飞牛</title>',
      contentType: 'text/html',
    }));

    const error = await api.get('/library').catch((e) => e);

    expect(error.code).toBe('GATEWAY_HTML_RESPONSE');
    expect(error.message).toContain('桌面图标');
  });

  it('其它非 JSON（比如负载均衡器的纯文本 502）也要给出可读信息', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({
      status: 502,
      body: 'Bad Gateway',
      contentType: 'text/plain',
    }));

    const error = await api.get('/library').catch((e) => e);

    expect(error.code).toBe('NON_JSON_RESPONSE');
    expect(error.message).toContain('502');
    expect(error.message).toContain('Bad Gateway');
  });

  it('401 + 非 JSON 也必须走登出逻辑（以前解析先抛，这段永远执行不到）', async () => {
    setToken('stale-token');
    globalThis.fetch = vi.fn(async () => mockResponse({
      status: 401,
      body: 'Unauthorized',
      contentType: 'text/plain',
    }));

    const error = await api.get('/library').catch((e) => e);

    expect(error.status).toBe(401);
    expect(getToken()).toBeNull();
    expect(env.events).toContain('auth:unauthorized');
  });

  it('401 + JSON 的原有行为不变', async () => {
    setToken('stale-token');
    globalThis.fetch = vi.fn(async () => mockResponse({
      status: 401,
      body: JSON.stringify({ success: false, error: { message: '未授权访问，请先登录' } }),
    }));

    const error = await api.get('/library').catch((e) => e);

    expect(error.status).toBe(401);
    expect(error.message).toContain('未授权访问');
    expect(getToken()).toBeNull();
    expect(env.events).toContain('auth:unauthorized');
  });

  it('/auth/status 的 401 不触发登出事件（否则会自己把自己踢回登录页）', async () => {
    setToken('stale-token');
    globalThis.fetch = vi.fn(async () => mockResponse({
      status: 401,
      body: 'nope',
      contentType: 'text/plain',
    }));

    await api.get('/auth/status').catch(() => {});

    expect(env.events).not.toContain('auth:unauthorized');
  });

  it('正常的 JSON 响应照旧返回 data 字段', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({
      status: 200,
      body: JSON.stringify({ success: true, data: { libraries: [{ id: 1 }] } }),
    }));

    const data = await api.get('/library');

    expect(data).toEqual({ libraries: [{ id: 1 }] });
  });

  it('空响应体（204）返回 null，不炸', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({ status: 204, body: '' }));

    await expect(api.delete('/image', { path: 'x' })).resolves.toBeNull();
  });

  it('网络层失败（fetch 抛异常）仍是 APIError(status 0)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });

    const error = await api.get('/library').catch((e) => e);

    expect(error).toBeInstanceOf(APIError);
    expect(error.status).toBe(0);
    expect(error.message).toContain('Failed to fetch');
  });
});
