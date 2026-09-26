// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 认证状态管理
 */

import { apiBase } from '../utils/appBase.js';
import { create } from 'zustand';

export const useAuthStore = create((set) => ({
  // 是否已设置密码
  hasPassword: false,
  
  // 是否已通过认证
  isAuthenticated: false,
  
  // 是否正在检查认证状态
  isChecking: true,

  // 设置认证状态
  setAuthStatus: (hasPassword, isAuthenticated) => set({
    hasPassword,
    isAuthenticated,
    isChecking: false
  }),

  // 设置检查状态
  setChecking: (isChecking) => set({ isChecking }),

  // 登录成功
  setAuthenticated: () => set({ isAuthenticated: true }),

  // 登出
  // 登出：除了本地状态，还要让服务端把会话 Cookie 清掉 ——
  // 否则"退出登录"之后，图片 URL 仍然能直接打开（Cookie 还有效 30 天）
  logout: () => {
    try {
      fetch(`${apiBase()}/auth/logout`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    } catch { /* 忽略网络错误 */ }
    try { localStorage.removeItem('niupic_token'); } catch { /* 忽略 */ }
    set({ isAuthenticated: false });
  }
}));
