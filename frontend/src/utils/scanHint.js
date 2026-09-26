// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 扫描结束后给用户看的那句话。
 *
 * 为什么值得单独一个文件：这句话以前把三种完全不同的结果混在一起说 ——
 *   · 处理成功（入库）
 *   · 跳过（文件没变过、缩略图也在）—— **跳过是好事**
 *   · 处理失败（文件读不了、缩略图写不下去）—— **这是要用户知道的事**
 * 真机上的教训：色图库有 10 个文件根本没入库（9 张 4K BMP + 1 张损坏 PNG），
 * 日志每次都报错，界面却说"跳过 6279（没变过）、0 失败"，用户完全看不出来。
 *
 * 现在：跳过与失败分开说，失败时还给出前几个文件名（悬停可见）。
 *
 * @param {object|null} result 扫描统计（后端返回的 stats）
 * @param {string|null} error 扫描直接失败时的错误信息
 * @param {string|number} [libraryId] 只显示当前素材库的结果
 * @returns {{tone: 'ok'|'error', text: string, title?: string}|null}
 */
export function scanHint(result, error, libraryId) {
  if (error) return { tone: 'error', text: `扫描失败：${error}` };
  if (!result || (libraryId && result.libraryId !== libraryId)) return null;

  const { total, processed, skipped, errors, added, modified, deleted, removed, failed } = result;
  const changed = [added, modified, deleted, removed, processed]
    .filter((n) => typeof n === 'number' && n > 0);

  if (total === 0) {
    return {
      tone: 'error',
      text: '扫描完成，但一个文件都没找到 —— 检查素材库目录是否还在、应用是否有读取权限',
    };
  }

  if (typeof total !== 'number') return { tone: 'ok', text: '扫描完成' };

  const parts = [`找到 ${total} 个文件`];
  if (changed.length) parts.push(`处理 ${changed[0]}`);
  if (typeof skipped === 'number' && skipped > 0) parts.push(`跳过 ${skipped} 个未改动`);
  if (errors > 0) parts.push(`${errors} 个处理失败`);

  const detail = Array.isArray(failed) && failed.length
    ? `处理失败的文件（这些文件不在库里）：\n${failed.slice(0, 8).map((f) => `· ${f.path} —— ${f.error}`).join('\n')}`
      + (errors > failed.length ? `\n…另有 ${errors - failed.length} 个，详见应用日志` : '')
    : '';

  return {
    tone: errors > 0 ? 'error' : 'ok',
    text: `扫描完成：${parts.join('，')}`,
    title: detail || undefined,
  };
}
