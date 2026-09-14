/**
 * 统一主题管理 Hook - 轻量、快速、稳定
 * 集中处理：初始化、切换、持久化
 *
 * 管两件事：
 *   1. 明暗主题（documentElement 上的 .dark 类）
 *   2. 主题色（documentElement 上的 --accent-* 变量，见 utils/accentColor.js）
 */

import { useEffect } from 'react';
import { useUIStore } from '../stores/useUIStore';
import { libraryAPI } from '../api';
import { applyAccentColor, normalizeHex, DEFAULT_ACCENT, isDefaultAccent } from '../utils/accentColor';

export function useTheme() {
  const theme = useUIStore(state => state.theme);
  const setTheme = useUIStore(state => state.setTheme);
  const accentColor = useUIStore(state => state.accentColor);
  const setAccentColor = useUIStore(state => state.setAccentColor);

  // 初始化：应用主题到 DOM
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  // 主题色：写 CSS 变量。accentColor 为 null 时清掉内联变量，回到 index.css 里的默认蓝
  useEffect(() => {
    applyAccentColor(accentColor);
  }, [accentColor]);

  // 切换主题（带后端持久化）
  const toggleTheme = async () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    
    // 异步保存，不阻塞 UI
    try {
      await libraryAPI.updateTheme(newTheme);
    } catch (error) {
      console.error('保存主题失败:', error);
    }
  };

  /**
   * 设置主题色
   * @param {string|null} value '#rrggbb'；传 null 或默认蓝 = 用内置默认蓝
   * @param {object} [options]
   * @param {boolean} [options.persist=true] 是否写回后端（色轮拖动时的实时预览传 false）
   */
  const changeAccentColor = async (value, options = {}) => {
    const { persist = true } = options;
    const normalized = value === null || value === undefined ? null : normalizeHex(value);
    const next = normalized === null || isDefaultAccent(normalized) ? null : normalized;

    setAccentColor(next);

    if (persist) {
      try {
        // 用默认蓝时存空串，后端据此回到内置蓝
        await libraryAPI.updateThemeColor(next || '');
      } catch (error) {
        console.error('保存主题色失败:', error);
      }
    }
  };

  /** 恢复默认主题色 */
  const resetAccentColor = () => changeAccentColor(DEFAULT_ACCENT);

  return { theme, toggleTheme, accentColor, changeAccentColor, resetAccentColor };
}
