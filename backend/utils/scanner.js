// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

const fs = require('fs');
const path = require('path');
const {
  isImageFile,
  getFileType,
  calculateFileHash,
  getImageMetadata,
  getOriginalDimensions,
  generateImageThumbnails,
  clearSharpCache
} = require('./thumbnail');
const scanManager = require('./scanManager');
const { constants } = require('../src/config');
const logger = require('../src/utils/logger');

// 遍历时永远跳过的目录名：应用自己的索引/缩略图目录，以及依赖目录
const SKIP_DIRS = new Set(['.niupic', '.flypic', 'node_modules']);

/**
 * 扫描时遇到读不了的目录，抛这个错（带上路径，便于界面直接告诉用户怎么办）
 */
class ScanPathError extends Error {
  constructor(message, dirPath) {
    super(message);
    this.name = 'ScanPathError';
    this.dirPath = dirPath;
  }
}

/**
 * 列出素材库里的所有文件（递归）
 *
 * 为什么不用 glob：
 *   FlyPic 时代这里用的是 `glob('**\/*.*', { nocase: true })`，
 *   而 `nocase: true` 会让 glob 在 **btrfs**（飞牛的数据盘就是 btrfs）上一个文件都匹配不到 ——
 *   连"路径完全正确、文件确实存在"的情况也返回空数组。实测：
 *
 *     glob('/vol1/.../frontend/src/**\/*.js', { nodir: true })              → 47 个
 *     glob('/vol1/.../frontend/src/**\/*.js', { nodir: true, nocase: true }) →  0 个
 *     glob('/vol1/.../package.json',           { nocase: true })             →  0 个（文件明明存在）
 *     同样的调用放在 ext4/tmpfs 上（/tmp）却是好的
 *
 *   于是"扫描完成，0 个文件"，用户看到的是空空如也的库 —— 路径里带大写字母的库
 *   （例如 `Photos-Backup/Camera`）就是这么中招的；有些库是老版本入库的，所以看着没事。
 *   `nocase` 本来就是给 Windows/macOS 准备的（Linux 上大小写敏感，扩展名大小写
 *   由 `*.*` 这类匹配天然覆盖），所以这里改成自己用 readdir 走一遍：
 *   行为确定、不依赖 glob 的大小写匹配，还能顺手统计"到底看见了多少东西"。
 *
 * @param {string} libraryPath 素材库根目录
 * @returns {Promise<string[]>} 文件绝对路径（顺序稳定：按目录名排序深度优先）
 */
