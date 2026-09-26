// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * ImageViewer - 沉浸式全屏图片查看器
 *
 * 交互逻辑参考 Windows「照片」应用：
 *  1. 双击缩略图进入全屏（优先浏览器 Fullscreen API，失败时退化为全视口浮层）
 *  2. 左右切换：← / → 方向键、空格（下一张）、Backspace（上一张）、Home / End 首尾、
 *     左右滑动（鼠标拖拽 / 触屏滑动），以及两侧悬停出现的箭头按钮
 *  3. 缩放：滚轮以光标为锚点缩放（同照片应用）、双击在「适应窗口 / 100%」间切换、
 *     拖拽平移、+/- 键、工具栏缩放条
 *  4. 旋转：[ 左旋、] 右旋（等价 Ctrl+, / Ctrl+.），旋转后自动重算适应比例
 *  5. 工具栏与标题 2.6 秒无操作后自动隐藏，鼠标移动即恢复（沉浸式体验）
 *  6. I 切换文件信息面板，F 切换全屏，Esc 退出（信息面板打开时先关面板）
 *  7. 打开期间吞掉全局键盘事件（捕获阶段 + stopImmediatePropagation），
 *     避免缩略图网格的 Del / 1-5 / Ctrl+Z 等快捷键在查看图片时误触发
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCcw, RotateCw,
  Info, Maximize, Minimize, Play, Pause, ExternalLink, Loader2, ImageOff
} from 'lucide-react';
import RatingStars from './RatingStars';
import {
  requestFullscreen, exitFullscreen, isFullscreen,
  isFullscreenSupported, onFullscreenChange
} from '../utils/fullscreen';
import { createLogger } from '../utils/logger';

const logger = createLogger('ImageViewer');

