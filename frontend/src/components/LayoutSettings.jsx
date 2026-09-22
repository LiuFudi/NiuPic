// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 瀑布流布局设置
 *
 * 两件事：
 *   行间距 —— 上下两张图之间留多少空白（0 = 完全无缝）
 *   按文件夹分隔 —— 不同文件夹的图片之间画一条横线（会自动换行）
 *
 * 两种用法：
 *   默认   —— 顶栏一个小按钮 + 弹层
 *   inline —— 直接铺开，给手机端设置面板用
 */

import { useEffect, useRef, useState } from 'react';
import { Rows } from 'lucide-react';
import { useUIStore } from '../stores/useUIStore';
import { libraryAPI } from '../api';
import { createLogger } from '../utils/logger';

const logger = createLogger('LayoutSettings');

/** 保存到后端（不阻塞界面，失败只记日志） */
function persist(prefs) {
  libraryAPI.updatePreferences(prefs).catch((error) => {
    logger.warn('保存布局偏好失败:', error.message);
  });
}

export default function LayoutSettings({ className = '', inline = false }) {
  const rowGap = useUIStore((st) => st.rowGap);
  const separateByFolder = useUIStore((st) => st.separateByFolder);
  const setRowGap = useUIStore((st) => st.setRowGap);
  const setSeparateByFolder = useUIStore((st) => st.setSeparateByFolder);

  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const controls = (
    <>
      <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">行间距</div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 leading-relaxed">
        上下两张图之间的空白。最小 28px —— 那是文件名那一行占的高度，再小也压不掉。
      </div>
      <div className="flex items-center gap-3 mb-4">
        <input
          type="range"
          min="28"
          max="80"
          step="2"
          value={rowGap}
          data-testid="row-gap-slider"
          onChange={(e) => setRowGap(parseInt(e.target.value, 10))}
          onMouseUp={() => persist({ rowGap })}
          onTouchEnd={() => persist({ rowGap })}
          className="flex-1"
          aria-label="行间距"
        />
        <span className="text-xs text-gray-600 dark:text-gray-400 w-10 text-right">{rowGap}px</span>
      </div>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={separateByFolder}
          data-testid="folder-separator-toggle"
          onChange={(e) => {
            setSeparateByFolder(e.target.checked);
            persist({ separateByFolder: e.target.checked });
          }}
          className="mt-0.5"
        />
        <span>
          <span className="block text-sm text-gray-700 dark:text-gray-300">按文件夹分隔</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            开启后，不同文件夹的图片之间会画一条横线隔开（并自动换行）。
            文件夹很多的时候，找图会清楚不少。
          </span>
        </span>
      </label>
    </>
  );

  if (inline) {
    return (
      <div className={className} data-testid="layout-settings-inline">
        {controls}
      </div>
    );
  }

  return (
    <div className={`relative ${className}`} ref={boxRef} data-testid="layout-settings">
      <button
        type="button"
        data-testid="layout-settings-button"
        onClick={() => setOpen((v) => !v)}
        title="布局设置（行间距 / 按文件夹分隔）"
        className={`p-2 rounded-lg transition-colors ${
          open ? 'bg-gray-100 dark:bg-gray-700' : 'hover:bg-gray-100 dark:hover:bg-gray-700'
        }`}
      >
        <Rows className="w-5 h-5 text-gray-700 dark:text-gray-300" />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-80 p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-50">
          {controls}
        </div>
      )}
    </div>
  );
}
