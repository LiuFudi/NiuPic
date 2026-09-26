// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * NiuPic 服务器入口（新架构）
 * 使用重构后的 Service 层和 Model 层
 */

const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// 导入新架构的应用
const { createApp } = require('./src/app');

// 导入现有的依赖（保持兼容）
const config = require('./utils/config');
const dbPool = require('./database/dbPool');
const scanner = require('./utils/scanner');
const scanManager = require('./utils/scanManager');
const lightweightWatcher = require('./utils/lightweightWatcher');
const MemoryMonitor = require('./utils/memoryMonitor');
const CleanupManager = require('./utils/cleanupManager');

const PORT = process.env.PORT || 15002;

// 自动检测前端构建目录
let FRONTEND_DIST = process.env.FRONTEND_DIST;
if (!FRONTEND_DIST) {
  const possiblePaths = [
    path.join(__dirname, 'public'),
    path.join(__dirname, '../frontend/dist'),
    path.join(__dirname, '../public'),
    path.join(__dirname, '../../frontend/dist')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      FRONTEND_DIST = p;
      console.log('✅ 前端目录:', p);
      break;
    }
  }

  if (!FRONTEND_DIST) {
    console.log('⚠️ 未找到前端，API模式');
  }
}

// 设置环境变量
if (FRONTEND_DIST) {
  process.env.FRONTEND_DIST = FRONTEND_DIST;
}

// 应用目录（server.js 在 <appdest>/server/ 下），Unix socket 放在 appdest/app.sock，
// 与 app/ui/config 里的 gatewaySocket 对应 —— 飞牛统一网关就是连这个 socket。
const APPDEST = process.env.TRIM_APPDEST || path.join(__dirname, '..');
const SOCKET_PATH = process.env.NIUPIC_SOCKET || path.join(APPDEST, 'app.sock');
// 只监听**回环地址**：应用的主入口是飞牛统一网关（见 app/ui/config 的 gatewayPrefix /
// gatewaySocket），端口只留给本机调试与平台自检，不对局域网暴露 ——
// 这就是上架要求第 2 条「不要监听公网端口」的落地方式。
// 需要临时从别的机器直连时，显式 HOST=0.0.0.0 启动即可（不要长期这么用）。
const HOST = process.env.HOST || '127.0.0.1';

/**
 * 剥掉网关前缀：网关可能把 /app/<appname>/... 原样转发过来（也可能剥掉后再转发，
 * 两种都要能工作）。所以这里把 /app/<appname> 前缀去掉，剩下的交给 Express 与 Socket.IO。
 * 用 prependListener 是因为 Socket.IO 也监听 'request' 事件，必须让改写**先**发生。
 */
function stripGatewayPrefix(req) {
  const m = req.url.match(/^\/app\/[A-Za-z0-9._-]+(?=\/|$)/);
  if (m) {
    // 留个记号：Express 收到的 path 已经被剥掉前缀，后面要往 index.html 里注入
    // <base> 时得知道真实前缀是什么。
    req.niupicBasePrefix = m[0];
    req.url = req.url.slice(m[0].length) || '/';
  }
}

/**
 * 让网关前缀在**任何监听器之前**被剥掉。
 *
 * 为什么不能只用 prependListener（第一版就是这么写的，实测没生效）：
 * engine.io 在 attach() 时会把服务器上**已有的** request 监听器全部摘下来缓存，
 * 然后装一个自己的监听器：先按自己的 path（/socket.io）判断，匹配就自己处理，
 * 不匹配才回头调用被摘下来的那些。于是：
 *   带前缀的 /app/niupic/socket.io/… → 它按 /socket.io 判断**不匹配**
 *   → 转给旧监听器（我的剥前缀）→ 但此时它已经决定不处理了 → 最后落到 Express
 *   → 返回 index.html → 前端"实时连接一直连不上"。
 * 所以必须在 emit 这一层归一：无论谁监听、顺序如何，看到的 URL 都已经是剥好的。
 */
function prepare(server) {
  const originalEmit = server.emit;
  server.emit = function emit(event, ...args) {
    if ((event === 'request' || event === 'upgrade') && args[0] && typeof args[0].url === 'string') {
      stripGatewayPrefix(args[0]);
    }
    return originalEmit.apply(this, [event, ...args]);
  };
  // 双保险：也挂一个最早的监听器（对不接管监听器的普通 http 服务同样有效）
  server.prependListener('request', (req) => stripGatewayPrefix(req));
  return server;
}

