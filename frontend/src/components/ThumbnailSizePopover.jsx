// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
//
// 缩略图大小：点图标弹出滑块。
//
// 为什么从"常驻滑块"改成"点开才显示"：顶栏在网关形态下可用宽度会变窄
// （平台自己的界面占了一部分），滑块 + 数值标签常驻要吃掉近 200px，
// 结果就是筛选/排序那些按钮被挤成一团。滑块本身是低频操作，收进弹层更合适。
//
// 交互与项目里其它顶栏弹层保持一致：点图标开合、点外面关、Esc 关。

import { useEffect, useRef, useState } from 'react';
import { Sliders } from 'lucide-react';

export default function ThumbnailSizePopover({ value, onChange, className = '' }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`relative ${className}`} ref={boxRef} data-testid="thumbnail-size">
      <button
        type="button"
        data-testid="thumbnail-size-button"
        onClick={() => setOpen((v) => !v)}
        title={`缩略图大小（当前 ${value}px）`}
        className={`p-2 rounded-lg transition-colors ${
          open ? 'bg-gray-100 dark:bg-gray-700' : 'hover:bg-gray-100 dark:hover:bg-gray-700'
        }`}
      >
        <Sliders className="w-5 h-5 text-gray-700 dark:text-gray-300" />
      </button>

      {open && (
        <div
          data-testid="thumbnail-size-popover"
          className="absolute top-full right-0 mt-1 w-56 p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-50"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-700 dark:text-gray-300">缩略图大小</span>
            <span className="text-xs text-gray-500 dark:text-gray-400" data-testid="thumbnail-size-value">{value}px</span>
          </div>
          <input
            type="range"
            min="150"
            max="300"
            value={value}
            onChange={(e) => onChange(parseInt(e.target.value))}
            className="w-full"
            data-testid="thumbnail-size-slider"
          />
        </div>
      )}
    </div>
  );
}
