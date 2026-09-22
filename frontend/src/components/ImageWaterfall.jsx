// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 图片瀑布流组件 - 重构版
 * 从 1880 行精简到 ~300 行，通过提取 hooks 和组件实现
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { VariableSizeList as List } from 'react-window';

// Stores
import { useLibraryStore } from '../stores/useLibraryStore';
import { useImageStore } from '../stores/useImageStore';
import { useUIStore } from '../stores/useUIStore';

// Custom Hooks
import { useWaterfallLayout } from '../hooks/useWaterfallLayout';
import { useImageDelete } from '../hooks/useImageDelete';
import { useConflictHandler } from '../hooks/useConflictHandler';
import { useImageClipboard } from '../hooks/useImageClipboard';
import { useImageMove } from '../hooks/useImageMove';
import { useImageRename } from '../hooks/useImageRename';
import { useImageRating } from '../hooks/useImageRating';
import { useImageUpload } from '../hooks/useImageUpload';
import { useImageKeyboard } from '../hooks/useImageKeyboard';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';

// Utils
import { imageAPI } from '../api';
import { requestFullscreen } from '../utils/fullscreen';

// Components
import ImageCell from './ImageCell';
import DragDropOverlay from './DragDropOverlay';
import UploadProgress from './UploadProgress';
import EmptyState from './EmptyState';
import FileViewer from './FileViewer';
import ImageViewer from './ImageViewer';
import ContextMenu, { menuItems } from './ContextMenu';
import UndoToast from './UndoToast';
import RatingToast from './RatingToast';
import FolderSelector from './FolderSelector';
import ConflictDialog from './ConflictDialog';

// 虚拟滚动阈值
const VIRTUAL_SCROLL_THRESHOLD = 50;

// 加载配置
// 双击判定窗口（毫秒）：同一张图 + 这个时间内再次点击 = 双击
const DOUBLE_CLICK_MS = 400;

const LOAD_CONFIG = {
  overscanCount: 4, // 预渲染 4 行
};

