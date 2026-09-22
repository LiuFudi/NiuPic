// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

import { useState, useEffect, useMemo } from 'react';
import { Star, ArrowUp, ArrowDown, Shuffle, X } from 'lucide-react';
import { useLibraryStore } from '../stores/useLibraryStore';
import { useImageStore, SORT_OPTIONS } from '../stores/useImageStore';
import { imageAPI } from '../api';
import { countActiveFilters, findSizeRangeIndexes, shortBracketLabel, sumBracketCounts } from '../utils/filters';
import { createLogger } from '../utils/logger';
import ThemeColorPicker from './ThemeColorPicker';
import DualRangeSlider from './DualRangeSlider';

const logger = createLogger('FilterSortPanel');

const ORIENTATION_LABELS = {
  horizontal: '横图',
  vertical: '竖图',
  square: '方图',
};

// 格式按类别分组显示，顺序就是用户要的：图片 → 视频 → 其他
const KIND_GROUPS = [
  { kind: 'image', label: '图片' },
  { kind: 'video', label: '视频' },
  { kind: 'other', label: '其他' },
];

const kindOf = (kind) => (kind === 'image' || kind === 'video' ? kind : 'other');

/**
 * 筛选 + 排序卡片（桌面端画在图片区里，手机端跟在搜索栏下面）
 *
 * 版式分上下两块，**排序置顶**、筛选在下，中间一条分隔线：
 *   排序和筛选回答的是同一个问题（看到哪些图、按什么顺序），所以放同一张卡片；
 *   但它们是两件事，混在一起排会让人找不到"排序在哪"。
 *
 * 选项全部来自后端 /api/image/filter-options：
 *   · 格式只列出**当前文件夹里真实存在**的，带条数，按 图片 → 视频 → 其他 分组
 *   · 大小是区间双把手（挡位表在 constants.SIZE_BRACKETS，前端只负责画）
 *
 * horizontal（桌面端）：筛选条件和主题色**横向排开**，主题色是右边一栏
 *   （手机端传 false，保持上下排 —— 窄屏上横排挤不下）
 */
