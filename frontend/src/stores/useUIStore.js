// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * UI 状态管理
 */

import { create } from 'zustand';

/** 行间距下限：文件名那一行的高度，再往下压没有意义 */
export const MIN_ROW_GAP = 28;

export const useUIStore = create((set) => ({
  // 主题
  theme: 'light',

  // 主题色（强调色）。null = 用 CSS 里的默认蓝，非空时是 '#rrggbb'
  accentColor: null,

  // 移动端视图
  mobileView: 'main', // 'sidebar' | 'main' | 'detail'
  
  // 缩略图高度
  thumbnailHeight: 200,

  // 行间距：上下两张图之间的空白（不含文件名那一行）。0 = 完全无缝
  rowGap: 32,

  // 按文件夹分隔：不同文件夹的图片用横线隔开（会自动换行）
  separateByFolder: false,

  // 顶栏那两个卡片（筛选 + 排序 / 主题色）。
  //
  // 卡片画在**中间图片区**里，不画在顶栏里 —— 画在顶栏里的话整个内容行都会被压矮，
  // 左右两个侧栏也跟着变短（用户要的是"只挤图片区"）。
  // 桌面端由 App 在中间列渲染，手机端没有侧栏，仍然跟在搜索栏下面。
  activePanel: null,   // null | 'filter' | 'theme'
  
  // 面板调整状态
  isResizingPanels: false,
  resizingSide: null, // 'left' | 'right' | null
  
  // 主题操作
  setTheme: (theme) => set({ theme }),
  
  toggleTheme: () => set((state) => ({ 
    theme: state.theme === 'light' ? 'dark' : 'light' 
  })),

  // 主题色
  setAccentColor: (accentColor) => set({ accentColor }),
  
  // 移动端视图
  setMobileView: (view) => set({ mobileView: view }),
  
  // 缩略图高度
  setThumbnailHeight: (height) => set({ thumbnailHeight: height }),

  // 行间距
  setRowGap: (rowGap) => set({ rowGap: Math.max(MIN_ROW_GAP, Math.min(80, Number(rowGap) || MIN_ROW_GAP)) }),

  // 按文件夹分隔
  setSeparateByFolder: (separateByFolder) => set({ separateByFolder: !!separateByFolder }),

  // 同一时刻只开一个卡片；再点一次同一个按钮就收起来
  togglePanel: (name) => set((state) => ({
    activePanel: state.activePanel === name ? null : name
  })),
  closePanels: () => set({ activePanel: null }),
  
  // 面板调整
  setIsResizingPanels: (value) => set({ isResizingPanels: value }),
  
  setResizingSide: (side) => set({ resizingSide: side })
}));
