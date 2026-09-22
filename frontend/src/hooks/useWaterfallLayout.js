// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 瀑布流布局计算 Hook
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useUIStore } from '../stores/useUIStore';

/**
 * 瀑布流布局计算
 * @param {Array} images - 图片列表
 * @param {Object} options - 配置选项
 * @returns {Object} { rows, containerRef, containerWidth, containerHeight }
 */
/**
 * 图片下沿到行底之间的固定高度：文件名那一行 + 它的上下边距（实测 28px）。
 * 行高 = 图片高 + CELL_OVERHEAD + 行尾空白，这个数必须和 ImageCell 的实际渲染一致，
 * 否则虚拟列表的行位置会和真实内容对不上。
 */
export const CELL_OVERHEAD = 28;

/** 「按文件夹分隔」时那条横线占的高度（线 + 上下留白） */
export const FOLDER_SEPARATOR_HEIGHT = 25;

export const useWaterfallLayout = (images, options = {}) => {
  const {
    gap = 16,
    // 行间距：上下两个「图片块」之间**纯空白**的高度（不含文件名那一行）。
    // 默认 32 —— 用户看到的两张图之间的距离就是这个值。
    rowGap = 32,
    // 按文件夹分隔：文件夹一变就换行，并在行之间画一条横线
    separateByFolder = false,
  } = options;
  const { thumbnailHeight, isResizingPanels } = useUIStore();
  
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  // 监听容器宽度变化（使用 ResizeObserver + 去抖/阈值抑制）
  useEffect(() => {
    let resizeObserver = null;
    let retryCount = 0;
    const maxRetries = 10;

    // 记录上次尺寸，避免频繁 setState
    const lastSizeRef = { current: { width: 0, height: 0 } };
    let debounceTimer = null;

    // 宽度阈值给大一点：宽度一变就要重算整个瀑布流布局，贵，抖动不值得跟；
    // 高度阈值必须是 0 —— 它只决定可视区大小（便宜），而且必须**立刻**跟上：
    // 顶栏那些面板（排序/主题色/布局）一开一合，容器高度就变几十像素，
    // 如果这里只看宽度，列表就会继续按旧高度渲染，底部空出一块，刷新才恢复。
    const WIDTH_THRESHOLD = 12;
    const HEIGHT_THRESHOLD = 0;

    const emitSize = (width, height) => {
      const prev = lastSizeRef.current;
      const widthChanged = Math.abs(width - prev.width) >= WIDTH_THRESHOLD;
      const heightChanged = Math.abs(height - prev.height) > HEIGHT_THRESHOLD;
      if (!widthChanged && !heightChanged) return true;

      lastSizeRef.current = { width, height };

      // 去抖：在一小段静止后再更新（拖动时降低重算频率）
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // setState 对相同的值会自动跳过，所以这里两个都设是安全的
        setContainerWidth(width);
        setContainerHeight(height);
      }, 50);
      return true;
    };

    const measureAndEmit = () => {
      if (containerRef.current) {
        // 预留 padding：与现有布局保持一致
        const width = containerRef.current.offsetWidth - 32;
        const height = containerRef.current.offsetHeight;
        if (width > 0) {
          return emitSize(width, height);
        }
      }
      return false;
    };

    const tryInit = () => {
      if (measureAndEmit()) {
        // 成功获取宽度，设置 ResizeObserver
        if (containerRef.current) {
          resizeObserver = new ResizeObserver(() => {
            // 拖动时跳过更新，避免频繁重算布局
            if (useUIStore.getState().isResizingPanels) return;
            measureAndEmit();
          });
          resizeObserver.observe(containerRef.current);
        }
      } else if (retryCount < maxRetries) {
        // 重试
        retryCount++;
        requestAnimationFrame(tryInit);
      }
    };

    // 使用 requestAnimationFrame 确保 DOM 已渲染
    requestAnimationFrame(tryInit);

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, []);

  // 拖动结束时（isResizingPanels 从 true -> false）立即测量一次
  useEffect(() => {
    if (isResizingPanels) return;
    if (!containerRef.current) return;
    const width = containerRef.current.offsetWidth - 32;
    const height = containerRef.current.offsetHeight;
    if (width > 0) {
      setContainerWidth(width);
      setContainerHeight(height);
    }
  }, [isResizingPanels]);

  // 布局计算（始终在主线程同步执行）
  //
  // 这里是「固定高度 + 从左往右排」的排法：
  //   **每张图的高度 = 顶栏滑块的值**，宽度 = 高度 × 宽高比，放不下就换行。
  //
  // 为什么不用「把整行拉伸到填满宽度」（justified）的排法：
  //   那种排法下行高 = 容器宽度 ÷ 该行宽高比之和，**跟滑块没有任何关系**，
  //   滑块只影响「一行放几张图」。于是拖滑块时，分组没变的那些行尺寸纹丝不动，
  //   而且实际高度可能远超标尺值（实测滑块 300px 时图片是 365px）。
  //   用户要的是「滑块就是图片大小」，所以改成固定高度，代价是每行右侧可能留白。
  const rows = useMemo(() => {
    if (!images.length || !containerWidth) {
      return [];
    }

    const targetHeight = thumbnailHeight;
    const calculatedRows = [];
    let currentRow = [];
    let currentRowWidthSum = 0; // 含行内间距的总宽

    /** 收尾当前行：按 targetHeight 定尺寸，放不下的超宽图整体缩一点 */
    const finishRow = () => {
      if (currentRow.length === 0) return;
      const startsNewFolder = currentRow.startsNewFolder === true;

      const rowImages = currentRow.map((img) => {
        const rawWidth = targetHeight * img.aspectRatio;
        // 正常情况下 scale = 1（高度就是滑块值）；
        // 只有全景图这种「按滑块高度算出来比容器还宽」的，才整体缩小以放进容器
        const scale = Math.min(1, containerWidth / rawWidth);
        return {
          ...img,
          calculatedWidth: rawWidth * scale,
          calculatedHeight: targetHeight * scale
        };
      });

      // 行数组本身挂标记，渲染时据此决定要不要画文件夹分界线
      rowImages.startsNewFolder = startsNewFolder;
      rowImages.folder = rowImages[0] ? rowImages[0].folder : '';
      calculatedRows.push(rowImages);

      currentRow = [];
      currentRowWidthSum = 0;
    };

    images.forEach((image, index) => {
      const aspectRatio = image.width / image.height;
      const imageWidth = targetHeight * aspectRatio;
      const isNewFolder = separateByFolder && index > 0 &&
        image.folder !== images[index - 1].folder;

      // 换了文件夹：按文件夹分隔时从这里断开
      if (isNewFolder && currentRow.length > 0) finishRow();

      // 这一行放不下了：换行（行内第一张不换，否则超宽图会死循环）
      const projectedWidth = currentRowWidthSum +
        (currentRow.length > 0 ? gap : 0) + imageWidth;
      if (currentRow.length > 0 && projectedWidth > containerWidth) finishRow();

      if (currentRow.length === 0) currentRow.startsNewFolder = isNewFolder;
      currentRow.push({ ...image, originalWidth: imageWidth, aspectRatio });
      currentRowWidthSum += (currentRow.length > 1 ? gap : 0) + imageWidth;
    });

    finishRow();
    return calculatedRows;
  }, [images, thumbnailHeight, containerWidth, gap, separateByFolder]);

  // 扁平化的图片列表（用于 Shift 多选）
  const flatImages = useMemo(() => {
    if (!rows || rows.length === 0) return [];
    return rows.flat();
  }, [rows]);

  /**
   * 行与行之间真正留出的空白。
   *
   * 用户说的「行间距」= 上下两张图之间的空白，所以要把图片下方那 28px
   * （文件名行 + 边距）扣掉。rowGap=32 时留 4px，两张图之间正好 32px；
   * rowGap=0 就是完全无缝（只剩文件名那一行）。
   *
   * 之前这里写死 +32，加上文件名那 28px，实际间隔是 62px —— 用户看到的
   * 「远大于 32px 的白条」就是这么来的。
   */
  const rowPadding = Math.max(0, rowGap - CELL_OVERHEAD);

  // 获取行高（用于虚拟滚动）
  const getRowHeight = useCallback((index) => {
    const separator = separateByFolder && rows && rows[index] && rows[index].startsNewFolder
      ? FOLDER_SEPARATOR_HEIGHT
      : 0;
    if (!rows || !rows[index] || rows[index].length === 0) {
      return thumbnailHeight + CELL_OVERHEAD + rowPadding + separator;
    }
    const firstImage = rows[index][0];
    return (firstImage?.calculatedHeight || thumbnailHeight) + CELL_OVERHEAD + rowPadding + separator;
  }, [rows, thumbnailHeight, rowPadding, separateByFolder]);

  return {
    rows,
    flatImages,
    containerRef,
    containerWidth,
    containerHeight,
    getRowHeight,
    rowPadding
  };
};
