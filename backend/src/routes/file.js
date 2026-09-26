// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 文件操作路由
 * 提供删除、重命名、移动、复制等文件操作接口
 */

const express = require('express');
const router = express.Router();
// ValidationError 必须一起引进来：/restore 里用它区分"参数不对（400）"和"服务出错（500）"。
// 漏掉的话抛的是 ReferenceError，会被 asyncHandler 交给错误中间件、返回 500
// —— 用户看到「服务器内部错误」，排查方向完全被带偏。
const { asyncHandler, ValidationError } = require('../middleware/errorHandler');

// 服务实例（从 app 中获取）
let fileService;

router.use((req, res, next) => {
  if (!fileService) {
    fileService = req.app.get('fileService');
  }
  next();
});

/**
 * 删除文件或文件夹（移到临时文件夹，5分钟内可撤销）
 * DELETE /api/file/delete
 * Body: { libraryId, items: [{type, path}] }
 */
router.delete('/delete', asyncHandler(async (req, res) => {
  const { libraryId, items } = req.body;

  if (!libraryId || !items || !Array.isArray(items)) {
    return res.status(400).json({
      success: false,
      error: '缺少必要参数'
    });
  }

  const results = await fileService.deleteItems(libraryId, items);
  
  res.json({
    success: true,
    data: results
  });
}));

/**
 * 重命名文件或文件夹
 * PATCH /api/file/rename
 * Body: { libraryId, path, newName }
 */
router.patch('/rename', asyncHandler(async (req, res) => {
  const { libraryId, path, newName } = req.body;

  if (!libraryId || !path || !newName) {
    return res.status(400).json({
      success: false,
      error: '缺少必要参数'
    });
  }

  const result = await fileService.renameItem(libraryId, path, newName);
  
  res.json({
    success: true,
    data: result
  });
}));

/**
 * 移动文件或文件夹
 * POST /api/file/move
 * Body: { libraryId, items: [{type, path}], targetFolder, conflictAction?: 'skip'|'replace'|'rename' }
 */
router.post('/move', asyncHandler(async (req, res) => {
  const { libraryId, items, targetFolder, conflictAction } = req.body;

  if (!libraryId || !items || !Array.isArray(items) || targetFolder === undefined) {
    return res.status(400).json({
      success: false,
      error: '缺少必要参数'
    });
  }

  const results = await fileService.moveItems(libraryId, items, targetFolder, conflictAction);
  
  res.json({
    success: true,
    data: results
  });
}));

/**
 * 复制文件或文件夹
 * POST /api/file/copy
 * Body: { libraryId, items: [{type, path}], targetFolder, conflictAction?: 'skip'|'replace'|'rename' }
 */
router.post('/copy', asyncHandler(async (req, res) => {
  const { libraryId, items, targetFolder, conflictAction } = req.body;

  if (!libraryId || !items || !Array.isArray(items) || targetFolder === undefined) {
    return res.status(400).json({
      success: false,
      error: '缺少必要参数'
    });
  }

  const results = await fileService.copyItems(libraryId, items, targetFolder, conflictAction);
  
  res.json({
    success: true,
    data: results
  });
}));

/**
 * 更新文件元数据（评分、收藏、标签）
 * PATCH /api/file/metadata
 * Body: { libraryId, path, rating?, favorite?, tags? }
 */
router.patch('/metadata', asyncHandler(async (req, res) => {
  const { libraryId, path, ...metadata } = req.body;

  if (!libraryId || !path) {
    return res.status(400).json({
      success: false,
      error: '缺少必要参数'
    });
  }

  const result = await fileService.updateMetadata(libraryId, path, metadata);
  
  res.json({
    success: true,
    data: result
  });
}));

/**
 * 恢复文件
 */
router.post('/restore', asyncHandler(async (req, res) => {
  const { libraryId, items } = req.body;

  if (!libraryId) {
    throw new ValidationError('libraryId');
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('items');
  }

  const fileService = req.app.get('fileService');
  const result = await fileService.restoreItems(libraryId, items);

  res.json({
    success: true,
    data: result
  });
}));

/**
 * 创建空文件夹
 * POST /api/file/create-folder
 * Body: { libraryId, folderPath }
 */
router.post('/create-folder', asyncHandler(async (req, res) => {
  const { libraryId, folderPath } = req.body;

  if (!libraryId || !folderPath) {
    return res.status(400).json({
      success: false,
      error: '缺少必需参数'
    });
  }

  const result = await fileService.createFolder(libraryId, folderPath);

  res.json({
    success: true,
    data: result
  });
}));

module.exports = router;
