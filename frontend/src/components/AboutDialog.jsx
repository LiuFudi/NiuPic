// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
//
// 关于页：让用户不翻仓库就能看到"这个程序是什么版本、什么协议、谁写的、跟飞牛什么关系"。
// 版本号由 Vite 在构建时从仓库根 package.json 注入（__APP_VERSION__），
// 不在前端另写一份常量 —— 版本号只能有一处真源。

import { useEffect } from 'react'
import { X, Github, Scale, ShieldAlert, Info } from 'lucide-react'
import { withBase } from '../utils/appBase'

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '开发版'
const AUTHOR_URL = 'https://github.com/LiuFudi'
const UPSTREAM_URL = 'https://github.com/ZangXincz/FlyPic'

export default function AboutDialog({ isOpen, onClose, version }) {
  // Esc 关闭：与项目里其它弹窗保持一致的手感
  useEffect(() => {
    if (!isOpen) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const ver = version || APP_VERSION

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      data-testid="about-dialog"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
            <Info className="w-4 h-4" />
            关于 NiuPic
          </h2>
          <button
            onClick={onClose}
            title="关闭"
            data-testid="about-close"
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-sm text-gray-700 dark:text-gray-300">
          <div>
            <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              NiuPic <span data-testid="about-version" className="text-blue-600 dark:text-blue-400">v{ver}</span>
            </div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              为飞牛 fnOS 设计的图片素材浏览应用 · 基于 FlyPic 二次开发
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Scale className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />
            <div>
              <div className="font-medium text-gray-800 dark:text-gray-200">版权与许可</div>
              <div className="mt-0.5 text-xs leading-relaxed">
                Copyright (C) 2026{' '}
                <a href={AUTHOR_URL} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                  LiuFudi
                </a>
                <br />
                本项目以 <strong>GNU GPL-3.0-or-later</strong> 分发：你可以自由使用、修改、再分发，
                但分发修改版时必须同样开源。
                <br />
                <a href={withBase('/LICENSE.txt')} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline" data-testid="about-license-link">
                  查看协议全文（LICENSE.txt）
                </a>
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Github className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />
            <div>
              <div className="font-medium text-gray-800 dark:text-gray-200">项目主页与反馈</div>
              <div className="mt-0.5 text-xs leading-relaxed">
                <a href={AUTHOR_URL} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                  {AUTHOR_URL}
                </a>
                <br />
                上游原始项目：
                <a href={UPSTREAM_URL} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                  ZangXincz/FlyPic
                </a>
                （MIT 协议，原作者已归档）
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />
            <div>
              <div className="font-medium text-gray-800 dark:text-gray-200">商标与非隶属声明</div>
              <div className="mt-0.5 text-xs leading-relaxed">
                "飞牛"、"fnOS" 是飞牛科技的商标。本应用是第三方独立项目，
                <strong>与飞牛科技无隶属、赞助或背书关系</strong>，不是官方应用。
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-gray-50 dark:bg-gray-900/60 px-3 py-2 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
            本程序按"现状"提供，不提供任何明示或默示担保，使用风险自负。
            它会读取你授权的目录，并在库内写入索引数据库与缩略图缓存（<code>.niupic/</code>）；
            删除素材库、清理缓存等操作会修改磁盘内容，请先确认已备份。
          </div>
        </div>
      </div>
    </div>
  )
}