function ImageWaterfall() {
  const { currentLibraryId } = useLibraryStore();
  const { 
    images, selectedImage, setSelectedImage, selectedImages, setSelectedImages, 
    toggleImageSelection, clearSelection, imageLoadingState, selectedFolder,
    searchKeywords, filters, folders, setSelectedFolderItem
  } = useImageStore();

  // 状态
  const [photoIndex, setPhotoIndex] = useState(-1);
  const [lastSelectedIndex, setLastSelectedIndex] = useState(null);
  const [viewerFile, setViewerFile] = useState(null);
  const [contextMenu, setContextMenu] = useState({ isOpen: false, position: null, image: null });
  // 统一图片移动/删除撤销顺序的栈：按操作时间顺序记录 'move' | 'delete'
  const [undoStack, setUndoStack] = useState([]);
  const listRef = useRef(null);
  const prevRowCountRef = useRef(0);

  // 筛选已全部下沉到后端 SQL（见 imageQuery.js / ImageModel._buildSearchQuery）。
  // 之前这里是 filterImages(images, filters) 本地筛，只能筛到已加载的第一页，
  // 翻页之后的图完全不受筛选影响 —— 和排序那次的 bug 是同一类问题。
  const filteredImages = images;

  // 瀑布流布局
  const rowGap = useUIStore((st) => st.rowGap);
  const separateByFolder = useUIStore((st) => st.separateByFolder);
  const thumbnailHeight = useUIStore((st) => st.thumbnailHeight);

  const { rows, flatImages, containerRef, containerWidth, containerHeight, getRowHeight, rowPadding } = 
    useWaterfallLayout(filteredImages, { rowGap, separateByFolder });

  // 删除和撤销
  const { undoHistory, undoToast, setUndoToast, handleQuickDelete, handleUndo } = 
    useImageDelete();

  // 统一冲突处理
  const { conflictDialog, showConflictDialog, hideConflictDialog, resolveConflict } = 
    useConflictHandler();

  // 剪贴板操作
  const { handleCopy, handlePaste, executePaste } = 
    useImageClipboard(showConflictDialog);

  // 移动功能
  const { 
    showFolderSelector, moveItems, handleMoveClick, handleMove, handleCancelMove, executeMove,
    undoHistory: moveUndoHistory, undoToast: moveUndoToast, setUndoToast: setMoveUndoToast, handleUndoMove
  } = useImageMove(showConflictDialog);

  // 重命名
  const { 
    renamingImage, 
    editingFilename, 
    editInputRef, 
    setEditingFilename, 
    handleStartRename, 
    handleFinishRename, 
    handleCancelRename 
  } = useImageRename();

  // 评分
  const { ratingToast, setRatingToast, handleQuickRating } = useImageRating();

  // 上传
  const { 
    isDraggingOver, 
    uploadProgress, 
    handleDragEnter, 
    handleDragOver, 
    handleDragLeave, 
    handleDrop: baseHandleDrop,
    uploadWithConflictAction
  } = useImageUpload();

  // 无限滚动
  const { loadMoreImages, preloadThreshold } = useInfiniteScroll();

  // 带撤销栈的删除
  const handleQuickDeleteWithUndoStack = useCallback(async () => {
    await handleQuickDelete();
    setUndoStack(prev => [...prev, 'delete']);
  }, [handleQuickDelete]);

  // 带撤销栈的移动（通过文件夹选择器触发）
  const handleMoveWithUndoStack = useCallback(async (targetFolder) => {
    await handleMove(targetFolder);
    setUndoStack(prev => [...prev, 'move']);
  }, [handleMove]);

  // 键盘快捷键（Ctrl+Z 按照 undoStack 顺序一步步撤销）
  useImageKeyboard({
    onDelete: handleQuickDeleteWithUndoStack,
    onUndo: async () => {
      // 检查撤销栏状态
      
      if (undoStack.length === 0) return;
      const last = undoStack[undoStack.length - 1];
      setUndoStack(prev => prev.slice(0, -1));

      // 准备撤销操作

      if (last === 'move' && moveUndoHistory.length > 0) {
        // 执行移动撤销
        await handleUndoMove();
      } else if (last === 'delete' && undoHistory.length > 0) {
        // 执行删除撤销
        await handleUndo();
      }
      
      // 撤销完成
    },
    onCopy: () => {
      const result = handleCopy();
      if (result.success) {
        setUndoToast({
          isVisible: true,
          message: `已复制 ${result.count} 个文件`,
          count: result.count
        });
        setTimeout(() => setUndoToast({ isVisible: false, message: '', count: 0 }), 2000);
      }
    },
    onPaste: handlePaste,
    onRename: handleStartRename,
    onRating: handleQuickRating,
    canUndo: undoStack.length > 0,
    canPaste: selectedFolder !== null
  });

  // 包装上传处理以集成冲突对话框
  const handleDrop = useCallback(async (e) => {
    await baseHandleDrop(e, (conflicts, files, targetFolder) => {
      showConflictDialog(conflicts, 'upload', { files, targetFolder });
    });
  }, [baseHandleDrop, showConflictDialog]);

  // 缩略图和原图 URL
  const getThumbnailUrl = useCallback((image) => {
    if (!currentLibraryId || !image.thumbnailPath) return '';
    const filename = image.thumbnailPath.replace(/\\/g, '/').split('/').pop();
    return imageAPI.getThumbnailUrl(currentLibraryId, filename);
  }, [currentLibraryId]);

  const getOriginalUrl = useCallback((image) => {
    if (!currentLibraryId) return '';
    return imageAPI.getOriginalUrl(currentLibraryId, image.path);
  }, [currentLibraryId]);

  // 图片点击处理
  // 图片双击处理：图片进入全屏查看器，其他类型文件仍走 FileViewer
  // （定义在 handleImageClick 之前，后者要引用它）
  const handleImageDoubleClick = useCallback((image, flatIndex) => {
    const fileType = image.fileType || 'image';

    if (fileType !== 'image') {
      setViewerFile(image);
      return;
    }

    // 在用户手势内同步申请全屏，成功率最高；
    // 被浏览器或 iframe 策略拒绝时，ImageViewer 的全视口浮层提供同样的沉浸效果
    requestFullscreen();
    setPhotoIndex(flatIndex);
  }, []);

  // 自己判定双击：不能依赖原生 dblclick。
  // 图片数超过 50 时走 react-window 虚拟列表，第一次点击引发的重渲染会重建行 DOM，
  // 第二次点击落在新节点上，浏览器因此不派发 dblclick，onDoubleClick 永远收不到事件。
  // 放在父组件里用 ref 记录，与渲染方式、与 DOM 是否被重建都无关。
  const lastClickRef = useRef({ id: null, time: 0 });

  const handleImageClick = useCallback((image, event, imageIndex) => {
    const now = Date.now();
    const last = lastClickRef.current;
    if (last.id === image.id && now - last.time < DOUBLE_CLICK_MS) {
      lastClickRef.current = { id: null, time: 0 };
      handleImageDoubleClick(image, imageIndex);
      return;
    }
    lastClickRef.current = { id: image.id, time: now };

    setSelectedFolderItem(null);
    
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      toggleImageSelection(image);
      setLastSelectedIndex(imageIndex);
    } else if (event.shiftKey && lastSelectedIndex !== null) {
      event.preventDefault();
      const start = Math.min(lastSelectedIndex, imageIndex);
      const end = Math.max(lastSelectedIndex, imageIndex);
      const rangeImages = flatImages.slice(start, end + 1);
      setSelectedImages(rangeImages);
    } else {
      clearSelection();
      setSelectedImage(image);
      setLastSelectedIndex(imageIndex);
    }
  }, [flatImages, lastSelectedIndex, toggleImageSelection, setSelectedImages, clearSelection, setSelectedImage, setSelectedFolderItem, handleImageDoubleClick]);

  // 查看器内切换图片：同步缩略图网格的选中项，关闭后仍停留在最后浏览的那张
  const handleViewerIndexChange = useCallback((nextIndex) => {
    setPhotoIndex(nextIndex);

    const nextImage = filteredImages[nextIndex];
    if (!nextImage) return;

    clearSelection();
    setSelectedImage(nextImage);
    setLastSelectedIndex(nextIndex);
  }, [filteredImages, clearSelection, setSelectedImage]);
  
  // 文件名双击处理（重命名）
  const handleFilenameDoubleClick = useCallback((e, image) => {
    // 始终阻止事件冒泡，避免触发图片放大
    e.stopPropagation();
    
    // 只在单选时允许双击重命名
    if (selectedImages.length === 0) {
      handleStartRename(image);
    }
  }, [selectedImages, handleStartRename]);

  // 右键菜单
  const handleContextMenu = useCallback((e, image) => {
    e.preventDefault();

    // 右键时，如果当前图片不在选区中，则将其设为新的选中项
    if (selectedImages.length === 0) {
      if (!selectedImage || selectedImage.id !== image.id) {
        clearSelection();
        setSelectedImage(image);
      }
    } else if (!selectedImages.some(img => img.id === image.id)) {
      // 已经有多选，但右键点在选区外，则重置为单选
      clearSelection();
      setSelectedImage(image);
    }

    setContextMenu({
      isOpen: true,
      position: { x: e.clientX, y: e.clientY },
      image
    });
  }, [selectedImages, selectedImage, clearSelection, setSelectedImage]);

  // 拖拽开始
  const handleDragStart = useCallback((e, image) => {
    const draggedImages = selectedImages.length > 0 && selectedImages.some(img => img.id === image.id)
      ? selectedImages
      : [image];
    
    const items = draggedImages.map(img => ({ type: 'file', path: img.path }));
    e.dataTransfer.setData('application/json', JSON.stringify({ items }));
    e.dataTransfer.effectAllowed = 'move';
  }, [selectedImages]);

  // 准备移动文件（用于右键菜单）
  const handlePrepareMove = useCallback(() => {
    const itemsToMove = selectedImages.length > 0
      ? selectedImages.map(img => ({ type: 'file', path: img.path }))
      : selectedImage
      ? [{ type: 'file', path: selectedImage.path }]
      : [];

    if (itemsToMove.length === 0) return;
    
    setContextMenu({ isOpen: false, position: null, image: null });
    handleMoveClick(itemsToMove);
  }, [selectedImages, selectedImage, handleMoveClick]);

  // 处理冲突解决（统一处理粘贴、移动、上传）
  const handleConflictResolveAll = useCallback(async (action) => {
    await resolveConflict(action, async (resolvedAction, operation) => {
      const { type, pendingOperation } = conflictDialog;
      
      try {
        if (type === 'paste') {
          await executePaste(pendingOperation.items, pendingOperation.targetFolder, resolvedAction);
        } else if (type === 'move') {
          await executeMove(pendingOperation.items, pendingOperation.targetFolder, resolvedAction);
          // 注意：不在这里推入 undoStack，由外层的 handleMoveWithUndoStack 统一管理
        } else if (type === 'upload') {
          const result = await uploadWithConflictAction(
            pendingOperation.files,
            pendingOperation.targetFolder,
            resolvedAction
          );
          if (result.success && !result.skipped) {
            setUndoToast({
              isVisible: true,
              message: `上传完成: 成功 ${result.successCount} 个${result.failedCount > 0 ? `, 失败 ${result.failedCount} 个` : ''}`,
              count: result.successCount
            });
            setTimeout(() => setUndoToast({ isVisible: false, message: '', count: 0 }), 3000);
          }
        }
      } catch (error) {
        alert(`操作失败: ${error.message || '未知错误'}`);
      }
    });
  }, [conflictDialog, resolveConflict, executePaste, executeMove, uploadWithConflictAction, setUndoToast]);

  // 右键菜单选项
  const getContextMenuOptions = useCallback((image) => {
    const isMultiSelection = selectedImages.length > 0;
    const menuOptions = [
      menuItems.copy(() => {
        setContextMenu({ isOpen: false, position: null, image: null });
        const result = handleCopy();
        if (result.success) {
          setUndoToast({
            isVisible: true,
            message: `已复制 ${result.count} 个文件`,
            count: result.count
          });
          setTimeout(() => setUndoToast({ isVisible: false, message: '', count: 0 }), 3000);
        }
      })
    ];
    
    if (!isMultiSelection) {
      menuOptions.push(
        menuItems.rename(() => {
          setContextMenu({ isOpen: false, position: null, image: null });
          handleStartRename(image);
        })
      );
    }
    
    menuOptions.push(
      menuItems.move(handlePrepareMove),
      menuItems.delete(async () => {
        setContextMenu({ isOpen: false, position: null, image: null });
        await handleQuickDelete();
      })
    );
    
    return menuOptions;
  }, [selectedImages, handlePrepareMove, handleStartRename, handleCopy, handleQuickDelete, setUndoToast]);

  // 渲染单行
  const renderRow = useCallback(({ index, style }) => {
    const row = rows[index];
    if (!row) return null;
    
    let flatIndexBase = 0;
    for (let i = 0; i < index; i++) {
      flatIndexBase += rows[i]?.length || 0;
    }
    
    const showFolderLine = separateByFolder && row.startsNewFolder === true;

    return (
      <div
        style={{ ...style, paddingBottom: `${rowPadding}px` }}
        className={`flex gap-4 ${showFolderLine ? 'border-t-2 border-gray-300 dark:border-gray-600 pt-3' : ''}`}
        data-folder-line={showFolderLine ? 'true' : undefined}
      >
        {row.map((image, imageIndex) => {
          const flatIndex = flatIndexBase + imageIndex;
          const isSingleSelected = selectedImage?.id === image.id;
          const isMultiSelected = selectedImages.some(img => img.id === image.id);
          const isSelected = isSingleSelected || isMultiSelected;
          
          return (
            <ImageCell
              key={image.id}
              image={image}
              flatIndex={flatIndex}
              isSelected={isSelected}
              renamingImage={renamingImage}
              editingFilename={editingFilename}
              editInputRef={editInputRef}
              getThumbnailUrl={getThumbnailUrl}
              onImageClick={handleImageClick}
              onImageDoubleClick={handleImageDoubleClick}
              onContextMenu={handleContextMenu}
              onDragStart={handleDragStart}
              onEditingChange={setEditingFilename}
              onFinishRename={handleFinishRename}
              onCancelRename={handleCancelRename}
              onStartRename={handleStartRename}
            />
          );
        })}
      </div>
    );
  }, [
    rows, 
    selectedImage, 
    selectedImages, 
    renamingImage, 
    editingFilename, 
    getThumbnailUrl,
    handleImageClick,
    handleImageDoubleClick,
    handleContextMenu,
    handleDragStart,
    handleStartRename,
    handleFinishRename,
    handleCancelRename
  ]);

  /**
   * 虚拟列表的行高缓存刷新
   *
   * ⚠️ 这段原来是 `useRef(() => {...})` —— useRef 的回调**永远不会执行**，
   * 所以 resetAfterIndex 一次都没被调用过，react-window 一直用着旧的行高缓存。
   *
   * 后果就是用户看到的「远大于行间距的空白条」：只要重新排版过一次
   * （拖侧栏宽度、拉缩略图大小、改行间距…），每行的实际高度都变了，
   * 但列表还按旧高度摆放，多出来的差就变成一条条白带。
   *
   * 所以这里分两种情况：
   *   - 影响**所有行**的排版参数变了 → 从头开始重算（resetAfterIndex(0)）
   *   - 只是往下又加载了一批（前面的行没变）→ 从最后一行开始重算就够了
   */
  const layoutKey = `${Math.round(containerWidth)}|${thumbnailHeight}|${rowGap}|${separateByFolder}`;
  const prevLayoutKeyRef = useRef(layoutKey);

  // 滚动位置 + 上一次的行几何，用来做「滚动锚定」（见下面 effect 的说明）
  const scrollOffsetRef = useRef(0);
  const prevGeometryRef = useRef({ rows: [], getRowHeight: () => 0 });

  useEffect(() => {
    const list = listRef.current;
    if (!list || filteredImages.length <= VIRTUAL_SCROLL_THRESHOLD) return;

    const prevRowCount = prevRowCountRef.current;
    const currRowCount = rows.length;
    const prev = prevGeometryRef.current;

    if (prevLayoutKeyRef.current !== layoutKey) {
      // 容器宽度 / 缩略图高度 / 行间距 / 分隔开关变了：所有行高都可能变。
      //
      // 这里要做**滚动锚定**：不改的话，拖缩略图滑块时每一行的高矮都变了，
      // 但列表的滚动位置还是那个像素值，于是画面里的图片会整体上下乱窜。
      // 做法是先把「视口顶部那一行 + 它被卷上去多少」记下来，
      // 重算之后再把这个行放回原来的位置。
      const scrollTop = scrollOffsetRef.current;

      // 锚定的对象是**图片**而不是「第几行」——
      // 改尺寸后每行能放的张数会变，同一张图会换到别的行里去，
      // 只记行号的话它照样会跑掉。所以记「视口顶部那张图的序号 + 它在行内的偏移」。
      const findAnchor = (rowsArr, heightFn) => {
        let acc = 0;
        let flat = 0;
        for (let i = 0; i < rowsArr.length; i++) {
          const h = heightFn(i);
          if (acc + h > scrollTop) return { flatIndex: flat, offset: scrollTop - acc };
          acc += h;
          flat += rowsArr[i].length;
        }
        return { flatIndex: Math.max(0, flat - 1), offset: 0 };
      };

      const rowTopOf = (rowsArr, heightFn, flatIndex) => {
        let acc = 0;
        let flat = 0;
        for (let i = 0; i < rowsArr.length; i++) {
          if (flatIndex < flat + rowsArr[i].length) return acc;
          acc += heightFn(i);
          flat += rowsArr[i].length;
        }
        return acc;
      };

      const anchor = prev.rows.length > 0
        ? findAnchor(prev.rows, prev.getRowHeight)
        : { flatIndex: 0, offset: 0 };

      list.resetAfterIndex(0);

      // 用新几何把这张图放回原来的高度位置
      const target = Math.max(0, rowTopOf(rows, getRowHeight, anchor.flatIndex) + anchor.offset);
      if (Math.abs(target - scrollTop) > 1) {
        list.scrollTo(target);
        scrollOffsetRef.current = target;
      }
      prevLayoutKeyRef.current = layoutKey;
    } else if (currRowCount > prevRowCount && prevRowCount > 0) {
      // 只是追加了新图片，前面的行没动
      list.resetAfterIndex(Math.max(0, prevRowCount - 1));
    } else if (currRowCount !== prevRowCount) {
      list.resetAfterIndex(0);
    }

    prevRowCountRef.current = currRowCount;
    prevGeometryRef.current = { rows, getRowHeight };
  }, [rows, filteredImages.length, layoutKey]);

  // 是否启用虚拟滚动
  const useVirtualScroll = filteredImages.length > VIRTUAL_SCROLL_THRESHOLD;

  // 空状态
  if (!filteredImages.length) {
    return (
      <div 
        ref={containerRef} 
        className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400 relative"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <DragDropOverlay isVisible={isDraggingOver} />
        <UploadProgress progress={uploadProgress} />
        <EmptyState isLoading={imageLoadingState.isLoading} />
      </div>
    );
  }

  // 等待容器宽度初始化
  if (!containerWidth && filteredImages.length > 0) {
    return <div ref={containerRef} className="h-full overflow-hidden" />;
  }

  return (
    <div 
      ref={containerRef} 
      className="h-full overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DragDropOverlay isVisible={isDraggingOver} />
      <UploadProgress progress={uploadProgress} />
      
      {useVirtualScroll ? (
        <List
          ref={listRef}
          height={containerHeight || 600}
          width={containerWidth + 32}
          itemCount={rows.length}
          itemSize={getRowHeight}
          className="p-4"
          overscanCount={LOAD_CONFIG.overscanCount}
          onScroll={({ scrollOffset, scrollDirection }) => {
            scrollOffsetRef.current = scrollOffset;
            if (scrollDirection === 'forward' && imageLoadingState.hasMore && !imageLoadingState.isLoading) {
              const totalHeight = rows.reduce((sum, _, i) => sum + getRowHeight(i), 0);
              const scrollBottom = scrollOffset + (containerHeight || 600);
              if (totalHeight - scrollBottom < preloadThreshold) {
                loadMoreImages();
              }
            }
          }}
        >
          {renderRow}
        </List>
      ) : (
        <div
          className="h-full overflow-y-auto p-4"
          onScroll={(e) => {
            if (imageLoadingState.hasMore && !imageLoadingState.isLoading) {
              const { scrollTop, scrollHeight, clientHeight } = e.target;
              if (scrollHeight - scrollTop - clientHeight < preloadThreshold) {
                loadMoreImages();
              }
            }
          }}
        >
          <div>
            {rows.map((row, rowIndex) => {
              let flatIndexBase = 0;
              for (let i = 0; i < rowIndex; i++) {
                flatIndexBase += rows[i]?.length || 0;
              }
              return (
                <div
                  key={rowIndex}
                  style={{ paddingBottom: `${rowPadding}px` }}
                  className={`flex gap-4 ${separateByFolder && row.startsNewFolder ? 'border-t-2 border-gray-300 dark:border-gray-600 pt-3' : ''}`}
                >
                  {row.map((image, imageIndex) => {
                    const flatIndex = flatIndexBase + imageIndex;
                    const isSingleSelected = selectedImage?.id === image.id;
                    const isMultiSelected = selectedImages.some(img => img.id === image.id);
                    const isSelected = isSingleSelected || isMultiSelected;

                    return (
                      <ImageCell
                        key={image.id}
                        image={image}
                        flatIndex={flatIndex}
                        isSelected={isSelected}
                        renamingImage={renamingImage}
                        editingFilename={editingFilename}
                        editInputRef={editInputRef}
                        getThumbnailUrl={getThumbnailUrl}
                        onImageClick={handleImageClick}
                        onImageDoubleClick={handleImageDoubleClick}
                        onContextMenu={handleContextMenu}
                        onDragStart={handleDragStart}
                        onEditingChange={setEditingFilename}
                        onFinishRename={handleFinishRename}
                        onCancelRename={handleCancelRename}
                        onStartRename={handleStartRename}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 全屏图片查看器（双击缩略图打开，可左右切换） */}
      {photoIndex >= 0 && (
        <ImageViewer
          images={filteredImages}
          index={photoIndex}
          onIndexChange={handleViewerIndexChange}
          onClose={() => setPhotoIndex(-1)}
          getOriginalUrl={getOriginalUrl}
          getThumbnailUrl={getThumbnailUrl}
          onRequestMore={loadMoreImages}
          hasMore={imageLoadingState.hasMore}
        />
      )}

      {/* 文件查看器 */}
      {viewerFile && (
        <FileViewer
          file={viewerFile}
          libraryId={currentLibraryId}
          onClose={() => setViewerFile(null)}
        />
      )}

      {/* 右键菜单 */}
      <ContextMenu
        isOpen={contextMenu.isOpen}
        position={contextMenu.position}
        onClose={() => setContextMenu({ isOpen: false, position: null, image: null })}
        options={contextMenu.image ? getContextMenuOptions(contextMenu.image) : []}
      />

      {/* 撤销删除提示 */}
      <UndoToast
        isVisible={undoToast.isVisible}
        message={undoToast.message}
        onUndo={handleUndo}
        onClose={() => setUndoToast({ isVisible: false, message: '', count: 0 })}
      />

      {/* 撤销移动提示 */}
      <UndoToast
        isVisible={moveUndoToast.isVisible}
        message={moveUndoToast.message}
        onUndo={handleUndoMove}
        onClose={() => setMoveUndoToast({ isVisible: false, message: '', count: 0 })}
      />

      {/* 评分提醒 */}
      <RatingToast
        isVisible={ratingToast.isVisible}
        rating={ratingToast.rating}
        count={ratingToast.count}
        onClose={() => setRatingToast({ isVisible: false, rating: 0, count: 0 })}
      />

      {/* 文件夹选择器 */}
      {showFolderSelector && (
        <FolderSelector
          folders={folders}
          currentFolder={selectedFolder}
          onSelect={handleMoveWithUndoStack}
          onClose={handleCancelMove}
        />
      )}

      {/* 冲突处理对话框 */}
      <ConflictDialog
        isOpen={conflictDialog.isOpen}
        conflicts={conflictDialog.conflicts}
        onResolve={handleConflictResolveAll}
        onCancel={hideConflictDialog}
      />
    </div>
  );
}

export default ImageWaterfall;
