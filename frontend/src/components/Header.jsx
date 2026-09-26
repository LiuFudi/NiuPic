// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

import { useState, useEffect, useMemo, useRef } from 'react';
import { Sun, Moon, Search, Filter, Sliders, RefreshCw, ArrowUpDown, ArrowUp, ArrowDown, Palette, Heart } from 'lucide-react';
import { useLibraryStore } from '../stores/useLibraryStore';
import { useImageStore, SORT_OPTIONS } from '../stores/useImageStore';
import { useUIStore } from '../stores/useUIStore';
import DonateDialog, { DonateButton } from './DonateDialog';
import { useScanStore } from '../stores/useScanStore';
import { useTheme } from '../hooks/useTheme';
import ThemeColorPicker from './ThemeColorPicker';
import ScanMenu from './ScanMenu';
import FilterSortPanel from './FilterSortPanel';
import LayoutSettings from './LayoutSettings';
import ThumbnailSizePopover from './ThumbnailSizePopover';
import { libraryAPI, scanAPI, watchAPI } from '../api';
import { countActiveFilters, filterModeLabel } from '../utils/filters';
import { createLogger } from '../utils/logger';

const logger = createLogger('Header');

function Header() {
  const { currentLibraryId } = useLibraryStore();
  const {
    searchKeywords, selectedFolder, setSearchKeywords,
    filters, resetFilters,
    sort,
  } = useImageStore();
  const { thumbnailHeight, setThumbnailHeight, mobileView } = useUIStore();
  const { theme, toggleTheme, accentColor } = useTheme();
  
  // 筛选 + 排序 / 主题色：卡片本身画在**图片区**里（见 App.jsx），
  // 这里只负责开合。画在顶栏里的话，卡片一展开整个内容行都被压矮，
  // 左右两个侧栏也跟着变短 —— 用户要的是"只挤图片区"。
  const activePanel = useUIStore((st) => st.activePanel);
  const togglePanel = useUIStore((st) => st.togglePanel);
  const showPanel = activePanel === 'filter';
  const showColorPicker = activePanel === 'theme';
  const [isMobile, setIsMobile] = useState(false);
  const [showMobileSettings, setShowMobileSettings] = useState(false);
  const [localSearchValue, setLocalSearchValue] = useState(searchKeywords);
  // 打赏弹窗：只有用户点了入口才会打开（规范 3.2「绝不自动弹出」）
  const [showDonate, setShowDonate] = useState(false);
  const searchDebounceRef = useRef(null);
  
  // 筛选/排序按钮上要显示的读数
  const activeFilterCount = countActiveFilters(filters);
  const filterMode = filterModeLabel(filters);
  const currentSortOption = SORT_OPTIONS.find((o) => o.field === sort.field) || SORT_OPTIONS[0];
  const sortOrderLabel = sort.order === 'asc' ? '升序' : '降序';

  // 检测移动端
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // 切文件夹或**切素材库**都要清空筛选和搜索词
  //
  // 为什么必须带上 currentLibraryId：筛选条件（格式/大小/方向/评分）和搜索词都是
  // "上一个库"的语境。切库之后如果不清，新库会被旧条件筛一遍 ——
  // 用户在 A 库选了"只看 jpg"，切到全是 png 的 B 库，就只会看到"暂无图片"；
  // 点一下文件夹（触发这条 effect）或者刷新页面（筛选不持久化）又好了 ——
  // 这个"切库后短暂显示、然后空库"的怪现象就是这么来的。
  useEffect(() => {
    resetFilters();
  }, [currentLibraryId, selectedFolder, resetFilters]);

  // 🎯 内存优化：禁用前端启动 chokidar 文件监控
  // 后端已经使用轻量级监控器（智能轮询），不需要前端启动
  // 如果需要手动启动 chokidar，可以取消注释下面的代码
  /*
  useEffect(() => {
    if (!currentLibraryId) return;

    // 启动文件监控
    watchAPI.start(currentLibraryId)
      .catch(error => {
        console.error('启动文件监控失败:', error);
      });

    // 清理：关闭监控
    return () => {
      watchAPI.stop(currentLibraryId).catch(err => console.error('Stop watch error:', err));
    };
  }, [currentLibraryId]);
  */

  // 防抖搜索（300ms 延迟，减少请求频率）
  const handleSearchChange = (value) => {
    setLocalSearchValue(value);
    
    // 清除之前的定时器
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }
    
    // 300ms 后触发实际搜索
    searchDebounceRef.current = setTimeout(() => {
      setSearchKeywords(value);
    }, 300);
  };

  // 同步外部 searchKeywords 变化
  useEffect(() => {
    setLocalSearchValue(searchKeywords);
  }, [searchKeywords]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, []);

  const handleThumbnailHeightChange = async (height) => {
    setThumbnailHeight(height);
    try {
      await libraryAPI.updatePreferences({ thumbnailHeight: height });
    } catch (error) {
      console.error('Error saving preferences:', error);
    }
  };


  // 移动端布局
  if (isMobile) {
    // 文件夹视图不显示搜索和筛选
    const showSearch = mobileView !== 'sidebar';
    
    return (
      <header className="flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        {/* 顶部栏 */}
        <div className="h-14 flex items-center justify-between px-4">
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">NiuPic</h1>
          
          <div className="flex items-center gap-2">
            <ScanMenu libraryId={currentLibraryId} />
            
            <button
              onClick={() => setShowMobileSettings(!showMobileSettings)}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="设置（含主题色）"
            >
              <Sliders className="w-5 h-5 text-gray-700 dark:text-gray-300" />
            </button>
            
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              {theme === 'light' ? (
                <Moon className="w-5 h-5 text-gray-700 dark:text-gray-300" />
              ) : (
                <Sun className="w-5 h-5 text-gray-700 dark:text-gray-300" />
              )}
            </button>
          </div>
        </div>
        
        {/* 搜索栏（仅在图片和详情视图显示） */}
        {showSearch && (
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  placeholder="搜索图片..."
                  value={searchKeywords}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm"
                />
              </div>
              <button
                onClick={() => togglePanel('filter')}
                data-testid="filter-sort-button"
                title={`${filterMode}${activeFilterCount > 0 ? `（${activeFilterCount} 项）` : ''} · 排序：${currentSortOption.label}（${sortOrderLabel}）· 主题色`}
                className={`relative flex items-center gap-1 px-2 py-2 border rounded-lg transition-colors ${
                  showPanel || activeFilterCount > 0
                    ? 'border-gray-400 dark:border-gray-400 bg-gray-100 dark:bg-gray-700'
                    : 'border-gray-300 dark:border-gray-600'
                }`}
              >
                <Filter className="w-5 h-5 text-gray-700 dark:text-gray-300" />
                <ArrowUpDown className="w-5 h-5 text-gray-700 dark:text-gray-300" />
                <Palette
                  className="w-5 h-5"
                  style={accentColor ? { color: accentColor } : undefined}
                />
                {activeFilterCount > 0 && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] leading-4 text-white text-center"
                    style={{ backgroundColor: 'rgb(var(--accent-500))' }}
                  >
                    {activeFilterCount}
                  </span>
                )}
              </button>

              {/* 打赏入口：搜索栏右侧（《打赏功能规范》第六节）。 */}
              <DonateButton onClick={() => setShowDonate(true)} />
            </div>
          </div>
        )}

        <DonateDialog isOpen={showDonate} onClose={() => setShowDonate(false)} />

        {/* 排序面板（移动端） */}

        {/* 移动端设置面板 */}
        {showMobileSettings && (
          <div className="px-4 pb-3 border-t border-gray-200 dark:border-gray-700 pt-3">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700 dark:text-gray-300">缩略图大小</span>
                <span className="text-sm text-gray-500 dark:text-gray-400">{thumbnailHeight}px</span>
              </div>
              <input
                type="range"
                min="150"
                max="300"
                value={thumbnailHeight}
                onChange={(e) => handleThumbnailHeightChange(parseInt(e.target.value))}
                className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, rgb(var(--accent-500)) 0%, rgb(var(--accent-500)) ${((thumbnailHeight - 150) / 150) * 100}%, #e5e7eb ${((thumbnailHeight - 150) / 150) * 100}%, #e5e7eb 100%)`
                }}
              />

              {/* 布局：行间距 / 按文件夹分隔 */}
              <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
                <LayoutSettings inline />
              </div>

              {/* 主题色 */}
              <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
                <ThemeColorPicker />
              </div>
            </div>
          </div>
        )}
        
        {/* 手机端没有侧栏，卡片仍然跟在搜索栏下面 */}
        {showSearch && showPanel && <FilterSortPanel className="px-4 pb-3" />}
      </header>
    );
  }

  // 桌面端布局
  return (
    <header className="flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      {/* 三段式：左（标题）/ 中（筛选按钮 + 搜索框，居中）/ 右（缩略图、布局、扫描、主题色）
          左右两段都 flex-1，所以中间那段是**顶栏正中**，而不是"标题右边剩下的地方"。 */}
      <div className="h-14 flex items-center gap-4 px-6">
        {/* 左：logo。**不加 min-w-0** —— flex 项的默认最小宽度就是内容宽度，
            所以它不会被压到文字宽度以下（上一版加了 min-w-0，结果被中间抢走了空间）。 */}
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white whitespace-nowrap">NiuPic</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap hidden 2xl:block">轻量快速的图片素材库管理</p>
        </div>

        {/* 中间：搜索框居中，筛选按钮**挂在它左边**。
            按钮用 absolute right-full 挂在搜索框左侧，这样它不会把搜索框推离中心
            （用 flex 排一排的话，搜索框会往右偏半个按钮宽度，实测偏了 107px）。 */}
        {/* 中段：搜索框。
            flex-1 + **max-w-[28rem]**：宽屏时顶到 28rem（就是最初那个宽度）就停住，多出来的
            空间还给左右两段（所以 logo 不会被撑走）；窄屏时按比例被压缩 —— 先挤搜索框。
            两种写法都试过：只写 flex-1（会长到很宽，挤 logo ✗）、只写 flex-[0_1_28rem]
            （永远 448px 不肯缩，窄屏时把打赏按钮顶到右侧控件上 ✗）。 */}
        <div className="flex-1 max-w-[28rem] min-w-[8rem]">
          <div className="relative w-full">
          {/* 筛选 + 排序：一个按钮开一张卡片（卡片画在图片区里，见 App.jsx） */}
          <button
            onClick={() => togglePanel('filter')}
            data-testid="filter-sort-button"
            className={`absolute top-0 right-full mr-3 flex items-center gap-2 px-3 py-2 border rounded-lg transition-colors whitespace-nowrap ${
              showPanel || activeFilterCount > 0
                ? 'border-gray-400 dark:border-gray-400 bg-gray-100 dark:bg-gray-700'
                : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
            title={`${filterMode}${activeFilterCount > 0 ? `（已启用 ${activeFilterCount} 项）` : ''} · 排序：${currentSortOption.label}（${sortOrderLabel}）· 主题色`}
          >
            <span className="relative flex items-center">
              <Filter className="w-5 h-5 text-gray-700 dark:text-gray-300" />
              {activeFilterCount > 0 && (
                <span
                  className="absolute -top-1.5 -right-1.5 min-w-[14px] h-3.5 px-0.5 rounded-full text-[10px] leading-[14px] text-white text-center"
                  style={{ backgroundColor: 'rgb(var(--accent-500))' }}
                >
                  {activeFilterCount}
                </span>
              )}
            </span>
            {/* 窄屏只留图标：文字在 2xl（≥1536px）才显示，避免顶栏被挤成一团 */}
            <span className="hidden 2xl:inline text-sm text-gray-700 dark:text-gray-200">
              {activeFilterCount > 0 ? `${filterMode} ${activeFilterCount}` : '筛选'}
            </span>
            <span className="hidden 2xl:inline-block w-px h-4 bg-gray-300 dark:bg-gray-600" />
            <ArrowUpDown className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            <span className="hidden 2xl:inline text-sm text-gray-700 dark:text-gray-200">{currentSortOption.label}</span>
            {sort.order === 'asc'
              ? <ArrowUp className="w-3.5 h-3.5 text-gray-500" />
              : <ArrowDown className="w-3.5 h-3.5 text-gray-500" />}
            {/* 主题色也在这张卡片里，按钮上写出来，用户才知道去哪儿换色 */}
            <span className="hidden 2xl:inline-block w-px h-4 bg-gray-300 dark:bg-gray-600" />
            <Palette
              className="w-4 h-4"
              style={accentColor ? { color: accentColor } : undefined}
            />
            <span className="hidden 2xl:inline text-sm text-gray-700 dark:text-gray-200">主题色</span>
          </button>

          <div className="relative w-full">
            {/* 打赏入口：挂在搜索框**右侧**（筛选按钮在左侧，左右各一个，搜索框仍然居中）。
                同样用 absolute 定位，否则它会把搜索框往左推半个按钮宽度。 */}
            <div className="absolute top-0 left-full ml-3">
              <DonateButton onClick={() => setShowDonate(true)} />
            </div>
            <Search className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="搜索图片... (多个关键词用空格分隔)"
              value={localSearchValue}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          </div>
        </div>

        {/* 右侧：其他功能 */}
        <div className="flex-1 flex items-center justify-end gap-2">
          {/* 缩略图大小：点图标弹出滑块（原来是常驻的滑块 + 数值，宽度一紧就挤爆顶栏） */}
          <ThumbnailSizePopover value={thumbnailHeight} onChange={handleThumbnailHeightChange} />

          <LayoutSettings className="ml-2" />

          <ScanMenu libraryId={currentLibraryId} className="ml-2" />
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title={theme === 'light' ? '切换到暗色模式' : '切换到亮色模式'}
          >
            {theme === 'light' ? (
              <Moon className="w-5 h-5 text-gray-700 dark:text-gray-300" />
            ) : (
              <Sun className="w-5 h-5 text-gray-700 dark:text-gray-300" />
            )}
          </button>
        </div>
      </div>

      <DonateDialog isOpen={showDonate} onClose={() => setShowDonate(false)} />

      {/* 桌面端的筛选/主题色卡片不在这里 —— 它们画在中间图片区（App.jsx），
          这样卡片只挤图片区，左右侧栏高度不受影响。 */}
    </header>
  );
}

export default Header;
