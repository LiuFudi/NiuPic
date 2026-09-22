// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * NiuPic 飞牛应用构建脚本
 * 
 * 使用 Docker (node:22-slim, Debian) 构建 Linux glibc 版本依赖
 * 确保与飞牛 fnOS (Debian 系) 兼容
 * 
 * 用法: node scripts/build.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 路径配置
const root = path.join(__dirname, '..');
const backendDir = path.join(root, 'backend');
const frontendDir = path.join(root, 'frontend');
const packDir = path.join(root, 'niupic');
const packServerDir = path.join(packDir, 'app', 'server');

// 执行命令
function run(cmd, options = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: true, ...options });
}

// 转换 Windows 路径为 Docker 挂载路径
function toDockerPath(winPath) {
  // C:\Users\... -> /c/Users/...
  return winPath.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║       NiuPic 飞牛应用构建脚本 (Docker + Debian)            ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// ============================================================
// 1. 构建前端
// ============================================================
console.log('📦 [1/6] 构建前端...');
run('npm run build', { cwd: frontendDir });
console.log('   ✅ 前端构建完成\n');

// ============================================================
// 2. 清理并准备服务器目录
// ============================================================
console.log('🧹 [2/6] 准备服务器目录...');
if (fs.existsSync(packServerDir)) {
  fs.rmSync(packServerDir, { recursive: true });
}
fs.mkdirSync(packServerDir, { recursive: true });
console.log('   ✅ 目录已清理\n');

// ============================================================
// 3. 复制后端文件
// ============================================================
console.log('📋 [3/6] 复制后端文件...');

// 复制单文件
const backendFiles = ['server.js', 'package.json'];
backendFiles.forEach(file => {
  const src = path.join(backendDir, file);
  const dest = path.join(packServerDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`   复制: ${file}`);
  }
});

// 复制目录
const backendDirs = ['src', 'database', 'utils'];
backendDirs.forEach(dir => {
  const src = path.join(backendDir, dir);
  const dest = path.join(packServerDir, dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true });
    console.log(`   复制目录: ${dir}/`);
  }
});
console.log('   ✅ 后端文件复制完成\n');

// ============================================================
// 4. 复制前端构建产物
// ============================================================
console.log('🎨 [4/6] 复制前端构建产物...');
const frontendDist = path.join(frontendDir, 'dist');
const serverPublic = path.join(packServerDir, 'public');
if (fs.existsSync(frontendDist)) {
  fs.cpSync(frontendDist, serverPublic, { recursive: true });
  console.log('   复制: frontend/dist -> app/server/public');
}
console.log('   ✅ 前端产物复制完成\n');

// ============================================================
// 5. 使用 Docker 安装 Linux 依赖
// ============================================================
console.log('🐳 [5/6] 使用 Docker 安装 Linux 依赖...');
console.log('   镜像: node:22-slim (Debian, glibc)');
console.log('   目标: 飞牛 fnOS (Debian 系)');
console.log('   ⏳ 首次构建需要编译原生模块，约需 1-3 分钟...\n');

const dockerPath = toDockerPath(packServerDir);

// 创建临时安装脚本（使用国内镜像源）
const installScript = `#!/bin/sh
set -e

# 使用阿里云镜像源加速（避免连接超时）
# 兼容新旧版本的 Debian 配置
if [ -f /etc/apt/sources.list ]; then
    sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list
    sed -i 's/security.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list
fi

if [ -d /etc/apt/sources.list.d ]; then
    find /etc/apt/sources.list.d -name "*.sources" -exec sed -i 's/deb.debian.org/mirrors.aliyun.com/g; s/security.debian.org/mirrors.aliyun.com/g' {} \\;
fi

apt-get update
apt-get install -y python3 make g++ --no-install-recommends

# 配置 npm 使用国内镜像
npm config set registry https://registry.npmmirror.com

# 使用环境变量配置二进制文件镜像源（避免网络超时）
export NODEJS_ORG_MIRROR=https://registry.npmmirror.com/-/binary/node/
export SHARP_DIST_BASE_URL=https://registry.npmmirror.com/-/binary/sharp/
export BETTER_SQLITE3_BINARY_HOST=https://registry.npmmirror.com/-/binary/better-sqlite3/

rm -rf node_modules package-lock.json
npm install --production
echo
echo "=== 依赖安装完成 ==="
du -sh node_modules/
`;

const installScriptPath = path.join(packServerDir, 'install.sh');
fs.writeFileSync(installScriptPath, installScript.replace(/\r\n/g, '\n'), 'utf8');

const dockerCmd = `docker run --rm -v "${dockerPath}:/app" -w /app node:22-slim sh /app/install.sh`;

try {
  run(dockerCmd, { cwd: root });
  // 删除临时安装脚本
  if (fs.existsSync(installScriptPath)) {
    fs.unlinkSync(installScriptPath);
  }
  console.log('\n   ✅ Linux 依赖安装成功');
  console.log('   ✅ 包含 sharp-linux-x64 (glibc 版本)');
  console.log('   ✅ 包含 better-sqlite3 (Linux 编译版本)\n');
} catch (error) {
  // 删除临时安装脚本
  if (fs.existsSync(installScriptPath)) {
    fs.unlinkSync(installScriptPath);
  }
  console.error('\n   ❌ Docker 构建失败');
  console.error('   错误:', error.message);
  console.log('\n   请检查:');
  console.log('   1. Docker Desktop 是否正在运行');
  console.log('   2. 是否有 node:22-slim 镜像 (docker pull node:22-slim)');
  console.log('   3. 网络连接是否正常');
  process.exit(1);
}

// ============================================================
// 6. 修复脚本换行符 (Windows -> Unix)
// ============================================================
console.log('🔧 [6/6] 修复脚本换行符...');
const cmdDir = path.join(packDir, 'cmd');
if (fs.existsSync(cmdDir)) {
  const scripts = fs.readdirSync(cmdDir);
  scripts.forEach(script => {
    const scriptPath = path.join(cmdDir, script);
    if (fs.statSync(scriptPath).isFile()) {
      let content = fs.readFileSync(scriptPath, 'utf8');
      content = content.replace(/\r\n/g, '\n');
      fs.writeFileSync(scriptPath, content, { encoding: 'utf8' });
      console.log(`   修复: cmd/${script}`);
    }
  });
}
console.log('   ✅ 换行符修复完成\n');

// ============================================================
// 完成
// ============================================================
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║                    🎉 构建完成！                           ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log(`📁 打包目录: ${packDir}\n`);

console.log('📦 包含内容:');
console.log('   • app/server/         后端代码 + 前端构建产物');
console.log('   • app/server/node_modules/  Linux glibc 依赖 (~57MB)');
console.log('   • app/ui/             UI 配置');
console.log('   • cmd/                生命周期脚本');
console.log('   • config/             资源配置');
console.log('   • wizard/             安装向导');
console.log('   • manifest            应用清单');
console.log('   • ICON*.PNG           应用图标\n');

console.log('📋 下一步:');
console.log('   1. 上传 niupic 文件夹到飞牛 NAS');
console.log('      例如: /vol1/1000/niupic');
console.log('');
console.log('   2. SSH 登录飞牛，打包应用:');
console.log('      cd /vol1/1000/niupic');
console.log('      fnpack build');
console.log('');
console.log('   3. 安装生成的 .fpk 文件');
console.log('      在应用中心 -> 手动安装 -> 选择 niupic_x.x.x_all.fpk');
