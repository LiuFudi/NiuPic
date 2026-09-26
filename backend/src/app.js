// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * Express 应用配置
 * 使用新的架构：Config → Model → Service → Route
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { errorHandler } = require('./middleware/errorHandler');
const { createAuthMiddleware } = require('./middleware/authMiddleware');

// 导入服务
const LibraryService = require('./services/LibraryService');
const ImageService = require('./services/ImageService');
const ScanService = require('./services/ScanService');
const FileService = require('./services/FileService');
const AuthService = require('./services/AuthService');
const AccessibleFoldersService = require('./services/AccessibleFoldersService');

/**
 * 创建 Express 应用
 */

/**
 * 前端 index.html 的 base 注入。
 *
 * 为什么必须在服务端注入（实测踩过）：桌面入口是 `/app/niupic`（**没有结尾斜杠**），
 * 而前端产物里的资源是相对路径 `./assets/index-xxx.js`。浏览器按"最后一段是文件"的规则
 * 解析，会把基准目录算成上一级 —— 于是资源被请求到 `/app/assets/…` → 404 → **整页白屏**。
 * 直接访问端口（`/`）时反而正常，所以很容易只在网关形态下才暴露。
 *
 * 用 `<base href="…/">` 把基准固定下来：无论浏览器地址有没有结尾斜杠、
 * 平台是否加/去斜杠，资源都能正确解析。
 */
let indexHtmlCache = null;

function renderIndexHtml(req) {
  const dist = process.env.FRONTEND_DIST;
  const file = path.join(dist, 'index.html');
  if (indexHtmlCache === null) {
    indexHtmlCache = fs.readFileSync(file, 'utf8');
  }
  // 前缀已由 server.js 在剥 URL 时记在请求上；没有前缀（直接开端口）时用 '/'
  const prefix = req.niupicBasePrefix || '';
  const base = `${prefix}/`;
  if (indexHtmlCache.includes('<base ')) return indexHtmlCache;
  const tag = `<base href="${base}">`;
  return indexHtmlCache.includes('<head>')
    ? indexHtmlCache.replace('<head>', `<head>\n    ${tag}`)
    : tag + indexHtmlCache;
}

function createApp(dependencies) {
  const {
    configManager,
    dbPool,
    scanner,
    scanManager,
    lightweightWatcher,
    io
  } = dependencies;

  const app = express();

  // 中间件
  app.use(cors());
  app.use(express.json());

  // 初始化服务
  const authService = new AuthService(configManager);

  // 可访问文件夹（飞牛授权目录）清单
  const accessibleFoldersService = new AccessibleFoldersService({
    getLibraries: () => (configManager.load().libraries || [])
  });

  const libraryService = new LibraryService(
    configManager,
    dbPool,
    scanManager,
    lightweightWatcher,
    io,
    accessibleFoldersService
  );

  const imageService = new ImageService(
    configManager,
    dbPool
  );

  const scanService = new ScanService(
    configManager,
    dbPool,
    scanner,
    scanManager,
    io
  );

  const fileService = new FileService(dbPool, configManager);

  // 将服务和依赖注入到 app 中，供路由使用
  app.set('configManager', configManager);
  app.set('dbPool', dbPool);
  app.set('authService', authService);
  app.set('libraryService', libraryService);
  app.set('accessibleFoldersService', accessibleFoldersService);
  app.set('imageService', imageService);
  app.set('scanService', scanService);
  app.set('fileService', fileService);

  // 认证中间件（仅作用于 /api 路由，避免拦截前端静态页面）
  app.use('/api', createAuthMiddleware(
    () => authService.getPasswordHash(),
    () => authService.getJwtSecret()
  ));

  // API 路由
  const authRouter = require('./routes/auth');
  const libraryRouter = require('./routes/library');
  const imageRouter = require('./routes/image');
  const scanRouter = require('./routes/scan');
  const fileRouter = require('./routes/file');
  const uploadRouter = require('./routes/upload');

  app.use('/api/auth', authRouter);
  app.use('/api/library', libraryRouter);
  app.use('/api/image', imageRouter);
  app.use('/api/scan', scanRouter);
  app.use('/api/file', fileRouter);
  app.use('/api/upload', uploadRouter);

  // 健康检查
  app.get('/api/health', (req, res) => {
    res.json({
      success: true,
      status: 'ok',
      timestamp: Date.now()
    });
  });

  // 静态文件服务（前端）
  const FRONTEND_DIST = process.env.FRONTEND_DIST;
  if (FRONTEND_DIST) {
    // index 关掉：HTML 必须由下面那个路由来发（要注入 <base>），
    // 否则 express.static 会把未注入的 index.html 直接吐出去。
    app.use(express.static(FRONTEND_DIST, { index: false }));

    // 兜底路由（SPA）：**只在"看起来是页面请求"时回 index.html**。
    // 带扩展名却找不到的资源必须直接 404 —— 否则 /assets/xxx.js 会返回一段 HTML，
    // 浏览器报的是语法错误、图片变成破图，排查时完全看不出是 404（fpk 规范踩坑 #20）。
    app.get('*', (req, res) => {
      if (/\.[A-Za-z0-9]{1,8}$/.test(req.path)) {
        return res.status(404).send('Not found');
      }
      res.type('html').send(renderIndexHtml(req));
    });
  }

  // 错误处理中间件（必须放在最后）
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
