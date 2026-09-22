// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
//
// 打赏弹窗（《打赏功能规范》第六节）。
//
// 这个组件的实现约束，改之前先看一眼，几条都是刻意的：
//   · 纯本地 —— 不 fetch、不上报、不统计点击、不加载远程图片；二维码是构建期
//     内嵌的 data URI（见 scripts/make-donate-qr.js），所以断网也照常显示；
//   · 绝不自动弹出 —— 只有用户点了入口才渲染；
//   · 关闭只要一次点击（× / 点遮罩 / Esc），没有任何"再想想"式的挽留；
//   · 不做任何"是否打赏过"的判断，也没有打赏后解锁之类的东西 —— 与功能完全解耦；
//   · 不集成支付：只显示收款码图片，转账在微信/支付宝里完成，与本软件无关。
//
// 文案写在 config/donate.json 里，弹窗里不放催促、祈使句（规范 4.x 与附录 B）。

import { useEffect } from 'react';
import { X, Heart } from 'lucide-react';
import donateConfig from '../config/donate.json';
import { DONATE_QR } from '../assets/donateQr.js';

/**
 * 打赏入口按钮。移动端与桌面端两套顶栏布局共用一个定义 —— 样式写两份迟早会不一致。
 * 位置由外面的容器决定（桌面端用 absolute left-full 挂在搜索框右侧，见 Header.jsx）。
 */
export function DonateButton({ onClick, className = '' }) {
  // 分发者可以在 donate.json 里整体关掉（界面里改不到，见规范 3.6）
  if (donateConfig.enabled === false) return null;
  return (
    <button
      onClick={onClick}
      data-testid="donate-button"
      title={donateConfig.title}
      className={`flex items-center gap-1 px-2 py-2 border border-err/40 rounded-lg text-err whitespace-nowrap transition-colors hover:bg-err/10 hover:border-err ${className}`}
    >
      <Heart className="w-5 h-5" />
      <span className="text-sm">打赏</span>
    </button>
  );
}

export default function DonateDialog({ isOpen, onClose }) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const codes = (donateConfig.qrcodes || []).filter((item) => DONATE_QR[item.key]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      data-testid="donate-dialog"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={donateConfig.title}
        className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100" data-testid="donate-title">
            {donateConfig.title}
          </h2>
          <button
            onClick={onClose}
            title="关闭"
            data-testid="donate-close"
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="m-0 mb-4 text-sm leading-relaxed text-gray-700 dark:text-gray-300" data-testid="donate-message">
            {donateConfig.message}
          </p>

          <div className="mb-4 flex flex-wrap justify-center gap-5">
            {codes.map((item) => (
              <figure key={item.key} className="m-0 text-center">
                <img
                  src={DONATE_QR[item.key]}
                  alt={`${item.label}收款码`}
                  width={180}
                  height={180}
                  data-testid={`donate-qr-${item.key}`}
                  className="rounded-lg border border-gray-200 bg-white dark:border-gray-600"
                />
                <figcaption className="mt-2 text-sm text-gray-600 dark:text-gray-400">{item.label}</figcaption>
              </figure>
            ))}
          </div>

          <p className="m-0 text-xs leading-relaxed text-gray-500 dark:text-gray-400" data-testid="donate-note">
            {donateConfig.note}
          </p>
        </div>
      </div>
    </div>
  );
}
