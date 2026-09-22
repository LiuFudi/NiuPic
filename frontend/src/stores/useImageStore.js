// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 图片状态管理
 * 简化版：只做向下无限滚动，依赖浏览器原生懒加载管理内存
 */

import { create } from 'zustand';

// ==================== 排序 ====================
// 排序是「跨层级」的偏好：在「全部图片」选好排序，点进任意子文件夹应该继续用同一个排序，
// 而且刷新页面也要记得。所以它独立于 filters（filters 会在切文件夹时被 resetFilters 清掉），
// 并且存在 localStorage 里。
export const SORT_STORAGE_KEY = 'niupic_sort';

export const DEFAULT_SORT = { field: 'created', order: 'desc', seed: 0 };

/** 可选排序字段。field 必须与后端 constants.SORT.FIELDS 的键一致。 */
export const SORT_OPTIONS = [
  { field: 'created',    label: '创建时间',   hint: '文件创建 / 拍摄时间' },
  { field: 'indexed',    label: '添加时间',   hint: '加入图库的时间，刚导入的老照片会排在最前' },
  { field: 'modified',   label: '修改时间',   hint: '文件最后修改时间' },
  { field: 'name',       label: '文件名',     hint: '自然排序，img2 会排在 img10 前面' },
  { field: 'size',       label: '文件大小',   hint: '按字节数' },
  { field: 'resolution', label: '分辨率',     hint: '按总像素（宽 × 高）' },
  { field: 'width',      label: '宽度',       hint: '按图片宽度' },
  { field: 'height',     label: '高度',       hint: '按图片高度' },
  { field: 'aspect',     label: '宽高比',     hint: '宽幅 / 全景图排前面' },
  // 「格式」原本也在这里（jpg / png / webp …），和「文件类型」是一回事，已去掉。
  // 别再加回来：老偏好里如果存着 format，loadSortPref() 会自动退回默认排序。
  { field: 'type',       label: '文件类型',   hint: '图片 / 视频 / 文档 …' },
  { field: 'rating',     label: '评分',       hint: '按星级' },
  { field: 'favorite',   label: '收藏',       hint: '收藏的排前面' },
  { field: 'folder',     label: '所在文件夹', hint: '同一文件夹的图片聚在一起' },
  { field: 'random',     label: '随机',       hint: '打乱顺序，再点一次重新洗牌' },
];

/** 这些字段「大 / 新」在前更符合直觉，切过去时默认用倒序 */
export const SORT_DESC_BY_DEFAULT = [
  'created', 'indexed', 'modified', 'size', 'resolution', 'width', 'height', 'rating', 'favorite'
];

export const defaultOrderFor = (field) =>
  (SORT_DESC_BY_DEFAULT.includes(field) ? 'desc' : 'asc');

/** 读回上次用的排序；解析失败就退回默认值 */
export function loadSortPref() {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SORT };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SORT };

    const known = SORT_OPTIONS.some((o) => o.field === parsed.field);
    // 字段没了（比如「格式」下线了）就连方向一起重置：
    // 原来存的方向是配那个字段的，硬留下来会变成「创建时间 升序」——
    // 用户看到的是最老的照片排在最前面，比退回默认值更莫名其妙
    if (!known) return { ...DEFAULT_SORT };

    return {
      field: parsed.field,
      order: parsed.order === 'asc' || parsed.order === 'desc' ? parsed.order : DEFAULT_SORT.order,
      seed: Number.isFinite(Number(parsed.seed)) ? Math.floor(Number(parsed.seed)) : 0,
    };
  } catch (e) {
    return { ...DEFAULT_SORT };
  }
}

function persistSort(sort) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch (e) {
    // 隐私模式等场景写不进去，忽略即可
  }
}

