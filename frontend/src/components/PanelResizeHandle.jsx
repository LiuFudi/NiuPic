// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 面板宽度拖拽把手
 *
 * 以前是「一条通高的 4px 拖拽条 + 两侧各扩 20px 的透明点击区」，
 * 结果整条分界线从上到下都能触发拖拽 —— 想拖滑块、想滚页面，
 * 鼠标稍微偏一点就变成改侧栏宽度了。
 *
 * 现在改成：分界线只负责「看」（pointer-events: none），
 * 只有在**顶部那个把手**上按住才进入拖拽；双击把手恢复默认宽度。
 */

export default function PanelResizeHandle({ side, onMouseDown, onReset, active = false }) {
  const isLeft = side === 'left';

  return (
    <div
      className="relative w-px h-full flex-shrink-0 bg-gray-200 dark:bg-gray-700 pointer-events-none z-10"
      data-testid={`panel-divider-${side}`}
    >
      <button
        type="button"
        data-testid={`resize-handle-${side}`}
        aria-label={isLeft ? '调整左侧栏宽度' : '调整右侧栏宽度'}
        title="按住拖动可调整宽度，双击恢复默认"
        onMouseDown={onMouseDown}
        onDoubleClick={onReset}
        className={`pointer-events-auto absolute top-0 left-1/2 -translate-x-1/2 h-11 w-3 rounded-b-md cursor-col-resize flex items-center justify-center transition-colors ${
          active
            ? 'bg-blue-500'
            : 'bg-gray-300/90 dark:bg-gray-600 hover:bg-blue-400 dark:hover:bg-blue-500'
        }`}
      >
        <span
          className={`w-0.5 h-4 rounded-full ${active ? 'bg-white' : 'bg-white/90 dark:bg-gray-300'}`}
        />
      </button>
    </div>
  );
}
