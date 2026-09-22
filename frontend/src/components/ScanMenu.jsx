// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 扫描菜单
 *
 * 原来顶栏那个「刷新」按钮调的是增量同步（只找新增/删除的文件），
 * 用户在磁盘上重新整理过文件之后按它没反应，看着就像坏的。
 * 这里做成 Emby / Jellyfin 那种明确的两档：
 *
 *   增量扫描 —— 只找新增和删除的文件，快
 *   全量重扫 —— 每个文件都重新读一遍（元数据 / 名称排序 / 缺失的缩略图），
 *              并清理磁盘上已不存在的记录。评分、收藏、标签都会保留。
 *
 * 菜单里是**两个正交的维度**，而不是一堆名字相近的入口：
 *
 *   扫描范围：当前库 / 某一个库 / 全部库     ← 一个选择器
 *   扫描方式：增量 / 全量                    ← 两个按钮
 *
 * 之前是「全量重扫」「全库重扫」「按库扫描」三个并列入口：
 *   前两个名字只差一个字，看着就是重复功能；
 *   而"按库扫描"其实就是范围选择 —— 把它塞进「全量扫描」里等于同一件事两个名字。
 * 现在范围归范围、方式归方式，想怎么组合都行（全量某库、增量全部库都可以）。
 * （扫描都是服务端异步任务，点完就能关掉菜单/切库，进度走 Socket 推送）
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, ChevronDown, Zap, DatabaseZap, Check, AlertTriangle, Wrench } from 'lucide-react';
import { scanAPI, imageAPI } from '../api';
import { useImageStore } from '../stores/useImageStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import { useScanStore } from '../stores/useScanStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('ScanMenu');

