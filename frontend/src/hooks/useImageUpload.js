// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 图片上传 Hook
 */

import { useState, useCallback, useRef } from 'react';
import { useImageStore } from '../stores/useImageStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import { fileAPI, imageAPI } from '../api';
import { createLogger } from '../utils/logger';

const logger = createLogger('useImageUpload');

/**
 * 图片上传功能（拖拽上传）
 * @returns {Object} 上传相关的状态和方法
 */
export const useImageUpload = () => {
  const { currentLibraryId } = useLibraryStore();
  const { selectedFolder, setImages, setFolders } = useImageStore();
  
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ 
    isUploading: false, 
    percent: 0, 
    current: 0, 
    total: 0 
  });
  const containerRef = useRef(null);

  /**
   * 拖放事件处理 - 拖拽进入
   */
  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 只检测外部文件拖入，排除应用内部拖动
    const types = e.dataTransfer.types;
    const hasFiles = types.includes('Files');
    const hasJson = types.includes('application/json');
    
    if (hasFiles && !hasJson) {
      setIsDraggingOver(true);
    }
  }, []);

  /**
   * 拖放事件处理 - 拖拽悬停
   */
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 检查是否为外部文件
    const types = e.dataTransfer.types;
    const hasFiles = types.includes('Files');
    const hasJson = types.includes('application/json');
    
    if (hasFiles && !hasJson) {
      e.dataTransfer.dropEffect = 'copy';
    } else {
      e.dataTransfer.dropEffect = 'none';
    }
  }, []);

  /**
   * 拖放事件处理 - 拖拽离开
   */
  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 离开容器区域立即取消提示
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const x = e.clientX;
      const y = e.clientY;
      // 检查鼠标是否离开容器区域
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        setIsDraggingOver(false);
      }
    }
  }, []);

  /**
   * 拖放事件处理 - 文件放下
   */
  const handleDrop = useCallback(async (e, onConflict) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    if (!currentLibraryId) {
      alert('请先选择素材库');
      return;
    }

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const uploadStartTime = Date.now();
    logger.file(`📤 开始上传 ${files.length} 个文件到 [${selectedFolder || '根目录'}]`);

    // 开始上传
    setUploadProgress({ isUploading: true, percent: 0, current: 0, total: files.length });

    try {
      const result = await fileAPI.upload(
        currentLibraryId,
        selectedFolder || '',
        files,
        (progressEvent) => {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          setUploadProgress(prev => ({ ...prev, percent }));
        }
      );

      // 上传完成
      const successList = result.data?.success || [];
      setUploadProgress({ isUploading: false, percent: 100, current: successList.length, total: files.length });

      // 检查是否有冲突
      const conflicts = result.data?.conflicts || [];
      if (conflicts.length > 0 && onConflict) {
        logger.file(`⚠️  检测到 ${conflicts.length} 个文件冲突，等待处理...`);
        onConflict(conflicts, files, selectedFolder || '');
        setUploadProgress({ isUploading: false, percent: 0, current: 0, total: 0 });
        return { hasConflicts: true, conflicts };
      }

      // 成功后刷新
      const successCount = result.data?.success?.length || 0;
      const failedCount = result.data?.failed?.length || 0;
      
      if (failedCount > 0) {
        logger.file(`📊 上传结果: 成功 ${successCount}, 失败 ${failedCount}`);
      }

      if (successCount > 0) {
        // 延迟150ms后刷新，等待后台缩略图生成完成
        await new Promise(resolve => setTimeout(resolve, 150));
        
        const params = { folder: selectedFolder || '' };
        const response = await imageAPI.search(currentLibraryId, params);
        setImages(response.images);

        // 刷新文件夹列表
        const foldersRes = await imageAPI.getFolders(currentLibraryId);
        setFolders(foldersRes.folders);
        
        // 2秒后再刷新一次，确保缩略图已生成
        setTimeout(async () => {
          try {
            const response2 = await imageAPI.search(currentLibraryId, params);
            setImages(response2.images);
          } catch (err) {
            logger.error('刷新缩略图失败:', err);
          }
        }, 2000);
      }

      setTimeout(() => {
        setUploadProgress({ isUploading: false, percent: 0, current: 0, total: 0 });
      }, 3000);
      
      const totalTime = Date.now() - uploadStartTime;
      logger.file(`✅ 上传完成 (${totalTime}ms)`);

      return { 
        success: true, 
        successCount, 
        failedCount,
        hasConflicts: false 
      };
    } catch (error) {
      logger.error('❌ 上传失败:', error.message);
      setUploadProgress({ isUploading: false, percent: 0, current: 0, total: 0 });
      throw error;
    }
  }, [currentLibraryId, selectedFolder, setImages, setFolders]);

  /**
   * 处理冲突后重新上传
   */
  const uploadWithConflictAction = useCallback(async (files, targetFolder, conflictAction) => {
    if (!currentLibraryId) return;

    const uploadStartTime = Date.now();
    logger.file(`📤 处理冲突后重新上传 (${conflictAction})`);
    
    if (conflictAction === 'skip') {
      return { success: true, skipped: true };
    }
    
    // 开始上传
    setUploadProgress({ isUploading: true, percent: 0, current: 0, total: files.length });
    
    try {
      const result = await fileAPI.upload(
        currentLibraryId,
        targetFolder,
        files,
        (progressEvent) => {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          setUploadProgress(prev => ({ ...prev, percent }));
        },
        conflictAction
      );
      
      // 上传完成
      const successList = result.data?.success || [];
      setUploadProgress({ 
        isUploading: false, 
        percent: 100, 
        current: successList.length, 
        total: files.length 
      });
      
      const successCount = result.data?.success?.length || 0;
      const failedCount = result.data?.failed?.length || 0;
      
      // 刷新图片列表
      if (successCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 150));
        
        const params = { folder: selectedFolder || '' };
        const response = await imageAPI.search(currentLibraryId, params);
        setImages(response.images);
        
        const foldersRes = await imageAPI.getFolders(currentLibraryId);
        setFolders(foldersRes.folders);
        
        // 2秒后再刷新一次
        setTimeout(async () => {
          try {
            const response2 = await imageAPI.search(currentLibraryId, params);
            setImages(response2.images);
          } catch (err) {
            logger.error('刷新缩略图失败:', err);
          }
        }, 2000);
      }

      setTimeout(() => {
        setUploadProgress({ isUploading: false, percent: 0, current: 0, total: 0 });
      }, 3000);
      
      const totalTime = Date.now() - uploadStartTime;
      logger.file(`✅ 上传完成 (${totalTime}ms)`);

      return { success: true, successCount, failedCount };
    } catch (error) {
      logger.error('❌ 上传失败:', error.message);
      setUploadProgress({ isUploading: false, percent: 0, current: 0, total: 0 });
      throw error;
    }
  }, [currentLibraryId, selectedFolder, setImages, setFolders]);

  return {
    isDraggingOver,
    uploadProgress,
    containerRef,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    uploadWithConflictAction
  };
};
