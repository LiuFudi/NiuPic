// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 认证路由
 */

const express = require('express');
const router = express.Router();
const { setTokenCookie, clearTokenCookie, readTokenCookie, verifyToken } = require('../middleware/authMiddleware');

/**
 * GET /api/auth/status
 * 获取认证状态
 */
router.get('/status', async (req, res, next) => {
  try {
    const authService = req.app.get('authService');
    const status = authService.getStatus();

    // 顺带告诉前端"当前请求算不算已登录"。
    // 为什么需要：会话凭据现在放在 HttpOnly Cookie 里（图片 <img> 靠它），
    // 而 localStorage 里可能没有 token（换了浏览器、清过缓存）。
    // 只看 localStorage 会让这种"其实已经登录"的用户被弹回登录页。
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : readTokenCookie(req.headers.cookie);
    status.authenticated = !!(status.hasPassword && token && verifyToken(token, authService.getJwtSecret()));

    // 同上：这是页面加载后第一个被调用的接口，在这里补发 Cookie 最及时 ——
    // 否则紧接着的图片请求（<img> 带不上 Header）会 401，表现为"图片全部加载失败"。
    if (token && status.authenticated && !readTokenCookie(req.headers.cookie)) {
      setTokenCookie(res, token, 30 * 24 * 3600);
    }

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/setup
 * 首次设置密码
 * Body: { password: string }
 */
router.post('/setup', async (req, res, next) => {
  try {
    const authService = req.app.get('authService');
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        error: { message: '密码不能为空' }
      });
    }

    const result = await authService.setupPassword(password);

    // 浏览器端靠 Cookie 带着凭据取图片，所以设置口令后立刻下发
    if (result && result.token) {
      setTokenCookie(res, result.token, 30 * 24 * 3600);
    }

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/login
 * 登录验证
 * Body: { password: string }
 */
router.post('/login', async (req, res, next) => {
  try {
    const authService = req.app.get('authService');
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        error: { message: '密码不能为空' }
      });
    }

    // 获取客户端 IP（用于防暴力破解）
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    const result = await authService.login(password, clientIP);

    // 同上：登录后下发 HttpOnly Cookie，界面里的 <img> 才能带上凭据
    if (result && result.token) {
      setTokenCookie(res, result.token, 30 * 24 * 3600);
    }

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/logout
 * 退出登录：清掉浏览器会话 Cookie
 */
router.post('/logout', async (req, res) => {
  clearTokenCookie(res);
  res.json({ success: true, data: { loggedOut: true } });
});

/**
 * POST /api/auth/change-password
 * 修改密码（需要认证）
 * Body: { oldPassword: string, newPassword: string }
 */
router.post('/change-password', async (req, res, next) => {
  try {
    const authService = req.app.get('authService');
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: { message: '原密码和新密码不能为空' }
      });
    }

    const result = await authService.changePassword(oldPassword, newPassword);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
