// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 空状态提示组件
 */

const EmptyState = ({ isLoading }) => {
  return (
    <div className="text-center">
      {isLoading ? (
        <p className="text-lg mb-2">加载中...</p>
      ) : (
        <>
          <p className="text-lg mb-2">暂无图片</p>
          <p className="text-sm">请添加素材库或调整搜索条件</p>
          <p className="text-xs mt-4 text-gray-400">可以直接拖拽文件到这里上传</p>
        </>
      )}
    </div>
  );
};

export default EmptyState;
