// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

const fs = require('fs');
const path = require('path');
const os = require('os');

// 配置缓存
let configCache = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000; // 5秒缓存

/**
 * 目录存在且可写：真的写一个探针文件再删掉。
 * 为什么不只看权限位/`ls`：ACL、只读挂载、父目录可写但自身只读都会骗过它，
 * 而"保存配置失败"对用户就是"我设的东西不见了"。
 */
function isWritableDirectory(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const probe = path.join(dir, `.niupic-write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次性搬迁：把老位置里的配置搬到新位置。
 *
 * 只在新位置**还没有**配置时做，而且是复制（老文件留着当兜底）。
 * @returns {boolean} true = 可以安全在新位置工作（含"本来就没配置可搬"）
 */
function migrateLegacyConfig(targetDir) {
  const target = path.join(targetDir, 'config.json');
  if (fs.existsSync(target)) return true;

  const others = [process.env.TRIM_PKGVAR, process.env.TRIM_PKGETC]
    .filter((dir) => dir && path.resolve(dir) !== path.resolve(targetDir));

  for (const dir of others) {
    const legacy = path.join(dir, 'config.json');
    if (!fs.existsSync(legacy)) continue;
    try {
      fs.copyFileSync(legacy, target);
      const legacyBak = `${legacy}.bak`;
      if (fs.existsSync(legacyBak) && !fs.existsSync(`${target}.bak`)) {
        fs.copyFileSync(legacyBak, `${target}.bak`);
      }
      console.log(`📦 配置已迁移到 ${target}（原位置保留一份作为兜底）`);
      return true;
    } catch (error) {
      console.warn(`⚠️ 配置迁移失败，继续使用原位置: ${error.message}`);
      return false;
    }
  }

  return true;
}

// 配置目录只解析一次：解析里含写权限探测与一次性迁移，不该每个请求都做一遍。
let configDirCache = null;

/**
 * 配置目录。
 *
 * **优先 `etc/`（TRIM_PKGETC）** —— 飞牛在卸载时不删它，重装/升级后配置自然还在，
 * 这是官方给"用户配置"留的位置（《飞牛fpk开发规范》第十节 10.1）。
 *
 * 早期版本把配置放在 `var/`（TRIM_PKGVAR，即 @appdata）：那会被卸载流程清理，
 * 于是"每次更新 = 重装"（素材库列表、访问口令、JWT 密钥、主题色全丢），
 * 本项目因此丢过两次配置，最后靠三层补救（卸载默认不删 + 写 .bak + 安装时自动恢复）
 * 才稳住。规范里说得很直白：三层一个都不能少，但**更好的做法是一开始就放 etc/**。
 *
 * 所以这里是"能用 etc 就用 etc，不能用就退回 var"：宁可少一层理想，
 * 也绝不能出现"配置写不进去"——那才是真把用户配置丢了。
 */
function getConfigDir() {
  if (configDirCache) return configDirCache;

  const etcDir = process.env.TRIM_PKGETC;   // fnOS：卸载不删的配置目录
  const varDir = process.env.TRIM_PKGVAR;   // fnOS：运行数据目录（老位置）

  if (etcDir && isWritableDirectory(etcDir) && migrateLegacyConfig(etcDir)) {
    configDirCache = etcDir;
    return configDirCache;
  }
  if (etcDir) {
    console.warn(`⚠️ 配置目录 ${etcDir} 不可用，回退到 var/`);
  }
  if (varDir) {
    configDirCache = varDir;
    return configDirCache;
  }

  // Windows
  if (process.platform === 'win32') {
    configDirCache = path.join(process.env.APPDATA || os.homedir(), 'NiuPic');
    return configDirCache;
  }

  // Linux/Mac
  configDirCache = path.join(os.homedir(), '.niupic');
  return configDirCache;
}

/**
 * Get config file path
 */
function getConfigPath() {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, 'config.json');
}

/**
 * Load configuration
 */
function loadConfig(forceReload = false) {
  // 检查缓存是否有效
  const now = Date.now();
  if (!forceReload && configCache && (now - configCacheTime) < CONFIG_CACHE_TTL) {
    return configCache;
  }
  
  const configPath = getConfigPath();
  
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      libraries: [],
      theme: 'light',
      themeColor: '',   // '' = 内置默认蓝；否则是 '#rrggbb'
      currentLibraryId: null,
      // UI preferences
      preferences: {
        thumbnailHeight: 200,
        rowGap: 32,
        columnGap: 16,
        leftPanelWidth: 256,  // 左侧边栏宽度
        rightPanelWidth: 320  // 右侧边栏宽度
      }
    };
    saveConfig(defaultConfig);
    return defaultConfig;
  }
  
  try {
    const data = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(data);
    
    // Ensure preferences exist (for backward compatibility)
    if (!config.preferences) {
      config.preferences = {
        thumbnailHeight: 200,
        rowGap: 32,
        columnGap: 16
      };
    }

    // 主题色：老配置里没有这个字段，补成 ''（= 默认蓝）
    if (typeof config.themeColor !== 'string') {
      config.themeColor = '';
    }
    
    // 更新缓存
    configCache = config;
    configCacheTime = now;
    
    return config;
  } catch (error) {
    console.error('Error loading config:', error);
    return {
      libraries: [],
      theme: 'light',
      themeColor: '',
      currentLibraryId: null,
      preferences: {
        thumbnailHeight: 200,
        rowGap: 32,
        columnGap: 16
      }
    };
  }
}

/**
 * Save configuration
 */
function saveConfig(config) {
  const configPath = getConfigPath();
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    // 顺手留一份备份。
    // 更新/重装时如果 config.json 因为卸载脚本或平台清理而丢失，
    // cmd/install_init 会用这份 .bak 自动恢复（素材库列表、主题色、密码都在里面）。
    try {
      fs.copyFileSync(configPath, `${configPath}.bak`);
    } catch (backupError) {
      // 备份失败不影响主流程
      console.warn('Error writing config backup:', backupError.message);
    }
    // 同步更新缓存
    configCache = config;
    configCacheTime = Date.now();
    return true;
  } catch (error) {
    console.error('Error saving config:', error);
    return false;
  }
}

/**
 * 清除配置缓存（用于强制重新加载）
 */
function clearConfigCache() {
  configCache = null;
  configCacheTime = 0;
}

/**
 * Add library to config
 */
function addLibrary(name, libraryPath) {
  const config = loadConfig();
  const id = Date.now().toString();
  
  config.libraries.push({
    id,
    name,
    path: libraryPath,
    lastScan: null,
    createdAt: Date.now()
  });
  
  if (!config.currentLibraryId) {
    config.currentLibraryId = id;
  }
  
  saveConfig(config);
  return id;
}

/**
 * Remove library from config
 * @param {string} libraryId - 要删除的素材库ID
 * @param {boolean} autoSelectNext - 是否自动选择下一个素材库，默认 true
 */
function removeLibrary(libraryId, autoSelectNext = true) {
  const config = loadConfig();
  config.libraries = config.libraries.filter(lib => lib.id !== libraryId);
  
  if (config.currentLibraryId === libraryId) {
    if (autoSelectNext) {
      config.currentLibraryId = config.libraries.length > 0 ? config.libraries[0].id : null;
    } else {
      config.currentLibraryId = null;
    }
  }
  
  saveConfig(config);
  return true;
}

/**
 * Update library
 */
function updateLibrary(libraryId, updates) {
  const config = loadConfig();
  const library = config.libraries.find(lib => lib.id === libraryId);
  
  if (library) {
    Object.assign(library, updates);
    saveConfig(config);
    return true;
  }
  
  return false;
}

/**
 * Get library by ID
 */
function getLibrary(libraryId) {
  const config = loadConfig();
  return config.libraries.find(lib => lib.id === libraryId);
}

/**
 * Set current library
 */
function setCurrentLibrary(libraryId) {
  const config = loadConfig();
  config.currentLibraryId = libraryId;
  saveConfig(config);
  return true;
}

/**
 * Update preferences
 */
function updatePreferences(preferences) {
  const config = loadConfig();
  config.preferences = { ...config.preferences, ...preferences };
  saveConfig(config);
  return config.preferences;
}

/**
 * Update theme
 */
function updateTheme(theme) {
  const config = loadConfig();
  config.theme = theme;
  saveConfig(config);
  return true;
}

/**
 * Update theme color (accent color)
 * @param {string} themeColor '#rrggbb'；空串 = 恢复内置默认蓝
 */
function updateThemeColor(themeColor) {
  const config = loadConfig();
  config.themeColor = themeColor || '';
  saveConfig(config);
  return config.themeColor;
}

module.exports = {
  getConfigDir,
  getConfigPath,
  loadConfig,
  saveConfig,
  clearConfigCache,
  addLibrary,
  removeLibrary,
  updateLibrary,
  getLibrary,
  setCurrentLibrary,
  updatePreferences,
  updateTheme,
  updateThemeColor
};