// 创建 Socket.IO 服务器（TCP 监听 + 网关 Unix socket 共用同一个实例）
const server = prepare(http.createServer());
const io = new Server(server, {
  cors: {
    origin: FRONTEND_DIST ? false : ['http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST']
  }
});

// 准备依赖注入
// 包装 config 函数为对象接口
const configManager = {
  // 兼容两种命名风格
  load: () => config.loadConfig(),
  save: (data) => config.saveConfig(data),
  // 其余的一次性全带进来。
  // 这里原本是手写白名单，新增配置项时忘了同步就会让对应接口 500
  // —— 主题色就这么踩过一次（界面看着正常，其实根本没存下来），
  // 所以改成从 utils/config 的导出自动展开，不再逐个手写。
  ...config
};

const dependencies = {
  configManager,
  dbPool,
  scanner,
  scanManager,
  lightweightWatcher,
  io
};

// 创建 Express 应用（使用新架构）
const app = createApp(dependencies);

// 将 Express 应用挂载到 HTTP 服务器
server.on('request', app);

// 网关用的 Unix socket：飞牛统一网关通过它访问应用，**不需要对外开端口**。
// socket 只允许本机进程连接（0600、属主为应用账号），网关以 root 运行可以连上。
const unixServer = prepare(http.createServer());
// 顺序很关键（实测踩过）：**socket.io 必须比 Express 先拿到 request**。
// socket.io 只处理自己 path 上的请求、其余放行；如果 Express 排在前面，
// 它会把 /socket.io/… 当成"没有对应静态文件"的页面请求、回一个 index.html ——
// 表现就是"经网关能打开界面、但实时连接一直连不上"，而且日志里连一条 socket 记录都没有。
io.attach(unixServer);
unixServer.on('request', app);

function startSocketServer() {
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);   // 陈旧 socket 会让 bind 失败
    unixServer.listen(SOCKET_PATH, () => {
      try { fs.chmodSync(SOCKET_PATH, 0o600); } catch { /* 权限设置失败不影响功能 */ }
      console.log(`🔌 网关 socket（主入口）: ${SOCKET_PATH}`);
    });
    unixServer.on('error', (err) => {
      console.log(`⚠️ 网关 socket 未能监听（${err.message}），TCP 端口仍可访问`);
    });
  } catch (err) {
    console.log(`⚠️ 网关 socket 初始化失败：${err.message}`);
  }
}
startSocketServer();

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log('✅ 客户端连接:', socket.id);

  socket.on('disconnect', () => {
    console.log('❌ 客户端断开:', socket.id);
  });
});

// 启动内存监控（开发模式：每30秒输出RSS）
const memoryMonitor = new MemoryMonitor({ 
  devMode: true,
  devLogInterval: 30000 // 30秒
});
memoryMonitor.start();

// 启动清理管理器
const cleanupManager = new CleanupManager({ dbPool });
cleanupManager.startRoutineCleanup();

