// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

import { X, ExternalLink } from 'lucide-react';
import { imageAPI } from '../api';

/**
 * 文件查看器 - 支持视频播放和文档查看
 * 不依赖额外库，使用浏览器原生能力
 */
function FileViewer({ file, libraryId, onClose }) {
  if (!file) return null;

  // 兼容前端的 fileType 字段和旧的 file_type 字段
  const fileType = file.fileType || file.file_type || 'image';
  const originalUrl = imageAPI.getOriginalUrl(libraryId, file.path);

  // 在浏览器中打开原始文件（交给浏览器/系统处理）
  const openInSystem = async () => {
    try {
      if (originalUrl) {
        window.open(originalUrl, '_blank');
      }
    } catch (error) {
      console.error('Failed to open file in browser:', error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-90 flex items-center justify-center">
      {/* 顶部工具栏 */}
      <div className="absolute top-0 left-0 right-0 h-16 bg-black bg-opacity-50 flex items-center justify-between px-4 z-10">
        <div className="text-white text-sm truncate max-w-md">
          {file.filename}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openInSystem}
            className="p-2 text-white hover:bg-white hover:bg-opacity-20 rounded transition-colors"
            title="在系统默认应用中打开"
          >
            <ExternalLink className="w-5 h-5" />
          </button>
          <button
            onClick={onClose}
            className="p-2 text-white hover:bg-white hover:bg-opacity-20 rounded transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="w-full h-full flex items-center justify-center p-20">
        {fileType === 'video' && (
          <video
            src={originalUrl}
            controls
            autoPlay
            className="max-w-full max-h-full rounded shadow-2xl"
            onError={(e) => {
              console.error('Video load error:', e);
              alert('视频加载失败，请尝试在系统默认应用中打开');
            }}
          >
            您的浏览器不支持视频播放
          </video>
        )}

        {fileType === 'audio' && (
          <div className="flex flex-col items-center justify-center">
            <div className="text-white text-6xl mb-8">🎵</div>
            <audio
              src={originalUrl}
              controls
              autoPlay
              className="w-96 rounded shadow-2xl"
              onError={(e) => {
                console.error('Audio load error:', e);
                alert('音频加载失败，请尝试在系统默认应用中打开');
              }}
            >
              您的浏览器不支持音频播放
            </audio>
            <p className="text-white mt-4 text-sm opacity-70">{file.filename}</p>
          </div>
        )}

        {fileType === 'document' && (
          <div className="w-full h-full bg-white rounded shadow-2xl overflow-hidden">
            {file.format === 'pdf' ? (
              <iframe
                src={originalUrl}
                className="w-full h-full"
                title={file.filename}
              />
            ) : (
              <iframe
                src={originalUrl}
                className="w-full h-full"
                title={file.filename}
                sandbox="allow-same-origin"
              />
            )}
          </div>
        )}

        {(fileType === 'design' || fileType === 'other' || !fileType) && (
          <div className="text-center text-white">
            <p className="mb-4">此文件类型需要在专业软件中打开</p>
            <button
              onClick={openInSystem}
              className="px-6 py-3 bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors"
            >
              在系统默认应用中打开
            </button>
          </div>
        )}
      </div>

      {/* 点击背景关闭 */}
      <div
        className="absolute inset-0 -z-10"
        onClick={onClose}
      />
    </div>
  );
}

export default FileViewer;
