// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 扫描服务层（简化版）
 * 无暂停功能，只负责扫描和进度推送
 */

const { NotFoundError, ValidationError } = require('../middleware/errorHandler');

class ScanService {
  constructor(configManager, dbPool, scanner, scanManager, io) {
    this.configManager = configManager;
    this.dbPool = dbPool;
    this.scanner = scanner;
    this.scanManager = scanManager;
    this.io = io;
  }

  /**
   * 全量扫描
   */
  async fullScan(libraryId, wait = false) {
    const library = this._getLibrary(libraryId);
    const db = this.dbPool.acquire(library.path);

    try {
      if (this.scanManager.isScanning(libraryId)) {
        throw new ValidationError('Scan already in progress', 'libraryId');
      }

      if (wait) {
        const stats = await this.scanner.scanLibrary(
          library.path,
          db,
          (progress) => this._emitProgress(libraryId, progress),
          libraryId
        );
        // 把统计带回去：界面要说"找到 N 个文件"，而不是笼统一句"扫描完成"
        return { success: true, message: 'Scan completed', libraryId, stats };
      } else {
        this._startAsyncScan(libraryId, library.path, db);
        return { success: true, message: 'Scan started', libraryId, async: true };
      }
    } catch (error) {
      this.dbPool.release(library.path);
      throw error;
    }
  }

  /**
   * 增量同步
   */
  async incrementalSync(libraryId, wait = false) {
    const library = this._getLibrary(libraryId);
    const db = this.dbPool.acquire(library.path);

    try {
      if (this.scanManager.isScanning(libraryId)) {
        throw new ValidationError('Scan already in progress', 'libraryId');
      }

      if (wait) {
        await this.scanner.syncLibrary(
          library.path,
          db,
          false,
          (progress) => this._emitProgress(libraryId, progress)
        );
        return { success: true, message: 'Sync completed', libraryId };
      } else {
        this._startAsyncSync(libraryId, library.path, db);
        return { success: true, message: 'Sync started', libraryId, async: true };
      }
    } catch (error) {
      this.dbPool.release(library.path);
      throw error;
    }
  }

  /**
   * 获取扫描状态
   */
  getScanStatus(libraryId) {
    const library = this._getLibrary(libraryId);
    const state = this.scanManager.getState(libraryId);

    return {
      libraryId,
      status: state?.status || 'idle',
      progress: state?.progress || null,
      startTime: state?.startTime || null
    };
  }

  /**
   * 获取所有活跃状态
   */
  getAllActiveStates() {
    return this.scanManager.getAllActiveStates();
  }

  /**
   * 修复文件夹路径
   */
  async fixFolders(libraryId) {
    const library = this._getLibrary(libraryId);
    const db = this.dbPool.acquire(library.path);

    try {
      await this.scanner.fixFolderPaths(library.path, db);
      return { success: true, message: 'Folders fixed', libraryId };
    } finally {
      this.dbPool.release(library.path);
    }
  }

  /**
   * 全量重扫（Emby / Jellyfin 那种「扫描媒体库」）
   *
   * 和「增量同步」的区别：
   *   - 增量同步只找新增/删除的文件，改动过的文件目前不会重新处理
   *   - 全量重扫把每个文件都重新读一遍：元数据、name_sort、缺失的缩略图，
   *     并清理磁盘上已经不存在的记录
   *
   * 评分 / 收藏 / 标签不会丢（入库走的是保留用户数据的 upsert）。
   */
  async rescan(libraryId, wait = false, options = {}) {
    const library = this._getLibrary(libraryId);
    const db = this.dbPool.acquire(library.path);

    try {
      if (this.scanManager.isScanning(libraryId)) {
        throw new ValidationError('Scan already in progress', 'libraryId');
      }

      if (wait) {
        const stats = await this.scanner.rescanLibrary(
          library.path,
          db,
          (progress) => this._emitProgress(libraryId, progress),
          libraryId,
          options
        );
        return { success: true, message: 'Rescan completed', libraryId, stats };
      }

      this._startAsyncRescan(libraryId, library.path, db, options);
      return { success: true, message: 'Rescan started', libraryId, async: true };
    } catch (error) {
      this.dbPool.release(library.path);
      throw error;
    }
  }

  /**
   * 启动异步全量重扫
   */
  _startAsyncRescan(libraryId, libraryPath, db, options = {}) {
    this.scanner.rescanLibrary(
      libraryPath,
      db,
      (progress) => this._emitProgress(libraryId, progress),
      libraryId,
      options
    ).then((stats) => {
      this._emitComplete(libraryId, stats);
      this.dbPool.release(libraryPath);
    }).catch((error) => {
      this._emitError(libraryId, error);
      this.dbPool.release(libraryPath);
    });
  }

  /**
   * 启动异步扫描
   */
  _startAsyncScan(libraryId, libraryPath, db) {
    this.scanner.scanLibrary(
      libraryPath,
      db,
      (progress) => this._emitProgress(libraryId, progress),
      libraryId
    ).then((stats) => {
      this._emitComplete(libraryId, stats);
      this.dbPool.release(libraryPath);
    }).catch((error) => {
      this._emitError(libraryId, error);
      this.dbPool.release(libraryPath);
    });
  }

  /**
   * 启动异步同步
   */
  _startAsyncSync(libraryId, libraryPath, db) {
    this.scanner.syncLibrary(
      libraryPath,
      db,
      false,
      (progress) => this._emitProgress(libraryId, progress)
    ).then((stats) => {
      this._emitComplete(libraryId, stats);
      this.dbPool.release(libraryPath);
    }).catch((error) => {
      this._emitError(libraryId, error);
      this.dbPool.release(libraryPath);
    });
  }

  _emitProgress(libraryId, progress) {
    if (this.io) {
      this.io.emit('scanProgress', { libraryId, ...progress });
    }
  }

  _emitComplete(libraryId, stats = null) {
    if (this.io) {
      this.io.emit('scanComplete', { libraryId, stats });
    }
  }

  _emitError(libraryId, error) {
    if (this.io) {
      this.io.emit('scanError', { libraryId, error: error.message });
    }
  }

  _getLibrary(libraryId) {
    const config = this.configManager.load();
    const library = config.libraries.find(lib => lib.id === libraryId);
    if (!library) {
      throw new NotFoundError('Library', libraryId);
    }
    return library;
  }
}

module.exports = ScanService;
