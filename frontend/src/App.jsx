// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

import { appBase } from './utils/appBase.js';
import { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import { useUIStore } from './stores/useUIStore';
import { useLibraryStore } from './stores/useLibraryStore';
import { useImageStore } from './stores/useImageStore';
import { useScanStore } from './stores/useScanStore';
import { useTheme } from './hooks/useTheme';
import { libraryAPI, imageAPI, scanAPI } from './api';
import domCleanup from './utils/domCleanup';
import { normalizeHex, isDefaultAccent } from './utils/accentColor';
import { buildImageQueryParams } from './utils/imageQuery';
import Sidebar from './components/Sidebar';
import MainContent from './components/MainContent';
import RightPanel from './components/RightPanel';
import PanelResizeHandle from './components/PanelResizeHandle';
import Header from './components/Header';
import FilterSortPanel from './components/FilterSortPanel';
import LibraryMissingModal from './components/LibraryMissingModal';
import { createLogger } from './utils/logger';

const logger = createLogger('App');

/** 面板默认宽度（双击把手复位用，与 256px=w-64 / 320px=w-80 对齐） */
const DEFAULT_LEFT_WIDTH = 256;
const DEFAULT_RIGHT_WIDTH = 320;

function App() {
  // 使用统一的主题管理 Hook
  useTheme();
  
  const { mobileView, setMobileView, activePanel } = useUIStore();
  const { 
    setLibraries, 
    setCurrentLibrary, 
    removeLibrary,
    setShowAddLibraryForm,
    triggerExpandLibrarySelector 
  } = useLibraryStore();
  const { selectedImage } = useImageStore();
  const { setScanProgress } = useScanStore();
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH);
  const [isDraggingLeft, setIsDraggingLeft] = useState(false);
  const [isDraggingRight, setIsDraggingRight] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true); // 启动加载状态
  const [connectionError, setConnectionError] = useState(null);
  const [missingLibrary, setMissingLibrary] = useState(null); // 丢失的素材库信息
  const containerRef = useRef(null);

  // 检测屏幕尺寸
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 768; // < 768px 为移动端
      setIsMobile(mobile);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // 选中图片时自动切换到详情视图（移动端）
  useEffect(() => {
    if (isMobile && selectedImage) {
      setMobileView('detail');
    }
  }, [selectedImage, isMobile, setMobileView]);

  useEffect(() => {
    // Setup Socket.IO - 开发模式连接后端端口，生产模式使用同源
    const socketUrl = import.meta.env.DEV
      ? 'http://localhost:15002'  // 开发模式：后端端口
      : window.location.origin;   // 生产模式：同源

    // 统一网关下应用在 /app/<appname>/ 之后，socket.io 的握手路径也要跟着加前缀，
    // 否则握手打不到应用（后端已做了前缀剥离，两种形态都能连上）。
    const socket = io(socketUrl, {
      path: `${appBase()}/socket.io`,
      transports: ['websocket', 'polling'], // 优先使用 websocket
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });

    socket.on('connect', () => {
      // 连接后检查扫描状态
      const checkScanStatus = (retries = 5, delay = 1000) => {
        const currentLibId = useLibraryStore.getState().currentLibraryId;
        if (!currentLibId) return;
        
        scanAPI.getStatus(currentLibId).then(res => {
          const scanStatus = res.data || res;
          
          if (scanStatus && scanStatus.status === 'scanning' && scanStatus.progress) {
            setScanProgress(scanStatus.progress);
          } else if (retries > 0) {
            setTimeout(() => checkScanStatus(retries - 1, delay), delay);
          }
        }).catch((err) => {
          if (retries > 0) {
            setTimeout(() => checkScanStatus(retries - 1, delay), delay);
          }
        });
      };
      
      checkScanStatus(5, 1000);
    });

    socket.on('connect_error', (error) => {
      logger.error('Socket连接错误:', error.message);
    });

    socket.on('scanProgress', (progress) => {
      const currentLibId = useLibraryStore.getState().currentLibraryId;
      if (progress.libraryId === currentLibId) {
        setScanProgress(progress);
      }
    });

    socket.on('scanComplete', ({ libraryId, results, stats }) => {
      const currentLibId = useLibraryStore.getState().currentLibraryId;

      // 扫描结果里最关键的一个数字是"找到多少个文件"：
      // 0 说明目录没读到东西（权限/路径），要直接告诉用户，不能只说"扫描完成"。
      const summary = stats || results;
      if (summary && typeof summary.total === 'number') {
        useScanStore.getState().setLastScanResult({ libraryId, ...summary });
      }

      if (libraryId !== currentLibId) {
        setScanProgress(null);
        return;
      }

      // 扫描结束之后把当前视图重新拉一遍。
      //
      // 这里原来有个"Dashboard 分支"：如果没选文件夹、没搜索、没格式筛选，就
      // `setImages([])`（当时的想法是"保持在 Dashboard 不加载图片"）。问题是
      // **扫描随时可能结束** —— 文件监控（lightweightWatcher）发现新文件就会自己跑一次
      // 增量同步，然后广播 scanComplete。于是用户在"全部图片"下看图时，
      // 后台一次扫描完成就把网格清空了，界面上就是「图片短暂显示 → 暂无图片」；
      // 点一下文件夹（走另一条加载路径）或者刷新页面又好了。
      //
      // 现在：只要当前有素材库，就按**和首屏完全一样**的参数重新加载第一页。
      const imageState = useImageStore.getState();
      const params = buildImageQueryParams({
        folder: imageState.selectedFolder,
        keywords: imageState.searchKeywords,
        filters: imageState.filters,
        sort: imageState.sort,
        offset: 0,
        limit: 100,
      });

      Promise.all([
        imageAPI.getFolders(libraryId),
        imageAPI.search(libraryId, params),
        // 扫描完成后重新获取统计信息（包含 totalSize）
        imageAPI.getStats(libraryId)
      ]).then(([foldersRes, imagesRes, statsRes]) => {
        const fresh = useImageStore.getState();
        fresh.setFolders(foldersRes.folders);
        fresh.setImages(imagesRes.images);
        fresh.setOriginalImages(imagesRes.images);
        fresh.setTotalImageCount(statsRes.total || 0);
        fresh.setTotalSize(statsRes.totalSize || 0);
        fresh.setImageLoadingState({
          isLoading: false,
          loadedCount: (imagesRes.images || []).length,
          totalCount: imagesRes.total || 0,
          hasMore: imagesRes.hasMore || false,
        });
      }).catch(err => {
        logger.error('扫描完成后加载数据失败:', err.message);
      }).finally(() => {
        setScanProgress(null);
      });
    });

    socket.on('scanError', ({ libraryId, error }) => {
      setScanProgress(null);
      useScanStore.getState().setLastScanError(error || '扫描失败');
      logger.error('扫描错误:', error);
    });


    // Socket 监听已就绪后，再加载库并可能触发同步
    loadLibraries();

    return () => {
      socket.disconnect();
      // 组件卸载时清理所有 DOM 资源
      domCleanup.cleanup();
    };
  }, []);

  // 加载文件夹和统计信息（需要在 loadLibraries 之前定义）
  const loadFolders = async (libraryId) => {
    try {
      // 并行获取文件夹和统计信息
      const [foldersResponse, statsResponse] = await Promise.all([
        imageAPI.getFolders(libraryId),
        imageAPI.getStats(libraryId)
      ]);
      
      useImageStore.getState().setFolders(foldersResponse.folders);
      // 注意：后端返回的字段是 total 和 totalSize
      useImageStore.getState().setTotalImageCount(statsResponse.total || 0);
      useImageStore.getState().setTotalSize(statsResponse.totalSize || 0);
    } catch (error) {
      logger.error('加载文件夹失败:', error.message);
    }
  };

  const loadLibraries = async (retryCount = 0) => {
    const maxRetries = 5;
    const retryDelay = 1000; // 1秒

    try {
      setConnectionError(null);
      const response = await libraryAPI.getAll();
      const data = response.data || response;

      setLibraries(data.libraries || []);
      setCurrentLibrary(data.currentLibraryId);
      
      const libId = data.currentLibraryId;

      // 加载主题和偏好设置
      if (data.theme) {
        useUIStore.getState().setTheme(data.theme);
      }
      // 主题色：'' 或非法值 = 用内置默认蓝（null）
      const savedAccent = normalizeHex(data.themeColor);
      if (!isDefaultAccent(savedAccent)) {
        useUIStore.getState().setAccentColor(savedAccent);
      }
      if (data.preferences) {
        const { thumbnailHeight, leftPanelWidth, rightPanelWidth, rowGap, separateByFolder } = data.preferences;
        if (thumbnailHeight) useUIStore.getState().setThumbnailHeight(thumbnailHeight);
        if (leftPanelWidth) setLeftWidth(leftPanelWidth);
        if (rightPanelWidth) setRightWidth(rightPanelWidth);
        if (rowGap !== undefined) useUIStore.getState().setRowGap(rowGap);
        if (separateByFolder !== undefined) useUIStore.getState().setSeparateByFolder(separateByFolder);
      }

      if (libId) {
        // 验证当前素材库路径是否存在
        try {
          const validateRes = await libraryAPI.validate(libId);
          const validateData = validateRes.data || validateRes;
          
          // 检查状态：ok / missing_index / missing_folder
          if (validateData.status !== 'ok') {
            // 路径或索引不存在，显示弹窗
            setMissingLibrary({
              id: libId,
              name: validateData.name,
              path: validateData.path,
              status: validateData.status // 'missing_index' 或 'missing_folder'
            });
            setIsConnecting(false);
            return; // 不继续加载
          }
        } catch (validateError) {
          logger.warn('验证素材库路径失败:', validateError.message);
          // 验证失败时继续正常加载
        }

        // 加载文件夹和统计信息（包含 totalSize）
        await loadFolders(libId);

        // 后台检查当前素材库的扫描状态
        scanAPI.getStatus(libId).then(scanStatus => {
          const { status, progress } = scanStatus;
          if (status === 'scanning') {
            setScanProgress(progress);
          }
        }).catch(() => { });
      }
      
      // 连接成功
      setIsConnecting(false);
      
    } catch (error) {
      logger.error(`加载素材库失败 (${retryCount + 1}/${maxRetries}):`, error.message);

      // 平台网关会话失效（真机实测：它返回 HTTP 200 + 纯文本 "invalid token"）：
      // **不要重试、不要闪烁**。重试 5 次只会让界面反复重画，而问题出在会话上，
      // 后端其实是好的 —— 以前这里会说"请检查后端是否启动"，方向完全错了。
      if (error.code === 'GATEWAY_SESSION_INVALID' || error.code === 'GATEWAY_HTML_RESPONSE') {
        setIsConnecting(false);
        setConnectionError(error.message);
        return;
      }

      if (retryCount < maxRetries - 1) {
        // 重试
        setConnectionError(`连接服务器中... (${retryCount + 1}/${maxRetries})`);
        setTimeout(() => loadLibraries(retryCount + 1), retryDelay);
      } else {
        // 重试次数用完
        setIsConnecting(false);
        setConnectionError('无法连接到服务器，请检查后端是否启动');
      }
    }
  };

  const loadImages = async (libraryId) => {
    try {
      const params = {};

      // Get current selected folder
      const selectedFolder = useImageStore.getState().selectedFolder;
      if (selectedFolder) {
        params.folder = selectedFolder;
      }

      const response = await imageAPI.search(libraryId, params);
      useImageStore.getState().setImages(response.images);
    } catch (error) {
      logger.error('加载图片失败:', error.message);
    }
  };

  // 保存面板宽度
  const savePanelWidths = async (left, right) => {
    try {
      await libraryAPI.updatePreferences({
        leftPanelWidth: left,
        rightPanelWidth: right
      });
    } catch (error) {
      logger.error('保存面板宽度失败:', error.message);
    }
  };

  // 双击把手恢复默认宽度
  const resetLeftWidth = () => {
    setLeftWidth(DEFAULT_LEFT_WIDTH);
    savePanelWidths(DEFAULT_LEFT_WIDTH, rightWidth);
  };

  const resetRightWidth = () => {
    setRightWidth(DEFAULT_RIGHT_WIDTH);
    savePanelWidths(leftWidth, DEFAULT_RIGHT_WIDTH);
  };

  // 处理鼠标拖动（极致性能优化 + RAF 批处理）
  useEffect(() => {
    if (!isDraggingLeft && !isDraggingRight) return;

    const leftPanel = document.getElementById('left-panel');
    const rightPanel = document.getElementById('right-panel');
    let currentLeftWidth = leftWidth;
    let currentRightWidth = rightWidth;

    // 缓存容器位置，避免重复计算
    const containerRect = containerRef.current.getBoundingClientRect();
    const containerLeft = containerRect.left;
    const containerRight = containerRect.right;

    // RAF 批处理，避免一帧多次样式写入
    let rafId = null;
    let pendingLeft = null;
    let pendingRight = null;

    const flushStyle = () => {
      if (leftPanel && pendingLeft != null) {
        leftPanel.style.width = `${pendingLeft}px`;
        currentLeftWidth = pendingLeft;
      }
      if (rightPanel && pendingRight != null) {
        rightPanel.style.width = `${pendingRight}px`;
        currentRightWidth = pendingRight;
      }
      rafId = null;
      pendingLeft = null;
      pendingRight = null;
    };

    const handleMouseMove = (e) => {
      let needSchedule = false;

      if (isDraggingLeft && leftPanel) {
        const newWidth = e.clientX - containerLeft;
        if (newWidth >= 200 && newWidth <= 400) {
          pendingLeft = newWidth;
          needSchedule = true;
        }
      }

      if (isDraggingRight && rightPanel) {
        const newWidth = containerRight - e.clientX;
        if (newWidth >= 280 && newWidth <= 500) {
          pendingRight = newWidth;
          needSchedule = true;
        }
      }

      if (needSchedule && rafId == null) {
        rafId = requestAnimationFrame(flushStyle);
      }
    };

    const handleMouseUp = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        flushStyle();
      }
      // 更新 state 并保存
      setLeftWidth(currentLeftWidth);
      setRightWidth(currentRightWidth);
      savePanelWidths(currentLeftWidth, currentRightWidth);

      setIsDraggingLeft(false);
      setIsDraggingRight(false);
      // 拖动结束，恢复
      useUIStore.getState().setIsResizingPanels(false);
      useUIStore.getState().setResizingSide(null);
    };

    // 使用 passive: false 确保可以阻止默认行为
    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    // 禁用过渡动画
    if (leftPanel) leftPanel.style.transition = 'none';
    if (rightPanel) rightPanel.style.transition = 'none';

    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // 恢复过渡动画
      if (leftPanel) leftPanel.style.transition = '';
      if (rightPanel) rightPanel.style.transition = '';
    };
  }, [isDraggingLeft, isDraggingRight]);

  // 启动加载界面（移动端和桌面端共用）
  if (isConnecting) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-50 dark:bg-gray-900">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <div className="text-lg font-medium text-gray-700 dark:text-gray-300">
            {connectionError || '正在连接服务器...'}
          </div>
        </div>
      </div>
    );
  }

  // 连接失败界面
  if (connectionError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-50 dark:bg-gray-900">
        <div className="flex flex-col items-center gap-4 text-center px-4">
          <div className="text-red-500 text-5xl">⚠️</div>
          <div className="text-lg font-medium text-gray-700 dark:text-gray-300">
            {connectionError}
          </div>
          <button
            onClick={() => {
              setIsConnecting(true);
              setConnectionError(null);
              loadLibraries(0);
            }}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            重新连接
          </button>
        </div>
      </div>
    );
  }

  // 素材库路径丢失弹窗处理函数
  const handleRescanLibrary = async () => {
    if (!missingLibrary) return;
    
    // 关闭弹窗
    setMissingLibrary(null);
    
    // 触发全量扫描
    try {
      await scanAPI.fullScan(missingLibrary.id);
      // 扫描会通过 Socket.IO 推送进度
    } catch (error) {
      logger.error('启动扫描失败:', error.message);
      alert('启动扫描失败: ' + error.message);
    }
  };

  const handleOpenOtherLibrary = async () => {
    if (!missingLibrary) return;
    
    // 从配置中移除当前素材库（不自动选择下一个）
    try {
      await libraryAPI.remove(missingLibrary.id, false);
      removeLibrary(missingLibrary.id);
      
      // 清空当前素材库，让用户自己选择
      setCurrentLibrary(null);
      useImageStore.getState().setImages([]);
      useImageStore.getState().setFolders([]);
      useImageStore.getState().setTotalImageCount(0);
      useImageStore.getState().setSelectedFolder(null);
    } catch (error) {
      logger.error('移除素材库失败:', error.message);
    }
    
    // 关闭弹窗
    setMissingLibrary(null);
    
    // 触发展开素材库选择器
    setTimeout(() => {
      triggerExpandLibrarySelector();
    }, 100);
  };

  const handleCreateNewLibrary = async () => {
    if (!missingLibrary) return;
    
    // 从配置中移除当前素材库
    try {
      await libraryAPI.remove(missingLibrary.id);
      removeLibrary(missingLibrary.id);
    } catch (error) {
      logger.error('移除素材库失败:', error.message);
    }
    
    // 关闭弹窗
    setMissingLibrary(null);
    
    // 触发显示新建素材库表单
    setTimeout(() => {
      setShowAddLibraryForm(true);
    }, 100);
  };

  // 移动端布局
  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900">
        <Header />
        {/* 素材库路径丢失弹窗 */}
        <LibraryMissingModal
          isOpen={!!missingLibrary}
          libraryName={missingLibrary?.name}
          libraryPath={missingLibrary?.path}
          status={missingLibrary?.status}
          onRescan={handleRescanLibrary}
          onOpenOther={handleOpenOtherLibrary}
          onCreateNew={handleCreateNewLibrary}
        />
        <div className="flex-1 overflow-hidden relative">
          {/* 侧边栏视图 */}
          <div className={`absolute inset-0 transition-transform duration-300 ${mobileView === 'sidebar' ? 'translate-x-0' : '-translate-x-full'
            }`}>
            <Sidebar />
          </div>

          {/* 主内容视图 */}
          <div className={`absolute inset-0 transition-transform duration-300 ${mobileView === 'main' ? 'translate-x-0' :
            mobileView === 'sidebar' ? 'translate-x-full' : '-translate-x-full'
            }`}>
            <MainContent />
          </div>

          {/* 详情视图 */}
          <div className={`absolute inset-0 transition-transform duration-300 ${mobileView === 'detail' ? 'translate-x-0' : 'translate-x-full'
            }`}>
            <RightPanel />
          </div>
        </div>

        {/* 底部导航 */}
        <div className="flex border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <button
            onClick={() => setMobileView('sidebar')}
            className={`flex-1 flex flex-col items-center py-2 ${mobileView === 'sidebar' ? 'text-blue-500' : 'text-gray-500'
              }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <span className="text-xs mt-1">文件夹</span>
          </button>
          <button
            onClick={() => setMobileView('main')}
            className={`flex-1 flex flex-col items-center py-2 ${mobileView === 'main' ? 'text-blue-500' : 'text-gray-500'
              }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-xs mt-1">图片</span>
          </button>
          <button
            onClick={() => setMobileView('detail')}
            disabled={!selectedImage}
            className={`flex-1 flex flex-col items-center py-2 ${mobileView === 'detail' ? 'text-blue-500' : 'text-gray-500'
              } disabled:opacity-30`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-xs mt-1">详情</span>
          </button>
        </div>
      </div>
    );
  }

  // 桌面端布局
  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900">
      <Header />
      {/* 素材库路径丢失弹窗 */}
      <LibraryMissingModal
        isOpen={!!missingLibrary}
        libraryName={missingLibrary?.name}
        libraryPath={missingLibrary?.path}
        status={missingLibrary?.status}
        onRescan={handleRescanLibrary}
        onOpenOther={handleOpenOtherLibrary}
        onCreateNew={handleCreateNewLibrary}
      />
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* 左侧边栏 */}
        <div id="left-panel" style={{ width: `${leftWidth}px` }} className="flex-shrink-0 h-full bg-white dark:bg-gray-800">
          <Sidebar />
        </div>

        {/* 左侧分界线 + 顶部拖拽把手（只有按住把手才能调宽度） */}
        <PanelResizeHandle
          side="left"
          active={isDraggingLeft}
          onMouseDown={(e) => {
            e.preventDefault();
            // 标记正在拖动，供其他组件抑制重算
            useUIStore.getState().setIsResizingPanels(true);
            useUIStore.getState().setResizingSide('left');
            setIsDraggingLeft(true);
          }}
          onReset={resetLeftWidth}
        />

        {/* 中间主内容区。
            筛选/排序、主题色这两张卡片画在这里（不是画在顶栏里）——
            画在顶栏里的话卡片一展开，整行内容都被压矮，左右两个侧栏也跟着变短；
            画在这里就只挤图片区，两侧边栏高度纹丝不动。 */}
        <div className="flex-1 min-w-0 h-full flex flex-col">
          {/* 筛选/排序卡片（里面也含主题色）。画在图片区这一列里，
              所以只挤图片区，左右两侧边栏的高度完全不受影响。 */}
          {activePanel && (
            <FilterSortPanel className="px-3 pt-3" horizontal />
          )}
          <div className="flex-1 min-h-0">
            <MainContent />
          </div>
        </div>

        {/* 右侧分界线 + 顶部拖拽把手 */}
        <PanelResizeHandle
          side="right"
          active={isDraggingRight}
          onMouseDown={(e) => {
            e.preventDefault();
            useUIStore.getState().setIsResizingPanels(true);
            useUIStore.getState().setResizingSide('right');
            setIsDraggingRight(true);
          }}
          onReset={resetRightWidth}
        />

        {/* 右侧边栏 */}
        <div id="right-panel" style={{ width: `${rightWidth}px` }} className="flex-shrink-0 h-full bg-white dark:bg-gray-800">
          <RightPanel />
        </div>
      </div>
    </div>
  );
}

export default App;
