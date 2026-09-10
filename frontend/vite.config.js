import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
