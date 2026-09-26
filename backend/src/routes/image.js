// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 图片路由（新架构）
 * 薄层路由，业务逻辑在 Service 层
 */

const express = require('express');
const router = express.Router();
const { resolveInside, PathEscapeError } = require('../utils/safePath');
const path = require('path');
const fs = require('fs');
const { asyncHandler } = require('../middleware/errorHandler');
const { validatePagination } = require('../middleware/validator');
const { getNiuPicPath } = require('../config');
const preview = require('../../utils/preview');
const formats = require('../config/formats');

// 服务实例（从 app 中获取）
let imageService;

router.use((req, res, next) => {
  if (!imageService) {
    imageService = req.app.get('imageService');
  }
  next();
});

/**
 * 搜索图片
 * GET /api/image?libraryId=xxx&keywords=xxx&folder=xxx&offset=0&limit=100
 *                  &sort=created|indexed|modified|name|size|resolution|width|height
 *                        |aspect|format|type|rating|favorite|folder|random
 *                  &order=asc|desc
 *                  &seed=12345   （仅 sort=random 时用，决定洗牌结果）
 */
router.get('/', 
  validatePagination,
  asyncHandler(async (req, res) => {
    const {
      libraryId, keywords, folder, formats, offset, limit, sort, order, seed,
      filterMode, minSize, maxSize, orientations, ratings
    } = req.query;

    const filters = {};
    if (keywords) filters.keywords = keywords;
    if (folder) filters.folder = folder;
    if (formats) filters.formats = formats.split(',').filter(Boolean);

    // 筛选 / 排除：exclude 时上面那些条件变成「剔除」
    if (filterMode) filters.filterMode = filterMode === 'exclude' ? 'exclude' : 'include';

    // 文件大小（字节，来自双滑块）
    const min = Number(minSize);
    const max = Number(maxSize);
    if (Number.isFinite(min) && min > 0) filters.minSize = min;
    if (Number.isFinite(max) && max > 0) filters.maxSize = max;

    // 方向 / 评分
    if (orientations) filters.orientations = orientations.split(',').filter(Boolean);
    if (ratings) filters.ratings = ratings.split(',').map(Number).filter((n) => Number.isFinite(n));

    // 排序（字段白名单校验在 ImageModel._buildOrderBy 里做）
    if (sort) filters.sort = sort;
    if (order) filters.order = order;
    if (seed) filters.seed = seed;

    const pagination = (offset !== undefined && limit !== undefined)
      ? { offset: parseInt(offset), limit: parseInt(limit) }
      : null;

    const result = await imageService.searchImages(libraryId, filters, pagination);
    res.json({ success: true, data: result });
  })
);

/**
 * 当前范围内的筛选选项
 * GET /api/image/filter-options?libraryId=xxx&folder=xxx&keywords=xxx
 *
 * 界面只应该列出「当前文件夹里实际存在」的格式 / 大小范围 / 方向 / 评分。
 * 必须放在 /:id 之类的动态路由之前。
 */
router.get('/filter-options',
  asyncHandler(async (req, res) => {
    const { libraryId, folder, keywords } = req.query;
    if (!libraryId) {
      return res.status(400).json({ success: false, message: '缺少必要参数: libraryId' });
    }
    const filters = {};
    if (folder) filters.folder = folder;
    if (keywords) filters.keywords = keywords;
    const data = await imageService.getFilterOptions(libraryId, filters);
    res.json({ success: true, data });
  })
);

/**
 * 获取图片总数
 * GET /api/image/count?libraryId=xxx
 */
router.get('/count', asyncHandler(async (req, res) => {
  const { libraryId } = req.query;
  const count = await imageService.getImageCount(libraryId);
  res.json({ success: true, data: { count } });
}));

/**
 * 获取图片统计
 * GET /api/image/stats?libraryId=xxx
 */
router.get('/stats', asyncHandler(async (req, res) => {
  const { libraryId } = req.query;
  const stats = await imageService.getImageStats(libraryId);
  res.json({ success: true, data: stats });
}));

/**
 * 获取文件夹列表
 * GET /api/image/folders?libraryId=xxx
 */
router.get('/folders', asyncHandler(async (req, res) => {
  const { libraryId } = req.query;
  const folders = await imageService.getFolders(libraryId);
  res.json({ success: true, data: { folders } });
}));

/**
 * 获取缓存元数据
 * GET /api/image/cache-meta?libraryId=xxx
 */
router.get('/cache-meta', asyncHandler(async (req, res) => {
  const { libraryId } = req.query;
  const meta = await imageService.getCacheMeta(libraryId);
  res.json({ success: true, data: meta });
}));

/**
 * 获取图片详情
 * GET /api/image/:id?libraryId=xxx
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { libraryId } = req.query;
  const image = await imageService.getImageById(libraryId, id);
  res.json({ success: true, data: image });
}));

/**
 * 获取缩略图
 * GET /api/image/thumbnail/:libraryId/:filename
 * 使用分片结构：.niupic/thumbnails/ab/hash.webp
 */
