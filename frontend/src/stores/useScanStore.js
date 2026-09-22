// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 扫描状态管理（简化版）
 */

import { create } from 'zustand';

export const useScanStore = create((set, get) => ({
  scanProgress: null,
  scanStartTime: null,

  // 最近一次扫描的结果 / 错误。
  // 为什么要留这个：以前扫描结束只显示"扫描完成"，哪怕一个文件都没找到也这么说。
  // 现在把"找到 N 个文件"摆在界面上 —— 0 就是权限或路径有问题，得让用户看见。
  lastScanResult: null,   // { libraryId, total, processed, errors, removed } | null
  lastScanError: null,    // string | null
  
  setScanProgress: (progress) => set((state) => {
    if (progress && !state.scanStartTime && progress.current > 0) {
      return { scanProgress: progress, scanStartTime: Date.now() };
    }
    if (!progress) {
      return { scanProgress: null, scanStartTime: null };
    }
    return { scanProgress: progress };
  }),
  
  clearScanProgress: () => set({ scanProgress: null, scanStartTime: null }),

  setLastScanResult: (lastScanResult) => set({ lastScanResult, lastScanError: null }),
  setLastScanError: (lastScanError) => set({ lastScanError }),
  clearLastScanResult: () => set({ lastScanResult: null, lastScanError: null }),
  
  getEstimatedTimeLeft: () => {
    const { scanProgress, scanStartTime } = get();
    if (!scanProgress || !scanStartTime || scanProgress.current === 0) {
      return null;
    }
    const elapsed = Date.now() - scanStartTime;
    const rate = scanProgress.current / elapsed;
    const remaining = scanProgress.total - scanProgress.current;
    return Math.ceil((remaining / rate) / 1000);
  },
  
  isScanning: () => {
    const { scanProgress } = get();
    return scanProgress && scanProgress.status !== 'preparing';
  }
}));
