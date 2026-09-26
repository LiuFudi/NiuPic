// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// 应用版本号的真源是仓库根 package.json（打包脚本会交叉校验它与 niupic/manifest、
// CHANGELOG 三处一致）。前端不另存一份常量，否则会出现"界面显示 2.3.9、装的是 2.3.10"。
const rootPkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
)

export default defineConfig({
  plugins: [react()],
  // 资源用相对路径：这样同一份产物在 `/`（直接开端口）和 `/app/niupic/`
  // （飞牛统一网关）两种路径下都能正确加载，不必为部署路径重新构建。
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:15002',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    // 提高 chunk 大小警告阈值（可选）
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // 暂时禁用代码分割，避免依赖问题
        // manualChunks: undefined
      }
    }
  },
  worker: {
    // 确保 Worker 使用 ES 模块格式
    format: 'es',
    plugins: () => []
  },
  optimizeDeps: {
    exclude: ['layoutWorker.js']
  }
})
