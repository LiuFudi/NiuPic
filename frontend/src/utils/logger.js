/**
 * NiuPic 前端日志系统
 * 专注于用户操作和UI交互日志
 * 
 * 日志分类：
 * - USER: 用户操作（点击、选择、快捷键）
 * - FILE: 文件操作（复制、移动、删除、重命名）
 * - DATA: 数据加载（加载图片、文件夹、搜索）
 * - UI: UI状态（主题切换、面板展开）
 * - ERROR: 错误（API失败、操作异常）
 */

const isDev = import.meta.env.DEV;
const isDebugEnabled = isDev || import.meta.env.VITE_ENABLE_DEBUG === 'true';

// 日志类别配置
const LOG_CATEGORIES = {
  USER: { emoji: '👤', color: '#3b82f6', label: 'USER' },    // 用户操作
  FILE: { emoji: '📁', color: '#10b981', label: 'FILE' },    // 文件操作
  DATA: { emoji: '📊', color: '#8b5cf6', label: 'DATA' },    // 数据加载
  UI: { emoji: '🎨', color: '#f59e0b', label: 'UI' },        // UI状态
  ERROR: { emoji: '❌', color: '#ef4444', label: 'ERROR' },  // 错误
};

/**
 * 日志工具类
 */
class Logger {
  constructor(namespace = '') {
    this.namespace = namespace;
  }

  /**
   * 格式化日志前缀
   */
  _getPrefix(category) {
    const config = LOG_CATEGORIES[category] || {};
    const emoji = config.emoji || '📝';
    const label = config.label || 'LOG';
    const ns = this.namespace ? `[${this.namespace}]` : '';
    return `${emoji} ${label}${ns}`;
  }

  /**
   * 输出彩色日志
   */
  _log(category, method, ...args) {
    if (!isDebugEnabled && category !== 'ERROR') return;
    
    const config = LOG_CATEGORIES[category];
    const prefix = this._getPrefix(category);
    
    if (config && config.color) {
      console[method](
        `%c${prefix}`,
        `color: ${config.color}; font-weight: bold;`,
        ...args
      );
    } else {
      console[method](prefix, ...args);
    }
  }

  // ==================== 用户操作日志 ====================
  
  /**
   * 用户操作日志
   * @example logger.user('点击图片', imageId)
   */
  user(...args) {
    this._log('USER', 'log', ...args);
  }

  // ==================== 文件操作日志 ====================
  
  /**
   * 文件操作日志
   * @example logger.file('删除文件', { count: 3, folder: '/photos' })
   */
  file(...args) {
    this._log('FILE', 'log', ...args);
  }

  // ==================== 数据加载日志 ====================
  
  /**
   * 数据加载日志
   * @example logger.data('加载图片', { count: 100, time: 500 })
   */
  data(...args) {
    this._log('DATA', 'log', ...args);
  }

  // ==================== UI状态日志 ====================
  
  /**
   * UI状态日志
   * @example logger.ui('切换主题', 'dark')
   */
  ui(...args) {
    this._log('UI', 'log', ...args);
  }

  // ==================== 错误日志 ====================
  
  /**
   * 错误日志（所有环境）
   * @example logger.error('API请求失败', error)
   */
  error(...args) {
    this._log('ERROR', 'error', ...args);
  }

  /**
   * 警告日志（所有环境）
   */
  warn(...args) {
    if (!isDebugEnabled) return;
    console.warn(this._getPrefix(''), ...args);
  }

  // ==================== 调试工具 ====================
  
  /**
   * 表格输出（仅开发环境）
   */
  table(data) {
    if (isDebugEnabled) {
      console.table(data);
    }
  }

  /**
   * 分组日志（仅开发环境）
   */
  group(label, collapsed = false) {
    if (isDebugEnabled) {
      if (collapsed) {
        console.groupCollapsed(label);
      } else {
        console.group(label);
      }
    }
  }

  groupEnd() {
    if (isDebugEnabled) {
      console.groupEnd();
    }
  }

  /**
   * 性能计时
   */
  time(label) {
    if (isDebugEnabled) {
      console.time(label);
    }
  }

  timeEnd(label) {
    if (isDebugEnabled) {
      console.timeEnd(label);
    }
  }
}

/**
 * 创建带命名空间的日志器
 * @param {string} namespace - 日志命名空间
 * @returns {Logger} 日志器实例
 * 
 * @example
 * const logger = createLogger('ImageWaterfall')
 * logger.user('选中图片', imageId)
 */
export function createLogger(namespace) {
  return new Logger(namespace);
}

/**
 * 默认日志器
 */
export const logger = new Logger();

export default logger;
