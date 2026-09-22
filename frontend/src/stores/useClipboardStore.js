// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 剪贴板状态管理
 * 管理复制的文件和文件夹
 */

import { create } from 'zustand';

export const useClipboardStore = create((set, get) => ({
  // 剪贴板数据
  clipboardItems: [], // [{type: 'file'|'folder', path: string, data: object}]
  clipboardType: null, // 'copy' | 'cut' | null
  
  /**
   * 复制项目到剪贴板
   */
  copyToClipboard: (items, type = 'copy') => {
    set({
      clipboardItems: items,
      clipboardType: type
    });
    console.log(`📋 已复制 ${items.length} 个项目到剪贴板`);
  },
  
  /**
   * 清空剪贴板
   */
  clearClipboard: () => {
    set({
      clipboardItems: [],
      clipboardType: null
    });
  },
  
  /**
   * 获取剪贴板内容
   */
  getClipboard: () => {
    const { clipboardItems, clipboardType } = get();
    return { items: clipboardItems, type: clipboardType };
  },
  
  /**
   * 检查剪贴板是否有内容
   */
  hasClipboard: () => {
    return get().clipboardItems.length > 0;
  }
}));
