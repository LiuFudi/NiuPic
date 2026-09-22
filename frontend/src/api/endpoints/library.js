// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 素材库 API
 */

import { api } from '../client';

/**
 * 获取所有素材库
 */
export async function getAll() {
  return api.get('/library');
}

/**
 * 添加素材库
 */
export async function add(name, path) {
  return api.post('/library', { name, path });
}

/**
 * 获取「可访问的文件夹」清单
 * —— 飞牛应用市场里管理员授权给 NiuPic 的目录，添加素材库时直接选，不用手输路径。
 * @param {string} [lang] - 语义路径语言（如 zh-CN）。不传则由后端按飞牛系统语言决定，
 *                          显示结果和飞牛文件管理器一致，推荐不传。
 */
export async function getAccessibleFolders(lang) {
  const query = lang ? `?lang=${encodeURIComponent(lang)}` : '';
  return api.get(`/library/accessible-folders${query}`);
}

/**
 * 更新素材库
 */
export async function update(id, updates) {
  return api.put(`/library/${id}`, updates);
}

/**
 * 删除素材库
 * @param {string} id - 素材库ID
 * @param {boolean} autoSelectNext - 是否自动选择下一个素材库，默认 true
 */
export async function remove(id, autoSelectNext = true) {
  return api.delete(`/library/${id}?autoSelectNext=${autoSelectNext}`);
}

/**
 * 删除素材库（别名）
 */
export const deleteLibrary = remove;

/**
 * 设置当前素材库
 */
export async function setCurrent(id) {
  return api.post(`/library/${id}/set-current`);
}

/**
 * 更新偏好设置
 */
export async function updatePreferences(preferences) {
  return api.put('/library/preferences', preferences);
}

/**
 * 更新主题
 */
export async function updateTheme(theme) {
  return api.put('/library/theme', { theme });
}

/**
 * 更新主题色（强调色）
 * @param {string} themeColor - '#rrggbb'；空串表示恢复内置默认蓝
 */
export async function updateThemeColor(themeColor) {
  return api.put('/library/theme-color', { themeColor });
}

/**
 * 验证素材库路径是否存在
 */
export async function validate(id) {
  return api.get(`/library/${id}/validate`);
}
