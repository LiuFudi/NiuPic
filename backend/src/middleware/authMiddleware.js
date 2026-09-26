// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 认证中间件
 * 轻量级访问密码验证
 */

const jwt = require('jsonwebtoken');

const TOKEN_EXPIRY = '30d'; // Token 有效期 30 天

/**
 * 生成 JWT Token
 * @param {string} jwtSecret - JWT 密钥（从配置文件读取）
 */
function generateToken(jwtSecret) {
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
  }
  return jwt.sign(
    { app: 'niupic', timestamp: Date.now() },
    jwtSecret,
    { expiresIn: TOKEN_EXPIRY }
  );
}

/**
 * 验证 JWT Token
 * @param {string} token - JWT Token
 * @param {string} jwtSecret - JWT 密钥（从配置文件读取）
 */
function verifyToken(token, jwtSecret) {
  if (!jwtSecret) {
    return false;
  }
  try {
    jwt.verify(token, jwtSecret);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * 认证中间件工厂
 * @param {Function} getPasswordHash - 获取密码哈希的函数
 * @param {Function} getJwtSecret - 获取 JWT 密钥的函数
 */
function createAuthMiddleware(getPasswordHash, getJwtSecret) {
  return (req, res, next) => {
    // 路径可能在网关前缀之下（/app/niupic/api/...），所以按 "/api/" 定位而不是前缀匹配
    const fullPath = req.originalUrl.split('?')[0];
    const apiIndex = fullPath.indexOf('/api/');
    const apiPath = apiIndex >= 0 ? fullPath.slice(apiIndex) : fullPath;

    // 公开接口只有这几个：登录相关 + 健康检查。**图片资源不在其中**
    // （原来 /api/image/thumbnail|original 在免鉴权白名单里，等于任何人可下载全部照片）
    const publicPaths = [
      '/api/auth/status',
      '/api/auth/login',
      '/api/auth/setup',
      '/api/auth/logout',
      '/api/health'
    ];
    if (publicPaths.includes(apiPath)) {
      return next();
    }

    const passwordHash = getPasswordHash();
    if (!passwordHash) {
      // 未设置口令时**不再放行一切**（fail-closed）。
      // 原来这里是 `return next()`，于是新装用户还没设口令的那段时间，局域网内
      // 任何人都能调所有接口（含删除/移动）。现在只允许上面的公开接口，
      // 其余一律 403 并带上 code，前端据此引导用户先去设置口令。
      return res.status(403).json({
        success: false,
        error: { code: 'PASSWORD_NOT_SET', message: '尚未设置访问口令，请先设置口令' }
      });
    }

    // 凭据来源：Authorization: Bearer（API 客户端）或 HttpOnly Cookie（浏览器）。
    // 为什么必须有 Cookie 这条路：界面里的图片是 <img src="/api/image/...">，
    // 这种请求带不上自定义 Header —— 以前正是因为带不上才把图片接口设成免鉴权。
    // 用 Cookie 之后图片请求自动带上凭据，接口就能和其他接口一样要求登录。
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else {
      token = readTokenCookie(req.headers.cookie);
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        error: { message: '未授权访问，请先登录' }
      });
    }

    if (!verifyToken(token, getJwtSecret())) {
      return res.status(401).json({
        success: false,
        error: { message: 'Token 无效或已过期，请重新登录' }
      });
    }

    // 自愈：升级到"图片接口要鉴权"的版本后，老会话只有 localStorage 里的 token
    // （登录动作发生在升级之前，所以没有会话 Cookie），而 <img> 又带不上 Header ——
    // 结果就是图片全部 401。这里凡是"凭据有效但没带 Cookie"的请求都补发一次 Cookie，
    // 下一次接口调用就把会话补全，用户不需要重新登录。
    if (!readTokenCookie(req.headers.cookie)) {
      setTokenCookie(res, token, 30 * 24 * 3600);
    }

    next();
  };
}


/** 浏览器会话用的 Cookie 名（与前端 localStorage 的 token 是同一个 JWT） */
const TOKEN_COOKIE = 'niupic_token';

/** 从 Cookie 头里取 token（自己解析，不引第三方依赖） */
function readTokenCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === TOKEN_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/**
 * 登录成功后下发会话 Cookie。
 * HttpOnly：JS 读不到（XSS 也偷不走）；SameSite=Lax：跨站拿不到凭据，
 * 而本站的 <img>/fetch 照常带上 —— 这正是图片接口能改成"要登录"的前提。
 * 不开 Secure：局域网内是 http 访问，加了会导致 Cookie 根本不下发。
 */
function setTokenCookie(res, token, maxAgeSeconds) {
  const parts = [
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  res.append('Set-Cookie', parts.join('; '));
}

/** 退出登录：让 Cookie 立刻失效 */
function clearTokenCookie(res) {
  res.append('Set-Cookie', `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  createAuthMiddleware,
  generateToken,
  verifyToken,
  setTokenCookie,
  clearTokenCookie,
  readTokenCookie,
  TOKEN_COOKIE
};
