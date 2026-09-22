// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 拖拽上传提示覆盖层组件
 */

const DragDropOverlay = ({ isVisible }) => {
  if (!isVisible) return null;

  return (
    <div className="absolute inset-0 z-50 bg-blue-500 bg-opacity-20 border-4 border-dashed border-blue-500 flex items-center justify-center pointer-events-none">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-8 shadow-2xl">
        <div className="text-center">
          <div className="text-6xl mb-4">📤</div>
          <p className="text-xl font-semibold text-gray-800 dark:text-gray-200 mb-2">
            拖放图片到这里
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            支持 JPG、PNG、GIF、WebP 等格式
          </p>
        </div>
      </div>
    </div>
  );
};

export default DragDropOverlay;
