// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 可访问文件夹服务
 *
 * 飞牛的文件夹权限是**管理员在应用市场里手动授权**的，所以应用能访问的文件夹是
 * 一份固定清单。添加素材库时直接把这份清单列出来给用户选，用户不需要（也不应该）
 * 去手输文件系统路径。
 *
 * 清单来源按可靠性排序：
 *
 *   1. 飞牛开放 API trim.file.getSharedAccessibleFolders —— 权威、实时
 *      （管理员刚加/刚删的授权立刻可见，不受进程环境变量过期影响）
 *   2. 环境变量 TRIM_DATA_ACCESSIBLE_PATHS —— 进程启动时飞牛注入的授权目录
 *      （: 分隔）。API 不可用时用它兜底
 *   3. 环境变量 TRIM_DATA_SHARE_PATHS —— 应用自己在 config/resource 里声明的
 *      共享目录（用户能在文件管理器里看到），只读展示
 *   4. 卷扫描兜底 —— 以上都没有时，试探 /vol1../vol9 里进程真正能读的目录
 *
 * 注意：飞牛给的是「祖先目录可穿越 + 授权目录可读写」的 ACL，所以**不能**靠
 * 「从 /vol 往下递归找能读的目录」来反推授权清单（中间层往往读不了），
 * 因此 1、2 才是主路径，扫描只是最后的兜底。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { callFnosApi, isUnavailableError } = require('../utils/fnosApi');
const { getNiuPicPath, getDatabasePath } = require('../config');

/** 扫描兜底时最多返回多少条，避免刷出上千条 */
const PROBE_LIMIT = 200;
/** 扫描兜底的卷根 */
const VOLUME_ROOTS = ['/vol1', '/vol2', '/vol3', '/vol4', '/vol5', '/vol6', '/vol7', '/vol8', '/vol9'];

/**
 * 把飞牛路径环境变量（: 分隔）拆成数组并规范化
 */