export const useImageStore = create((set, get) => ({
  // 图片列表
  images: [],
  selectedImage: null,
  selectedImages: [],
  totalImageCount: 0,
  totalSize: 0,  // 素材库总大小（字节）
  
  // 文件夹
  folders: [],
  selectedFolder: null,  // 当前浏览的文件夹路径
  selectedFolderItem: null,  // 选中的文件夹对象（用于显示详情、操作等）
  
  // 搜索和过滤
  searchKeywords: '',
  // 筛选条件（全部在后端 SQL 里生效，前端不再本地筛已加载的那一页）
  //   mode        —— 'include' 命中留下 / 'exclude' 命中剔除
  //   minSize/maxSize —— 文件大小区间，单位**字节**（null = 不限）
  filters: {
    mode: 'include',
    formats: [],
    minSize: null,
    maxSize: null,
    orientations: [],    // ['horizontal', 'vertical', 'square']
    ratings: [],         // [0, 1, 2, 3, 4, 5]
  },
  
  // 排序偏好（跨层级、跨刷新保留，不随 filters 一起重置）
  sort: loadSortPref(),

  // 原始图片列表（用于生成筛选选项，不受筛选影响）
  originalImages: [],
  
  // 加载状态
  imageLoadingState: {
    isLoading: false,
    loadedCount: 0,
    totalCount: 0,
    hasMore: false,
  },
  
  // 重命名状态
  renamingImage: null, // 正在重命名的图片
  
  // 图片操作
  setImages: (images) => set({ images }),
  
  // 设置原始图片（用于筛选选项）
  setOriginalImages: (images) => set({ originalImages: images }),
  
  // 追加图片（向下滚动时）
  appendImages: (newImages) => set((state) => ({
    images: [...state.images, ...newImages],
    originalImages: [...state.originalImages, ...newImages]
  })),
  
  clearImages: () => set({ images: [], originalImages: [] }),
  
  // 选择操作
  setSelectedImage: (image) => set({ selectedImage: image }),
  
  setSelectedImages: (images) => set({ selectedImages: images }),
  
  toggleImageSelection: (image) => set((state) => {
    const isSelected = state.selectedImages.some(img => img.path === image.path);
    return {
      selectedImages: isSelected
        ? state.selectedImages.filter(img => img.path !== image.path)
        : [...state.selectedImages, image]
    };
  }),
  
  clearSelection: () => set({ selectedImages: [], selectedImage: null, selectedFolderItem: null }),
  
  // 文件夹操作
  setFolders: (folders) => set({ folders }),
  
  setSelectedFolder: (folder) => set({ selectedFolder: folder }),
  
  setSelectedFolderItem: (folderItem) => set({ selectedFolderItem: folderItem }),
  
  // 排序
  /**
   * 设置排序。传 { field } 切换字段（方向自动选该字段更符合直觉的默认值），
   * 传 { order } 只改升降序。
   */
  setSort: (partial) => set((state) => {
    const next = { ...state.sort, ...partial };
    // 切换字段时没显式给方向，就套用该字段的默认方向
    if (partial.field && partial.order === undefined) {
      next.order = defaultOrderFor(partial.field);
    }
    // 选「随机」时换一个种子，等于重新洗牌
    if (partial.field === 'random') {
      next.seed = Math.floor(Math.random() * 2147483647);
    }
    persistSort(next);
    return { sort: next };
  }),

  /** 重新洗牌（仅 sort.field === 'random' 时有意义） */
  reshuffle: () => set((state) => {
    const next = { ...state.sort, field: 'random', seed: Math.floor(Math.random() * 2147483647) };
    persistSort(next);
    return { sort: next };
  }),

  toggleSortOrder: () => set((state) => {
    const next = { ...state.sort, order: state.sort.order === 'asc' ? 'desc' : 'asc' };
    persistSort(next);
    return { sort: next };
  }),

  // 搜索和过滤
  setSearchKeywords: (keywords) => set({ searchKeywords: keywords }),
  
  setFilters: (filters) => set((state) => ({ 
    filters: { ...state.filters, ...filters } 
  })),

  // ---------- 筛选动作 ----------
  // 全部收敛到这几个 action 里：面板、快捷键、以后别的地方都调同一份，
  // 避免"button 里算一遍、别处又算一遍"这种两处逻辑不一致的老问题。
  // 注意每次都要造新对象 —— MainContent 监听 filters 变化来重新向后端请求。

  // 筛选模式：'include' 命中留下 / 'exclude' 命中剔除
  setFilterMode: (mode) => set((state) => ({
    filters: { ...state.filters, mode: mode === 'exclude' ? 'exclude' : 'include' }
  })),

  toggleFilterValue: (key, value) => set((state) => {
    const list = state.filters[key] || [];
    const next = list.includes(value)
      ? list.filter((v) => v !== value)
      : [...list, value];
    return { filters: { ...state.filters, [key]: next } };
  }),

  // 一键切换一组值（格式那一栏的「图片 / 视频 / 其他」组头用）：
  // 整组都选中了就整组取消，否则整组补上。
  toggleFilterValues: (key, values = []) => set((state) => {
    const list = state.filters[key] || [];
    const allIn = values.length > 0 && values.every((v) => list.includes(v));
    const next = allIn
      ? list.filter((v) => !values.includes(v))
      : [...list, ...values.filter((v) => !list.includes(v))];
    return { filters: { ...state.filters, [key]: next } };
  }),

  // 文件大小：区间（两个把手），单位字节。null = 这一端不限。
  // 挡位表在后端 constants.SIZE_BRACKETS（唯一定义处），前端把两个把手所在的挡位
  // 翻译成 minSize / maxSize 两个搜索参数（两端都放开就是 null / null = 不限）。
  setSizeRange: ({ minSize = null, maxSize = null } = {}) => set((state) => ({
    filters: {
      ...state.filters,
      minSize: Number.isFinite(minSize) ? minSize : null,
      maxSize: Number.isFinite(maxSize) ? maxSize : null,
    }
  })),

  // 清空具体条件（模式也回到默认：排除了半天什么都没选，视图却还挂着"排除"没有意义）
  clearFilters: () => set((state) => ({
    filters: {
      ...state.filters,
      mode: 'include',
      formats: [],
      minSize: null,
      maxSize: null,
      orientations: [],
      ratings: [],
    }
  })),
  
  resetFilters: () => set({
    searchKeywords: '',
    filters: {
      mode: 'include',
      formats: [],
      minSize: null,
      maxSize: null,
      orientations: [],
      ratings: []
    }
  }),
  
  // 统计
  setTotalImageCount: (count) => set({ totalImageCount: count }),
  setTotalSize: (size) => set({ totalSize: size }),
  
  // 加载状态
  setImageLoadingState: (state) => set((prev) => ({
    imageLoadingState: { ...prev.imageLoadingState, ...state }
  })),
  
  // 重命名操作
  setRenamingImage: (image) => set({ renamingImage: image }),
  
  // 更新图片信息（重命名、评分等）
  updateImage: (oldPath, newData) => set((state) => ({
    images: state.images.map(img => 
      img.path === oldPath ? { ...img, ...newData } : img
    ),
    originalImages: state.originalImages.map(img =>
      img.path === oldPath ? { ...img, ...newData } : img
    ),
    selectedImage: state.selectedImage?.path === oldPath 
      ? { ...state.selectedImage, ...newData } 
      : state.selectedImage
  }))
}));
