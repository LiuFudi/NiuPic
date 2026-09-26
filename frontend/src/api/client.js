// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

import { apiBase } from '../utils/appBase.js';

/**
 * HTTP 客户端
 * 使用原生 Fetch API
 */

const API_BASE = apiBase();

/**
 * API 错误类
 */
class APIError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.data = data;
    // 统一暴露一个 code：既认"客户端自己标的"（如 GATEWAY_SESSION_INVALID），
    // 也认服务端返回的 error.code（如 PASSWORD_NOT_SET）——
    // 调用方只需要看 error.code，不用记住两种嵌套结构。
    this.code = (data && (data.code || (data.error && data.error.code))) || null;
  }
}

/**
 * 获取存储的 Token
 */
function getToken() {
  return localStorage.getItem('niupic_token');
}

/**
 * 设置 Token
 */
function setToken(token) {
  if (token) {
    localStorage.setItem('niupic_token', token);
  } else {
    localStorage.removeItem('niupic_token');
  }
}

/**
 * 发送请求
 */
/** 网关/代理在会话失效时返回的固定文案（飞牛平台实测：HTTP 200 + text/plain） */
const GATEWAY_TOKEN_ERROR = /invalid token/i;

/**
 * 读响应体：**先当文本读，再尝试解析 JSON**。
 *
 * 为什么不能直接 `response.json()`：应用是挂在飞牛统一网关后面的，
 * 网关在会话失效时返回的既不是 JSON、也不是 401 —— 实测是
 *
 *     HTTP/1.1 200 OK
 *     Content-Type: text/plain; charset=utf-8
 *
 *     invalid token
 *
 * 直接 `json()` 会抛 `Unexpected token 'i', "invalid token" is not valid JSON`：
 * 用户看到的就是这句天书，而且**后面判断状态的代码根本不会执行**
 * （401 该触发的登出、该给的提示全都跳过）。200 + 非 JSON 尤其危险：
 * 会被当成"成功但数据为空"。所以这里统一按"文本 → 试解析"处理。
 */
async function readBody(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return { data: null, raw: '', nonJson: false };
  }
  if (text.length === 0) return { data: null, raw: '', nonJson: false };
  try {
    return { data: JSON.parse(text), raw: text, nonJson: false };
  } catch {
    return { data: null, raw: text, nonJson: true };
  }
}

/** 非 JSON 响应该怎么说 —— 分"平台网关拦截"和"其它"两种，文案要能指导下一步 */
function nonJsonError(response, raw) {
  const snippet = raw.trim().slice(0, 120);

  if (GATEWAY_TOKEN_ERROR.test(snippet)) {
    return new APIError(
      '飞牛网关会话已失效，请回到飞牛桌面重新登录后再打开 NiuPic',
      response.status,
      { code: 'GATEWAY_SESSION_INVALID', raw: snippet }
    );
  }

  // 网关/反向代理返回 HTML（桌面页、错误页）也是这一类：不是我们的接口在应答
  const looksHtml = /^\s*<!doctype html|^\s*<html/i.test(snippet);
  return new APIError(
    looksHtml
      ? `服务端返回了网页而不是接口数据（HTTP ${response.status}）—— 多半是平台网关把请求拦下了，请从飞牛桌面图标重新打开 NiuPic`
      : `服务端返回了非 JSON 响应（HTTP ${response.status}）：${snippet || '空内容'}`,
    response.status,
    { code: looksHtml ? 'GATEWAY_HTML_RESPONSE' : 'NON_JSON_RESPONSE', raw: snippet }
  );
}

async function request(url, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  // 自动添加 Authorization header
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const config = {
    headers,
    ...options
  };

  try {
    const response = await fetch(`${API_BASE}${url}`, config);
    const { data, raw, nonJson } = await readBody(response);

    // 非 JSON：先按失败处理（不管 HTTP 状态码是多少），再走下面的鉴权分支
    if (nonJson) {
      if (response.status === 401) {
        handleUnauthorized(url);
      }
      throw nonJsonError(response, raw);
    }

    if (!response.ok) {
      // 401 未授权处理
      if (response.status === 401) {
        handleUnauthorized(url);
      }

      throw new APIError(
        data?.error?.message || data?.error || 'Request failed',
        response.status,
        data
      );
    }

    // 直接返回数据，不包装
    if (data === null) return null;
    return data.data !== undefined ? data.data : data;
  } catch (error) {
    if (error instanceof APIError) {
      throw error;
    }

    // 网络错误（fetch 本身失败）
    throw new APIError(
      error.message || 'Network error',
      0,
      null
    );
  }
}

/** 401 的统一处理：清 token + 通知界面回登录页（认证检查接口除外，避免自我循环） */
function handleUnauthorized(url) {
  const isAuthCheck = url.includes('/auth/status');
  if (isAuthCheck) return;
  setToken(null);
  window.dispatchEvent(new Event('auth:unauthorized'));
}

/**
 * GET 请求
 */
function get(url, options = {}) {
  return request(url, { method: 'GET', ...options });
}

/**
 * POST 请求
 */
function post(url, body, options = {}) {
  return request(url, { 
    method: 'POST', 
    body: JSON.stringify(body),
    ...options 
  });
}

/**
 * PUT 请求
 */
function put(url, body, options = {}) {
  return request(url, { 
    method: 'PUT', 
    body: JSON.stringify(body),
    ...options 
  });
}

/**
 * PATCH 请求
 */
function patch(url, body, options = {}) {
  return request(url, { 
    method: 'PATCH', 
    body: JSON.stringify(body),
    ...options 
  });
}

/**
 * DELETE 请求
 * 支持带 body 的 DELETE 请求（用于批量删除等操作）
 */
function del(url, body, options = {}) {
  // 如果 body 是对象（非 options），则作为请求体发送
  if (body && typeof body === 'object' && !body.method) {
    return request(url, { 
      method: 'DELETE', 
      body: JSON.stringify(body),
      ...options 
    });
  }
  // 否则，body 实际上是 options
  return request(url, { method: 'DELETE', ...body });
}

export const api = {
  get,
  post,
  put,
  patch,
  delete: del
};

export { APIError, getToken, setToken };
