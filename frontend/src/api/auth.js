// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 认证 API
 */

import { api } from './client';

/**
 * 获取认证状态
 */
export function getAuthStatus() {
  return api.get('/auth/status');
}

/**
 * 首次设置密码
 */
export function setupPassword(password) {
  return api.post('/auth/setup', { password });
}

/**
 * 登录
 */
export function login(password) {
  return api.post('/auth/login', { password });
}

/**
 * 修改密码
 */
export function changePassword(oldPassword, newPassword) {
  return api.post('/auth/change-password', { oldPassword, newPassword });
}

export const authAPI = {
  getAuthStatus,
  setupPassword,
  login,
  changePassword
};