export default function ScanMenu({ libraryId, className = '', align = 'right' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null); // 'sync' | 'rescan' | 'all' | `lib:${id}` | null
  // setState 是异步的：连点两下时 busy 还没更新，第二次就漏过去了
  // （全库重扫会因此把每个库扫两遍，实测踩到过）。用 ref 当闸门。
  const runningRef = useRef(false);
  const [doneHint, setDoneHint] = useState('');
  const libraries = useLibraryStore((st) => st.libraries);
  const lastScanResult = useScanStore((st) => st.lastScanResult);
  const lastScanError = useScanStore((st) => st.lastScanError);
  const clearLastScanResult = useScanStore((st) => st.clearLastScanResult);

  // 扫描结束后的结果提示。最要紧的是"找到 0 个文件"这种情况 ——
  // 以前界面只会说"扫描完成"，用户完全看不出是权限/路径的问题。
  const resultHint = useMemo(() => {
    if (lastScanError) {
      return { tone: 'error', text: `扫描失败：${lastScanError}` };
    }
    if (!lastScanResult || (libraryId && lastScanResult.libraryId !== libraryId)) return null;

    const { total, processed, errors, added, modified, deleted, removed } = lastScanResult;
    const changed = [added, modified, deleted, removed, processed]
      .filter((n) => typeof n === 'number' && n > 0);

    if (total === 0) {
      return {
        tone: 'error',
        text: '扫描完成，但一个文件都没找到 —— 检查素材库目录是否还在、应用是否有读取权限'
      };
    }
    if (typeof total === 'number') {
      return {
        tone: 'ok',
        text: `扫描完成：找到 ${total} 个文件${changed.length ? `，处理 ${changed[0]}` : ''}${errors ? `，失败 ${errors}` : ''}`
      };
    }
    return { tone: 'ok', text: '扫描完成' };
  }, [lastScanResult, lastScanError, libraryId]);
  const boxRef = useRef(null);

  // 点外面关掉
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (!doneHint) return;
    const t = setTimeout(() => setDoneHint(''), 2600);
    return () => clearTimeout(t);
  }, [doneHint]);

  /**
   * 扫描方式和范围是**两件正交的事**：
   *   方式：增量（只找新增/删除） / 全量（每个文件重读一遍）
   *   范围：当前库 / 某个库 / 全部库
   *
   * 上一版把"范围"塞进了「全量扫描」入口里，结果那个库列表本身就是"按库扫描" ——
   * 同一件事两个名字，用户一眼就看出来了。现在范围单独做成一个选择器，
   * 两个按钮只负责"用哪种方式扫"。
   */
  const scopeOptions = useMemo(() => ([
    ...libraries.map((lib) => ({
      value: lib.id,
      label: lib.id === libraryId ? `${lib.name}（当前）` : lib.name,
      lib,
    })),
    { value: 'all', label: `全部库（${libraries.length} 个）`, lib: null },
  ]), [libraries, libraryId]);

  // 范围默认"当前库"；选中的库被删掉时自动回到当前库
  const [scope, setScope] = useState('__current__');
  useEffect(() => {
    if (scope === '__current__' || scope === 'all') return;
    if (!libraries.some((lib) => lib.id === scope)) setScope('__current__');
  }, [libraries, scope]);

  const effectiveScope = scope === '__current__' ? (libraryId || 'all') : scope;
  const scopeLabel = effectiveScope === 'all'
    ? `全部库（${libraries.length} 个）`
    : (scopeOptions.find((o) => o.value === effectiveScope)?.label || '当前库');

  /**
   * 只修文件夹结构与计数：不读磁盘，秒级
   *
   * 用在"文件夹列表显示 0 张"这种时候 —— 数据库里已经写清楚每张图在哪个目录，
   * 不需要为了这个把整个库重扫一遍（大库在机械硬盘上要半小时）。
   */
  const fixFolders = async () => {
    const target = effectiveScope === 'all'
      ? libraries.find((lib) => lib.id === libraryId) || libraries[0]
      : libraries.find((lib) => lib.id === effectiveScope);
    if (!target || busy || runningRef.current) return;

    runningRef.current = true;
    setBusy('fix');
    setOpen(false);
    try {
      const res = await scanAPI.fixFolders(target.id);
      const folders = (res && res.data && res.data.folders) || 0;
      setDoneHint(`已修复「${target.name}」的文件夹结构（${folders} 个，未读磁盘）`);
      logger.data(`修复文件夹结构: ${target.name}`);
      // 文件夹列表变了，重新拉一次
      const foldersRes = await imageAPI.getFolders(target.id);
      useImageStore.getState().setFolders(foldersRes.folders || []);
    } catch (error) {
      alert(`修复文件夹失败: ${error.message}`);
    } finally {
      setBusy(null);
      runningRef.current = false;
    }
  };

  /** 按"范围 + 方式"启动扫描 */
  const startScan = async (mode) => {
    if (busy || runningRef.current || libraries.length === 0) return;
    runningRef.current = true;
    setBusy(mode);
    setOpen(false);

    const targets = effectiveScope === 'all'
      ? libraries
      : libraries.filter((lib) => lib.id === effectiveScope);
    const call = mode === 'sync'
      ? (id) => scanAPI.sync(id, false)
      : (id) => scanAPI.rescan(id, false);

    let started = 0;
    try {
      for (const lib of targets) {
        try {
          await call(lib.id);
          started += 1;
        } catch (error) {
          logger.warn(`扫描「${lib.name}」启动失败: ${error.message}`);
        }
        // 多库时稍微隔开一点，别一下子把磁盘 IO 顶满
        if (targets.length > 1) await new Promise((r) => setTimeout(r, 1500));
      }
      const modeLabel = mode === 'sync' ? '增量扫描' : '全量扫描';
      setDoneHint(
        targets.length > 1
          ? `已开始${modeLabel}：${started} 个素材库`
          : `已开始${modeLabel}：${targets[0] ? targets[0].name : ''}`
      );
      logger.data(`${modeLabel} 已启动（${scopeLabel}）`);
    } finally {
      setBusy(null);
      runningRef.current = false;
    }
  };

  return (
    <div className={`relative ${className}`} ref={boxRef} data-testid="scan-menu">
      <button
        type="button"
        data-testid="scan-menu-button"
        onClick={() => setOpen((v) => !v)}
        disabled={!libraryId || !!busy}
        title="扫描 / 刷新素材库"
        className="flex items-center gap-0.5 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw className={`w-5 h-5 text-gray-700 dark:text-gray-300 ${busy ? 'animate-spin' : ''}`} />
        <ChevronDown className="w-3 h-3 text-gray-500" />
      </button>

      {open && (
        <div
          className={`absolute top-full mt-1 w-80 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-50 overflow-hidden ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {/* ---------- 扫描范围（一个维度：扫哪个库） ---------- */}
          <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-700">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1" htmlFor="scan-scope-select">
              扫描范围
            </label>
            <select
              id="scan-scope-select"
              data-testid="scan-scope-select"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="w-full px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            >
              <option value="__current__">
                {libraryId
                  ? `${(libraries.find((l) => l.id === libraryId) || {}).name || '当前素材库'}（当前）`
                  : '当前素材库'}
              </option>
              {libraries
                .filter((lib) => lib.id !== libraryId)
                .map((lib) => <option key={lib.id} value={lib.id}>{lib.name}</option>)}
              <option value="all">全部库（{libraries.length} 个）</option>
            </select>
          </div>

          {/* ---------- 扫描方式（另一个维度：怎么扫） ---------- */}
          <button
            type="button"
            data-testid="scan-menu-sync"
            onClick={() => startScan('sync')}
            disabled={!!busy || libraries.length === 0}
            className="w-full text-left px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700 disabled:opacity-50"
          >
            <div className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100">
              <Zap className="w-4 h-4 text-blue-500 flex-shrink-0" />
              增量扫描
              <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 truncate max-w-[9rem]" title={scopeLabel}>
                {scopeLabel}
              </span>
            </div>
            <div className="mt-0.5 ml-6 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
              只查找新增和删除的文件，很快。日常加图之后用这个。
            </div>
          </button>

          <button
            type="button"
            data-testid="scan-menu-fix-folders"
            onClick={fixFolders}
            disabled={!!busy || libraries.length === 0 || effectiveScope === 'all'}
            className="w-full text-left px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700 border-t border-gray-100 dark:border-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100">
              <Wrench className="w-4 h-4 text-emerald-500 flex-shrink-0" />
              修复文件夹结构
            </div>
            <div className="mt-0.5 ml-6 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
              只按数据库重建文件夹列表和每层张数，<b>不读磁盘</b>，几秒钟完成。
              文件夹显示 0 张、或者磁盘上挪过文件夹时用这个。
            </div>
          </button>

          <button
            type="button"
            data-testid="scan-menu-full"
            onClick={() => startScan('rescan')}
            disabled={!!busy || libraries.length === 0}
            className="w-full text-left px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            <div className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100">
              <DatabaseZap className="w-4 h-4 text-blue-500 flex-shrink-0" />
              全量扫描
              <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 truncate max-w-[9rem]" title={scopeLabel}>
                {scopeLabel}
              </span>
            </div>
            <div className="mt-0.5 ml-6 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
              每个文件都重新读一遍：尺寸、格式、时间、名称排序，并补齐缺失的缩略图、
              清理磁盘上已不存在的记录。
              <span className="text-emerald-600 dark:text-emerald-400">评分和收藏会保留。</span>
              文件多的时候比较慢。
            </div>
          </button>
        </div>
      )}

      {(doneHint || resultHint) && (
        <div
          data-testid="scan-result-hint"
          data-tone={resultHint ? resultHint.tone : 'ok'}
          onClick={() => { setDoneHint(''); clearLastScanResult(); }}
          title="点击关闭"
          className={`absolute top-full mt-1 px-2 py-1 rounded text-white text-xs z-50 flex items-center gap-1 cursor-pointer ${
            align === 'right' ? 'right-0' : 'left-0'
          } ${
            resultHint && resultHint.tone === 'error'
              ? 'bg-red-600/95 max-w-[22rem] whitespace-normal leading-relaxed'
              : 'bg-gray-900/90 whitespace-nowrap'
          }`}
        >
          {resultHint && resultHint.tone === 'error' ? <AlertTriangle className="w-3 h-3 shrink-0" /> : <Check className="w-3 h-3 shrink-0" />}
          {resultHint ? resultHint.text : doneHint}
        </div>
      )}
    </div>
  );
}