// 启动服务器
server.listen(PORT, HOST, () => {
  console.log('\n🚀 NiuPic 服务器已启动');
  console.log(`📡 监听: ${HOST}:${PORT}`);
  console.log(`🔌 Socket.IO 就绪`);
  if (FRONTEND_DIST) console.log(`📁 前端: ${FRONTEND_DIST}`);
  console.log('');

  try {
    const currentConfig = config.loadConfig();
    
    // 启动定时清理任务（每分钟检查一次过期临时文件）
    const fileService = app.get('fileService');
    setInterval(async () => {
      if (currentConfig.libraries && currentConfig.libraries.length > 0) {
        for (const library of currentConfig.libraries) {
          try {
            const result = await fileService.cleanExpiredTempFiles(library.id);
            if (result.cleaned > 0 || result.thumbnailsCleaned > 0) {
              const parts = [];
              if (result.cleaned > 0) parts.push(`${result.cleaned} 个过期文件`);
              if (result.thumbnailsCleaned > 0) parts.push(`${result.thumbnailsCleaned} 个缩略图`);
              console.log(`🧹 已清理: ${parts.join('、')}`);
            }
          } catch (error) {
            // 忽略错误
          }
        }
      }
    }, 60 * 1000); // 每分钟执行一次
    
    // 恢复所有素材库的扫描状态
    if (currentConfig.libraries && currentConfig.libraries.length > 0) {
      scanManager.restoreAllStates(currentConfig.libraries);
      
      // 检查是否有未完成的扫描，自动继续
      const activeStates = scanManager.getAllActiveStates();
      if (Object.keys(activeStates).length > 0) {
        console.log(`📊 发现 ${Object.keys(activeStates).length} 个活跃扫描`);
      }
      
      for (const [libraryId, state] of Object.entries(activeStates)) {
        const lib = currentConfig.libraries.find(l => l.id === libraryId);
        if (lib && state.status === 'scanning') {
          console.log(`🔄 恢复扫描: ${lib.name} (${state.progress?.percent || 0}%)`);
          
          // 立即恢复扫描状态（让前端能检测到）
          scanManager.scanStates.set(libraryId, {
            status: 'scanning',
            progress: state.progress || { current: 0, total: 0, percent: 0 },
            startTime: state.startTime || Date.now()
          });
          
          // 立即向所有连接的客户端推送扫描状态
          io.emit('scanProgress', {
            libraryId,
            ...state.progress,
            resuming: true
          });
          
          // 延迟启动实际扫描，等服务完全准备好
          setTimeout(() => {
            const db = dbPool.acquire(lib.path);
            // 继续扫描（从中断处继续）
            scanner.scanLibrary(
              lib.path,
              db,
              (progress) => {
                io.emit('scanProgress', { libraryId, ...progress });
              },
              libraryId
            ).then(() => {
              scanManager.completeScan(libraryId);
              io.emit('scanComplete', { libraryId });
              dbPool.release(lib.path);
              console.log(`✅ 扫描完成: ${lib.name}`);
            }).catch((err) => {
              console.error(`❌ 扫描失败: ${lib.name}`, err.message);
              scanManager.completeScan(libraryId);
              dbPool.release(lib.path);
            });
          }, 2000);
        }
      }
    }
    
    // 为当前素材库启动文件监控（仅当索引存在时）
    if (currentConfig.currentLibraryId) {
      const currentLib = currentConfig.libraries.find(lib => lib.id === currentConfig.currentLibraryId);
      if (currentLib) {
        const fs = require('fs');
        const { getNiuPicPath, getDatabasePath } = require('./src/config');
        const niupicPath = getNiuPicPath(currentLib.path);
        const dbPath = getDatabasePath(currentLib.path);
        
        // 只有当文件夹和索引都存在时才启动监控
        const folderExists = fs.existsSync(currentLib.path);
        const indexExists = fs.existsSync(niupicPath) && fs.existsSync(dbPath);
        
        if (folderExists && indexExists) {
          lightweightWatcher.watch(currentLib.id, currentLib.path, currentLib.name, io);
        } else {
          console.log(`⚠️ 跳过文件监控: ${currentLib.name} (${!folderExists ? '文件夹不存在' : '索引不存在'})`);
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ 初始化失败:', e.message);
  }
});

// 标记是否正在关闭
let isShuttingDown = false;

// 优雅关闭
const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('\n🛑 正在关闭服务器...');

  // 停止接受新连接
  server.close(() => {
    console.log('✅ HTTP 服务器已关闭');
  });

  // 停止监控
  memoryMonitor.stop();
  cleanupManager.stopRoutineCleanup();

  // 停止所有文件监控
  lightweightWatcher.stopAll();

  // 等待扫描任务完成当前批次（最多等2秒）
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 关闭所有数据库连接
  dbPool.closeAll();

  console.log('✅ 关闭完成');
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// 错误处理
process.on('uncaughtException', (error) => {
  console.error('💥 未捕获异常:', error.message);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 未处理的Promise拒绝:', reason);
  shutdown();
});

// 导出供测试使用。
// ⚠️ 这里必须是**唯一**给 module.exports 赋值的地方：以前上面还写过
// `module.exports.isShuttingDown = …`，然后被这一行整个覆盖掉 —— 导出看着有、
// 实际永远拿到 undefined（谁也发现不了，因为没人调用它才没炸）。
module.exports = { app, server, io, isShuttingDown: () => isShuttingDown };
