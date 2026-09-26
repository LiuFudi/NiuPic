// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 认证包装器
 * 检查认证状态，未认证时显示登录页面
 */

import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { authAPI } from '../api/auth';
import { getToken } from '../api/client';
import { appBase, apiBase } from '../utils/appBase';
import { shouldAutoReload, markRetried, clearLocalSession, platformLoginUrl } from '../utils/gatewayRecovery';
import Login from './Login';
import { AlertTriangle, RefreshCw, ExternalLink } from 'lucide-react';

export default function AuthWrapper({ children }) {
  const { hasPassword, isAuthenticated, isChecking, setAuthStatus, logout } = useAuthStore();
  // 平台网关把请求拦下时（会话失效）单独记一条：这种情况**不能**当成"没设口令"放行。
  // 存整个错误对象（含 status / 原始响应片段），界面上给折叠的"诊断信息"。
  const [gatewayError, setGatewayError] = useState(null);

  useEffect(() => {
    // 检查认证状态
    checkAuth();

    // 监听 401 未授权事件
    const handleUnauthorized = () => {
      logout();
    };

    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, []);

  const checkAuth = async () => {
    try {
      setGatewayError(null);
      const status = await authAPI.getAuthStatus();
      const token = getToken();
      
      console.log('🔐 认证状态检查:', { hasPassword: status.hasPassword, hasToken: !!token });
      
      // 已设置密码但没有 token，需要登录
      // 未设置密码或有有效 token，允许访问
      // 会话有效性优先用服务端给的 authenticated（它认 HttpOnly Cookie），
      // 没有这个字段时再退回"看 localStorage 有没有 token"的老逻辑
      const authenticated = typeof status.authenticated === 'boolean'
        ? status.authenticated
        : (status.hasPassword ? !!token : true);
      setAuthStatus(status.hasPassword, authenticated);
    } catch (error) {
      console.error('❌ 检查认证状态失败:', error);

      // ① 平台网关拦下了请求（真机上的原话是纯文本 "invalid token"）：
      //    **必须明说**，不能"假设未设密码"放行 —— 放行的结果是界面画出来了、
      //    随后每个接口都失败，用户看到的是一句 JSON 解析错误 + 一直闪的 logo。
      if (error.code === 'GATEWAY_SESSION_INVALID' || error.code === 'GATEWAY_HTML_RESPONSE') {
        // 先自救一次：如果本页地址里还带着平台给的一次性凭据（桌面打开时的 ?token=…），
        // 重载一次可能就把会话重新种上 —— 能自动好的情况就别打扰用户。只试一次。
        if (shouldAutoReload()) {
          markRetried();
          console.warn('⚠️ 网关拒绝了请求，地址里带凭据 —— 先自动重载一次试试');
          window.location.replace(window.location.href);
          return;
        }
        setGatewayError(error);
        return;
      }

      if (error.status === 401) {
        // 明确的 401 错误，说明需要认证
        setAuthStatus(true, false);
      } else {
        // 其它错误（网络问题等）：保持原来的宽松处理，避免因网络抖动把用户锁在门外
        console.warn('⚠️ 无法验证认证状态，假设未设置密码');
        setAuthStatus(false, true);
      }
    }
  };

  // 平台网关会话失效：给一页**能照着做**的说明。
  // 真机上用户就是卡在这里：提示有了，但地址是纯文本、没有可点的入口，
  // 也没说"桌面页面本身可能是缓存的"这种情况 —— 2026-09-23 补上。
  if (gatewayError) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const desktopUrl = `${origin}/`;
    // 直达平台**登录页**（而不是桌面首页）：会话卡住时，桌面首页可能仍显示"已登录"的老界面，
    // 而登录页一定会让用户重新输一次密码 —— 等价于"清 Cookie + 重新登录"，但不用手工清。
    const loginUrl = platformLoginUrl(origin);
    const message = (gatewayError && gatewayError.message) || String(gatewayError);
    const detail = gatewayError && gatewayError.data ? gatewayError.data.raw : '';

    return (
      <div
        data-testid="gateway-error"
        className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-6"
      >
        <div className="max-w-lg w-full bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
          <div className="flex justify-center mb-4">
            <AlertTriangle className="w-12 h-12 text-amber-500" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-3 text-center">
            连接不到 NiuPic 服务
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-5 text-center">
            {message}
          </p>

          <ol className="text-left text-sm text-gray-600 dark:text-gray-300 space-y-2 mb-5 list-decimal pl-5">
            <li>
              点下面的<strong>「重新登录飞牛」</strong>（会打开
              <a
                href={loginUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="gateway-desktop-link"
                className="mx-1 font-mono text-blue-600 dark:text-blue-400 underline break-all"
              >
                {loginUrl}
              </a>
              ），重新输一次飞牛的密码
            </li>
            <li>
              登录完回到<strong>飞牛桌面</strong>，点桌面上的<strong>牛图库图标</strong>打开
            </li>
            <li>
              不要用书签、历史记录打开应用地址，也别反复刷新这一页 ——
              新凭据只能由桌面在打开时签发
            </li>
          </ol>

          <div className="text-left text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/60 rounded-lg p-3 mb-5 leading-relaxed">
            <div className="font-medium text-gray-600 dark:text-gray-300 mb-1">还是不行？按顺序试：</div>
            <div>① 上面第 1 步做完仍然这样 → 点「清除本机登录信息后重新登录」（清掉浏览器里这一站的旧凭据）</div>
            {/* 这里**不要**写具体地址（哪怕是"示例"）：当初写的是作者自己 NAS 的内网 IP，
                它会随界面发给所有人 —— 规范 6.1 明确禁止交付物里出现内网 IP/主机名。 */}
            <div>② 确认桌面和应用是<strong>同一个地址</strong>（同一个 IP、同一个端口，别一个用 IP 一个用主机名）——换过地址登录，凭据不通用</div>
            <div>③ 还不行就换一个<strong>无痕窗口</strong>重新登录，排除浏览器禁用 Cookie / 拦截脚本的可能</div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3">
            <a
              href={loginUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="gateway-open-desktop"
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm"
            >
              <ExternalLink className="w-4 h-4" />
              重新登录飞牛
            </a>
            <button
              type="button"
              data-testid="gateway-clear-relogin"
              onClick={() => {
                const cleared = clearLocalSession();
                console.info(`已清除本机登录信息（${cleared} 个 Cookie）`);
                window.open(loginUrl, '_blank', 'noopener');
              }}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 text-sm hover:bg-blue-50 dark:hover:bg-blue-900/30"
            >
              清除本机登录信息后重新登录
            </button>
            <button
              type="button"
              data-testid="gateway-retry"
              onClick={() => { setGatewayError(null); useAuthStore.setState({ isChecking: true }); checkAuth(); }}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 text-sm hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              <RefreshCw className="w-4 h-4" />
              重试
            </button>
          </div>

          {detail ? (
            <details className="mt-5 text-left">
              <summary className="text-xs text-gray-400 cursor-pointer">诊断信息（反馈问题时请附上）</summary>
              <pre className="mt-2 text-[11px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/60 rounded p-2 overflow-auto max-h-32 whitespace-pre-wrap break-all">
{`请求：${apiBase()}/auth/status
HTTP：${gatewayError.status}
响应：${String(detail).slice(0, 200)}`}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    );
  }

  // 检查中，显示加载状态
  if (isChecking) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-50 dark:bg-gray-900">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <div className="text-lg font-medium text-gray-700 dark:text-gray-300">
            正在检查认证状态...
          </div>
        </div>
      </div>
    );
  }

  // 未设置密码，强制设置（首次使用）
  if (!hasPassword) {
    return <Login />;
  }

  // 已设置密码但未认证，显示登录页面
  if (hasPassword && !isAuthenticated) {
    return <Login />;
  }

  // 已认证，显示应用
  return children;
}