function splitPathEnvironment(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(':')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * 规范化单个路径，非法返回 undefined
 */
function normalizePath(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('/') || trimmed.includes('\0')) {
    return undefined;
  }
  const normalized = path.normalize(trimmed);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * 规范化路径数组并去重（保持首次出现顺序）
 */
function normalizePaths(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const normalized = normalizePath(item);
    if (normalized === undefined || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** 读取飞牛注入的授权目录环境变量 */
function accessiblePathsFromEnvironment(env = process.env) {
  return normalizePaths(splitPathEnvironment(env.TRIM_DATA_ACCESSIBLE_PATHS));
}

/** 读取应用自己声明的共享目录环境变量 */
function dataSharePathsFromEnvironment(env = process.env) {
  return normalizePaths(splitPathEnvironment(env.TRIM_DATA_SHARE_PATHS));
}

/**
 * 飞牛的「语义路径」在拿不到开放 API 时的近似写法：
 *   /vol1/1000/图片库  →  存储空间1/1000/图片库
 * 只是给用户看的近似名，真实路径始终同时展示，不会误导。
 */
function readableFallbackPath(target, language) {
  const lang = typeof language === 'string' && language.length > 0 ? language : 'zh-CN';
  const chinese = lang.toLowerCase().startsWith('zh');
  const volume = /^\/vol(\d+)(?:\/(.*))?$/.exec(target);
  if (volume !== null) {
    const prefix = chinese ? `存储空间${volume[1]}` : `Storage ${volume[1]}`;
    return volume[2] === undefined || volume[2].length === 0 ? prefix : `${prefix}/${volume[2]}`;
  }
  if (target === '/') return chinese ? '根目录' : 'Root';
  return target;
}

/** 目录是否可读、可写（不产生副作用，不做写入测试） */
function inspectDirectory(target) {
  const info = { exists: false, readable: false, writable: false, isDirectory: false };
  try {
    const stat = fs.statSync(target);
    info.exists = true;
    info.isDirectory = stat.isDirectory();
  } catch {
    return info;
  }
  if (!info.isDirectory) return info;
  try {
    fs.accessSync(target, fs.constants.R_OK | fs.constants.X_OK);
    info.readable = true;
  } catch {
    info.readable = false;
  }
  try {
    fs.accessSync(target, fs.constants.W_OK);
    info.writable = true;
  } catch {
    info.writable = false;
  }
  return info;
}

class AccessibleFoldersService {
  /**
   * @param {object} [options]
   * @param {() => Array<{path: string}>} [options.getLibraries] 已添加的素材库，用于标记「已添加」
   */
  constructor(options = {}) {
    this.getLibraries = options.getLibraries || (() => []);
  }

  /**
   * 取「管理员授权给本应用的文件夹」清单（权威来源）
   * @returns {Promise<string[]>}
   */
  async fetchAuthorizedPaths() {
    const data = await callFnosApi('trim.file.getSharedAccessibleFolders');
    if (Array.isArray(data)) return normalizePaths(data);
    if (data && Array.isArray(data.paths)) return normalizePaths(data.paths);
    return [];
  }

  /**
   * 把内部路径换成飞牛给用户看的语义路径（例如 /vol1/1000/x → 存储空间1/x）
   * 失败时不影响主流程，由调用方退回可读的近似路径。
   */
  async convertPaths(paths, language) {
    const result = new Map();
    if (paths.length === 0) return result;
    try {
      const data = await callFnosApi('trim.file.convertPath', {
        path: paths,
        language: language || 'zh-CN'
      });
      const entries = Array.isArray(data) ? data : data && Array.isArray(data.result) ? data.result : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const raw = normalizePath(entry.path);
        const semantic = typeof entry.semanticPath === 'string' ? entry.semanticPath.trim() : '';
        if (raw !== undefined && semantic.length > 0 && semantic !== raw) {
          result.set(raw, semantic);
        }
      }
    } catch (error) {
      if (!isUnavailableError(error)) {
        logger.debug(`[accessible-folders] 语义路径转换失败: ${error.message}`);
      }
    }
    return result;
  }

  /**
   * 兜底：试探卷根里进程真正能读的目录
   * 只在飞牛没有给出任何授权目录时才用。
   */
  probeReadableVolumes(basePaths) {
    const found = [];
    const seen = new Set(basePaths);
    const push = (target) => {
      if (found.length >= PROBE_LIMIT || seen.has(target)) return;
      const info = inspectDirectory(target);
      if (!info.isDirectory || !info.readable) return;
      seen.add(target);
      found.push(target);
    };

    for (const volume of VOLUME_ROOTS) {
      let entries;
      try {
        entries = fs.readdirSync(volume, { withFileTypes: true });
      } catch {
        continue;
      }
      // 一级：卷根下的用户目录 / 共享目录
      const level1 = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('@') && !entry.name.startsWith('.'))
        .map((entry) => path.join(volume, entry.name));
      // 二级：飞牛的个人文件夹是纯数字（1000 之类），共享目录通常也在这一层
      for (const dir of level1) {
        push(dir);
        if (!/^\/vol\d+\/\d+$/.test(dir)) continue;
        let children;
        try {
          children = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of children) {
          if (!child.isDirectory()) continue;
          if (child.name.startsWith('@') || child.name.startsWith('.')) continue;
          push(path.join(dir, child.name));
        }
      }
    }
    return found;
  }

  /**
   * 汇总可访问文件夹清单
   *
   * @param {object} [options]
   * @param {string} [options.language] 语义路径的语言
   * @returns {Promise<{folders: Array, canManage: boolean, sources: object, message: string, reason: string}>}
   */
  async list(options = {}) {
    const language = options.language || 'zh-CN';
    const sources = { authorized: [], shared: [], scanned: [] };
    let canManage = false;
    let message = '';
    let reason = '';

    // 1) 飞牛开放 API（权威）
    try {
      sources.authorized = await this.fetchAuthorizedPaths();
      canManage = true;
    } catch (error) {
      reason = error && error.message ? error.message : String(error);
      if (isUnavailableError(error)) {
        logger.debug(`[accessible-folders] 开放 API 不可用: ${reason}`);
      } else {
        logger.warn(`[accessible-folders] 查询飞牛授权目录失败: ${reason}`);
      }
    }

    // 2) 环境变量兜底（飞牛在进程启动时注入；管理员改授权后重启应用才会刷新）
    if (sources.authorized.length === 0) {
      sources.authorized = accessiblePathsFromEnvironment();
      if (sources.authorized.length > 0) {
        canManage = true;
        reason = '';
        logger.debug('[accessible-folders] 使用 TRIM_DATA_ACCESSIBLE_PATHS 兜底');
      }
    }

    // 3) 应用自己的共享目录
    sources.shared = dataSharePathsFromEnvironment();

    // 4) 卷扫描兜底（只在飞牛没给出任何东西时）
    if (sources.authorized.length === 0 && sources.shared.length === 0) {
      sources.scanned = this.probeReadableVolumes([]);
    }

    // 合并（按来源优先级保序去重）
    const ordered = [];
    const seen = new Set();
    const add = (list, source) => {
      for (const item of list) {
        if (seen.has(item)) continue;
        seen.add(item);
        ordered.push({ path: item, source });
      }
    };
    add(sources.authorized, 'authorized');
    add(sources.shared, 'shared');
    add(sources.scanned, 'scanned');

    // 语义路径 + 目录状态 + 已添加标记
    const semanticMap = await this.convertPaths(
      ordered.map((item) => item.path),
      language
    );
    const libraries = this.getLibraries() || [];
    const libraryPaths = new Set(
      libraries.map((lib) => normalizePath(lib && lib.path)).filter(Boolean)
    );

    const folders = [];
    for (const item of ordered) {
      const info = inspectDirectory(item.path);
      const niupicDir = getNiuPicPath(item.path);
      const dbPath = getDatabasePath(item.path);
      folders.push({
        path: item.path,
        name: path.basename(item.path) || item.path,
        // 拿不到飞牛的语义路径时用「存储空间1/…」这种可读近似名兜底；
        // 真实路径在界面上始终一并展示，用户不会看错。
        displayPath: semanticMap.get(item.path) || readableFallbackPath(item.path, language),
        source: item.source,
        exists: info.exists,
        readable: info.readable,
        writable: info.writable,
        alreadyAdded: libraryPaths.has(item.path),
        hasExistingIndex: info.exists && fs.existsSync(niupicDir) && fs.existsSync(dbPath)
      });
    }

    // 能用的排前面：可读写且在的 → 已添加的次之 → 其余沉底
    // 只读目录用不了：NiuPic 要在素材库里建 .niupic 索引目录
    const rank = (folder) => {
      if (!folder.exists || !folder.readable || !folder.writable) return 2;
      return folder.alreadyAdded ? 1 : 0;
    };
    folders.sort((a, b) => {
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return a.displayPath.localeCompare(b.displayPath, 'zh-CN');
    });

    if (folders.length === 0) {
      message = canManage
        ? '还没有授权任何文件夹。请在飞牛「应用中心 → NiuPic → 应用设置 → 可访问文件夹」里把要当素材库的目录加进来（权限选读写），然后点右上角刷新。'
        : '还没有可用的文件夹。请在飞牛「应用中心 → NiuPic → 应用设置 → 可访问文件夹」里授权素材库目录，然后点右上角刷新。';
    } else if (!canManage) {
      message = `没能读到飞牛的授权目录清单${reason ? `（${reason}）` : ''}，下面是应用当前能看到的位置。重新安装一次本应用可补上该权限。`;
    }

    logger.debug(
      `[accessible-folders] 共 ${folders.length} 个（授权 ${sources.authorized.length} / 共享 ${sources.shared.length} / 扫描 ${sources.scanned.length}）`
    );

    return {
      folders,
      canManage,
      reason,
      sources: {
        authorized: sources.authorized.length,
        shared: sources.shared.length,
        scanned: sources.scanned.length
      },
      message
    };
  }

  /**
   * 判断某个路径是否在飞牛授权范围内。
   * 拿不到授权清单时返回 null（表示「无法判断」，调用方自行决定是否放行）。
   *
   * @param {string} target
   * @returns {Promise<boolean|null>}
   */
  async isPathAuthorized(target) {
    const normalized = normalizePath(target);
    if (normalized === undefined) return false;

    let roots = [];
    try {
      roots = await this.fetchAuthorizedPaths();
    } catch (error) {
      if (!isUnavailableError(error)) {
        logger.warn(`[accessible-folders] 授权范围校验失败: ${error.message}`);
      }
    }
    if (roots.length === 0) {
      // API 拿不到，退回环境变量；仍拿不到就认为「无法判断」
      roots = accessiblePathsFromEnvironment();
    }
    if (roots.length === 0) return null;

    return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  }
}

module.exports = AccessibleFoldersService;
module.exports.normalizePath = normalizePath;
module.exports.normalizePaths = normalizePaths;
module.exports.splitPathEnvironment = splitPathEnvironment;
module.exports.readableFallbackPath = readableFallbackPath;
