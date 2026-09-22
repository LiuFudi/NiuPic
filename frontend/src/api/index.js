// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * API 统一导出
 */

import * as library from './endpoints/library';
import * as image from './endpoints/image';
import * as scan from './endpoints/scan';
import { fileAPI } from './file';

export const libraryAPI = library;
export const imageAPI = image;
export const scanAPI = scan;
export { fileAPI };

export { api, APIError } from './client';

// watchAPI 空实现（已废弃）
export const watchAPI = {
  start: () => Promise.resolve({}),
  stop: () => Promise.resolve({}),
  status: () => Promise.resolve({ watching: false }),
  list: () => Promise.resolve({ watchers: [] })
};
