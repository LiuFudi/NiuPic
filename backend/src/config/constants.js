// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 应用常量配置
 */

// 格式清单只有一份：src/config/formats.js。这里不再抄一遍。
const formats = require('./formats');

module.exports = {
  // 支持的图片格式（所有能出缩略图的，含 RAW 与 ffmpeg 解的静态图）
  SUPPORTED_FORMATS: formats.IMAGE_EXT,
  
  // 缩略图配置
  THUMBNAIL: {
    SIZES: {
      SMALL: 200,
      MEDIUM: 480,
      LARGE: 800
    },
    QUALITY: 80,
    FORMAT: 'webp',
    SHARD_LENGTH: 2  // 分片目录长度
  },
  
  // 文件大小筛选的固定挡位（MB）
  //
  // 为什么不给滑块：素材库里的文件大小跨度动辄 200 倍（100KB ~ 20MB），
  // 滑块要么对数刻度（用户看不懂"为什么中间是 2MB"），要么线性（小文件全挤在最左边拖不动）。
  // 固定挡位是"能用眼睛选"的东西 —— 这和 PornHub 的时长筛选是同一个思路。
  //
  // 边界语义：挡位的统计口径是 [minSize, maxSize)，也就是每张图只算进一个挡位、
  // 各挡位计数之和 = 总数；发给搜索接口的是闭区间 [minSize, maxSize]，
  // 正好卡在边界上的文件（例如恰好 5MB）会同时出现在相邻两个挡位里。
  SIZE_BRACKETS: [
    { key: 'lt1',     label: '< 1 MB',      minSize: null, maxSize: 1 },
    { key: '1-5',     label: '1 - 5 MB',    minSize: 1,    maxSize: 5 },
    { key: '5-10',    label: '5 - 10 MB',   minSize: 5,    maxSize: 10 },
    { key: '10-20',   label: '10 - 20 MB',  minSize: 10,   maxSize: 20 },
    { key: '20-40',   label: '20 - 40 MB',  minSize: 20,   maxSize: 40 },
    { key: '40-60',   label: '40 - 60 MB',  minSize: 40,   maxSize: 60 },
    { key: '60-80',   label: '60 - 80 MB',  minSize: 60,   maxSize: 80 },
    { key: '80-100',  label: '80 - 100 MB', minSize: 80,   maxSize: 100 },
    { key: 'gt100',   label: '100 MB 以上', minSize: 100,  maxSize: null }
  ],

  // 分页配置
  PAGINATION: {
    DEFAULT_SIZE: 100,
    MAX_SIZE: 500
  },
  
  // 扫描配置
  SCAN: {
    BATCH_SIZE: 50,              // 扫描时每批处理的文件数
    WRITE_BATCH_SIZE: 50,        // 数据库批量写入大小
    STREAM_BATCH_SIZE: 200,      // 流式处理批次大小
    CONCURRENT_LIMIT: 10,        // 并发处理限制
    PROGRESS_UPDATE_INTERVAL: 100,
    PROGRESS_LOG_INTERVAL: 1000, // 每处理1000个文件输出一次进度
    GC_TRIGGER_INTERVAL: 1000    // 每处理1000个文件触发一次GC
  },
  
  // 内存配置
  MEMORY: {
    WARNING_THRESHOLD_MB: 200,
    DANGER_THRESHOLD_MB: 300,
    CACHE_SIZE_KB: 4096,
    CLEANUP_INTERVAL_MS: 60000,     // 清理间隔：1分钟
    DB_IDLE_TIMEOUT_MS: 60000,      // 数据库空闲超时：60秒
    DB_CLEANUP_CHECK_INTERVAL: 10000, // 数据库清理检查间隔：10秒（已优化）
    WAL_CHECKPOINT_INTERVAL_MS: 600000 // WAL checkpoint间隔：10分钟（降低I/O开销）
  },
  
  // 数据库配置
  DATABASE: {
    PRAGMA: {
      journal_mode: 'DELETE',
      synchronous: 'NORMAL',
      cache_size: -4096,
      temp_store: 'FILE',
      page_size: 4096,
      mmap_size: 0
    }
  },
  
  // 路径配置
  PATHS: {
    NIUPIC_DIR: '.niupic',
    THUMBNAILS_DIR: 'thumbnails',
    DATABASE_FILE: 'metadata.db',
    CONFIG_FILE: 'config.json',
    TEMP_BACKUP_DIR: '.niupic/temp_backup'
  },
  
  // 文件操作配置
  FILE_OPERATIONS: {
    TEMP_FILE_EXPIRY_MS: 5 * 60 * 1000,  // 临时文件过期时间：5分钟
    COPY_FOLDER_BATCH_SIZE: 10,          // 复制文件夹时每批处理的图片数
    COPY_FOLDER_BATCH_LOG_INTERVAL: 50   // 每处理50张输出进度
  },
  
  // 缩略图生成配置
  THUMBNAIL_GENERATION: {
    TARGET_HEIGHT: 480,                  // 目标高度
    TARGET_WIDTH: 640,                   // 目标宽度（视频封面/占位图用）
    MAX_QUALITY: 95,                     // 最高质量
    DEFAULT_QUALITY: 92,                 // 默认质量
    EFFORT: 4,                           // WebP编码努力程度
    SHARP_CACHE_MEMORY_MB: 20,           // Sharp缓存内存限制
    SHARP_CACHE_ITEMS: 10,               // Sharp缓存项数
    SHARP_CONCURRENCY: 1,                // Sharp并发数
    GC_PROBABILITY: 0.1,                 // GC触发概率
    PLACEHOLDER_WIDTH: 640,              // 占位图宽度
    PLACEHOLDER_HEIGHT: 480              // 占位图高度
  },
  
  // 排序配置
  // key 是给接口用的稳定标识，改动会让前端已保存的排序偏好失效，别随便改。
  // sql 里如果有多列，会各自套用正/倒序（例如 folder, name_sort）。
  SORT: {
    DEFAULT_FIELD: 'created',
    DEFAULT_ORDER: 'desc',
    // sql 是**数组**：多列就写多个（例如 folder 要让同一文件夹的图片聚在一起，
    // 文件夹内再按文件名自然序）。千万不要用逗号拼一个字符串 ——
    // 表达式内部本来就可能带逗号（NULLIF(height, 0)），一拆就坏。
    FIELDS: {
      created:    { label: '创建时间',   sql: ['created_at'] },
      indexed:    { label: '添加时间',   sql: ['indexed_at'] },
      modified:   { label: '修改时间',   sql: ['modified_at'] },
      name:       { label: '文件名',     sql: ['name_sort'] },
      size:       { label: '文件大小',   sql: ['size'] },
      resolution: { label: '分辨率',     sql: ['(width * height)'] },
      width:      { label: '宽度',       sql: ['width'] },
      height:     { label: '高度',       sql: ['height'] },
      aspect:     { label: '宽高比',     sql: ['(CAST(width AS REAL) / NULLIF(height, 0))'] },
      // 「格式」原本也在这里，和「文件类型」重复，已去掉（前端 SORT_OPTIONS 同步移除）。
      // 老客户端如果还传 sort=format，_buildOrderBy 会退回 DEFAULT_FIELD，不会报错。
      type:       { label: '文件类型',   sql: ['file_type'] },
      rating:     { label: '评分',       sql: ['rating'] },
      favorite:   { label: '收藏',       sql: ['favorite'] },
      folder:     { label: '所在文件夹', sql: ['folder', 'name_sort'] },
      random:     { label: '随机',       sql: null }   // 特殊处理，见 ImageModel
    },
    // 这些字段默认「大的 / 新的在前」更符合直觉，其余默认升序
    DESC_BY_DEFAULT: ['created', 'indexed', 'modified', 'size', 'resolution', 'width', 'height', 'rating', 'favorite']
  },

  // 文件监控配置
  FILE_WATCHER: {
    POLL_INTERVAL_MS: 5000,              // 轮询间隔：5秒
    OFFLINE_CHECK_ENABLED: true          // 是否检查离线变化
  }
};
