// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 全屏（Fullscreen API）工具
 *
 * 统一处理浏览器前缀，并在下列场景下安全降级（返回 false，不抛异常）：
 *  - 浏览器不支持 Fullscreen API
 *  - 页面被宿主以 iframe 嵌入且未授予 allow="fullscreen"（飞牛桌面 / FN Connect 场景）
 *  - 非用户手势触发
 * 调用方在失败时退化为「全视口浮层」，视觉上与全屏一致。
 */

/** 当前处于全屏状态的元素（无则返回 null） */
export function getFullscreenElement() {
  if (typeof document === 'undefined') return null;
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

/** 是否处于全屏状态 */
export function isFullscreen() {
  return !!getFullscreenElement();
}

/** 浏览器是否支持全屏 */
export function isFullscreenSupported() {
  if (typeof document === 'undefined') return false;
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

/**
 * 请求进入全屏
 * @param {HTMLElement} [target] 目标元素，默认 documentElement
 * @returns {Promise<boolean>} 是否成功进入全屏
 */
export async function requestFullscreen(target) {
  if (typeof document === 'undefined') return false;
  const el = target || document.documentElement;

  try {
    if (el.requestFullscreen) {
      await el.requestFullscreen({ navigationUI: 'hide' });
      return true;
    }
    if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
      return true;
    }
  } catch (error) {
    // 静默降级：由调用方使用全视口浮层
  }
  return false;
}

/**
 * 退出全屏
 * @returns {Promise<boolean>}
 */
export async function exitFullscreen() {
  if (typeof document === 'undefined' || !getFullscreenElement()) return true;

  try {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
      return true;
    }
    if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
      return true;
    }
  } catch (error) {
    return false;
  }
  return false;
}

/**
 * 监听全屏状态变化（含前缀事件）
 * @param {(fullscreen: boolean) => void} handler
 * @returns {() => void} 取消订阅
 */
export function onFullscreenChange(handler) {
  if (typeof document === 'undefined') return () => {};

  const emit = () => handler(isFullscreen());
  const events = ['fullscreenchange', 'webkitfullscreenchange'];
  events.forEach((name) => document.addEventListener(name, emit));

  return () => events.forEach((name) => document.removeEventListener(name, emit));
}