router.get('/thumbnail/:libraryId/:filename', (req, res) => {
  const { libraryId, filename } = req.params;
  
  try {
    const config = require('../../utils/config').loadConfig();
    
    // 尝试两种方式查找：数字和字符串
    let library = config.libraries.find(lib => lib.id === parseInt(libraryId));
    if (!library) {
      library = config.libraries.find(lib => lib.id == libraryId);
    }
    
    if (!library) {
      return res.status(404).send('Library not found');
    }
    
    // 文件名必须是**单个文件名**：不允许带分隔符或 .. （缩略图路由也踩过穿越）
    if (!/^[^/\\]+$/.test(filename) || filename === '.' || filename === '..') {
      return res.status(403).send('非法文件名');
    }

    // 使用分片结构：取文件名前2个字符作为分片目录
    const hash = filename.replace(/\.[^/.]+$/, '');
    const shard = hash.slice(0, 2);
    const niupicPath = getNiuPicPath(library.path);
    const thumbnailPath = resolveInside(niupicPath, path.join('thumbnails', shard, filename));
    
    if (!fs.existsSync(thumbnailPath)) {
      return res.status(404).send('Thumbnail not found');
    }
    
    res.sendFile(thumbnailPath);
  } catch (error) {
    if (error instanceof PathEscapeError) {
      return res.status(403).send('非法路径');
    }
    console.error('❌ 缩略图错误:', error.message);
    res.status(500).send('Error serving thumbnail');
  }
});

/**
 * 获取原图
 * GET /api/image/original/:libraryId/:path
 */
router.get('/original/:libraryId/*', (req, res) => {
  const { libraryId } = req.params;
  const imagePath = req.params[0]; // 获取通配符匹配的路径
  
  try {
    const config = require('../../utils/config').loadConfig();
    
    // 尝试两种方式查找：数字和字符串
    let library = config.libraries.find(lib => lib.id === parseInt(libraryId));
    if (!library) {
      library = config.libraries.find(lib => lib.id == libraryId);
    }
    
    if (!library) {
      return res.status(404).send('Library not found');
    }
    
    // 这里是穿越的重灾区：以前直接 path.join(library.path, imagePath) 就 sendFile，
    // 于是 `../../../../etc/passwd` 能读出来（而且当时这个路由还免鉴权）。
    const fullPath = resolveInside(library.path, imagePath);

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).send('Image not found');
    }

    res.sendFile(fullPath);
  } catch (error) {
    if (error instanceof PathEscapeError) {
      return res.status(403).send('非法路径');
    }
    console.error('Error serving original image:', error);
    res.status(500).send('Error serving image');
  }
});

/**
 * 获取可显示的预览图
 * GET /api/image/preview/:libraryId/*?size=4096
 *
 * 前端显示**统一**走这个路由，不自己判断"这个格式能不能显示"：
 *   - 浏览器自己就认的格式（jpg/png/webp/gif/avif/bmp/svg）→ 原样发原图，不转码不失真；
 *   - 浏览器不认的（heic/tiff/psd/tga/exr/qoi/dds… 以及各家相机 RAW）→ 按需转 webp 并缓存。
 * 这样"能不能看"只取决于后端有没有解码器，与用户用什么浏览器无关。
 */
router.get('/preview/:libraryId/*', asyncHandler(async (req, res) => {
  const { libraryId } = req.params;
  const imagePath = req.params[0];

  const config = require('../../utils/config').loadConfig();

  let library = config.libraries.find(lib => lib.id === parseInt(libraryId));
  if (!library) {
    library = config.libraries.find(lib => lib.id == libraryId);
  }
  if (!library) {
    return res.status(404).json({ success: false, message: '素材库不存在' });
  }

  // 与 /original 同样过一遍路径校验：这里也会 readFile/sendFile。
  // 必须自己把 PathEscapeError 翻成 403 —— 漏了这一步它会被全局错误处理接走，
  // 客户端拿到的是 500「服务器内部错误」，看着像故障而不是"你越界了"。
  let fullPath;
  try {
    fullPath = resolveInside(library.path, imagePath);
  } catch (error) {
    if (error instanceof PathEscapeError) {
      return res.status(403).json({ success: false, message: '非法路径' });
    }
    throw error;
  }

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).json({ success: false, message: '文件不存在' });
  }

  const ext = path.extname(fullPath).toLowerCase().slice(1);

  // 1) 浏览器直接认：发原图（保留动图、保留 EXIF 方向、支持 Range）
  if (!preview.needsConversion(fullPath)) {
    res.set('Cache-Control', 'private, max-age=86400');
    return res.sendFile(fullPath);
  }

  // 2) 需要转码：只有"图片"类别才转，其它类型明确回 415，前端据此退回占位
  if (!preview.isConvertible(fullPath)) {
    return res.status(415).json({
      success: false,
      message: `不支持的预览格式：${ext || '无扩展名'}`,
      decoder: formats.getImageDecoder(ext),
      category: formats.getCategory(ext),
    });
  }

  const result = await preview.ensurePreview(fullPath, library.path, { size: req.query.size });
  if (!result) {
    return res.status(422).json({ success: false, message: '这个文件解不出预览图（可能已损坏或格式变体不受支持）' });
  }

  res.set('Content-Type', 'image/webp');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(result.path);
}));

/**
 * 更新图片评分
 * PUT /api/image/rating
 * Body: { libraryId, paths: [string], rating: number }
 */
router.put('/rating', asyncHandler(async (req, res) => {
  const { libraryId, paths, rating } = req.body;
  
  if (!libraryId || !paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ 
      success: false, 
      message: '缺少必要参数: libraryId, paths' 
    });
  }
  
  if (typeof rating !== 'number' || rating < 0 || rating > 5) {
    return res.status(400).json({ 
      success: false, 
      message: '评分必须是 0-5 之间的整数' 
    });
  }
  
  const result = await imageService.updateRating(libraryId, paths, rating);
  res.json({ success: true, data: result });
}));

module.exports = router;
