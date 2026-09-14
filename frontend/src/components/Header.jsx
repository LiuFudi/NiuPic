import { useState, useEffect, useMemo, useRef } from 'react';
import { Sun, Moon, Search, Filter, Sliders, RefreshCw, Star, ArrowUpDown, ArrowUp, ArrowDown, Shuffle, Palette } from 'lucide-react';
import { useLibraryStore } from '../stores/useLibraryStore';
import { useImageStore, SORT_OPTIONS } from '../stores/useImageStore';
import { useUIStore } from '../stores/useUIStore';
import { useScanStore } from '../stores/useScanStore';
import { useTheme } from '../hooks/useTheme';
import ThemeColorPicker from './ThemeColorPicker';
import { libraryAPI, scanAPI, watchAPI } from '../api';
import { createLogger } from '../utils/logger';

const logger = createLogger('Header');

function Header() {
  const { currentLibraryId } = useLibraryStore();
  const {
    searchKeywords, originalImages, selectedFolder, setSearchKeywords,
    filters, setFilters, resetFilters,
    sort, setSort, toggleSortOrder, reshuffle,
  } = useImageStore();
  const { thumbnailHeight, setThumbnailHeight, mobileView } = useUIStore();
  const { theme, toggleTheme, accentColor } = useTheme();
  
  const [showFilters, setShowFilters] = useState(false);
  const [showSort, setShowSort] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [showMobileSettings, setShowMobileSettings] = useState(false);
  const [localSearchValue, setLocalSearchValue] = useState(searchKeywords);
  const searchDebounceRef = useRef(null);
  
  // 从全局 store 获取筛选状态
  const selectedFormats = filters.formats || [];
  const selectedSizes = filters.sizes || [];
  const selectedOrientations = filters.orientations || [];
  const selectedRatings = filters.ratings || [];

  // 检测移动端
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // 监听文件夹变化，自动清空筛选
  useEffect(() => {
    resetFilters();
  }, [selectedFolder, resetFilters]);

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

  // 智能计算文件大小范围
  const calculateSizeRanges = (sizes) => {
    if (sizes.length === 0) return [];
    
    const sorted = [...sizes].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    
    if (max - min < 10) {
      return [formatSizeRange(min, max)];
    }
    
    const rangeCount = 5;
    const ranges = [];
    const logMin = Math.log10(min || 1);
    const logMax = Math.log10(max);
    const logStep = (logMax - logMin) / rangeCount;
    
    for (let i = 0; i < rangeCount; i++) {
      const rangeStart = Math.pow(10, logMin + i * logStep);
      const rangeEnd = Math.pow(10, logMin + (i + 1) * logStep);
      const hasImages = sorted.some(size => size >= rangeStart && size < rangeEnd);
      
      if (hasImages || i === rangeCount - 1) {
        ranges.push(formatSizeRange(rangeStart, rangeEnd, i === rangeCount - 1));
      }
    }
    
    return ranges.filter(r => r);
  };

  // 格式化大小范围
  const formatSizeRange = (start, end, isLast = false) => {
    const formatSize = (kb) => {
      const roundToFriendly = (num) => {
        if (num < 10) return Math.round(num);
        if (num < 100) return Math.round(num / 5) * 5;
        if (num < 1000) return Math.round(num / 10) * 10;
        return Math.round(num / 50) * 50;
      };
      
      if (kb < 1) return `${roundToFriendly(kb * 1024)}B`;
      if (kb < 1024) return `${roundToFriendly(kb)}KB`;
      if (kb < 1024 * 1024) return `${roundToFriendly(kb / 1024)}MB`;
      return `${roundToFriendly(kb / (1024 * 1024))}GB`;
    };
    
    return isLast ? `> ${formatSize(start)}` : `${formatSize(start)} - ${formatSize(end)}`;
  };

  // 解析大小字符串
  const parseSizeToKB = (sizeStr) => {
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)(B|KB|MB|GB)$/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2];
    switch (unit) {
      case 'B': return value / 1024;
      case 'KB': return value;
      case 'MB': return value * 1024;
      case 'GB': return value * 1024 * 1024;
      default: return 0;
    }
  };

  // 匹配大小范围
  const matchSizeRange = (sizeKB, range) => {
    if (range.startsWith('>')) {
      const minStr = range.substring(1).trim();
      const minKB = parseSizeToKB(minStr);
      return sizeKB >= minKB;
    } else if (range.includes(' - ')) {
      const [minStr, maxStr] = range.split(' - ').map(s => s.trim());
      const minKB = parseSizeToKB(minStr);
      const maxKB = parseSizeToKB(maxStr);
      return sizeKB >= minKB && sizeKB < maxKB;
    }
    return false;
  };

  // 分析原始图片列表，生成可选项（基于 originalImages，不受筛选影响）
  const filterOptions = useMemo(() => {
    if (originalImages.length === 0) {
      return { formats: [], sizes: [], hasHorizontal: false, hasVertical: false, hasSquare: false, ratings: [] };
    }

    const formats = new Set();
    const sizes = [];
    const ratings = new Set();
    let hasHorizontal = false;
    let hasVertical = false;
    let hasSquare = false;

    originalImages.forEach(img => {
      // 格式
      if (img.format) {
        formats.add(img.format.toLowerCase());
      }
      // 文件大小
      sizes.push(img.size / 1024);
      
      // 方向检测
      const aspectRatio = img.width / img.height;
      if (aspectRatio > 1.05) {
        hasHorizontal = true;  // 横图
      } else if (aspectRatio < 0.95) {
        hasVertical = true;    // 竖图
      } else {
        hasSquare = true;      // 方图（宽高比在0.95-1.05之间）
      }
      
      // 评分统计
      const rating = img.rating || 0;
      ratings.add(rating);
    });

    // 计算文件大小范围
    const sizeRanges = calculateSizeRanges(sizes);

    return {
      formats: Array.from(formats).sort(),
      sizes: sizeRanges,
      hasHorizontal,
      hasVertical,
      hasSquare,
      ratings: Array.from(ratings).sort((a, b) => b - a)  // 评分降序排列
    };
  }, [originalImages]);

  // 切换选项 - 同步到全局 store
  const toggleFormat = (format) => {
    const newFormats = selectedFormats.includes(format) 
      ? selectedFormats.filter(f => f !== format) 
      : [...selectedFormats, format];
    setFilters({ formats: newFormats });
  };

  const toggleSize = (size) => {
    const newSizes = selectedSizes.includes(size) 
      ? selectedSizes.filter(s => s !== size) 
      : [...selectedSizes, size];
    setFilters({ sizes: newSizes });
  };

  const toggleOrientation = (orientation) => {
    const newOrientations = selectedOrientations.includes(orientation)
      ? selectedOrientations.filter(o => o !== orientation)
      : [...selectedOrientations, orientation];
    setFilters({ orientations: newOrientations });
  };

  const toggleRating = (rating) => {
    const newRatings = selectedRatings.includes(rating)
      ? selectedRatings.filter(r => r !== rating)
      : [...selectedRatings, rating];
    setFilters({ ratings: newRatings });
  };

  // ==================== 排序 ====================
  const currentSortOption = SORT_OPTIONS.find((o) => o.field === sort.field) || SORT_OPTIONS[0];
  const sortOrderLabel = sort.order === 'asc' ? '升序' : '降序';

  /**
   * 点排序选项：
   *   点没选中的 → 切过去（方向用该字段更符合直觉的默认值）
   *   点已选中的 → 再点一次换方向；「随机」则是重新洗牌
   */
  const handlePickSort = (field) => {
    if (field === sort.field) {
      if (field === 'random') reshuffle();
      else toggleSortOrder();
      return;
    }
    setSort({ field });
  };

  // 清除筛选
  const clearFilters = () => {
    setFilters({ formats: [], sizes: [], orientations: [], ratings: [] });
  };

  const handleThumbnailHeightChange = async (height) => {
    setThumbnailHeight(height);
    try {
      await libraryAPI.updatePreferences({ thumbnailHeight: height });
    } catch (error) {
      console.error('Error saving preferences:', error);
    }
  };

  const handleRefresh = async () => {
    if (!currentLibraryId || isRefreshing) return;
    
    setIsRefreshing(true);
    try {
      await scanAPI.sync(currentLibraryId);
      // Socket.IO 会触发更新
    } catch (error) {
      console.error('Error refreshing:', error);
      alert('刷新失败: ' + error.message);
    } finally {
      setIsRefreshing(false);
    }
  };

  // 从 filterOptions 中提取可用选项
  const availableFormats = filterOptions.formats;
  const availableSizes = filterOptions.sizes.map(size => ({ label: size }));
  const availableOrientations = [
    { value: 'horizontal', label: '横图' },
    { value: 'vertical', label: '竖图' },
    { value: 'square', label: '方图' }
  ].filter(o => 
    (o.value === 'horizontal' && filterOptions.hasHorizontal) ||
    (o.value === 'vertical' && filterOptions.hasVertical) ||
    (o.value === 'square' && filterOptions.hasSquare)
  );
  const availableRatings = filterOptions.ratings;

  // 移动端布局
  if (isMobile) {
    // 文件夹视图不显示搜索和筛选
    const showSearch = mobileView !== 'sidebar';
    
    return (
      <header className="flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        {/* 顶部栏 */}
        <div className="h-14 flex items-center justify-between px-4">
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">牛图 NiuPic</h1>
          
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={!currentLibraryId || isRefreshing}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-5 h-5 text-gray-700 dark:text-gray-300 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            
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
                onClick={() => { setShowFilters(!showFilters); setShowSort(false); }}
                className={`p-2 border rounded-lg ${
                  selectedFormats.length > 0 || selectedSizes.length > 0 || selectedOrientations.length > 0 || selectedRatings.length > 0
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/20'
                    : 'border-gray-300 dark:border-gray-600'
                }`}
              >
                <Filter className={`w-5 h-5 ${
                  selectedFormats.length > 0 || selectedSizes.length > 0 || selectedOrientations.length > 0 || selectedRatings.length > 0
                    ? 'text-blue-600 dark:text-blue-300'
                    : 'text-gray-600 dark:text-gray-400'
                }`} />
              </button>
              <button
                onClick={() => { setShowSort(!showSort); setShowFilters(false); }}
                className={`p-2 border rounded-lg ${
                  showSort ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/20' : 'border-gray-300 dark:border-gray-600'
                }`}
                title={`排序：${currentSortOption.label}（${sortOrderLabel}）`}
              >
                <ArrowUpDown className={`w-5 h-5 ${
                  showSort ? 'text-blue-600 dark:text-blue-300' : 'text-gray-600 dark:text-gray-400'
                }`} />
              </button>
            </div>
          </div>
        )}

        {/* 排序面板（移动端） */}
        {showSearch && showSort && renderSortPanel('px-4 pb-3')}
        
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

              {/* 主题色 */}
              <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
                <ThemeColorPicker />
              </div>
            </div>
          </div>
        )}
        
        {/* 筛选面板（仅在图片和详情视图显示） */}
        {showSearch && showFilters && (
          <div className="px-4 pb-3 border-t border-gray-200 dark:border-gray-700 pt-3">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">筛选条件</span>
              <button
                onClick={clearFilters}
                className="text-xs text-blue-500"
              >
                清除全部
              </button>
            </div>
            
            {/* 格式筛选 */}
            <div className="mb-3">
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">格式</div>
              <div className="flex flex-wrap gap-2">
                {availableFormats.map(format => (
                  <button
                    key={format}
                    onClick={() => toggleFormat(format)}
                    className={`px-3 py-1 text-xs rounded-full ${
                      selectedFormats.includes(format)
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            
            {/* 尺寸筛选 */}
            <div className="mb-3">
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">尺寸</div>
              <div className="flex flex-wrap gap-2">
                {availableSizes.map(size => (
                  <button
                    key={size.label}
                    onClick={() => toggleSize(size.label)}
                    className={`px-3 py-1 text-xs rounded-full ${
                      selectedSizes.includes(size.label)
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {size.label}
                  </button>
                ))}
              </div>
            </div>
            
            {/* 方向筛选 */}
            <div className="mb-3">
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">方向</div>
              <div className="flex flex-wrap gap-2">
                {availableOrientations.map(orientation => (
                  <button
                    key={orientation.value}
                    onClick={() => toggleOrientation(orientation.value)}
                    className={`px-3 py-1 text-xs rounded-full ${
                      selectedOrientations.includes(orientation.value)
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {orientation.label}
                  </button>
                ))}
              </div>
            </div>
            
            {/* 评分筛选 */}
            {availableRatings.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">评分</div>
                <div className="flex flex-wrap gap-2">
                  {[5, 4, 3, 2, 1, 0].filter(r => availableRatings.includes(r)).map(rating => (
                    <button
                      key={rating}
                      onClick={() => toggleRating(rating)}
                      className={`px-2 py-1 text-xs rounded-full flex items-center gap-1 ${
                        selectedRatings.includes(rating)
                          ? 'bg-blue-500 text-white'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {rating > 0 ? (
                        <>
                          {[...Array(rating)].map((_, i) => (
                            <Star key={i} size={12} className="fill-current" />
                          ))}
                        </>
                      ) : (
                        <span>未评分</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </header>
    );
  }

  /** 排序面板：桌面端和移动端共用同一段 */
  const renderSortPanel = (wrapperClass) => (
    <div className={wrapperClass}>
      <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            排序方式
            <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
              {currentSortOption.hint}
            </span>
          </div>
          <button
            onClick={toggleSortOrder}
            className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600"
            title="切换升序 / 降序"
          >
            {sort.order === 'asc'
              ? <><ArrowUp className="w-3.5 h-3.5" />{sortOrderLabel}</>
              : <><ArrowDown className="w-3.5 h-3.5" />{sortOrderLabel}</>}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {SORT_OPTIONS.map((option) => {
            const active = option.field === sort.field;
            return (
              <button
                key={option.field}
                onClick={() => handlePickSort(option.field)}
                title={option.hint}
                className={`flex items-center gap-1 px-3 py-1 text-xs rounded-full transition-colors ${
                  active
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-500'
                }`}
              >
                {option.field === 'random' && <Shuffle className="w-3 h-3" />}
                {option.label}
                {active && option.field !== 'random' && (
                  sort.order === 'asc'
                    ? <ArrowUp className="w-3 h-3" />
                    : <ArrowDown className="w-3 h-3" />
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-3 text-xs text-gray-400 dark:text-gray-500">
          排序对所有层级生效：首页、全部图片、任意子文件夹都用同一套排序，切换时会记住。
        </div>
      </div>
    </div>
  );

  // 桌面端布局
  return (
    <header className="flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="h-14 flex items-center justify-between px-6">
        <div className="flex-shrink-0">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">牛图 NiuPic</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">轻量快速的图片素材库管理</p>
        </div>
        
        {/* 搜索栏 */}
        <div className="flex-1 max-w-2xl mx-6 flex items-center gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="搜索图片... (多个关键词用空格分隔，即时搜索)"
              value={localSearchValue}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={() => { setShowFilters(!showFilters); setShowSort(false); }}
            className={`relative p-2 border rounded-lg transition-colors ${
              selectedFormats.length > 0 || selectedSizes.length > 0 || selectedOrientations.length > 0 || selectedRatings.length > 0
                ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-500/20 hover:bg-blue-100 dark:hover:bg-blue-500/30'
                : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
            title={
              selectedFormats.length > 0 || selectedSizes.length > 0 || selectedOrientations.length > 0 || selectedRatings.length > 0
                ? '筛选（已启用）'
                : '筛选'
            }
          >
            <Filter className={`w-5 h-5 ${
              selectedFormats.length > 0 || selectedSizes.length > 0 || selectedOrientations.length > 0 || selectedRatings.length > 0
                ? 'text-blue-600 dark:text-blue-300'
                : 'text-gray-600 dark:text-gray-400'
            }`} />
            {(selectedFormats.length > 0 || selectedSizes.length > 0 || selectedOrientations.length > 0 || selectedRatings.length > 0) && (
              <span 
                className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full" 
                style={{ backgroundColor: 'rgb(var(--accent-500))' }}
              ></span>
            )}
          </button>

          {/* 排序 */}
          <button
            onClick={() => { setShowSort(!showSort); setShowFilters(false); }}
            className={`flex items-center gap-2 px-3 py-2 border rounded-lg transition-colors whitespace-nowrap ${
              showSort
                ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-500/20'
                : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
            title={`排序：${currentSortOption.label}（${sortOrderLabel}）`}
          >
            <ArrowUpDown className={`w-5 h-5 ${
              showSort ? 'text-blue-600 dark:text-blue-300' : 'text-gray-600 dark:text-gray-400'
            }`} />
            <span className="text-sm text-gray-700 dark:text-gray-200">{currentSortOption.label}</span>
            {sort.order === 'asc'
              ? <ArrowUp className="w-3.5 h-3.5 text-gray-500" />
              : <ArrowDown className="w-3.5 h-3.5 text-gray-500" />}
          </button>
        </div>

        {/* 缩略图大小滑块 */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <Sliders className="w-4 h-4 text-gray-500" />
          <input
            type="range"
            min="150"
            max="300"
            value={thumbnailHeight}
            onChange={(e) => handleThumbnailHeightChange(parseInt(e.target.value))}
            className="w-32"
          />
          <span className="text-sm text-gray-600 dark:text-gray-400 w-12">{thumbnailHeight}px</span>
          
          <button
            onClick={handleRefresh}
            disabled={!currentLibraryId || isRefreshing}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ml-2"
            title="手动刷新素材库（文件监控已自动启用）"
          >
            <RefreshCw className={`w-5 h-5 text-gray-700 dark:text-gray-300 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          
          <button
            onClick={() => {
              setShowColorPicker(!showColorPicker);
              setShowSort(false);
              setShowFilters(false);
            }}
            className={`p-2 rounded-lg transition-colors ${
              showColorPicker
                ? 'bg-gray-100 dark:bg-gray-700'
                : 'hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
            title="主题色"
            data-testid="theme-color-button"
          >
            {accentColor ? (
              // 换过主题色就用当前颜色画图标，一眼能看出现在的主题色
              <Palette className="w-5 h-5" style={{ color: accentColor }} />
            ) : (
              <Palette className="w-5 h-5 text-gray-700 dark:text-gray-300" />
            )}
          </button>

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

      {/* 排序面板（桌面端）—— 必须放在 h-14 工具栏之外，否则会被固定高度裁掉 */}
      {showSort && renderSortPanel('px-6 pb-3')}

      {/* 主题色面板（桌面端）—— 同样必须在 h-14 工具栏之外 */}
      {showColorPicker && (
        <div className="px-6 pb-3">
          <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <ThemeColorPicker />
          </div>
        </div>
      )}

      {/* 筛选面板 */}
      {showFilters && (
        <div className="px-6 pb-3">
          <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-gray-700 dark:text-gray-300">筛选条件</div>
              <button
                onClick={clearFilters}
                className="text-xs text-blue-500 hover:text-blue-600 dark:hover:text-blue-400"
              >
                清除全部
              </button>
            </div>

            {/* 四列布局 */}
            <div className="grid grid-cols-4 gap-4">
              {/* 格式筛选 */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">格式</label>
                <div className="flex flex-col gap-1.5">
                  {filterOptions.formats.length > 0 ? (
                    filterOptions.formats.map(format => (
                      <button
                        key={format}
                        onClick={() => toggleFormat(format)}
                        className={`px-3 py-1.5 text-xs rounded transition-colors text-left ${
                          selectedFormats.includes(format)
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500'
                        }`}
                      >
                        {format.toUpperCase()}
                      </button>
                    ))
                  ) : (
                    <span className="text-xs text-gray-400 py-2">暂无格式数据</span>
                  )}
                </div>
              </div>

              {/* 文件大小筛选 */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">文件大小</label>
                <div className="flex flex-col gap-1.5">
                  {filterOptions.sizes.length > 0 ? (
                    filterOptions.sizes.map(size => (
                      <button
                        key={size}
                        onClick={() => toggleSize(size)}
                        className={`px-3 py-1.5 text-xs rounded transition-colors text-left ${
                          selectedSizes.includes(size)
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500'
                        }`}
                      >
                        {size}
                      </button>
                    ))
                  ) : (
                    <span className="text-xs text-gray-400 py-2">暂无大小数据</span>
                  )}
                </div>
              </div>

              {/* 图片方向筛选 */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">图片方向</label>
                <div className="flex flex-col gap-1.5">
                  {availableOrientations.length > 0 ? (
                    availableOrientations.map(orientation => (
                      <button
                        key={orientation.value}
                        onClick={() => toggleOrientation(orientation.value)}
                        className={`px-3 py-1.5 text-xs rounded transition-colors text-left ${
                          selectedOrientations.includes(orientation.value)
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500'
                        }`}
                      >
                        {orientation.label}
                      </button>
                    ))
                  ) : (
                    <span className="text-xs text-gray-400 py-2">暂无方向数据</span>
                  )}
                </div>
              </div>

              {/* 评分筛选 */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">评分</label>
                <div className="flex flex-col gap-1.5">
                  {availableRatings.length > 0 ? (
                    [5, 4, 3, 2, 1, 0].filter(r => availableRatings.includes(r)).map(rating => (
                      <button
                        key={rating}
                        onClick={() => toggleRating(rating)}
                        className={`px-3 py-1.5 text-xs rounded transition-colors text-left flex items-center gap-1.5 ${
                          selectedRatings.includes(rating)
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500'
                        }`}
                      >
                        {rating > 0 ? (
                          <>
                            {[...Array(rating)].map((_, i) => (
                              <Star key={i} size={14} className="fill-current" />
                            ))}
                          </>
                        ) : (
                          <span>未评分</span>
                        )}
                      </button>
                    ))
                  ) : (
                    <span className="text-xs text-gray-400 py-2">暂无评分数据</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

export default Header;
