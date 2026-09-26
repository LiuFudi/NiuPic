// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * Cleanup Manager
 * Executes routine and emergency memory cleanup procedures
 */

const logger = require('../src/utils/logger');

class CleanupManager {
  constructor(options = {}) {
    // 惯例清理的间隔：默认 60 秒。
    //
    // 以前默认 5 秒、而且每一轮都跑 5 次 global.gc()。发行包的 cmd/main 是
    // `node server.js`（不带 --expose-gc），所以线上 global.gc 是 undefined、
    // 白白每 5 秒醒一次；而开发时走的是 `node --expose-gc`，
    // 等于每 5 秒做 5 次全量 GC —— 那是纯 CPU 浪费，V8 自己会管。
    // 这个定时器的本职只是"清注册过的缓存"（目前没有注册任何缓存），
    // 没有理由跑得比数据库空闲检查（10 秒）还勤。
    this.routineInterval = options.routineInterval || 60000; // 60 seconds
    this.dbPool = options.dbPool;
    // 强制 GC 只在显式打开开发模式时做（默认关）。紧急清理那条路径不受影响：
    // 它是 memoryMonitor 超过 300MB 才会触发的罕见动作，本来就该狠一点。
    this.devMode = options.devMode === true;
    this.caches = new Map(); // name -> cache object with clear() method
    
    this.routineIntervalId = null;
    this.isRunning = false;
    this.cleanupCount = 0;
    this.lastCleanupTime = 0;
  }

  /**
   * Start routine cleanup
   */
  startRoutineCleanup() {
    if (this.isRunning) return;

    logger.task('清理管理器已启动');
    this.isRunning = true;

    this.routineIntervalId = setInterval(() => {
      this.executeRoutineCleanup();
    }, this.routineInterval);
  }

  /**
   * Stop routine cleanup
   */
  stopRoutineCleanup() {
    if (!this.isRunning) return;

    logger.task('清理管理器已停止');
    
    if (this.routineIntervalId) {
      clearInterval(this.routineIntervalId);
      this.routineIntervalId = null;
    }

    this.isRunning = false;
  }

  /**
   * Execute routine cleanup
   * - Clear registered caches
   * - Trigger garbage collection (if available)
   */
  executeRoutineCleanup() {
    const memoryBefore = this.getMemoryStats();
    const rssBefore = memoryBefore.rss / 1024 / 1024;
    
    try {
      // Clear all registered caches
      const cachesCleared = this.clearAllCaches();

      // 开发模式才强制 GC：反复全量 GC 只会占着 CPU 不放，减不了常驻内存。
      if (this.devMode && global.gc) global.gc();

      const memoryAfter = this.getMemoryStats();
      const rssAfter = memoryAfter.rss / 1024 / 1024;
      const memoryReclaimed = memoryBefore.heapUsed - memoryAfter.heapUsed;
      const rssReclaimed = rssBefore - rssAfter;

      this.cleanupCount++;
      this.lastCleanupTime = Date.now();

      // 只在内存回收显著时输出日志
      if (Math.abs(rssReclaimed) > 10) {
        logger.perf(`内存清理: ${rssBefore.toFixed(0)}MB → ${rssAfter.toFixed(0)}MB`);
      }

      return {
        memoryBefore,
        memoryAfter,
        memoryReclaimed,
        cachesCleared,
        connectionsCleared: 0
      };
    } catch (error) {
      logger.error('清理失败:', error.message);
      return null;
    }
  }

  /**
   * Execute emergency cleanup
   * - Force close all database connections
   * - Clear all caches
   * - Force garbage collection multiple times (3+)
   */
  executeEmergencyCleanup() {
    logger.task('执行紧急内存清理...');
    
    const memoryBefore = this.getMemoryStats();
    
    try {
      // 1. Force close all database connections
      let connectionsCleared = 0;
      if (this.dbPool) {
        try {
          this.dbPool.closeAll();
          connectionsCleared = 1;
          logger.task('数据库连接已关闭');
        } catch (error) {
          logger.error('关闭连接失败:', error.message);
        }
      }

      // 2. Clear all registered caches
      const cachesCleared = this.clearAllCaches();
      logger.task(`已清理 ${cachesCleared} 个缓存`);

      // 3. Force garbage collection multiple times (minimum 3)
      this.forceGarbageCollection(3);

      const memoryAfter = this.getMemoryStats();
      const memoryReclaimed = memoryBefore.heapUsed - memoryAfter.heapUsed;

      logger.task(`紧急清理完成: 回收 ${(memoryReclaimed / 1024 / 1024).toFixed(0)}MB`);

      return {
        memoryBefore,
        memoryAfter,
        memoryReclaimed,
        cachesCleared,
        connectionsCleared
      };
    } catch (error) {
      logger.error('紧急清理失败:', error.message);
      return null;
    }
  }

  /**
   * Force garbage collection multiple times
   * @param {number} iterations - Number of GC iterations (minimum 3)
   */
  forceGarbageCollection(iterations = 3) {
    if (!global.gc) return;

    const actualIterations = Math.max(3, iterations);
    for (let i = 0; i < actualIterations; i++) {
      try {
        global.gc();
      } catch (error) {
        logger.error(`GC失败 (${i + 1}/${actualIterations}):`, error.message);
      }
    }
  }

  /**
   * Clear all registered caches
   * @returns {number} Number of caches cleared
   */
  clearAllCaches() {
    let cleared = 0;

    for (const [name, cache] of this.caches.entries()) {
      try {
        if (cache && typeof cache.clear === 'function') {
          cache.clear();
          cleared++;
        }
      } catch (error) {
        logger.error(`清理缓存失败 "${name}":`, error.message);
      }
    }

    return cleared;
  }

  /**
   * Register a cache for cleanup
   * @param {string} name - Cache name
   * @param {Object} cache - Cache object with clear() method
   */
  registerCache(name, cache) {
    if (!cache || typeof cache.clear !== 'function') {
      logger.warn(`缓存 "${name}" 无clear()方法`);
      return;
    }

    this.caches.set(name, cache);
  }

  /**
   * Unregister a cache
   * @param {string} name - Cache name
   */
  unregisterCache(name) {
    this.caches.delete(name);
  }

  /**
   * Get current memory statistics
   */
  getMemoryStats() {
    const usage = process.memoryUsage();
    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
      timestamp: Date.now()
    };
  }

  /**
   * Get cleanup manager status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      routineInterval: this.routineInterval,
      cleanupCount: this.cleanupCount,
      lastCleanupTime: this.lastCleanupTime,
      registeredCaches: Array.from(this.caches.keys())
    };
  }
}

module.exports = CleanupManager;
