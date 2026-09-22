// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 扫描路由（新架构）
 * 薄层路由，业务逻辑在 Service 层
 */

const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequired } = require('../middleware/validator');

// 服务实例（从 app 中获取）
let scanService;

router.use((req, res, next) => {
  if (!scanService) {
    scanService = req.app.get('scanService');
  }
  next();
});

/**
 * 全量扫描
 * POST /api/scan/full
 * Body: { libraryId, wait? }
 */
router.post('/full',
  validateRequired(['libraryId']),
  asyncHandler(async (req, res) => {
    const { libraryId, wait = false } = req.body;
    const result = await scanService.fullScan(libraryId, wait);
    res.json({ success: true, data: result });
  })
);

/**
 * 全量重扫（界面上的「扫描库文件」）
 * POST /api/scan/rescan
 * Body: { libraryId, wait?, prune? }
 *
 *   wait  —— true 等扫完再返回；false 走 Socket.IO 推进度
 *   prune —— 是否清理磁盘上已不存在的记录（默认 true）
 *
 * 与 /sync（增量）的区别：每个文件都重新读一遍元数据、重算 name_sort、
 * 补齐缺失的缩略图，用于「在磁盘上重新整理过文件，想让库跟着更新」。
 * 评分 / 收藏 / 标签不会丢（入库是保留用户数据的 upsert）。
 */
router.post('/rescan',
  validateRequired(['libraryId']),
  asyncHandler(async (req, res) => {
    const { libraryId, wait = false, prune = true } = req.body;
    const result = await scanService.rescan(libraryId, wait, { prune: prune !== false });
    res.json({ success: true, data: result });
  })
);

/**
 * 增量同步
 * POST /api/scan/sync
 * Body: { libraryId, wait? }
 */
router.post('/sync',
  validateRequired(['libraryId']),
  asyncHandler(async (req, res) => {
    const { libraryId, wait = false } = req.body;
    const result = await scanService.incrementalSync(libraryId, wait);
    res.json({ success: true, data: result });
  })
);

/**
 * 获取扫描状态
 * GET /api/scan/status/:libraryId
 */
router.get('/status/:libraryId', asyncHandler(async (req, res) => {
  const { libraryId } = req.params;
  const result = scanService.getScanStatus(libraryId);
  res.json({ success: true, data: result });
}));

/**
 * 获取所有活跃的扫描状态
 * GET /api/scan/active-states
 */
router.get('/active-states', asyncHandler(async (req, res) => {
  const result = scanService.getAllActiveStates();
  res.json({ success: true, data: result });
}));

/**
 * 修复文件夹路径
 * POST /api/scan/fix-folders
 * Body: { libraryId }
 */
router.post('/fix-folders',
  validateRequired(['libraryId']),
  asyncHandler(async (req, res) => {
    const { libraryId } = req.body;
    const result = await scanService.fixFolders(libraryId);
    res.json({ success: true, data: result });
  })
);

module.exports = router;