// 无操作后隐藏工具栏的延时（毫秒）
const CHROME_HIDE_DELAY = 2600;
// 幻灯片播放间隔（毫秒）
const SLIDESHOW_INTERVAL = 4000;
// 缩放范围（相对原图尺寸的百分比）
const MIN_PERCENT = 10;
const MAX_PERCENT = 800;
// 滚轮灵敏度
const WHEEL_SENSITIVITY = 0.0018;
// 位移超过该像素视为「拖动」而非「点击」
const CLICK_TOLERANCE = 5;
// 滑动切换阈值
const SWIPE_THRESHOLD = 60;
// 预加载相邻图片的半径
const PRELOAD_RADIUS = 2;
// 预加载 URL 记录上限（避免长时间浏览后无限增长）
const PRELOAD_CACHE_LIMIT = 300;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ImageViewer({
  images = [],
  index = -1,
  onIndexChange,
  onClose,
  getOriginalUrl,
  getDisplayUrl,
  getThumbnailUrl,
  onRequestMore,
  hasMore = false,
}) {
  const viewportRef = useRef(null);
  const imageRef = useRef(null);
  const hideTimerRef = useRef(null);
  const pointersRef = useRef(new Map());
  const gestureRef = useRef(null);
  const suppressClickRef = useRef(false);
  const preloadedRef = useRef(new Set());

  // 布局 / 视图状态
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [dragging, setDragging] = useState(false);

  // 加载状态按 URL 记录：切换图片后旧事件自然失效，无需重置竞态
  const [loaded, setLoaded] = useState({ url: '', error: false });
  const [decoded, setDecoded] = useState({ url: '', width: 0, height: 0 });

  // 界面状态
  const [chromeVisible, setChromeVisible] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const [sliding, setSliding] = useState(false);

  const total = images.length;
  const safeIndex = index >= 0 && index < total ? index : -1;
  const current = safeIndex >= 0 ? images[safeIndex] : null;

  // 显示用 URL：走后端预览路由（HEIC/RAW/TIFF/PSD… 会被后端转成 webp）
  // 没传 getDisplayUrl 时退回原图 URL，行为与以前一致
  const displayUrl = useMemo(() => {
    if (!current) return '';
    if (getDisplayUrl) return getDisplayUrl(current);
    return getOriginalUrl ? getOriginalUrl(current) : '';
  }, [current, getDisplayUrl, getOriginalUrl]);

  // 原图 URL：只用于"打开原图"（交给浏览器/系统处理，拿到的是原始字节）
  const originalUrl = useMemo(
    () => (current && getOriginalUrl ? getOriginalUrl(current) : ''),
    [current, getOriginalUrl]
  );
  const thumbnailUrl = useMemo(
    () => (current && getThumbnailUrl ? getThumbnailUrl(current) : ''),
    [current, getThumbnailUrl]
  );

  const isReady = !!displayUrl && loaded.url === displayUrl && !loaded.error;
  const isError = !!displayUrl && loaded.url === displayUrl && loaded.error;
  const isLoading = !isReady && !isError;

  const decodedSize = decoded.url === displayUrl ? decoded : null;
  // 优先使用索引里的元数据尺寸，可让占位图与原图共用同一套变换，避免切换时跳动
  const naturalWidth = Number(current?.width) || decodedSize?.width || 0;
  const naturalHeight = Number(current?.height) || decodedSize?.height || 0;

  const rotated = rotation % 180 !== 0;
  const layoutWidth = rotated ? naturalHeight : naturalWidth;
  const layoutHeight = rotated ? naturalWidth : naturalHeight;

  // 适应窗口比例：不超过 100%（小图按原始像素显示，避免被放大模糊）
  const fitScale = layoutWidth > 0 && viewport.width > 0
    ? Math.min(viewport.width / layoutWidth, viewport.height / layoutHeight, 1)
    : 1;

  const fitPercent = fitScale * 100;
  const minPercent = Math.min(MIN_PERCENT, fitPercent);
  const maxPercent = Math.max(MAX_PERCENT, fitPercent);
  const displayPercent = Math.max(1, Math.round(fitPercent * view.zoom));

  const scale = fitScale * view.zoom;
  const atFit = Math.abs(view.zoom - 1) < 0.001;

  /** 把平移量限制在可视范围内（图片小于视口时居中） */
  const clampOffset = useCallback((offset, zoom) => {
    const nextScale = fitScale * zoom;
    const halfX = Math.max(0, (layoutWidth * nextScale - viewport.width) / 2);
    const halfY = Math.max(0, (layoutHeight * nextScale - viewport.height) / 2);
    return {
      x: clamp(offset.x, -halfX, halfX),
      y: clamp(offset.y, -halfY, halfY),
    };
  }, [fitScale, layoutWidth, layoutHeight, viewport.width, viewport.height]);

  /** 以 anchor（相对视口中心的位移）为锚点缩放到指定 zoom */
  const zoomTo = useCallback((nextZoom, anchor = { x: 0, y: 0 }) => {
    setView((prev) => {
      const target = clamp(nextZoom, minPercent / fitPercent, maxPercent / fitPercent);
      const ratio = target / prev.zoom;
      const offset = {
        x: anchor.x - ratio * (anchor.x - prev.x),
        y: anchor.y - ratio * (anchor.y - prev.y),
      };
      return { zoom: target, ...clampOffset(offset, target) };
    });
  }, [clampOffset, minPercent, maxPercent, fitPercent]);

  /** 相对当前比例继续缩放（用于 +/- 按钮与快捷键） */
  const zoomBy = useCallback((factor) => {
    setView((prev) => {
      const target = clamp(prev.zoom * factor, minPercent / fitPercent, maxPercent / fitPercent);
      return { zoom: target, ...clampOffset(prev, target) };
    });
  }, [clampOffset, minPercent, maxPercent, fitPercent]);

  const resetView = useCallback(() => setView({ zoom: 1, x: 0, y: 0 }), []);

  const rotateBy = useCallback((delta) => {
    setRotation((prev) => (prev + delta + 360) % 360);
    setView({ zoom: 1, x: 0, y: 0 });
  }, []);

  // ==================== 视口尺寸跟踪 ====================
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;

    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    update();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 视口 / 旋转变化后重新夹紧平移量
  useEffect(() => {
    setView((prev) => {
      const next = clampOffset(prev, prev.zoom);
      return next.x === prev.x && next.y === prev.y ? prev : { ...prev, ...next };
    });
  }, [clampOffset]);

  // ==================== 切换图片时复位视图 ====================
  const currentId = current?.id;
  useEffect(() => {
    if (currentId === undefined) return;
    setRotation(0);
    setView({ zoom: 1, x: 0, y: 0 });
    setDragging(false);
    pointersRef.current.clear();
    gestureRef.current = null;
  }, [currentId]);

  // ==================== 预加载相邻图片 ====================
  useEffect(() => {
    const preloadUrl = getDisplayUrl || getOriginalUrl;
    if (!current || !preloadUrl || total <= 1) return;
    if (preloadedRef.current.size > PRELOAD_CACHE_LIMIT) preloadedRef.current.clear();

    for (let step = 1; step <= PRELOAD_RADIUS; step += 1) {
      [safeIndex + step, safeIndex - step].forEach((target) => {
        if (target < 0 || target >= total) return;
        // 预加载的必须是**显示用的** URL：预加载原图、显示时却请求预览，
        // 等于白下载一遍（HEIC/RAW 甚至完全预加载不到点上）
        const url = preloadUrl(images[target]);
        if (!url || preloadedRef.current.has(url)) return;
        preloadedRef.current.add(url);
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
      });
    }
  }, [current, safeIndex, images, total, getDisplayUrl, getOriginalUrl]);

  // ==================== 切换 / 关闭 ====================
  const goTo = useCallback((nextIndex) => {
    if (nextIndex < 0 || nextIndex >= total) return;
    onIndexChange?.(nextIndex);
  }, [onIndexChange, total]);

  const goNext = useCallback(() => {
    if (safeIndex < 0) return;
    if (safeIndex >= total - 1) {
      if (hasMore) onRequestMore?.();
      return;
    }
    goTo(safeIndex + 1);
  }, [safeIndex, total, goTo, hasMore, onRequestMore]);

  const goPrev = useCallback(() => {
    if (safeIndex > 0) goTo(safeIndex - 1);
  }, [safeIndex, goTo]);

  // 快翻到列表末尾时提前拉取下一页，保证连续翻图不断档
  useEffect(() => {
    if (hasMore && total > 0 && safeIndex >= total - 3) onRequestMore?.();
  }, [hasMore, total, safeIndex, onRequestMore]);

  const handleClose = useCallback(async () => {
    setSliding(false);
    await exitFullscreen();
    onClose?.();
  }, [onClose]);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen()) await exitFullscreen();
    else await requestFullscreen(document.documentElement);
  }, []);

  // ==================== 工具栏自动隐藏 ====================
  const wakeChrome = useCallback(() => {
    setChromeVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setChromeVisible(false), CHROME_HIDE_DELAY);
  }, []);

  useEffect(() => {
    wakeChrome();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [wakeChrome]);

  // 信息面板 / 幻灯片期间保持工具栏常显
  useEffect(() => {
    if (showInfo || sliding) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setChromeVisible(true);
    } else {
      wakeChrome();
    }
  }, [showInfo, sliding, wakeChrome]);

  // ==================== 全屏状态同步 ====================
  useEffect(() => {
    setIsFs(isFullscreen());
    return onFullscreenChange(setIsFs);
  }, []);

  // ==================== 锁定页面滚动 ====================
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // ==================== 键盘交互（捕获阶段，屏蔽网格快捷键） ====================
  useEffect(() => {
    const handleKeyDown = (e) => {
      // 查看器是模态层：所有按键都不再向下传递
      e.stopImmediatePropagation();
      wakeChrome();

      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

      const key = e.key;

      switch (key) {
        case 'Escape':
          // 与照片应用一致：Esc 一步退出查看器（同时退出全屏）；
          // 信息面板打开时先收起面板。只想退出全屏可用 F 或标题栏按钮。
          e.preventDefault();
          if (showInfo) setShowInfo(false);
          else handleClose();
          return;
        case 'ArrowLeft':
        case 'PageUp':
        case 'Backspace':
          e.preventDefault();
          goPrev();
          return;
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault();
          goNext();
          return;
        case 'Home':
          e.preventDefault();
          goTo(0);
          return;
        case 'End':
          e.preventDefault();
          goTo(total - 1);
          return;
        case '+':
        case '=':
          e.preventDefault();
          zoomBy(1.25);
          return;
        case '-':
        case '_':
          e.preventDefault();
          zoomBy(1 / 1.25);
          return;
        case '0':
          e.preventDefault();
          resetView();
          return;
        case '[':
          e.preventDefault();
          rotateBy(-90);
          return;
        case ']':
          e.preventDefault();
          rotateBy(90);
          return;
        default:
          break;
      }

      if (e.ctrlKey && (key === ',' || key === '.')) {
        e.preventDefault();
        rotateBy(key === ',' ? -90 : 90);
        return;
      }

      const lower = typeof key === 'string' ? key.toLowerCase() : '';
      if (lower === 'i') {
        e.preventDefault();
        setShowInfo((prev) => !prev);
      } else if (lower === 'f') {
        e.preventDefault();
        toggleFullscreen();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [goNext, goPrev, goTo, total, zoomBy, resetView, rotateBy, showInfo, handleClose, toggleFullscreen, wakeChrome]);

  // ==================== 幻灯片 ====================
  useEffect(() => {
    if (!sliding) return undefined;
    const timer = setInterval(() => {
      if (safeIndex >= total - 1) {
        setSliding(false);
        return;
      }
      goTo(safeIndex + 1);
    }, SLIDESHOW_INTERVAL);
    return () => clearInterval(timer);
  }, [sliding, safeIndex, total, goTo]);

  // ==================== 滚轮缩放（以光标为锚点） ====================
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;

    // React 的 onWheel 是 passive 的，必须原生非 passive 监听才能 preventDefault
    const handleWheel = (e) => {
      e.preventDefault();
      wakeChrome();

      const rect = el.getBoundingClientRect();
      const anchor = {
        x: e.clientX - (rect.left + rect.width / 2),
        y: e.clientY - (rect.top + rect.height / 2),
      };

      setView((prev) => {
        const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY);
        const target = clamp(prev.zoom * factor, minPercent / fitPercent, maxPercent / fitPercent);
        if (target === prev.zoom) return prev;

        const ratio = target / prev.zoom;
        const offset = {
          x: anchor.x - ratio * (anchor.x - prev.x),
          y: anchor.y - ratio * (anchor.y - prev.y),
        };
        return { zoom: target, ...clampOffset(offset, target) };
      });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [clampOffset, minPercent, maxPercent, fitPercent, wakeChrome]);

  // ==================== 指针交互：拖拽平移 / 捏合缩放 / 滑动切换 ====================
  const handlePointerDown = useCallback((e) => {
    wakeChrome();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 1) {
      gestureRef.current = {
        mode: atFit ? 'swipe' : 'pan',
        startX: e.clientX,
        startY: e.clientY,
        originX: view.x,
        originY: view.y,
        moved: false,
      };
      setDragging(true);
    } else if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      gestureRef.current = {
        mode: 'pinch',
        startX: e.clientX,
        startY: e.clientY,
        originX: view.x,
        originY: view.y,
        moved: true,
        pinchDistance: Math.hypot(a.x - b.x, a.y - b.y),
        pinchZoom: view.zoom,
      };
    }
  }, [atFit, view.x, view.y, view.zoom, wakeChrome]);

  const handlePointerMove = useCallback((e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.mode === 'pinch' && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.pinchDistance > 0) zoomTo(gesture.pinchZoom * (distance / gesture.pinchDistance));
      suppressClickRef.current = true;
      return;
    }

    const dx = e.clientX - gesture.startX;
    const dy = e.clientY - gesture.startY;

    if (!gesture.moved && Math.hypot(dx, dy) > CLICK_TOLERANCE) {
      gesture.moved = true;
      suppressClickRef.current = true;
    }
    if (!gesture.moved) return;

    // 适应窗口时图片不超出视口，无需平移；此时拖拽用于滑动切换
    if (gesture.mode === 'pan') {
      setView((prev) => ({
        ...prev,
        ...clampOffset({ x: gesture.originX + dx, y: gesture.originY + dy }, prev.zoom),
      }));
    }
  }, [clampOffset, zoomTo]);

  const handlePointerUp = useCallback((e) => {
    const gesture = gestureRef.current;
    pointersRef.current.delete(e.pointerId);

    if (pointersRef.current.size === 0) {
      setDragging(false);
      gestureRef.current = null;

      if (gesture?.mode === 'swipe') {
        const dx = e.clientX - gesture.startX;
        const dy = e.clientY - gesture.startY;
        if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0) goNext(); else goPrev();
        }
      }
      return;
    }

    // 捏合中松开一指 → 回到单指拖拽
    if (pointersRef.current.size === 1 && gesture?.mode === 'pinch') {
      const [only] = [...pointersRef.current.values()];
      gestureRef.current = {
        mode: 'pan',
        startX: only.x,
        startY: only.y,
        originX: view.x,
        originY: view.y,
        moved: true,
      };
    }
  }, [goNext, goPrev, view.x, view.y]);

  // ==================== 图片事件 ====================
  const handleImageLoad = useCallback((e) => {
    const { naturalWidth: width, naturalHeight: height } = e.target;
    setLoaded({ url: displayUrl, error: false });
    if (width && height) setDecoded({ url: displayUrl, width, height });
  }, [displayUrl]);

  const handleImageError = useCallback(() => {
    logger.warn('图片加载失败:', displayUrl);
    setLoaded({ url: displayUrl, error: true });
  }, [displayUrl]);

  // 命中浏览器缓存时 load 事件可能早于挂载完成，这里补一次检查
  useEffect(() => {
    const el = imageRef.current;
    if (!el || loaded.url === displayUrl) return;
    if (el.complete && el.naturalWidth > 0) {
      setLoaded({ url: displayUrl, error: false });
      setDecoded({ url: displayUrl, width: el.naturalWidth, height: el.naturalHeight });
    }
  }, [displayUrl, loaded.url]);

  /** 双击图片：适应窗口 ⇄ 100%（以双击点为锚点） */
  const handleImageDoubleClick = useCallback((e) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const anchor = rect
      ? { x: e.clientX - (rect.left + rect.width / 2), y: e.clientY - (rect.top + rect.height / 2) }
      : { x: 0, y: 0 };

    if (atFit) zoomTo(1 / fitScale, anchor);
    else zoomTo(1, anchor);
  }, [atFit, fitScale, zoomTo]);

  /** 单击图片本身不关闭查看器（与照片应用一致） */
  const stopClick = useCallback((e) => e.stopPropagation(), []);

  /** 单击空白背景退出；拖拽/捏合后的那次 click 忽略 */
  const handleBackdropClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    handleClose();
  }, [handleClose]);

  const handleOpenOriginal = useCallback(() => {
    if (originalUrl) window.open(originalUrl, '_blank', 'noopener');
  }, [originalUrl]);

  // 缩放条：在对数刻度上映射 [minPercent, maxPercent]
  const sliderValue = useMemo(() => {
    const logMin = Math.log(minPercent);
    const logMax = Math.log(maxPercent);
    return clamp(((Math.log(displayPercent) - logMin) / (logMax - logMin)) * 100, 0, 100);
  }, [displayPercent, minPercent, maxPercent]);

  const handleSliderChange = useCallback((e) => {
    const ratio = Number(e.target.value) / 100;
    const logMin = Math.log(minPercent);
    const logMax = Math.log(maxPercent);
    const percent = Math.exp(logMin + ratio * (logMax - logMin));
    zoomTo(percent / fitPercent);
  }, [minPercent, maxPercent, fitPercent, zoomTo]);

  if (!current || safeIndex < 0) return null;

  const chromeClass = `transition-opacity duration-300 ${chromeVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`;
  const hasPrev = safeIndex > 0;
  const hasNext = safeIndex < total - 1;
  const imageTransform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${scale}) rotate(${rotation}deg)`;
  const imageTransition = dragging ? 'none' : 'transform 180ms ease-out';

  const content = (
    <div
      ref={viewportRef}
      className="fixed inset-0 z-[9999] overflow-hidden bg-black select-none niupic-viewer-enter"
      style={{ cursor: chromeVisible ? 'default' : 'none', touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={handleBackdropClick}
      onMouseMove={wakeChrome}
      role="dialog"
      aria-modal="true"
      aria-label="图片查看器"
    >
      {/* ============ 图片区 ============ */}
      {/* 缩略图先出画面（复用网格里已缓存的低清图），原图解码完成后叠加显示 */}
      {thumbnailUrl && !isReady && (
        <img
          src={thumbnailUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute left-1/2 top-1/2 max-w-none blur-[3px] opacity-60 pointer-events-none"
          style={{
            width: naturalWidth || 'auto',
            height: naturalHeight || 'auto',
            transform: imageTransform,
            transformOrigin: 'center center',
            transition: imageTransition,
          }}
        />
      )}

      {!isError && (
        <img
          key={`${current.id}-display`}
          ref={imageRef}
          src={displayUrl}
          alt={current.filename}
          draggable={false}
          onClick={stopClick}
          onDoubleClick={handleImageDoubleClick}
          onLoad={handleImageLoad}
          onError={handleImageError}
          className="absolute left-1/2 top-1/2 max-w-none niupic-viewer-image"
          style={{
            width: naturalWidth || 'auto',
            height: naturalHeight || 'auto',
            opacity: isReady ? 1 : 0,
            transform: imageTransform,
            transformOrigin: 'center center',
            cursor: atFit ? 'default' : (dragging ? 'grabbing' : 'grab'),
            transition: `${imageTransition}, opacity 220ms ease-out`,
          }}
        />
      )}

      {isLoading && (
        <div
          onClick={stopClick}
          onDoubleClick={stopClick}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-3 text-white/80"
        >
          <Loader2 className="w-8 h-8 animate-spin" />
          <span className="text-xs tracking-wide">正在加载原图…</span>
        </div>
      )}

      {isError && (
        <div
          onClick={stopClick}
          onDoubleClick={stopClick}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-4 px-6 text-center text-white/90"
        >
          <ImageOff className="w-12 h-12 opacity-70" />
          <div className="text-sm">原图加载失败，文件可能已被移动或删除</div>
          <button
            type="button"
            onClick={handleOpenOriginal}
            className="px-4 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-sm transition-colors"
          >
            在新标签页中打开
          </button>
        </div>
      )}

      {/* ============ 顶部标题栏 ============ */}
      <div
        className={`absolute top-0 left-0 right-0 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/70 to-transparent ${chromeClass}`}
        onClick={stopClick}
        onDoubleClick={stopClick}
      >
        <button
          type="button"
          onClick={handleClose}
          title="关闭 (Esc)"
          aria-label="关闭"
          className="p-2 rounded-full text-white/90 hover:text-white hover:bg-white/15 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-white/95">{current.filename}</div>
          <div className="truncate text-[11px] text-white/50">
            {safeIndex + 1} / {total}
            {naturalWidth > 0 && ` · ${naturalWidth} × ${naturalHeight}`}
            {current.size ? ` · ${formatBytes(current.size)}` : ''}
          </div>
        </div>

        <button
          type="button"
          onClick={handleOpenOriginal}
          title="在新标签页中打开原图"
          aria-label="在新标签页中打开原图"
          className="p-2 rounded-full text-white/90 hover:text-white hover:bg-white/15 transition-colors"
        >
          <ExternalLink className="w-5 h-5" />
        </button>
        {isFullscreenSupported() && (
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFs ? '退出全屏 (F)' : '全屏 (F)'}
            aria-label={isFs ? '退出全屏' : '全屏'}
            className="p-2 rounded-full text-white/90 hover:text-white hover:bg-white/15 transition-colors"
          >
            {isFs ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
          </button>
        )}
      </div>

      {/* ============ 左右切换（末张 / 首张时隐藏对应箭头） ============ */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); goPrev(); }}
        onDoubleClick={stopClick}
        title="上一张 (←)"
        aria-label="上一张"
        className={`absolute left-3 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 text-white/90 hover:bg-black/70 hover:text-white transition-opacity duration-300 ${chromeVisible && hasPrev ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <ChevronLeft className="w-7 h-7" />
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); goNext(); }}
        onDoubleClick={stopClick}
        title="下一张 (→)"
        aria-label="下一张"
        className={`absolute right-3 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 text-white/90 hover:bg-black/70 hover:text-white transition-opacity duration-300 ${chromeVisible && hasNext ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <ChevronRight className="w-7 h-7" />
      </button>

      {/* ============ 底部工具栏 ============ */}
      {/* 容器整层不拦截点击，让空白背景保持「点击退出」的手感；只有工具条本体响应点击 */}
      <div
        className={`absolute bottom-0 left-0 right-0 flex flex-col items-center gap-2 pt-10 pb-4 bg-gradient-to-t from-black/75 to-transparent pointer-events-none ${chromeClass}`}
      >
        <div
          onClick={stopClick}
          onDoubleClick={stopClick}
          style={{ pointerEvents: chromeVisible ? 'auto' : 'none' }}
          className="flex items-center gap-1 px-3 py-2 rounded-2xl bg-black/55 backdrop-blur-sm text-white shadow-lg"
        >
          <button
            type="button"
            onClick={() => zoomBy(1 / 1.25)}
            title="缩小 (-)"
            aria-label="缩小"
            className="p-2 rounded-full hover:bg-white/15 transition-colors"
          >
            <ZoomOut className="w-5 h-5" />
          </button>

          <input
            type="range"
            min="0"
            max="100"
            step="0.5"
            value={sliderValue}
            onChange={handleSliderChange}
            aria-label="缩放"
            className="niupic-viewer-slider w-28 md:w-44 mx-1"
          />

          <button
            type="button"
            onClick={() => zoomBy(1.25)}
            title="放大 (+)"
            aria-label="放大"
            className="p-2 rounded-full hover:bg-white/15 transition-colors"
          >
            <ZoomIn className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => (atFit ? zoomTo(1 / fitScale) : resetView())}
            title={atFit ? '切换到 100%' : '适应窗口'}
            className="ml-1 px-2 py-1 min-w-[54px] text-xs tabular-nums rounded-lg hover:bg-white/15 transition-colors"
          >
            {displayPercent}%
          </button>

          <span className="mx-1 h-5 w-px bg-white/20" />

          <button
            type="button"
            onClick={() => rotateBy(-90)}
            title="向左旋转 ([)"
            aria-label="向左旋转"
            className="p-2 rounded-full hover:bg-white/15 transition-colors"
          >
            <RotateCcw className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => rotateBy(90)}
            title="向右旋转 (])"
            aria-label="向右旋转"
            className="p-2 rounded-full hover:bg-white/15 transition-colors"
          >
            <RotateCw className="w-5 h-5" />
          </button>

          <span className="mx-1 h-5 w-px bg-white/20" />

          <button
            type="button"
            onClick={() => setSliding((prev) => !prev)}
            title={sliding ? '暂停幻灯片' : '播放幻灯片'}
            aria-label={sliding ? '暂停幻灯片' : '播放幻灯片'}
            className={`p-2 rounded-full transition-colors ${sliding ? 'bg-white/25' : 'hover:bg-white/15'}`}
          >
            {sliding ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>
          <button
            type="button"
            onClick={() => setShowInfo((prev) => !prev)}
            title="文件信息 (I)"
            aria-label="文件信息"
            className={`p-2 rounded-full transition-colors ${showInfo ? 'bg-white/25' : 'hover:bg-white/15'}`}
          >
            <Info className="w-5 h-5" />
          </button>
        </div>

        <div className="text-[11px] text-white/45">
          滚轮缩放 · 双击适应/100% · ← → 切换 · Esc 退出
        </div>
      </div>

      {/* ============ 文件信息面板 ============ */}
      {showInfo && (
        <aside
          className="absolute top-16 right-4 w-72 max-h-[70vh] overflow-y-auto rounded-xl bg-black/70 backdrop-blur-md text-white/90 text-xs shadow-2xl"
          onClick={stopClick}
          onDoubleClick={stopClick}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <span className="text-sm font-medium">文件信息</span>
            <button
              type="button"
              onClick={() => setShowInfo(false)}
              aria-label="关闭信息面板"
              className="p-1 rounded-full hover:bg-white/15 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <dl className="px-4 py-3 space-y-2">
            <div>
              <dt className="text-white/45">文件名</dt>
              <dd className="break-all">{current.filename}</dd>
            </div>
            <div>
              <dt className="text-white/45">路径</dt>
              <dd className="break-all">{current.path}</dd>
            </div>
            <div className="flex gap-6">
              <div>
                <dt className="text-white/45">尺寸</dt>
                <dd>{naturalWidth > 0 ? `${naturalWidth} × ${naturalHeight}` : '—'}</dd>
              </div>
              <div>
                <dt className="text-white/45">大小</dt>
                <dd>{formatBytes(current.size)}</dd>
              </div>
            </div>
            <div className="flex gap-6">
              <div>
                <dt className="text-white/45">格式</dt>
                <dd className="uppercase">
                  {current.format || current.filename?.split('.').pop() || '—'}
                </dd>
              </div>
              <div>
                <dt className="text-white/45">序号</dt>
                <dd>{safeIndex + 1} / {total}</dd>
              </div>
            </div>
            <div>
              <dt className="text-white/45">创建时间</dt>
              <dd>{formatDate(current.createdAt || current.created_at)}</dd>
            </div>
            <div>
              <dt className="text-white/45">修改时间</dt>
              <dd>{formatDate(current.modifiedAt || current.modified_at)}</dd>
            </div>
            <div>
              <dt className="text-white/45 mb-1">评分</dt>
              <dd>
                {current.rating > 0
                  ? <RatingStars rating={current.rating} size={14} disabled />
                  : <span className="text-white/40">未评分</span>}
              </dd>
            </div>
          </dl>
        </aside>
      )}
    </div>
  );

  return createPortal(content, document.body);
}

export default ImageViewer;
