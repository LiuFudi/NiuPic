// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 统一错误处理中间件
 */

/**
 * 应用错误类
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 验证错误
 */
class ValidationError extends AppError {
  constructor(message, field = null) {
    super(message, 400, 'VALIDATION_ERROR');
    this.field = field;
  }
}

/**
 * 资源未找到错误
 */
class NotFoundError extends AppError {
  constructor(resource, id = null) {
    super(
      `${resource} not found${id ? `: ${id}` : ''}`,
      404,
      'NOT_FOUND'
    );
    this.resource = resource;
    this.id = id;
  }
}

/**
 * 冲突错误
 */
class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, 'CONFLICT');
  }
}

/**
 * 路径越界（防穿越）。
 *
 * safePath.js 抛的是它自己的 PathEscapeError，这里统一翻成 403 ——
 * 兜底的意义在于：**忘了在路由里 catch 的写法也能得到 403 而不是 500**。
 * 500 会让"有人在试探目录穿越"看起来像"应用坏了"，日志和告警都会被带偏。
 */
const pathEscapeToAppError = (err) => {
  if (err && err.name === 'PathEscapeError') {
    return new AppError(`非法路径：${err.message}`, 403, 'PATH_ESCAPE');
  }
  return err;
};

/**
 * 错误处理中间件
 */
const errorHandler = (err, req, res, next) => {
  err = pathEscapeToAppError(err);

  // 操作性错误（预期的错误）
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.field && { field: err.field }),
        ...(err.remainingAttempts !== undefined && { remainingAttempts: err.remainingAttempts }),
        ...(err.currentAttempts !== undefined && { currentAttempts: err.currentAttempts })
      }
    });
  }

  // 编程错误（未预期的错误）
  console.error('💥 Unexpected Error:', err);
  
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'development' 
        ? err.message 
        : 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
};

/**
 * 异步路由处理器包装
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  errorHandler,
  asyncHandler
};
