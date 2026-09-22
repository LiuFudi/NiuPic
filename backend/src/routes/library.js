// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 素材库路由（新架构）
 * 薄层路由，业务逻辑在 Service 层
 */

const express = require('express');
const router = express.Router();
const { asyncHandler, ValidationError } = require('../middleware/errorHandler');
const { validateRequired } = require('../middleware/validator');

// 服务实例（从 app 中获取）
let libraryService;
let accessibleFoldersService;

router.use((req, res, next) => {
  if (!libraryService) {
    libraryService = req.app.get('libraryService');
  }
  if (!accessibleFoldersService) {
    accessibleFoldersService = req.app.get('accessibleFoldersService');
  }
  next();
});

/**
 * 列出「管理员在应用市场授权给本应用」的文件夹
 * GET /api/library/accessible-folders?lang=zh-CN
 *
 * 必须放在 /:id 之类的动态路由之前，避免被当成素材库 id。
 */
router.get('/accessible-folders', asyncHandler(async (req, res) => {
  const requested = typeof req.query.lang === 'string' ? req.query.lang.trim() : '';
  // 语言决定飞牛语义路径的写法（「存储空间1/图片」还是「Storage 1/pictures」）：
  // 前端没给就用系统语言，最后兜底 zh-CN。
  const systemLanguage =
    typeof process.env.TRIM_SYS_LANGUAGE === 'string' ? process.env.TRIM_SYS_LANGUAGE.trim() : '';
  const language = (requested || systemLanguage || 'zh-CN').slice(0, 32);

  const result = await accessibleFoldersService.list({ language });
  res.json({ success: true, data: result });
}));

/**
 * 获取所有素材库
 * GET /api/library
 */
router.get('/', asyncHandler(async (req, res) => {
  const data = libraryService.getAllLibraries();
  res.json({ success: true, data });
}));

/**
 * 创建素材库
 * POST /api/library
 * Body: { name, path }
 */
router.post('/', 
  validateRequired(['name', 'path']),
  asyncHandler(async (req, res) => {
    const { name, path } = req.body;
    const result = await libraryService.createLibrary(name, path);
    res.json({ success: true, data: result });
  })
);

/**
 * 更新偏好设置（必须在 /:id 之前，否则会被 /:id 匹配）
 * PUT /api/library/preferences
 * Body: { preferences }
 */
router.put('/preferences', asyncHandler(async (req, res) => {
  const result = libraryService.updatePreferences(req.body);
  res.json({ success: true, data: result });
}));

/**
 * 更新主题（必须在 /:id 之前）
 * PUT /api/library/theme
 * Body: { theme }
 */
router.put('/theme', 
  validateRequired(['theme']),
  asyncHandler(async (req, res) => {
    const { theme } = req.body;
    const result = libraryService.updateTheme(theme);
    res.json({ success: true, data: result });
  })
);

/**
 * 更新主题色（强调色，必须在 /:id 之前）
 * PUT /api/library/theme-color
 * Body: { themeColor: '#rrggbb' | '' }   —— '' 表示恢复内置默认蓝
 *
 * 不能用 validateRequired：空串是「恢复默认」的合法取值，会被它当成缺参数。
 */
router.put('/theme-color',
  (req, res, next) => {
    if (typeof req.body?.themeColor !== 'string') {
      return next(new ValidationError('themeColor is required', 'themeColor'));
    }
    next();
  },
  asyncHandler(async (req, res) => {
    const { themeColor } = req.body;
    const result = libraryService.updateThemeColor(themeColor);
    res.json({ success: true, data: result });
  })
);

/**
 * 更新素材库
 * PUT /api/library/:id
 * Body: { name?, path? }
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await libraryService.updateLibrary(id, req.body);
  res.json({ success: true, data: result });
}));

/**
 * 删除素材库
 * DELETE /api/library/:id
 * Query: autoSelectNext - 是否自动选择下一个素材库，默认 true
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const autoSelectNext = req.query.autoSelectNext !== 'false';
  const result = await libraryService.deleteLibrary(id, autoSelectNext);
  res.json({ success: true, data: result });
}));

/**
 * 设置当前素材库
 * POST /api/library/:id/set-current
 */
router.post('/:id/set-current', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await libraryService.setCurrentLibrary(id);
  res.json({ success: true, data: result });
}));

/**
 * 获取素材库统计
 * GET /api/library/:id/stats
 */
router.get('/:id/stats', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await libraryService.getLibraryStats(id);
  res.json({ success: true, data: result });
}));

/**
 * 验证素材库路径是否存在
 * GET /api/library/:id/validate
 */
router.get('/:id/validate', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = libraryService.validateLibraryPath(id);
  res.json({ success: true, data: result });
}));

module.exports = router;
