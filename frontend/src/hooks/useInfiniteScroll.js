// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 无限滚动 Hook
 */

import { useCallback } from 'react';
import { useImageStore } from '../stores/useImageStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import { imageAPI } from '../api';
import requestManager, { RequestType } from '../services/requestManager';
import { buildImageQueryParams } from '../utils/imageQuery';
import { createLogger } from '../utils/logger';

const logger = createLogger('useInfiniteScroll');

// 加载配置
const LOAD_CONFIG = {
  pageSize: 100,           // 每次加载 100 张
  preloadThreshold: 300,   // 距离边界 300px 时预加载
};

/**
 * 无限滚动加载
 * @returns {Object} 加载相关的状态和方法
 */
export const useInfiniteScroll = () => {
  const { currentLibraryId } = useLibraryStore();
  const { 
    images, 
    imageLoadingState, 
    setImageLoadingState,
    selectedFolder,
    searchKeywords,
    filters,
    sort,
    appendImages 
  } = useImageStore();

  /**
   * 加载更多图片
   */
  const loadMoreImages = useCallback(async () => {
    if (!currentLibraryId || !imageLoadingState.hasMore || imageLoadingState.isLoading) {
      return;
    }

    const requestContext = requestManager.createRequest(RequestType.IMAGES);
    setImageLoadingState({ isLoading: true });

    try {
      // offset 用「当前已经拿到的条数」，不能用心跳之外的计数。
      // 参数拼装统一走 buildImageQueryParams —— 之前这里手写了一份，
      // 漏了 sort/order/seed，导致第二页开始排序就失效了。
      const params = buildImageQueryParams({
        folder: selectedFolder,
        keywords: searchKeywords,
        filters,
        sort,
        offset: images.length,
        limit: LOAD_CONFIG.pageSize,
      });

      const response = await imageAPI.search(currentLibraryId, params, {
        signal: requestContext.signal
      });

      if (!requestManager.isValid(requestContext.id)) {
        return;
      }

      const { images: newImages, total, hasMore } = response;
      requestManager.complete(requestContext.id);

      appendImages(newImages);
      setImageLoadingState({
        isLoading: false,
        loadedCount: images.length + newImages.length,
        totalCount: total,
        hasMore: hasMore || false,
      });
    } catch (error) {
      if (error.name === 'CanceledError' || error.name === 'AbortError') {
        return;
      }
      logger.error('加载更多图片失败:', error.message);
      requestManager.error(requestContext.id);
      setImageLoadingState({ isLoading: false });
    }
  }, [
    currentLibraryId, 
    imageLoadingState, 
    images.length, 
    selectedFolder, 
    searchKeywords, 
    filters, 
    sort,
    appendImages, 
    setImageLoadingState
  ]);

  return {
    loadMoreImages,
    preloadThreshold: LOAD_CONFIG.preloadThreshold
  };
};