async function getAllImageFiles(libraryPath) {
  const files = [];
  const pending = [libraryPath];

  while (pending.length > 0) {
    const dir = pending.pop();

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // 根目录读不了 = 整个扫描没意义，直接抛出可读的错误；
      // 子目录读不了就跳过并记日志（一个子目录没权限不该让整个库扫不了）
      if (dir === libraryPath) {
        const hint = error.code === 'EACCES' || error.code === 'EPERM'
          ? '没有读取权限，请在「应用中心 → NiuPic → 应用设置 → 可访问文件夹」里给它授权'
          : error.message;
        throw new ScanPathError(`无法读取素材库目录：${dir}（${hint}）`, dir);
      }
      logger.warn(`跳过无法读取的目录 ${dir}: ${error.code || error.message}`);
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        pending.push(full);
      } else if (entry.isSymbolicLink()) {
        // 符号链接：指向文件的（且目标还在）才算，避免链接成环时无限递归
        try {
          if (fs.statSync(full).isFile()) files.push(full);
        } catch {
          /* 断链，忽略 */
        }
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  return files;
}

/**
 * Ensure a folder and its parents exist in DB
 */
function ensureFolderChain(db, folderPath) {
  if (!folderPath || folderPath === '.' || folderPath === '') return;
  let current = folderPath.replace(/\\/g, '/');
  const visited = new Set();
  while (current && current !== '.' && !visited.has(current)) {
    visited.add(current);
    const parent = path.posix.dirname(current);
    const name = current.split('/').pop();
    
    // 安全检查：确保 db 对象有 getFolderByPath 方法
    if (typeof db.getFolderByPath !== 'function') {
      logger.error('db.getFolderByPath 不是函数');
      return;
    }
    
    const existing = db.getFolderByPath(current);
    if (!existing) {
      db.insertFolder({
        path: current,
        parent_path: parent === '.' ? '' : (parent === current ? '' : parent),
        name,
        image_count: 0
      });
    }
    if (parent === current) break;
    current = parent;
  }
}

/**
 * Apply changes from file system events quickly without full rescan
 * events = {
 *   filesAdded: [relPath],
 *   filesChanged: [relPath],
 *   filesRemoved: [relPath],
 *   dirsAdded: [relDir],
 *   dirsRemoved: [relDir]
 * }
 */
async function applyChangesFromEvents(libraryPath, db, events) {
  try {
    // Normalize helper: 统一使用正斜杠，与数据库记录格式一致
    const norm = (p) => path.normalize(p).replace(/\\/g, '/');

    const affectedFolders = new Set();
    const results = { added: 0, modified: 0, deleted: 0, foldersAdded: 0, foldersRemoved: 0 };

    // Handle directory additions (ensure chain exists)
    for (const dir of (events.dirsAdded || [])) {
      const d = norm(dir);
      ensureFolderChain(db, d);
      results.foldersAdded++;
      // update parents too
      let cur = d;
      while (cur && cur !== '.') {
        affectedFolders.add(cur);
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }

    // Handle file additions
    for (const file of (events.filesAdded || [])) {
      try {
        const rel = norm(file);
        const full = path.join(libraryPath, rel);

        // 检查文件是否存在
        if (!fs.existsSync(full)) {
          logger.warn(`File not found, skipping: ${full}`);
          continue;
        }

        const folder = path.dirname(rel);
        ensureFolderChain(db, folder);
        await processImage(full, libraryPath, db);
        affectedFolders.add(folder);
        // parents
        let cur = folder;
        while (cur && cur !== '.') {
          affectedFolders.add(cur);
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
        results.added++;
      } catch (error) {
        logger.error(`处理新增文件失败 ${file}:`, error.message);
      }
    }

    // Handle file changes
    for (const file of (events.filesChanged || [])) {
      try {
        const rel = norm(file);
        const full = path.join(libraryPath, rel);

        // 检查文件是否存在
        if (!fs.existsSync(full)) {
          logger.warn(`File not found, skipping: ${full}`);
          continue;
        }

        await processImage(full, libraryPath, db);
        const folder = path.dirname(rel);
        affectedFolders.add(folder);
        results.modified++;
      } catch (error) {
        logger.error(`处理修改文件失败 ${file}:`, error.message);
      }
    }

    // Handle file removals
    for (const file of (events.filesRemoved || [])) {
      try {
        const rel = norm(file);
        db.deleteImage(rel);
        const folder = path.dirname(rel);
        affectedFolders.add(folder);
        // parents
        let cur = folder;
        while (cur && cur !== '.') {
          affectedFolders.add(cur);
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
        results.deleted++;
      } catch (error) {
        logger.error(`删除文件失败 ${file}:`, error.message);
      }
    }

    // Handle directory removals (bulk delete)
    for (const dir of (events.dirsRemoved || [])) {
      try {
        const d = norm(dir);
        // delete images and folders under this dir
        db.deleteImagesByFolderPrefix(d);
        db.deleteFoldersByPrefix(d);
        const parent = path.dirname(d);
        if (parent && parent !== '.') affectedFolders.add(parent);
        results.foldersRemoved++;
      } catch (error) {
        logger.error(`删除目录失败 ${dir}:`, error.message);
      }
    }

    // Update counts for all affected folders
    affectedFolders.forEach((folderPath) => {
      if (folderPath && folderPath !== '.') {
        try {
          db.updateFolderImageCount(folderPath);
        } catch (error) {
          logger.error(`更新文件夹计数失败 ${folderPath}:`, error.message);
        }
      }
    });

    return results;
  } catch (error) {
    logger.error('应用变化失败:', error.message);
    throw error;
  }
}

/**
 * Get folder structure
 */
async function getFolderStructure(libraryPath) {
  const folders = [];

  function scanDir(dirPath, parentPath = '') {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      if (item.isDirectory() && !item.name.startsWith('.')) {
        const fullPath = path.join(dirPath, item.name);
        const relativePath = path.relative(libraryPath, fullPath);
        const relativePathUnix = relativePath.replace(/\\/g, '/');
        const parentUnix = (parentPath || '').replace(/\\/g, '/');

        folders.push({
          path: relativePathUnix,
          parent_path: parentUnix,
          name: item.name,
          image_count: 0
        });

        scanDir(fullPath, relativePathUnix);
      }
    }
  }

  scanDir(libraryPath);
  return folders;
}

/**
 * Process a single image file
 */
/**
 * Process a single image file
 * @param {boolean} dryRun - If true, return data instead of inserting into DB (for batch write)
 */
/**
 * 纠正已入库记录里的原图分辨率
 *
 * 早期版本把缩略图尺寸当成原图尺寸写进了 width/height。文件没变时扫描会直接跳过，
 * 所以在这里补一次。读取失败或非图片一律不动，不影响扫描流程。
 */
async function repairStoredDimensions(imagePath, existing, db) {
  try {
    if (!db || typeof db.updateImageDimensions !== 'function') return;
    // 视频 / PSD / 文档的尺寸来自封面提取，不能被 sharp 的结果覆盖
    if (getFileType(imagePath) !== 'image') return;

    const dims = await getOriginalDimensions(imagePath);
    if (!dims || !dims.width || !dims.height) return;
    if (dims.width === existing.width && dims.height === existing.height) return;

    db.updateImageDimensions(existing.id, dims.width, dims.height);
  } catch (error) {
    // 纠正失败不影响扫描
  }
}

async function processImage(imagePath, libraryPath, db, dryRun = false, options = {}) {
  // force = 全量重扫：即使哈希没变也重新读元数据、重算 name_sort，
  // 用于「在磁盘上重新整理过文件、想让库里跟着更新」的场景。
  const force = options.force === true;
  const processStartTime = Date.now();
  const stepTimes = {}; // 记录每个步骤的耗时
  
  try {
    const relativePath = path.relative(libraryPath, imagePath);
    const filename = path.basename(imagePath);
    const folderRaw = path.dirname(relativePath);
    const folder = folderRaw === '.' ? '' : folderRaw.replace(/\\/g, '/');

    // Check if image already exists in database
    let stepStart = Date.now();
    const existing = db.getImageByPath(relativePath.replace(/\\/g, '/'));
    stepTimes.dbCheck = Date.now() - stepStart;
    
    stepStart = Date.now();
    const currentHash = calculateFileHash(imagePath);
    stepTimes.hashCalc = Date.now() - stepStart;

    // For unchanged files, check whether thumbnails need upgrade/regeneration
    let needRegenThumbs = false;
    if (existing) {
      const niupicDir = path.join(libraryPath, '.niupic');
      const filenameOnly = (existing.thumbnail_path || '').replace(/\\/g, '/').split('/').pop();
      if (filenameOnly) {
        // Calculate sharded path
        const hash = filenameOnly.replace(/\.[^/.]+$/, ""); // remove extension
        const shard1 = hash.slice(0, 2);
        // New structure: .niupic/thumbnails/ab/hash.webp
        const expectedPath = path.join(niupicDir, 'thumbnails', shard1, filenameOnly);

        // 需要重建的情况：新结构文件不存在
        if (!fs.existsSync(expectedPath)) {
          needRegenThumbs = true;
        }
      } else {
        needRegenThumbs = true;
      }
    }

    // Skip only if unchanged and thumbnails are up-to-date（force 时一律重跑）
    if (!force && existing && existing.file_hash === currentHash && !needRegenThumbs) {
      // 老库里 width/height 可能存的是缩略图尺寸，这里顺手纠正一次。
      // 只读文件头，比上面算 hash 的全文件读取便宜得多；只有真不一致时才写库。
      await repairStoredDimensions(imagePath, existing, db);
      const totalTime = Date.now() - processStartTime;
      // logger.info(`⏭️  跳过 (未变化): ${filename} (${totalTime}ms)`);
      return { status: 'skipped', path: relativePath };
    }

    // Get image metadata
    stepStart = Date.now();
    const metadata = await getImageMetadata(imagePath);
    stepTimes.metadata = Date.now() - stepStart;
    if (!metadata) {
      const totalTime = Date.now() - processStartTime;
      logger.warn(`❌ 元数据读取失败: ${filename} (${totalTime}ms)`);
      return { status: 'error', path: relativePath, error: 'Failed to read metadata' };
    }

    // Generate thumbnails (also for unchanged files when thumbnails missing/outdated)
    stepStart = Date.now();
    const thumbnails = await generateImageThumbnails(imagePath, libraryPath);
    stepTimes.thumbnail = Date.now() - stepStart;
    
    const fileType = getFileType(imagePath);

    // 分辨率一律记录**原图**尺寸。
    //   真实图片：用原图像素（缩略图只是 480p 的展示副本，绝不能当原图尺寸——
    //            否则前端「100%」、适应全屏的缩放比例全都会按缩略图算）
    //   视频 / PSD / 其它：原文件本来就没有可解码的像素，只能沿用封面/占位图尺寸
    // 图片和视频都用**真实**宽高：
    //   · 图片来自 sharp，视频来自 ffprobe（见 getImageMetadata）
    //   · 以前只有 image 走这条路，视频/PSD 一律用缩略图尺寸当宽高 ——
    //     于是所有视频都被当成 640×480，16:9 的片子在网格里比例是错的
    const useOriginalDims = (fileType === 'image' || fileType === 'video')
      && metadata.width && metadata.height;
    const actualWidth = useOriginalDims ? metadata.width : (thumbnails.width || metadata.width);
    const actualHeight = useOriginalDims ? metadata.height : (thumbnails.height || metadata.height);

    const imageData = {
      path: relativePath.replace(/\\/g, '/'),
      filename: filename,
      folder: folder,
      size: metadata.size,
      width: actualWidth,
      height: actualHeight,
      format: metadata.format,
      file_type: fileType,
      created_at: Math.floor(metadata.created_at),
      modified_at: Math.floor(metadata.modified_at),
      file_hash: currentHash,
      thumbnail_path: thumbnails.thumbnail_path,
      thumbnail_size: thumbnails.thumbnail_size
    };

    if (dryRun) {
      return { status: 'processed', path: relativePath, data: imageData };
    }

    // Insert/update in database
    stepStart = Date.now();
    db.insertImage(imageData);
    stepTimes.dbInsert = Date.now() - stepStart;
    
    const totalTime = Date.now() - processStartTime;
    
    // 输出详细的性能日志
    const logParts = [
      `总计${totalTime}ms`,
      `哈希${stepTimes.hashCalc}ms`,
      `元数据${stepTimes.metadata}ms`,
      `缩略图${stepTimes.thumbnail}ms`
    ];
    
    // 只有当总耗时超过 500ms 时才输出警告
    if (totalTime > 500) {
      logger.warn(`⚠️  处理较慢: ${filename} (${logParts.join(', ')})`);
    }
    
    return { status: 'processed', path: relativePath, timing: stepTimes, totalTime };
  } catch (error) {
    const totalTime = Date.now() - processStartTime;
    logger.error(`❌ 处理图片失败: ${path.basename(imagePath)} (${totalTime}ms)`, error.message);
    return { status: 'error', path: imagePath, error: error.message, totalTime };
  }
}

/**
 * Scan library and update database
 * @param {string} libraryPath - 素材库路径
 * @param {object} db - 数据库实例
 * @param {function} onProgress - 进度回调
 * @param {string} libraryId - 素材库ID（用于停止控制）
 * @param {Array} resumeFiles - 继续扫描时的待处理文件列表
 */
/**
 * Scan library and update database
 * @param {string} libraryPath - 素材库路径
 * @param {object} db - 数据库实例
 * @param {function} onProgress - 进度回调
 * @param {string} libraryId - 素材库ID（用于停止控制）
 * @param {Array} resumeFiles - 继续扫描时的待处理文件列表
 */
async function scanLibrary(libraryPath, db, onProgress, libraryId = null, resumeFiles = null) {
  try {
    let files;

    // 动态导入 p-limit
    const pLimit = (await import('p-limit')).default;

    // 根据 CPU 核心数动态调整并发数
    const os = require('os');
    const cpuCount = os.cpus().length;
    const concurrency = Math.max(4, Math.min(16, cpuCount - 1));
    const limit = pLimit(concurrency);

    if (resumeFiles && resumeFiles.length > 0) {
      // 继续扫描：使用待处理文件列表
      files = resumeFiles;
    } else {
      // 新扫描：获取所有文件
      files = await getAllImageFiles(libraryPath);

      // Get folder structure
      const folders = await getFolderStructure(libraryPath);
      // 使用事务批量插入文件夹
      const insertFolders = db.db.transaction((folders) => {
        for (const folder of folders) db.insertFolder(folder);
      });
      insertFolders(folders);
    }

    const total = files.length;

    // 初始化扫描状态
    if (libraryId) {
      scanManager.startScan(libraryId, total, libraryPath);
    }

    const results = {
      total,          // 目录里一共找到多少个文件（0 就是真的一个都没找到，界面要如实说）
      processed: 0,
      skipped: 0,
      errors: 0,
      stopped: false
    };

    const startTime = Date.now();
    let processedCount = 0;

    // 批量写入缓冲区
    let writeBuffer = [];
    const WRITE_BATCH_SIZE = constants.SCAN.WRITE_BATCH_SIZE;
    const STREAM_BATCH_SIZE = constants.SCAN.STREAM_BATCH_SIZE;

    // 批量写入函数（事务）
    const batchWrite = db.db.transaction((items) => {
      for (const item of items) {
        if (item.status === 'processed' && item.data) {
          db.insertImage(item.data);
        }
      }
    });

    // 处理单个文件的包装函数
    const processFile = async (file) => {
      try {
        const result = await processImage(file, libraryPath, db, true); // true = dryRun (不直接写入DB)
        return result;
      } catch (error) {
        return { status: 'error', path: file, error: error.message };
      }
    };

    // 流式处理：分批处理文件，避免一次性创建大量 Promise
    for (let batchStart = 0; batchStart < total; batchStart += STREAM_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + STREAM_BATCH_SIZE, total);
      const batchFiles = files.slice(batchStart, batchEnd);

      // 处理当前批次
      const batchTasks = batchFiles.map(file => limit(async () => {
        const result = await processFile(file);

        // 更新统计
        if (result.status === 'processed') results.processed++;
        else if (result.status === 'skipped') results.skipped++;
        else if (result.status === 'error') results.errors++;

        // 添加到写入缓冲区
        if (result.status === 'processed') {
          writeBuffer.push(result);

          // 缓冲区满，执行批量写入
          if (writeBuffer.length >= WRITE_BATCH_SIZE) {
            batchWrite(writeBuffer);
            writeBuffer = []; // 清空缓冲区，释放内存
          }
        }

        processedCount++;

        // 报告进度 (每完成 10 个文件报告一次)
        if (processedCount % 10 === 0 || processedCount === total) {
          const current = processedCount;

          if (libraryId) {
            scanManager.updateProgress(libraryId, current, total);
          }

          if (onProgress) {
            const elapsed = Date.now() - startTime;
            const avgTimePerImage = elapsed / current;
            const remaining = total - current;
            const estimatedTimeLeft = Math.round((remaining * avgTimePerImage) / 1000);

            onProgress({
              total,
              current,
              percent: Math.round((current / total) * 100),
              currentFile: file,
              estimatedTimeLeft
            });
          }
        }

        return result;
      }));

      // 等待当前批次完成
      await Promise.all(batchTasks);

      // 批次完成后，写入剩余缓冲区并释放内存
      if (writeBuffer.length > 0) {
        batchWrite(writeBuffer);
        writeBuffer = [];
      }

      // 定期输出进度
      const logInterval = constants.SCAN.PROGRESS_LOG_INTERVAL;
      const gcInterval = constants.SCAN.GC_TRIGGER_INTERVAL;
      
      if (processedCount % logInterval === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = processedCount / elapsed;
        const percent = ((processedCount / total) * 100).toFixed(1);
        logger.info(`扫描进度: ${processedCount}/${total} (${percent}%) | ${speed.toFixed(1)} 张/秒`);
      }
      
      // 定期触发 GC
      if (processedCount > 0 && processedCount % gcInterval === 0 && global.gc) {
        global.gc();
      }
    }

    // 写入剩余的缓冲区数据
    if (writeBuffer.length > 0) {
      batchWrite(writeBuffer);
      writeBuffer = [];
    }

    const totalTime = (Date.now() - startTime) / 1000;
    logger.info(
      `扫描完成: 找到 ${total} 个文件，处理 ${results.processed}，跳过 ${results.skipped}，失败 ${results.errors} ` +
      `(${totalTime.toFixed(1)}秒)`
    );
    if (total === 0) {
      logger.warn(`素材库目录里没有找到任何文件：${libraryPath}`);
    }

    // Update folder image counts
    db.updateAllFolderCounts();

    // 🎯 关键：扫描完成后清理 Sharp 缓存，释放内存
    clearSharpCache();
    
    // 强制 GC（如果可用）
    if (global.gc) {
      global.gc();
      logger.perf('内存已清理');
    }

    // 标记扫描完成
    if (libraryId) {
      scanManager.completeScan(libraryId);
    }
    return results;
  } catch (error) {
    logger.error('扫描失败:', error.message);
    if (libraryId) {
      scanManager.completeScan(libraryId);
    }
    throw error;
  }
}

/**
 * 只修文件夹结构与计数（不读磁盘上的图片，秒级完成）
 *
 * 用途：文件夹列表显示 0 张、或者磁盘上挪过文件夹之后想对齐 ——
 * 这种情况不需要重新读一遍图片（大库在机械硬盘上要半小时），
 * 数据库里 `images.folder` 已经写清楚了每张图在哪个目录，直接照着它重建即可。
 *
 * @returns {{folders:number, images:number}}
 */
async function fixFolderPaths(libraryPath, db) {
  const rows = db.db.prepare('SELECT DISTINCT folder FROM images').all();
  const paths = new Set();

  for (const row of rows) {
    let current = (row.folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    while (current) {
      paths.add(current);
      const idx = current.lastIndexOf('/');
      current = idx > 0 ? current.slice(0, idx) : '';
    }
  }

  const folders = [...paths].sort().map((p) => {
    const idx = p.lastIndexOf('/');
    return {
      path: p,
      parent_path: idx > 0 ? p.slice(0, idx) : '',
      name: idx >= 0 ? p.slice(idx + 1) : p,
      image_count: 0,
    };
  });

  db.db.transaction((list) => list.forEach((f) => db.insertFolder(f)))(folders);
  db.updateAllFolderCounts();

  const images = db.db.prepare('SELECT COUNT(*) AS c FROM images').get();
  logger.perf(`文件夹结构已按数据库重建: ${folders.length} 个（图片 ${images ? images.c : 0} 张，未读磁盘）`);

  return { folders: folders.length, images: images ? images.c : 0 };
}

/**
 * Sync library (incremental scan)
 */
async function syncLibrary(libraryPath, db, forceRebuildFolders = false, onProgress = null) {
  try {
    const startTime = Date.now();

    // Get all current files (统一使用正斜杠)
    const currentFiles = await getAllImageFiles(libraryPath);
    const currentPaths = new Set(
      currentFiles.map(file => path.relative(libraryPath, file).replace(/\\/g, '/'))
    );

    // Get database files (只获取路径，不加载完整数据)
    const dbPaths = new Set();
    const stmt = db.db.prepare('SELECT path FROM images');
    for (const row of stmt.iterate()) {
      dbPaths.add((row.path || '').replace(/\\/g, '/'));
    }

    // Find new, modified, and deleted files
    const toAdd = [...currentPaths].filter(p => !dbPaths.has(p));
    const toCheck = [...currentPaths].filter(p => dbPaths.has(p));
    let toDelete = [...dbPaths].filter(p => !currentPaths.has(p));

    logger.perf(`同步: 看到 ${currentPaths.size} 个文件, 新增 ${toAdd.length} 检查 ${toCheck.length} 删除 ${toDelete.length}`);

    // 安全检查：如果要删除的文件数量超过数据库中文件的50%，可能是路径匹配问题
    const dbImageCount = dbPaths.size;
    if (toDelete.length > 0 && dbImageCount > 0) {
      const deleteRatio = toDelete.length / dbImageCount;
      if (deleteRatio > 0.5 && toDelete.length > 10) {
        logger.warn(`安全检查: 跳过删除 ${toDelete.length}/${dbImageCount} 个文件 (${(deleteRatio * 100).toFixed(1)}%)`);
        toDelete = [];
      }
    }

    const total = toAdd.length + toDelete.length;
    let processed = 0;

    // Process new files in batches
    const batchSize = 100;
    for (let i = 0; i < toAdd.length; i += batchSize) {
      const batch = toAdd.slice(i, i + batchSize);
      await Promise.all(
        batch.map(relativePath => {
          const fullPath = path.join(libraryPath, relativePath);
          return processImage(fullPath, libraryPath, db);
        })
      );

      processed += batch.length;

      // 报告进度
      if (onProgress && total > 0) {
        onProgress({
          total,
          current: processed,
          percent: Math.round((processed / total) * 100),
          currentFile: batch[batch.length - 1]
        });
      }
    }

    // Check modified files in batches (只检查hash，不重新处理)
    const modifiedCount = toCheck.filter(relativePath => {
      const fullPath = path.join(libraryPath, relativePath);
      const existing = db.getImageByPath(relativePath);
      const currentHash = calculateFileHash(fullPath);
      return existing.file_hash !== currentHash;
    }).length;

    if (modifiedCount > 0) {
      logger.perf(`发现 ${modifiedCount} 个修改文件`);
    }

    // Delete removed files
    for (const relativePath of toDelete) {
      db.deleteImage(relativePath);
      // TODO: Clean up thumbnail files
    }

    // Rebuild folder structure if there are changes or forced
    if (toAdd.length > 0 || toDelete.length > 0 || forceRebuildFolders) {
      logger.perf('重建文件夹结构...');

      // Get current folder structure from file system
      const currentFolders = await getFolderStructure(libraryPath);

      // Get existing folders from database
      const dbFolders = db.getAllFolders();
      const dbFolderPaths = new Set(dbFolders.map(f => f.path));

      // Find new and deleted folders
      const currentFolderPaths = new Set(currentFolders.map(f => f.path));
      const foldersToAdd = currentFolders.filter(f => !dbFolderPaths.has(f.path));
      const foldersToDelete = dbFolders.filter(f => !currentFolderPaths.has(f.path));

      // Add new folders
      foldersToAdd.forEach(folder => {
        db.insertFolder(folder);
      });

      // Delete removed folders
      foldersToDelete.forEach(folder => {
        db.deleteFolder(folder.path);
      });

      if (foldersToAdd.length > 0 || foldersToDelete.length > 0) {
        logger.perf(`文件夹变化: +${foldersToAdd.length} -${foldersToDelete.length}`);
      }

      // Update folder image counts
      const affectedFolders = new Set();

      // Collect all affected folders (including parent folders)
      [...toAdd, ...toDelete].forEach(relativePath => {
        let folderPath = path.dirname(relativePath);

        // Add current folder and all parent folders
        while (folderPath && folderPath !== '.') {
          affectedFolders.add(folderPath);
          const parent = path.dirname(folderPath);
          if (parent === folderPath) break; // Reached root
          folderPath = parent;
        }
      });

      // Update counts for all affected folders
      affectedFolders.forEach(folderPath => {
        db.updateFolderImageCount(folderPath);
      });
    }

    const totalTime = (Date.now() - startTime) / 1000;
    logger.perf(`同步完成 (${totalTime.toFixed(1)}秒)`);

    // 清理 Sharp 缓存
    clearSharpCache();

    return {
      // total = 这次遍历一共看到多少个文件。
      // 它单独有用：0 就是"目录里一个文件都没找到"（权限/路径问题），
      // 而不是"文件都没变化"——两者以前从返回值上分不出来。
      total: currentPaths.size,
      added: toAdd.length,
      modified: modifiedCount,
      deleted: toDelete.length
    };
  } catch (error) {
    logger.error('同步失败:', error.message);
    clearSharpCache();
    throw error;
  }
}

/**
 * Quick sync - 只检查新增/删除，不检查修改（用于启动时快速检测）
 */
async function quickSync(libraryPath, db) {
  const startTime = Date.now();

  // 获取当前文件（统一使用正斜杠）
  const currentFiles = await getAllImageFiles(libraryPath);
  const currentPaths = new Set(
    currentFiles.map(file => path.relative(libraryPath, file).replace(/\\/g, '/'))
  );

  // 获取数据库文件（只获取路径，不加载完整数据）
  const dbPaths = new Set();
  const stmt = db.db.prepare('SELECT path FROM images');
  for (const row of stmt.iterate()) {
    dbPaths.add((row.path || '').replace(/\\/g, '/'));
  }

  // 只检查新增和删除（不检查修改）
  const toAdd = [...currentPaths].filter(p => !dbPaths.has(p));
  let toDelete = [...dbPaths].filter(p => !currentPaths.has(p));

  // 安全检查
  const dbImageCount = dbPaths.size;
  if (toDelete.length > 0 && dbImageCount > 0) {
    const deleteRatio = toDelete.length / dbImageCount;
    if (deleteRatio > 0.5 && toDelete.length > 10) {
      logger.warn(`跳过删除 ${toDelete.length} 个文件`);
      toDelete = [];
    }
  }

  // 处理新增文件
  for (const relativePath of toAdd) {
    try {
      const fullPath = path.join(libraryPath, relativePath);
      // 确保文件夹链存在
      const folder = path.dirname(relativePath).replace(/\\/g, '/');
      if (folder && folder !== '.') {
        ensureFolderChain(db, folder);
      }
      await processImage(fullPath, libraryPath, db);
    } catch (err) {
      logger.error(`添加失败 ${relativePath}:`, err.message);
    }
  }

  // 删除已移除的文件
  for (const relativePath of toDelete) {
    db.deleteImage(relativePath);
  }

  // 如果有变化，更新所有文件夹的图片数量
  if (toAdd.length > 0 || toDelete.length > 0) {
    db.updateAllFolderCounts();
  }

  const elapsed = Date.now() - startTime;
  if (toAdd.length > 0 || toDelete.length > 0) {
    logger.perf(`快速同步: +${toAdd.length} -${toDelete.length} (${elapsed}ms)`);
    // 有变化时清理 Sharp 缓存
    clearSharpCache();
  }

  return { added: toAdd.length, deleted: toDelete.length };
}

/**
 * 全量重扫：把库里的每个文件都重新读一遍
 *
 * 和 scanLibrary 的区别：
 *   - scanLibrary 会跳过「哈希没变」的文件（增量，快）
 *   - 这里 force=true，所有文件都重跑一遍元数据 / name_sort / 缺失的缩略图，
 *     用于「在磁盘上重新整理过文件，想让数据库跟着更新」
 *
 * 评分、收藏、标签不会被清掉（insertImage 已经是保留用户数据的 upsert）。
 *
 * @param {string} libraryPath
 * @param {object} db
 * @param {function} [onProgress]
 * @param {string|null} [libraryId]
 * @param {object} [options] { prune: boolean } 是否清理磁盘上已不存在的记录
 */
async function rescanLibrary(libraryPath, db, onProgress = null, libraryId = null, options = {}) {
  // skipUnchanged（默认开）：文件没变过就不重新读它。
  //
  // 为什么要有这个：全量重扫原本对**每个**文件都调 processImage(force) ——
  // 重新读元数据 + 重新生成缩略图。相机库 15000 多张在机械硬盘上要跑 30 分钟以上，
  // 而其中绝大多数根本没变过。
  // 现在先用"大小 + 修改时间"的快速哈希比一下：
  //   记录在、哈希没变、缩略图文件也在 → 直接跳过（不碰磁盘上的图片内容）
  //   只要缩略图缺了，还是会补生成（用户库里那批 404 的封面就是这么补回来的）
  // 传 { skipUnchanged: false } 才是"每个文件都硬重读一遍"。
  const { prune = true, skipUnchanged = true } = options;
  const startTime = Date.now();

  const files = await getAllImageFiles(libraryPath);
  const total = files.length;

  if (libraryId) scanManager.startScan(libraryId, total, libraryPath);

  const stats = { processed: 0, skipped: 0, errors: 0, removed: 0, total };
  const writeBuffer = [];
  const WRITE_BATCH_SIZE = constants.SCAN.WRITE_BATCH_SIZE;

  const flush = () => {
    if (writeBuffer.length === 0) return;
    db.db.transaction((items) => {
      for (const item of items) {
        if (item.status === 'processed' && item.data) db.insertImage(item.data);
      }
    })(writeBuffer);
    writeBuffer.length = 0;
  };

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    try {
      if (skipUnchanged) {
        const relativePath = path.relative(libraryPath, file).replace(/\\/g, '/');
        const existing = db.getImageByPath(relativePath);
        if (existing && existing.file_hash) {
          const sameHash = existing.file_hash === calculateFileHash(file);
          const thumbOk = existing.thumbnail_path
            && fs.existsSync(path.join(libraryPath, existing.thumbnail_path));
          if (sameHash && thumbOk) {
            stats.skipped += 1;
            if (onProgress && (i % 200 === 0 || i === files.length - 1)) {
              onProgress({
                total,
                current: i + 1,
                percent: total ? Math.round(((i + 1) / total) * 100) : 100,
                currentFile: path.basename(file),
              });
            }
            continue;
          }
        }
      }

      const result = await processImage(file, libraryPath, db, true, { force: true });
      if (result && result.status === 'processed' && result.data) {
        writeBuffer.push(result);
        stats.processed += 1;
      } else {
        stats.skipped += 1;
      }
      if (writeBuffer.length >= WRITE_BATCH_SIZE) flush();
    } catch (error) {
      stats.errors += 1;
      logger.warn(`重扫失败 ${file}: ${error.message}`);
    }

    if (onProgress && (i % 20 === 0 || i === files.length - 1)) {
      onProgress({
        total,
        current: i + 1,
        percent: total ? Math.round(((i + 1) / total) * 100) : 100,
        currentFile: path.basename(file)
      });
    }
  }
  flush();

  // 清理磁盘上已经不存在的记录
  if (prune) {
    const onDisk = new Set(
      files.map((f) => path.relative(libraryPath, f).replace(/\\/g, '/'))
    );
    const dbPaths = [];
    for (const row of db.db.prepare('SELECT path FROM images').iterate()) {
      dbPaths.push((row.path || '').replace(/\\/g, '/'));
    }
    const missing = dbPaths.filter((p) => !onDisk.has(p));

    // 护栏：一次删掉超过一半，多半是路径/权限出了问题，宁可不删
    const tooMany = dbPaths.length > 0 && missing.length > dbPaths.length * 0.5 && missing.length > 10;
    if (tooMany) {
      logger.warn(`重扫清理被拦下：将删除 ${missing.length}/${dbPaths.length} 条，比例过高`);
    } else {
      const del = db.db.prepare('DELETE FROM images WHERE path = ?');
      db.db.transaction((list) => list.forEach((p) => del.run(p)))(missing);
      stats.removed = missing.length;
    }
  }

  // 文件夹结构与计数重建
  //
  // 顺序很关键：insertFolder 是 INSERT OR REPLACE（撞 path 就删了重插），
  // 所以新插进去的行 image_count 是 0 —— **必须在这里重新数一遍**。
  // 之前这里少了 updateAllFolderCounts()，于是"全量重扫之后所有文件夹都显示 0 张"
  // （总张数和图片都正常，只有文件夹列表是 0）。
  try {
    const folders = await getFolderStructure(libraryPath);
    db.db.transaction((list) => list.forEach((f) => db.insertFolder(f)))(folders);
    db.updateAllFolderCounts();
    logger.perf(`文件夹结构重建完成: ${folders.length} 个，计数已刷新`);
  } catch (error) {
    logger.warn(`重扫重建文件夹结构失败: ${error.message}`);
  }

  if (libraryId) scanManager.completeScan(libraryId, stats);

  logger.perf(
    `全量重扫完成: ${stats.processed} 更新 / ${stats.skipped} 跳过（没变过） / ${stats.removed} 清理 / ${stats.errors} 失败 ` +
    `(${((Date.now() - startTime) / 1000).toFixed(1)}s)`
  );

  return stats;
}

module.exports = {
  ScanPathError,
  fixFolderPaths,
  getAllImageFiles,
  getFolderStructure,
  processImage,
  scanLibrary,
  syncLibrary,
  rescanLibrary,
  quickSync,
  applyChangesFromEvents
};
