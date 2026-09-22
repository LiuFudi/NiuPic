// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 文件上传路由
 * 支持拖拽上传图片到指定文件夹
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { asyncHandler } = require('../middleware/errorHandler');
const { processImage } = require('../../utils/scanner');
const logger = require('../utils/logger');

// 配置 multer 使用内存存储
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  }
  // 移除文件格式限制，让扫描逻辑自动处理
});

/**
 * 上传图片到指定文件夹
 * POST /api/upload
 * FormData: { libraryId, targetFolder, files[], conflictAction? }
 * conflictAction: 'skip' | 'replace' | 'rename'
 */
router.post('/', upload.array('files', 50), asyncHandler(async (req, res) => {
  const requestStartTime = Date.now();
  const totalSize = req.files?.length > 0 ? req.files.reduce((sum, f) => sum + f.size, 0) : 0;
  console.log(`\n📤 上传 ${req.files?.length} 个文件 (${(totalSize / 1024 / 1024).toFixed(2)}MB) 到 [${req.body.targetFolder || '根目录'}]`);
  
  const { libraryId, targetFolder, conflictAction } = req.body;
  const files = req.files;

  if (!libraryId) {
    console.error('❌ 缺少 libraryId 参数');
    return res.status(400).json({
      success: false,
      error: '缺少 libraryId 参数'
    });
  }

  if (!files || files.length === 0) {
    console.error('❌ 没有上传文件');
    return res.status(400).json({
      success: false,
      error: '没有上传文件'
    });
  }

  // 获取依赖
  const dbPool = req.app.get('dbPool');
  const configManager = req.app.get('configManager');
  
  if (!dbPool || !configManager) {
    console.error('❌ 服务未初始化');
    return res.status(500).json({
      success: false,
      error: '服务未初始化'
    });
  }
  
  // 获取素材库配置
  const config = configManager.load();
  const library = config.libraries.find(lib => lib.id === libraryId);
  
  if (!library) {
    console.error('❌ 素材库不存在:', libraryId);
    return res.status(404).json({
      success: false,
      error: '素材库不存在'
    });
  }
  
  // 获取数据库实例
  const db = dbPool.acquire(library.path);
  const libraryPath = library.path;
  const targetPath = targetFolder 
    ? path.join(libraryPath, targetFolder)
    : libraryPath;

  // 确保目标文件夹存在
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }

  const results = {
    success: [],
    failed: [],
    conflicts: []  // 改为 conflicts，与粘贴逻辑一致
  };

  // 用于后台处理的文件列表
  const filesToProcess = [];

  // 第一阶段：保存文件（根据 conflictAction 处理冲突）
  for (const file of files) {
    try {
      // 修复中文文件名乱码：multer 默认使用 latin1 编码，需要转换为 utf8
      let filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
      let filePath = path.join(targetPath, filename);

      // 检查文件是否已存在
      if (fs.existsSync(filePath)) {
        // 如果没有指定冲突处理方式，收集冲突信息返回给前端
        if (!conflictAction) {
          const relativePath = targetFolder 
            ? path.join(targetFolder, filename).replace(/\\/g, '/')
            : filename;
          results.conflicts.push({
            name: filename,
            path: relativePath
          });
          console.log(`⚠️  冲突: ${filename} (文件已存在)`);
          continue;
        }
        
        // 根据 conflictAction 处理冲突
        if (conflictAction === 'skip') {
          console.log(`⏭️  跳过: ${filename} (文件已存在)`);
          continue;
        } else if (conflictAction === 'replace') {
          // 覆盖：删除旧文件
          console.log(`🔄 覆盖: ${filename}`);
          fs.unlinkSync(filePath);
        } else if (conflictAction === 'rename') {
          // 重命名：生成新文件名
          const ext = path.extname(filename);
          const nameWithoutExt = filename.substring(0, filename.length - ext.length);
          let counter = 1;
          let newFilename = filename;
          let newFilePath = filePath;
          
          while (fs.existsSync(newFilePath)) {
            newFilename = `${nameWithoutExt} (${counter})${ext}`;
            newFilePath = path.join(targetPath, newFilename);
            counter++;
          }
          
          filename = newFilename;
          filePath = newFilePath;
          console.log(`📝 重命名: ${file.originalname} → ${filename}`);
        }
      }

      // 写入文件（同步，快速）
      fs.writeFileSync(filePath, file.buffer);
      
      // 计算相对路径（使用最终的文件名）
      const relativePath = targetFolder 
        ? path.join(targetFolder, filename).replace(/\\/g, '/')
        : filename;
      
      results.success.push({
        filename,
        path: relativePath,
        size: file.size
      });
      
      // 添加到待处理列表（只处理图片文件）
      const ext = path.extname(filename).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.svg'];
      if (imageExts.includes(ext)) {
        filesToProcess.push({ filePath, filename });
      }
    } catch (error) {
      console.error(`❌ 保存失败: ${file.originalname} -`, error.message);
      results.failed.push({
        filename: file.originalname,
        error: error.message
      });
    }
  }
  
  // 第二阶段：后台异步处理图片（生成缩略图、提取元数据）
  if (filesToProcess.length > 0) {
    setImmediate(async () => {
      const processStartTime = Date.now();
      let processedCount = 0;
      let failedCount = 0;
      
      for (const { filePath, filename } of filesToProcess) {
        try {
          await processImage(filePath, libraryPath, db);
          processedCount++;
        } catch (processError) {
          failedCount++;
          console.error(`❌ 处理失败: ${filename} -`, processError.message);
        }
      }
      
      const totalProcessTime = Date.now() - processStartTime;
      console.log(`✅ 后台处理完成: ${processedCount}/${filesToProcess.length} (${totalProcessTime}ms)`);
    });
  }

  // 更新文件夹图片计数
  if (targetFolder && results.success.length > 0) {
    try {
      const updateStmt = db.db.prepare(`
        UPDATE folders 
        SET image_count = (
          SELECT COUNT(*) FROM images WHERE folder = ? OR folder LIKE ?
        ),
        last_scan = ?
        WHERE path = ?
      `);
      updateStmt.run(
        targetFolder,
        targetFolder + '/%',
        Date.now(),
        targetFolder
      );
    } catch (error) {
      console.error('❌ 更新文件夹计数失败:', error.message);
    }
  }
  
  const totalRequestTime = Date.now() - requestStartTime;
  console.log(`✅ HTTP响应: 成功 ${results.success.length}, 失败 ${results.failed.length}, 冲突 ${results.conflicts.length} (${totalRequestTime}ms)\n`);

  res.json({
    success: true,
    data: results
  });
}));

module.exports = router;