export default function FilterSortPanel({ className = '', horizontal = false }) {
  const { currentLibraryId } = useLibraryStore();
  const {
    selectedFolder, searchKeywords,
    filters, setFilterMode, toggleFilterValue, toggleFilterValues, setSizeRange, clearFilters,
    sort, setSort, toggleSortOrder, reshuffle,
  } = useImageStore();

  const [options, setOptions] = useState(null);
  const [loadingOptions, setLoadingOptions] = useState(false);

  // 当前范围的筛选选项：切文件夹 / 改搜索词都要重新拉
  useEffect(() => {
    if (!currentLibraryId) return undefined;
    let cancelled = false;
    setLoadingOptions(true);

    const params = {};
    if (selectedFolder) params.folder = selectedFolder;
    if (searchKeywords) params.keywords = searchKeywords;

    imageAPI.getFilterOptions(currentLibraryId, params)
      .then((res) => { if (!cancelled) setOptions(res); })
      .catch((error) => {
        if (cancelled) return;
        logger.error('获取筛选选项失败:', error.message);
        setOptions(null);
      })
      .finally(() => { if (!cancelled) setLoadingOptions(false); });

    return () => { cancelled = true; };
  }, [currentLibraryId, selectedFolder, searchKeywords]);

  const currentSortOption = SORT_OPTIONS.find((o) => o.field === sort.field) || SORT_OPTIONS[0];
  const activeCount = countActiveFilters(filters);
  const excluding = filters.mode === 'exclude';

  // 大小区间：两个把手停在后端给的 9 个挡位上，两端 = 不限
  const brackets = useMemo(() => options?.sizeBrackets || [], [options]);
  const rangeIndexes = useMemo(() => findSizeRangeIndexes(brackets, filters), [brackets, filters]);
  const sizeStops = useMemo(
    () => brackets.map((b) => ({ ...b, shortLabel: shortBracketLabel(b.label) })),
    [brackets]
  );
  // 拖动过程中只改本地显示，松手才真正筛（否则每挪一格发一次请求）
  const [draggingRange, setDraggingRange] = useState(null);
  const shownLeft = draggingRange ? draggingRange.left : rangeIndexes.left;
  const shownRight = draggingRange ? draggingRange.right : rangeIndexes.right;
  const activeRangeCount = useMemo(
    () => sumBracketCounts(sizeStops, shownLeft, shownRight),
    [sizeStops, shownLeft, shownRight]
  );
  const isFullRange = shownLeft === 0 && shownRight === sizeStops.length - 1;

  const commitSizeRange = ({ left, right }) => {
    const leftStop = sizeStops[left];
    const rightStop = sizeStops[right];
    setSizeRange({
      minSize: leftStop && leftStop.minSize != null ? leftStop.minSize : null,
      maxSize: rightStop && rightStop.maxSize != null ? rightStop.maxSize : null,
    });
    setDraggingRange(null);
  };

  const handlePickSort = (field) => {
    if (field === sort.field) {
      if (field === 'random') reshuffle();
      else toggleSortOrder();
      return;
    }
    setSort({ field });
  };

  const formatsByGroup = useMemo(() => {
    const groups = { image: [], video: [], other: [] };
    (options?.formats || []).forEach((f) => groups[kindOf(f.kind)].push(f));
    return groups;
  }, [options]);

  const formatCount = (options?.formats || []).length;
  const availableOrientations = options?.orientations || [];
  // 评分从高到低排，「未评分」放最后
  const availableRatings = (options?.ratings || []).slice().sort((a, b) => b.value - a.value);

  const chipClass = (active) => `px-3 py-1 text-xs rounded-full transition-colors ${
    active
      ? 'text-white'
      : 'bg-gray-100 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-500'
  }`;

  const chipStyle = (active) => (active ? { backgroundColor: 'rgb(var(--accent-500))' } : undefined);

  const sectionTitle = 'text-xs font-medium text-gray-600 dark:text-gray-400 mb-2';

  return (
    <div className={className} data-testid="filter-sort-panel">

      {/* ============ 卡片一：排序（置顶，独立一张） ============
          排序和筛选虽然是一起用的，但它们是两件事：塞进同一张卡片里，
          排序很容易被当成筛选的一部分（上一版就是这么被吐槽的）。
          拆成两张卡之后，排序永远在最上面、永远看得见。 */}
      <div
        className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg w-full max-h-[46vh] overflow-y-auto"
        data-testid="sort-card"
      >
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            排序
            <span className="ml-2 text-xs font-normal text-gray-400 dark:text-gray-500">
              {currentSortOption.hint}
            </span>
          </span>
          <button
            onClick={toggleSortOrder}
            data-testid="sort-order-toggle"
            className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white"
            title="切换升序 / 降序"
          >
            {sort.order === 'asc'
              ? <><ArrowUp className="w-3.5 h-3.5" />升序</>
              : <><ArrowDown className="w-3.5 h-3.5" />降序</>}
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
                data-testid={`sort-${option.field}`}
                className={`flex items-center gap-1 px-3 py-1 text-xs rounded-full transition-colors ${
                  active
                    ? 'text-white'
                    : 'bg-gray-100 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-500'
                }`}
                style={chipStyle(active)}
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
      </div>

      {/* ============ 卡片二：筛选 + 主题色 ============
          两张卡都铺满图片区宽度，内容用栅格分栏 —— 上一版卡片只有 768px、
          右边空着一大片，被吐槽"看着合适但右边一大片空白"。 */}
      <div
        className="mt-3 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg w-full max-h-[52vh] overflow-y-auto"
        data-testid="filter-card"
      >
        {/* 桌面端按 6:4 分栏（用户指定的比例）：两边都各自挤压，
            各自有最小宽度，真的放不下时整栏换行到下面 —— 而不是把卡片撑宽、横向溢出 */}
        <div className={horizontal ? 'flex flex-wrap items-start' : 'min-w-0'}>
        {/* 左：筛选条件（60%），右：主题色（40%） */}
        <div
          className={horizontal ? 'basis-3/5 grow-0 shrink min-w-[22rem] pr-5' : 'min-w-0'}
          data-testid="filter-block"
        >
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">筛选</span>
            <div
              className="inline-flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden"
              data-testid="filter-mode-toggle"
              role="group"
              aria-label="筛选模式"
            >
              <button
                onClick={() => setFilterMode('include')}
                data-testid="filter-mode-include"
                aria-pressed={!excluding}
                className={`px-3 py-1 text-xs transition-colors ${
                  !excluding
                    ? 'text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
                style={!excluding ? { backgroundColor: 'rgb(var(--accent-500))' } : undefined}
                title="只显示符合下面条件的图片"
              >
                只显示
              </button>
              <button
                onClick={() => setFilterMode('exclude')}
                data-testid="filter-mode-exclude"
                aria-pressed={excluding}
                className={`px-3 py-1 text-xs transition-colors border-l border-gray-300 dark:border-gray-600 ${
                  excluding
                    ? 'text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
                style={excluding ? { backgroundColor: 'rgb(var(--accent-500))' } : undefined}
                title="把符合下面条件的图片藏起来"
              >
                排除
              </button>
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {excluding ? '符合条件的会被藏起来' : '只留下符合条件的'}
            </span>
          </div>

          <button
            onClick={clearFilters}
            data-testid="clear-filters"
            disabled={activeCount === 0}
            className={`flex items-center gap-1 text-xs ${
              activeCount === 0
                ? 'text-gray-400 dark:text-gray-500 cursor-default'
                : 'text-gray-500 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white'
            }`}
            title="清空下面所有条件"
          >
            <X className="w-3.5 h-3.5" />
            清空{activeCount > 0 ? `（${activeCount} 项）` : ''}
          </button>
        </div>

        {/* 格式：图片 → 视频 → 其他 */}
        <div className="mb-4">
          <div className={sectionTitle}>
            格式
            {formatCount > 0 && (
              <span className="ml-2 font-normal text-gray-400 dark:text-gray-500">
                当前范围内共 {formatCount} 种
              </span>
            )}
          </div>
          {formatCount > 0 ? (
            <div className="space-y-2">
              {KIND_GROUPS.map(({ kind, label }) => {
                const list = formatsByGroup[kind];
                if (list.length === 0) return null;
                const values = list.map((f) => f.value);
                const selected = values.filter((v) => filters.formats.includes(v));
                // 组头本身也是开关：照片多的时候先点「图片」比一个个点格式快得多
                const groupState = selected.length === 0 ? 'none' : (selected.length === values.length ? 'all' : 'some');
                const groupCount = list.reduce((sum, f) => sum + f.count, 0);
                return (
                  <div key={kind} className="flex items-start gap-2" data-format-group={kind}>
                    <button
                      type="button"
                      onClick={() => toggleFilterValues('formats', values)}
                      data-testid={`filter-group-${kind}`}
                      data-group-state={groupState}
                      aria-pressed={groupState === 'all'}
                      title={`一键${groupState === 'all' ? '取消' : '选中'}所有${label}格式（共 ${groupCount} 张）`}
                      className={`mt-0.5 w-12 shrink-0 px-1 py-1 text-xs rounded transition-colors ${
                        groupState === 'all'
                          ? 'text-white'
                          : groupState === 'some'
                            ? 'text-gray-800 dark:text-gray-100 bg-gray-200 dark:bg-gray-500'
                            : 'text-gray-500 dark:text-gray-300 bg-gray-100 dark:bg-gray-600 hover:bg-gray-200 dark:hover:bg-gray-500'
                      }`}
                      style={groupState === 'all' ? { backgroundColor: 'rgb(var(--accent-500))' } : undefined}
                    >
                      {label}
                    </button>
                    <div className="flex flex-wrap gap-2">
                      {list.map(({ value, count }) => (
                        <button
                          key={value}
                          onClick={() => toggleFilterValue('formats', value)}
                          data-testid={`filter-format-${value}`}
                          data-kind={kind}
                          aria-pressed={filters.formats.includes(value)}
                          className={chipClass(filters.formats.includes(value))}
                          style={chipStyle(filters.formats.includes(value))}
                        >
                          {value.toUpperCase()}
                          <span className="ml-1.5 opacity-70">{count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {loadingOptions ? '读取中…' : '当前范围里没有图片'}
            </span>
          )}
        </div>

        {/* 文件大小：区间双滑块（两个把手，默认占两端），刻度在滑条下面 */}
        <div className="mb-4">
          <div className={sectionTitle}>文件大小</div>
          {sizeStops.length > 1 ? (
            <div className="w-full max-w-md">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-gray-700 dark:text-gray-200" data-testid="size-range-current">
                  {isFullRange
                    ? '不限'
                    : `${sizeStops[shownLeft].label} ~ ${sizeStops[shownRight].label}`}
                </span>
                <span className="text-gray-400 dark:text-gray-500">
                  {activeRangeCount} 张
                </span>
              </div>
              <DualRangeSlider
                testId="size-range"
                ariaLabel="文件大小"
                stops={sizeStops}
                valueLeft={shownLeft}
                valueRight={shownRight}
                onChange={setDraggingRange}
                onChangeEnd={commitSizeRange}
              />
            </div>
          ) : (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {loadingOptions ? '读取中…' : '暂无大小数据'}
            </span>
          )}
        </div>

        {/* 方向 */}
        <div className="mb-4">
          <div className={sectionTitle}>方向</div>
          <div className="flex flex-wrap gap-2">
            {availableOrientations.length > 0 ? (
              availableOrientations.map(({ value, count }) => (
                <button
                  key={value}
                  onClick={() => toggleFilterValue('orientations', value)}
                  data-testid={`filter-orientation-${value}`}
                  aria-pressed={filters.orientations.includes(value)}
                  className={chipClass(filters.orientations.includes(value))}
                  style={chipStyle(filters.orientations.includes(value))}
                >
                  {ORIENTATION_LABELS[value] || value}
                  <span className="ml-1.5 opacity-70">{count}</span>
                </button>
              ))
            ) : (
              <span className="text-xs text-gray-400 dark:text-gray-500">暂无方向数据</span>
            )}
          </div>
        </div>

        {/* 评分 */}
        <div>
          <div className={sectionTitle}>评分</div>
          <div className="flex flex-wrap gap-2">
            {availableRatings.length > 0 ? (
              availableRatings.map(({ value, count }) => (
                <button
                  key={value}
                  onClick={() => toggleFilterValue('ratings', value)}
                  data-testid={`filter-rating-${value}`}
                  aria-pressed={filters.ratings.includes(value)}
                  className={`${chipClass(filters.ratings.includes(value))} flex items-center gap-1`}
                  style={chipStyle(filters.ratings.includes(value))}
                >
                  {value > 0 ? (
                    <>
                      {[...Array(value)].map((_, i) => <Star key={i} size={12} className="fill-current" />)}
                    </>
                  ) : (
                    <span>未评分</span>
                  )}
                  <span className="ml-0.5 opacity-70">{count}</span>
                </button>
              ))
            ) : (
              <span className="text-xs text-gray-400 dark:text-gray-500">暂无评分数据</span>
            )}
          </div>
        </div>

        <div className="mt-3 text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
          选项只列出当前文件夹里真实存在的格式；筛选在后端生效，翻页之后的图片同样受筛选影响。
        </div>
        </div>

        {/* 主题色：桌面端在右边一栏（横排），手机端在下面一整行。
            横排时用紧凑版（预设小一号、色轮 132px、内部一律竖排）——
            之前横排会横向溢出的原因就是这里还在用"完整版"的排布。 */}
        <div
          className={horizontal
            ? 'basis-2/5 grow-0 shrink min-w-[16rem] border-l border-gray-200 dark:border-gray-600 pl-5 min-w-0'
            : 'mt-4 pt-4 border-t border-gray-200 dark:border-gray-600 min-w-0'}
          data-testid="theme-section"
        >
          <ThemeColorPicker compact={horizontal} />
        </div>
        </div>
        </div>
      </div>
  );
}
