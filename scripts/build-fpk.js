#!/usr/bin/env node
/**
 * NiuPic 飞牛 fnOS 打包脚本（跨平台，无需 Docker）
 *
 * 产物：dist/niupic_<version>_x86.fpk
 *
 * 与 build.js（Docker 方案）的区别：
 *   build.js 在 Linux 容器里 npm install，靠本机编译得到 Linux 原生模块；
 *   本脚本则在任意开发机上直接拉取 Linux x64 glibc 的**官方预编译产物**，
 *   因此不需要 Docker，但原生模块的版本必须与飞牛运行时（nodejs_v22，ABI 127）匹配。
 *
 * 前置条件：
 *   1. Node.js >= 18
 *   2. pnpm（推荐）或 npm
 *   3. fnpack：https://developer.fnnas.com/docs/cli/fnpack/
 *      - 放到 PATH，或用 FNPACK 环境变量指定可执行文件路径
 *   4. frontend/ 已安装依赖（pnpm install --ignore-workspace 或 npm install）
 *
 * 用法：
 *   node scripts/build-fpk.js
 *   node scripts/build-fpk.js --skip-frontend     # 复用已有 frontend/dist
 *   node scripts/build-fpk.js --skip-deps         # 复用已有 node_modules
 *
 * 注意：原生模块（better-sqlite3 / bcrypt）在升级依赖版本时，
 *       必须同步确认 releases 页面存在对应 ABI 与 libc 的预编译包。
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ==================== 路径 ====================
const ROOT = path.join(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const BACKEND_DIR = path.join(ROOT, 'backend');
const PACK_DIR = path.join(ROOT, 'niupic');
const SERVER_DIR = path.join(PACK_DIR, 'app', 'server');
const BUILD_DIR = path.join(ROOT, 'build');
const DEPS_DIR = path.join(BUILD_DIR, 'server-deps');
const PREBUILT_DIR = path.join(BUILD_DIR, 'prebuilt');
const DIST_DIR = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const SKIP_FRONTEND = args.includes('--skip-frontend');
const SKIP_DEPS = args.includes('--skip-deps');

const nm = (p) => path.join(SERVER_DIR, 'node_modules', ...p.split('/'));

// ==================== 飞牛运行时上的原生模块 ====================
// 飞牛依赖应用 nodejs_v22 => Node 22 => NODE_MODULE_VERSION 127；系统为 Debian（glibc）
// urls 按顺序尝试：npmmirror 二进制镜像优先（国内更快），GitHub Releases 兜底。
// 若网络不可达，可手动把压缩包放到 build/prebuilt/ 下，脚本会直接复用缓存。
const NATIVE_MODULES = [
  {
    name: 'better-sqlite3',
    urls: [
      'https://registry.npmmirror.com/-/binary/better-sqlite3/v11.10.0/better-sqlite3-v11.10.0-node-v127-linux-x64.tar.gz',
      'https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better-sqlite3-v11.10.0-node-v127-linux-x64.tar.gz',
    ],
    archive: 'better-sqlite3.tar.gz',
    from: 'build/Release/better_sqlite3.node',
    to: 'better-sqlite3/build/Release/better_sqlite3.node',
    why: 'Node 22 (ABI 127) / linux-x64 / glibc',
  },
  {
    name: 'bcrypt',
    urls: [
      'https://github.com/kelektiv/node.bcrypt.js/releases/download/v5.1.1/bcrypt_lib-v5.1.1-napi-v3-linux-x64-glibc.tar.gz',
    ],
    archive: 'bcrypt.tar.gz',
    from: 'napi-v3/bcrypt_lib.node',
    to: 'bcrypt/lib/binding/napi-v3/bcrypt_lib.node',
    why: 'N-API v3（跨 Node 版本稳定）/ linux-x64 / glibc',
  },
];
// sharp 的原生模块以 npm 可选依赖形式发布，由 supportedArchitectures 直接装好，
// 无需手工下载：@img/sharp-linux-x64 与 @img/sharp-libvips-linux-x64

// ==================== 工具函数 ====================
const log = (msg) => console.log(msg);
const step = (n, total, msg) => console.log(`\n[${n}/${total}] ${msg}`);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

function run(command, commandArgs, options = {}) {
  // Windows 上 pnpm / npm 是 .cmd 包装脚本，必须经 shell 启动；
  // 此时把整条命令拼成字符串传入，避免 spawnSync 的 DEP0190 警告。
  const useShell = process.platform === 'win32';
  const result = useShell
    ? spawnSync(
      [command, ...commandArgs].map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' '),
      { stdio: 'inherit', shell: true, ...options },
    )
    : spawnSync(command, commandArgs, { stdio: 'inherit', ...options });

  if (result.error) fail(`无法执行 ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} 执行失败（exit ${result.status}）`);
}

/** 探测命令是否存在（Windows 需要经 shell 解析 .cmd） */
function commandExists(command) {
  const probe = process.platform === 'win32'
    ? spawnSync(`where ${command}`, { stdio: 'ignore', shell: true })
    : spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

function detectPackageManager() {
  for (const pm of ['pnpm', 'npm']) {
    if (commandExists(pm)) return pm;
  }
  fail('未找到 pnpm 或 npm，请先安装其一');
  return null;
}

function detectFnpack() {
  if (process.env.FNPACK) {
    if (!fs.existsSync(process.env.FNPACK)) fail(`FNPACK 指向的文件不存在: ${process.env.FNPACK}`);
    return process.env.FNPACK;
  }
  if (commandExists('fnpack')) return 'fnpack';
  fail('未找到 fnpack。请从 https://developer.fnnas.com/docs/cli/fnpack/ 下载后放入 PATH，或用 FNPACK 环境变量指定路径');
  return null;
}

async function download(urls, dest) {
  const list = Array.isArray(urls) ? urls : [urls];

  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    log(`   复用缓存: ${path.basename(dest)}`);
    return dest;
  }

  const errors = [];
  for (const url of list) {
    log(`   下载: ${url}`);
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        // 有些镜像只镜像部分文件，返回 HTML 404 页面而不是 JSON
        errors.push(`${url} -> HTTP ${res.status}`);
        log(`   跳过（HTTP ${res.status}），尝试下一个镜像`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 1024) {
        errors.push(`${url} -> 响应过小 (${buffer.length} B)`);
        continue;
      }
      fs.writeFileSync(dest, buffer);
      log(`   完成: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
      return dest;
    } catch (error) {
      const reason = (error.cause && (error.cause.code || error.cause.message)) || error.message;
      errors.push(`${url} -> ${reason}`);
      log(`   失败（${reason}），尝试下一个镜像`);
    }
  }

  fail([
    '以下地址均下载失败：',
    ...errors.map((e) => `  - ${e}`),
    '',
    `可手动下载后放到: ${dest}`,
    '（脚本会直接复用已存在的压缩包，无需重新下载）',
  ].join('\n'));
  return null;
}

function extractTarGz(archive, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  // Windows 10+ 自带 bsdtar，Linux / macOS 均有 tar
  run('tar', ['-xzf', archive, '-C', destDir]);
}

function readManifestVersion() {
  const manifest = fs.readFileSync(path.join(PACK_DIR, 'manifest'), 'utf8');
  const line = manifest.split(/\r?\n/).find((l) => /^version\s*=/.test(l));
  if (!line) fail('niupic/manifest 缺少 version 字段');
  return line.split('=')[1].trim();
}

// ==================== 主流程 ====================
const TOTAL_STEPS = SKIP_DEPS ? 4 : 6;

(async () => {
  const pm = detectPackageManager();
  const fnpack = detectFnpack();

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        NiuPic 飞牛 fnOS 打包（跨平台，无需 Docker）        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  log(`   包管理器: ${pm}   fnpack: ${fnpack}`);

  // ---------- 1. 构建前端 ----------
  let stepNo = 1;
  step(stepNo++, TOTAL_STEPS, '构建前端 (Vite)');
  if (SKIP_FRONTEND) {
    if (!fs.existsSync(path.join(FRONTEND_DIR, 'dist', 'index.html'))) fail('--skip-frontend 但 frontend/dist 不存在');
    log('   已跳过（复用现有 frontend/dist）');
  } else {
    if (!fs.existsSync(path.join(FRONTEND_DIR, 'node_modules'))) {
      fail('frontend/node_modules 不存在，请先执行: cd frontend && pnpm install --ignore-workspace（或 npm install）');
    }
    run(pm, ['run', 'build'], { cwd: FRONTEND_DIR });
  }

  // ---------- 2. 复制后端与前端产物 ----------
  step(stepNo++, TOTAL_STEPS, '组装 niupic/app/server');
  if (fs.existsSync(SERVER_DIR)) fs.rmSync(SERVER_DIR, { recursive: true, force: true });
  fs.mkdirSync(SERVER_DIR, { recursive: true });

  for (const file of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(BACKEND_DIR, file), path.join(SERVER_DIR, file));
    log(`   文件: ${file}`);
  }
  for (const dir of ['src', 'database', 'utils']) {
    fs.cpSync(path.join(BACKEND_DIR, dir), path.join(SERVER_DIR, dir), { recursive: true });
    log(`   目录: ${dir}/`);
  }
  fs.cpSync(path.join(FRONTEND_DIR, 'dist'), path.join(SERVER_DIR, 'public'), { recursive: true });
  // 运维小工具一起进包（例如从 FlyPic 迁移索引目录的脚本）
  const TOOLS_DIR = path.join(ROOT, 'scripts', 'tools');
  if (fs.existsSync(TOOLS_DIR)) {
    fs.cpSync(TOOLS_DIR, path.join(SERVER_DIR, 'scripts'), { recursive: true });
    log('   目录: scripts/  ← scripts/tools');
  }
  log('   目录: public/  ← frontend/dist');

  // ---------- 3. 解析 Linux x64 glibc 生产依赖 ----------
  step(stepNo++, TOTAL_STEPS, '解析 Linux x64 glibc 依赖');
  const serverPkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8'));

  if (!SKIP_DEPS) {
    fs.mkdirSync(DEPS_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEPS_DIR, 'package.json'), JSON.stringify({
      name: 'niupic-server-deps',
      private: true,
      version: '1.0.0',
      description: '仅为解析 niupic/app/server 的 Linux x64 glibc 生产依赖',
      dependencies: serverPkg.dependencies,
    }, null, 2));

    // 关键：hoisted + copy 得到 npm 式扁平 node_modules（真实目录、无软链接），
    // 否则整棵依赖树无法正常打进 tar 后在 NAS 上展开。
    fs.writeFileSync(path.join(DEPS_DIR, 'pnpm-workspace.yaml'), [
      'packages: []',
      '',
      '# 目标为飞牛 fnOS：Debian / glibc / x86_64',
      'supportedArchitectures:',
      '  os:',
      '    - linux',
      '  cpu:',
      '    - x64',
      '  libc:',
      '    - glibc',
      '',
      'nodeLinker: hoisted',
      'packageImportMethod: copy',
      '',
      '# 原生模块一律使用官方预编译产物，禁止在开发机上执行编译脚本',
      'onlyBuiltDependencies: []',
      'ignoredBuiltDependencies:',
      '  - better-sqlite3',
      '  - bcrypt',
      '  - sharp',
      '  - esbuild',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(DEPS_DIR, '.npmrc'), 'node-linker=hoisted\npackage-import-method=copy\n');

    run(pm, ['install', '--prod', '--ignore-scripts'], { cwd: DEPS_DIR });

    // 移除 musl 变体，避免把错误的 libc 版本打进 fpk
    for (const musl of ['@img/sharp-linuxmusl-x64', '@img/sharp-libvips-linuxmusl-x64']) {
      const p = path.join(DEPS_DIR, 'node_modules', ...musl.split('/'));
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        log(`   移除 musl 变体: ${musl}`);
      }
    }
  } else {
    log('   已跳过（复用现有 build/server-deps/node_modules）');
  }

  const depsNodeModules = path.join(DEPS_DIR, 'node_modules');
  if (!fs.existsSync(depsNodeModules)) fail('build/server-deps/node_modules 不存在');
  fs.cpSync(depsNodeModules, nm(''), { recursive: true });
  log(`   node_modules 就位: ${(fs.readdirSync(nm('')).length)} 个顶层条目`);

  // ---------- 4. 放入原生模块预编译产物 ----------
  step(stepNo++, TOTAL_STEPS, '安装原生模块预编译产物');
  fs.mkdirSync(PREBUILT_DIR, { recursive: true });

  for (const mod of NATIVE_MODULES) {
    const archive = path.join(PREBUILT_DIR, mod.archive);
    await download(mod.urls, archive);

    const unpackDir = path.join(PREBUILT_DIR, mod.name);
    extractTarGz(archive, unpackDir);

    const source = path.join(unpackDir, ...mod.from.split('/'));
    if (!fs.existsSync(source)) fail(`${mod.name} 预编译包结构异常，缺少 ${mod.from}`);

    const target = nm(mod.to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    log(`   ${mod.name}: ${mod.to}  (${mod.why})`);
  }

  // sharp 的预编译模块由 npm 包直接提供，这里只做存在性校验
  const sharpBinding = nm('@img/sharp-linux-x64/lib/sharp-linux-x64.node');
  if (!fs.existsSync(sharpBinding)) fail('缺少 @img/sharp-linux-x64，依赖未按 linux x64 解析');
  log('   sharp: @img/sharp-linux-x64 (由 supportedArchitectures 解析)');

  // ---------- 5. 统一脚本换行符 ----------
  step(stepNo++, TOTAL_STEPS, '修正 cmd/ 脚本换行符 (CRLF -> LF)');
  const cmdDir = path.join(PACK_DIR, 'cmd');
  if (fs.existsSync(cmdDir)) {
    for (const name of fs.readdirSync(cmdDir)) {
      const file = path.join(cmdDir, name);
      if (!fs.statSync(file).isFile()) continue;
      const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      fs.writeFileSync(file, content, 'utf8');
      log(`   ${name}`);
    }
  }

  // ---------- 6. 调用 fnpack 生成 fpk ----------
  step(stepNo++, TOTAL_STEPS, '调用 fnpack 生成 .fpk');
  run(fnpack, ['build', '--directory', PACK_DIR], { cwd: ROOT });

  const version = readManifestVersion();
  const produced = path.join(ROOT, 'niupic.fpk');
  if (!fs.existsSync(produced)) fail('fnpack 未生成 niupic.fpk');

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const finalName = `niupic_${version}_x86.fpk`;
  const finalPath = path.join(DIST_DIR, finalName);
  fs.rmSync(finalPath, { force: true });
  fs.renameSync(produced, finalPath);

  const size = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(2);
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                        🎉 打包完成                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\n   产物: ${path.relative(ROOT, finalPath)}  (${size} MB)`);
  console.log('\n   安装方式：');
  console.log('     应用中心 → 手动安装 → 选择该 .fpk');
  console.log('     或: appcenter-cli install-fpk ' + finalName);
  console.log('');
})().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
