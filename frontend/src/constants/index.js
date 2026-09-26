// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 前端常量配置
 */

// 这里**不放**图片格式清单：唯一真源是后端 `backend/src/config/formats.js`。
// 原来这儿抄了一份 7 个后缀的 IMAGE_FORMATS —— 没人引用、又和后端对不上，
// 谁哪天顺手 import 它，就会得到一份"少一大半格式"的判断。

// 缩略图尺寸
export const THUMBNAIL_SIZES = {
  SMALL: 200,
  MEDIUM: 480,
  LARGE: 800
};

// 分页配置
export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 100,
  WINDOW_SIZE: 200
};

// UI 配置
export const UI = {
  MOBILE_BREAKPOINT: 768,
  SIDEBAR_MIN_WIDTH: 200,
  SIDEBAR_MAX_WIDTH: 400,
  SIDEBAR_DEFAULT_WIDTH: 256,
  PANEL_MIN_WIDTH: 280,
  PANEL_MAX_WIDTH: 500,
  PANEL_DEFAULT_WIDTH: 320
};

// 防抖延迟
export const DEBOUNCE = {
  SEARCH: 300,
  RESIZE: 150,
  FOLDER_SWITCH: 50
};

// 缩略图高度范围
export const THUMBNAIL_HEIGHT = {
  MIN: 150,
  MAX: 300,
  DEFAULT: 200
};
