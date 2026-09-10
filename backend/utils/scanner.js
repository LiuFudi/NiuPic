const fs = require('fs');
const path = require('path');
const { glob } = require('glob');
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

/**
 * Get all image files in a directory
 */
async function getAllImageFiles(libraryPath) {
  // 支持所有文件格式（使用通配符 *.*）
  const pattern = path.join(libraryPath, '**', '*.*').replace(/\\/g, '/');
  const files = await glob(pattern, {
    nodir: true,
    nocase: true, // 大小写不敏感（Windows/macOS）
    ignore: ['**/.flypic/**', '**/.niupic/**', '**/node_modules/**']
  });
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

async function processImage(imagePath, libraryPath, db, dryRun = false) {
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

    // Skip only if unchanged and thumbnails are up-to-date
    if (existing && existing.file_hash === currentHash && !needRegenThumbs) {
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
    const useOriginalDims = fileType === 'image' && metadata.width && metadata.height;
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
    logger.info(`扫描完成: ${total} 个文件 (${totalTime.toFixed(1)}秒, ${(total / totalTime).toFixed(1)} 张/秒)`);

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

    logger.perf(`同步: +${toAdd.length} 检查${toCheck.length} -${toDelete.length}`);

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

module.exports = {
  getAllImageFiles,
  getFolderStructure,
  processImage,
  scanLibrary,
  syncLibrary,
  quickSync,
  applyChangesFromEvents
};
