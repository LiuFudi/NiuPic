// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 登录页面
 */

import { useState } from 'react';
import { authAPI } from '../api/auth';
import { setToken } from '../api/client';
import { useAuthStore } from '../stores/useAuthStore';

export default function Login() {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  const { hasPassword, setAuthStatus } = useAuthStore();

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!password) {
      setError('请输入密码');
      return;
    }

    if (password.length < 4) {
      setError('密码长度至少为 4 位');
      return;
    }

    setLoading(true);
    setError('');

    try {
      let result;
      
      if (hasPassword) {
        // 登录
        result = await authAPI.login(password);
      } else {
        // 首次设置密码
        result = await authAPI.setupPassword(password);
      }

      // 保存 token
      setToken(result.token);
      
      // 更新认证状态（已设置密码 + 已认证）
      setAuthStatus(true, true);

    } catch (err) {
      if (err.status === 401) {
        // 密码错误，检查是否有剩余尝试次数信息
        if (err.data?.error?.remainingAttempts !== undefined) {
          const remaining = err.data.error.remainingAttempts;
          if (remaining > 0) {
            setError(`密码错误，剩余 ${remaining} 次尝试机会`);
          } else {
            setError('密码错误，已达到最大尝试次数，请稍后再试');
          }
        } else {
          setError('密码错误');
        }
      } else if (err.status === 429) {
        // 尝试次数过多
        setError(err.message || '登录尝试次数过多，请稍后再试');
      } else if (err.status === 400 && err.message) {
        setError(err.message);
      } else {
        setError(err.message || '操作失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="w-full max-w-md">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-8">
          {/* Logo */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center mb-4">
              <img 
                src="/ICON_256.PNG" 
                alt="NiuPic Logo" 
                className="w-20 h-20 object-contain"
                onError={(e) => {
                  // 如果 ICON_256.PNG 加载失败，尝试 favicon.png
                  e.target.src = '/favicon.png';
                }}
              />
            </div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
              牛图 NiuPic
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              {hasPassword ? '请输入密码访问' : '首次使用，请设置访问密码'}
            </p>
          </div>

          {/* 表单 */}
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {hasPassword ? '访问密码' : '设置密码'}
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={hasPassword ? '请输入密码' : '至少 4 位字符'}
                className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
                disabled={loading}
                autoFocus
              />
              {!hasPassword && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  💡 密码将加密存储，请妥善保管
                </p>
              )}
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-600 dark:text-red-400">
                  {error}
                </p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white font-medium rounded-lg shadow-lg hover:shadow-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center justify-center">
                  <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  处理中...
                </span>
              ) : (
                hasPassword ? '登录' : '设置密码并进入'
              )}
            </button>
          </form>

          {/* 底部信息 */}
          <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
            <p className="text-center text-xs text-gray-500 dark:text-gray-400">
              轻量 · 快速 · 稳定的图片素材管理
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
