// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 飞牛 fnOS 开放 API 客户端（服务端专用）
 *
 * 飞牛只允许应用**通过本地 Unix Socket** 调用开放 API，不使用 HTTP 端口：
 *
 *   POST /api/v1/trimapp
 *   Unix Socket: /var/run/trim_open_gateway_apiscope.socket
 *   Authorization: Bearer ${TRIM_API_TOKEN}
 *
 * 安全约定（务必遵守）：
 *   - TRIM_API_TOKEN 只从当前进程环境读取，**不落盘、不打印、不下发前端**
 *   - req 名称由调用方白名单给出，绝不接受前端传入
 *   - 需要 config/resource 里声明对应的 api-scope，否则返回 403
 *   - 需要应用用户属于 TrimApiUsers 用户组（config/privilege 的 join-groups），
 *     否则连不上 Socket
 */

'use strict';

const http = require('http');
const logger = require('./logger');

/** 飞牛开放 API 网关的固定 Socket 与固定路径 */
const FNOS_API_SOCKET = '/var/run/trim_open_gateway_apiscope.socket';
const FNOS_API_PATH = '/api/v1/trimapp';
/** 响应体上限，避免异常返回撑爆内存 */
const RESPONSE_LIMIT = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10000;

class FnosApiError extends Error {
  constructor(apiCode, message) {
    super(message);
    this.name = 'FnosApiError';
    this.apiCode = apiCode;
  }
}

/**
 * 开放 API 错误码（飞牛文档：HTTP 状态 → code → msg → reqId → 权限/版本/参数）
 *   200001 Invalid Params   —— 参数不合法
 *   200003 Forbidden        —— config/resource 里没声明对应 api-scope
 *   200004 Unauthorized     —— 进程里没有有效的 TRIM_API_TOKEN
 *   200005 Not Found        —— req 拼写错误 / 系统版本不支持
 *   200006 Internal Error   —— 平台内部错误
 */
const API_CODE = {
  INVALID_PARAMS: 200001,
  FORBIDDEN: 200003,
  UNAUTHORIZED: 200004,
  NOT_FOUND: 200005,
  INTERNAL: 200006
};

/** 错误码对应的中文说明，用于日志与用户可见提示 */
function apiCodeLabel(code) {
  switch (code) {
    case API_CODE.INVALID_PARAMS:
      return '请求参数不合法';
    case API_CODE.FORBIDDEN:
      return '应用未声明所需的 api-scope';
    case API_CODE.UNAUTHORIZED:
      return '进程内没有有效的 TRIM_API_TOKEN';
    case API_CODE.NOT_FOUND:
      return '飞牛系统版本不支持该接口';
    case API_CODE.INTERNAL:
      return '飞牛开放 API 内部错误';
    default:
      return code === undefined ? '飞牛开放 API 调用失败' : `飞牛开放 API 错误码 ${code}`;
  }
}

/**
 * 这个错误是否代表「当前环境拿不到该能力」而不是「本次调用失败」。
 * 这类情况属于可预期的降级（旧版飞牛、没声明 scope、没重新安装应用），
 * 不该按异常刷警告日志。
 */
function isUnavailableError(error) {
  if (error instanceof FnosApiError) {
    if (
      error.apiCode === API_CODE.FORBIDDEN ||
      error.apiCode === API_CODE.UNAUTHORIZED ||
      error.apiCode === API_CODE.NOT_FOUND
    ) {
      return true;
    }
  }
  const message = String(error && error.message);
  return (
    message === 'TRIM_API_TOKEN 不可用' ||
    message.includes('ENOENT') ||
    message.includes('EACCES') ||
    message.includes('EPERM') ||
    message.includes('ECONNREFUSED')
  );
}

function requestId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function apiMessage(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'fnOS API 调用失败';
  }
  return value.trim().slice(0, 300);
}

/**
 * 调用一次飞牛开放 API。
 *
 * @param {string} req 白名单内的请求名，例如 trim.file.getSharedAccessibleFolders
 * @param {object} [data] 请求数据
 * @param {object} [options] { token, appName, socketPath, timeoutMs }
 * @returns {Promise<any>} 响应里的 data 字段
 */
function callFnosApi(req, data = {}, options = {}) {
  const token = String(options.token ?? process.env.TRIM_API_TOKEN ?? '').trim();
  if (token.length === 0) {
    return Promise.reject(new FnosApiError(undefined, 'TRIM_API_TOKEN 不可用'));
  }

  const appName =
    String(options.appName ?? process.env.TRIM_APPNAME ?? 'niupic').trim() || 'niupic';
  const socketPath = options.socketPath ?? FNOS_API_SOCKET;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const payload = JSON.stringify({
    reqId: requestId(),
    req,
    appName,
    data
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const handle = http.request(
      {
        socketPath,
        path: FNOS_API_PATH,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`
        }
      },
      (response) => {
        let body = '';
        let size = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size <= RESPONSE_LIMIT) body += chunk;
        });
        response.on('end', () => {
          if (size > RESPONSE_LIMIT) {
            done(reject, new FnosApiError(undefined, 'fnOS API 响应过大'));
            return;
          }
          // 网关在 401/403/404/500 时也会带业务错误码，所以先解析包体再判断状态码，
          // 这样日志里能看到「200003 应用未声明所需的 api-scope」而不是干巴巴的「HTTP 403」。
          let envelope = null;
          try {
            envelope = JSON.parse(body);
          } catch {
            envelope = null;
          }

          if (envelope === null || typeof envelope !== 'object') {
            const reason = `fnOS API 返回 HTTP ${response.statusCode}（响应不是合法 JSON）`;
            done(reject, new FnosApiError(undefined, reason));
            return;
          }

          const code = typeof envelope.code === 'number' ? envelope.code : undefined;
          const httpOk = response.statusCode >= 200 && response.statusCode < 300;

          if (code !== 0) {
            const detail =
              typeof envelope.msg === 'string' && envelope.msg.trim().length > 0
                ? envelope.msg.trim()
                : apiCodeLabel(code);
            done(
              reject,
              new FnosApiError(code, httpOk ? detail : `${detail}（HTTP ${response.statusCode}）`)
            );
            return;
          }

          if (!httpOk) {
            done(
              reject,
              new FnosApiError(code, `fnOS API 返回 HTTP ${response.statusCode}`)
            );
            return;
          }

          done(resolve, envelope.data);
        });
        response.on('error', (error) => done(reject, error));
      }
    );

    handle.setTimeout(timeoutMs, () => {
      handle.destroy(new Error('fnOS API 请求超时'));
    });
    handle.on('error', (error) => {
      logger.debug(`[fnos-api] ${req} 调用失败: ${error.message}`);
      done(reject, error);
    });
    handle.end(payload);
  });
}

module.exports = {
  FNOS_API_SOCKET,
  FNOS_API_PATH,
  API_CODE,
  FnosApiError,
  apiCodeLabel,
  callFnosApi,
  isUnavailableError
};
