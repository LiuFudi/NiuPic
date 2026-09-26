#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

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
const zlib = require('zlib');

// ==================== 路径 ====================
const ROOT = path.join(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const BACKEND_DIR = path.join(ROOT, 'backend');
const PACK_DIR = path.join(ROOT, 'niupic');
const SERVER_DIR = path.join(PACK_DIR, 'app', 'server');
const BUILD_DIR = path.join(ROOT, 'build');
const DEPS_DIR = path.join(BUILD_DIR, 'server-deps');
// 运行时依赖树的锁文件，**进仓库**（build/ 是忽略目录，所以放在 scripts/ 下）。
// 为什么必须有：backend/package.json 里写的是 ^11.10.0 这种范围，直接 pnpm install
// 每次解析出的 transitive 版本可能不同 —— 同一个源码包在两次构建里装出的依赖不一样，
// 交付出去的包就没法复现，也等于把"上游什么时候发了新版"的随机性带进了成品。
const DEPS_LOCK_DIR = path.join(ROOT, 'scripts', 'server-deps');
const DEPS_LOCK = path.join(DEPS_LOCK_DIR, 'pnpm-lock.yaml');
const PREBUILT_DIR = path.join(BUILD_DIR, 'prebuilt');
const DIST_DIR = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const SKIP_FRONTEND = args.includes('--skip-frontend');
const SKIP_DEPS = args.includes('--skip-deps');
const UPDATE_LOCK = args.includes('--update-lockfile');

const nm = (p) => path.join(SERVER_DIR, 'node_modules', ...p.split('/'));

/**
 * 递归复制目录。
 *
 * ⚠️ 为什么要包一层、不用 `fs.cpSync`：**Node 22.x + Windows 上它会让进程直接崩掉**。
 * 实测（node v22.23.3 / Windows 10 19045）：`fs.cpSync('backend/src', dest, {recursive:true})`
 * 以 `0xC0000409`（STATUS_STACK_BUFFER_OVERRUN）fail-fast 退出 —— 抛不出任何 JS 异常，
 * try/catch 也拦不住，打包脚本跑到「[3/7] 组装 niupic/app/server」打印两行之后就无声结束
 * （`node scripts/build-fpk.js` 的退出码是 -1073740791）。同一个目录换成
 * `fs.promises.cp`（异步版）或手写递归都正常复制 26 个文件，所以这里统一走异步版。
 *
 * 顺带说明：这条只在 Windows 上暴露，正是"构建脚本必须跨平台"要挡住的那类问题。
 */
const copyDir = (from, to) => fs.promises.cp(from, to, { recursive: true });

/** 读一个 tar 头里的八进制数值字段 */
function readTarOctal(header, offset, length) {
  const text = header.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/s, '').trim();
  return text ? parseInt(text, 8) : 0;
}

/** 写一个 tar 头里的八进制数值字段（7 位数字 + NUL，与 bsdtar/fnpack 的写法一致） */
function writeTarOctal(header, offset, length, value) {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

/** 遍历 tar（Buffer），对每个条目回调 (header, name, size) */
function walkTar(tar, visit) {
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break; // 结束块（全零）
    const size = readTarOctal(header, 124, 12);
    visit(header, name, size);
    pos += 512 + Math.ceil(size / 512) * 512;
  }
}

/**
 * 修正 fpk 内的权限位（构建期自校验，不通过就让构建失败）。
 *
 * 为什么必须有这一步：**fnpack 的 Windows 构建（fnpack-1.2.3-windows-amd64）把每个条目
 * 都写成 0666、目录写成 0777**。后果是致命的 —— `cmd/main` 进包后**没有执行位**，
 * 而应用中心是直接执行 `/var/apps/<appname>/cmd/main` 的，应用根本起不来。
 * 这正是《飞牛fpk开发规范》9.3 与坑 15 记的那个现象（"进包后没有执行位 → 起不来"）；
 * Linux 版 fnpack 会保留源文件的权限位，所以在 Linux 上打包不会暴露这个问题。
 * 实测：Windows 打出来的 cmd/main 是 `-rw-rw-rw-`、cmd/ 目录是 `drwxrwxrwx`。
 *
 * 做法：**只改 tar 头里的 mode 字段并重算头部 checksum**，不碰任何文件内容 ——
 * 所以 manifest 里的 `checksum`（= md5(app.tgz)）依旧有效，包里其它字节一个没动。
 * 目录 0755、其它文件 0644、`cmd/*` 0755。对 Linux 打出来的包是幂等的（本来就是这些值）。
 */
function fixFpkModes(fpkPath) {
  const tar = zlib.gunzipSync(fs.readFileSync(fpkPath));
  let patched = 0;

  walkTar(tar, (header, name, size) => {
    const isDir = String.fromCharCode(header[156]) === '5' || name.endsWith('/');
    const desired = isDir ? 0o755 : (name.startsWith('cmd/') ? 0o755 : 0o644);
    const current = readTarOctal(header, 100, 8);
    if (current === desired) return;
    writeTarOctal(header, 100, 8, desired);
    // checksum 必须重算：算的时候 checksum 字段本身按 8 个空格计
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    patched += 1;
  });

  // 反向校验：包里的 cmd/main 必须是 0755，否则宁可构建失败也不要发出装不上的包
  let mainMode = null;
  walkTar(tar, (header, name) => { if (name === 'cmd/main') mainMode = readTarOctal(header, 100, 8); });
  if (mainMode !== 0o755) {
    fail(`fpk 权限修正失败：cmd/main 的权限是 ${mainMode === null ? '未找到' : mainMode.toString(8)}，期望 755`);
  }

  if (patched > 0) {
    fs.writeFileSync(fpkPath, zlib.gzipSync(tar, { level: 9 }));
    log(`   修正 ${patched} 个条目的权限位（cmd/*=755、目录=755、其余=644）`);
  }
  log('   已确认 cmd/main = 755');
}

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

/**
 * 把目录里的文件权限归一到"文件 644、目录 755"。
 *
 * 为什么是**强制** 644 而不是"保留原有 +x"：app/server 与 app/ui 里没有一个文件是靠
 * 可执行位运行的（`cmd/main` 用 `node server.js` 起服务；`app/ui/config` 是给平台读的
 * 文本）。而"保留 +x"等于把上游工具链的权限习惯放进来 —— 实测 Vite 写出的 dist 就是
 * 755，于是成品里前端产物带可执行位、而干净重建的却没有（两边都是这台机器构建的，
 * 差别只在谁先写的文件）。**结果不确定的规则不是规则。**
 *
 * node_modules 一律不碰：里面可能有需要可执行位的预编译产物，动了会坏。
 */
function normalizeModes(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      fs.chmodSync(full, 0o755);
      normalizeModes(full);
    } else if (entry.isFile()) {
      fs.chmodSync(full, 0o644);
    }
  }
}
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

/**
 * 递归删除 node_modules 下的 .bin 目录，并清掉所有软链接。
 *
 * 飞牛的安装器解压 app.tgz 时无法处理「目标不存在的绝对软链接」，
 * 会直接报「解压app.tgz失败」。pnpm 在 Linux/macOS 上恰好就会生成这种链接。
 */
function stripBinAndSymlinks(root) {
  let removedBins = 0;
  let removedLinks = 0;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (e) {
        continue;
      }
      if (st.isSymbolicLink()) {
        fs.unlinkSync(full);
        removedLinks += 1;
        continue;
      }
      if (!st.isDirectory()) continue;
      if (entry.name === '.bin') {
        fs.rmSync(full, { recursive: true, force: true });
        removedBins += 1;
        continue;
      }
      walk(full);
    }
  };

  walk(root);

  // 再扫一遍，确认真的没有软链接了 —— 有的话宁可让构建失败，也别生成装不上的包
  const leftovers = [];
  const verify = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) leftovers.push(full);
      else if (st.isDirectory()) verify(full);
    }
  };
  verify(root);
  if (leftovers.length) {
    fail(`node_modules 里仍有 ${leftovers.length} 个软链接，飞牛解压会失败：\n  ${leftovers.slice(0, 5).join('\n  ')}`);
  }

  log(`   清理了 ${removedBins} 个 .bin 目录、${removedLinks} 个软链接`);
}

function detectPackageManager() {
  for (const pm of ['pnpm', 'npm']) {
    if (commandExists(pm)) return pm;
  }
  fail('未找到 pnpm 或 npm，请先安装其一');
  return null;
}

/**
 * pnpm 主版本必须 ≥ 10。
 *
 * 为什么：解析"给飞牛用的 Linux x64 依赖"靠的是 `pnpm-workspace.yaml` 里的
 * `supportedArchitectures`，而 **pnpm 9 及更早不认这个设置** —— 它会老老实实按当前
 * 开发机的平台装可选依赖，于是 sharp 的 `@img/sharp-linux-x64` 根本不会出现，
 * 构建最后停在 `缺少 @img/sharp-linux-x64，依赖未按 linux x64 解析`。
 * 那个报错完全不提 pnpm，实测时很容易往"依赖解析/镜像"方向查半天（本轮就踩了）。
 * 所以这里提前拦一道，把原因和解法直接写出来。
 */
function assertPnpmVersion(pm) {
  if (pm !== 'pnpm') {
    log('   提示: 用 pnpm 构建才走锁文件与跨平台依赖解析，npm 不保证同样的结果');
    return;
  }
  const result = spawnSync('pnpm', ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const text = String(result.stdout || '').trim();
  const major = Number.parseInt(text.split('.')[0], 10);
  if (!Number.isFinite(major)) {
    log(`   提示: 读不到 pnpm 版本（${text || '空'}），跳过版本检查`);
    return;
  }
  if (major < 10) {
    fail(
      `pnpm ${text} 太旧：跨平台解析 Linux 依赖需要 pnpm ≥ 10\n` +
      '  （pnpm 9 不认 supportedArchitectures → sharp 的 linux-x64 包装不上）\n' +
      '  升级：npm i -g pnpm@10',
    );
  }
  log(`   pnpm ${text}（≥ 10，supportedArchitectures 生效）`);
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

// 版本号只能有一处"真源"，但实际必然写在三个地方（包清单、npm 包、变更日志）。
// 漏改一处就会发出一个版本号自相矛盾的包，所以构建时先交叉校验，直接拦住。
function checkVersionConsistency() {
  const manifestVersion = readManifestVersion();

  // 上架要求第 6 条：版本号必须是**纯三段数字** x.y.z。
  // 4 段式无效；`x.y.z-beta` 这种非数字后缀在平台看来和 `x.y.z` 是同一个版本
  // （区分不了、也就升不了级），所以构建期就拦住，别等审核才发现。
  if (!/^\d+\.\d+\.\d+$/.test(manifestVersion)) {
    fail(`版本号必须是纯三段式 x.y.z（飞牛应用中心要求），当前是 "${manifestVersion}"`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.version !== manifestVersion) {
    fail(`版本号不一致：niupic/manifest = ${manifestVersion}，package.json = ${pkg.version}`);
  }

  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  if (!new RegExp(`^##\\s*${manifestVersion.replace(/\./g, '\\.')}\\s*$`, 'm').test(changelog)) {
    fail(`CHANGELOG.md 里没有 ${manifestVersion} 的条目（应有一行 "## ${manifestVersion}"）`);
  }

  return manifestVersion;
}

// ==================== 主流程 ====================
const TOTAL_STEPS = SKIP_DEPS ? 5 : 7;

(async () => {
  const pm = detectPackageManager();
  const fnpack = detectFnpack();

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        NiuPic 飞牛 fnOS 打包（跨平台，无需 Docker）        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  log(`   包管理器: ${pm}   fnpack: ${fnpack}`);
  assertPnpmVersion(pm);

  // 版本号交叉校验放在最前面：改漏了直接停，不要浪费几分钟构建完才发现
  const version = checkVersionConsistency();
  log(`   版本号: ${version}（manifest / package.json / CHANGELOG 一致）`);

  // SPDX 头兜底扫描（新增文件最容易漏，见 scripts/check-spdx.js）。
  // 用 process.execPath 而不是 'node'：打包脚本可能跑在 node 不在 PATH 的机器上。
  run(process.execPath, [path.join(ROOT, 'scripts', 'check-spdx.js')], { cwd: ROOT });

  // ---------- 1. 构建前端 ----------
  let stepNo = 1;
  // 收款码要在前端构建**之前**重新编译进源码，否则会发出一个"包内的码"和
  // assets/donate/ 里对不上的版本 —— 这类不一致肉眼看不出来（《打赏功能规范》5.2）。
  step(stepNo++, TOTAL_STEPS, '生成内嵌收款码 (donate-qr)');
  run(process.execPath, [path.join(ROOT, 'scripts', 'make-donate-qr.js')], { cwd: ROOT });

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
    await copyDir(path.join(BACKEND_DIR, dir), path.join(SERVER_DIR, dir));
    log(`   目录: ${dir}/`);
  }
  await copyDir(path.join(FRONTEND_DIR, 'dist'), path.join(SERVER_DIR, 'public'));
  // 协议全文要跟着成品走：用户装完包，在应用里就能看到自己拿到的是什么协议，
  // 不用去翻仓库。两处都放 —— app/ui/ 是 fnOS 的应用资源目录（规矩里的位置），
  // server/public/ 由后端静态托管，界面上「关于」页直接链过去。
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(SERVER_DIR, 'public', 'LICENSE.txt'));
  fs.mkdirSync(path.join(PACK_DIR, 'app', 'ui'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(PACK_DIR, 'app', 'ui', 'LICENSE.txt'));
  log('   文件: public/LICENSE.txt 与 app/ui/LICENSE.txt  ← LICENSE');
  // 运维小工具一起进包（例如从 FlyPic 迁移索引目录的脚本）
  const TOOLS_DIR = path.join(ROOT, 'scripts', 'tools');
  if (fs.existsSync(TOOLS_DIR)) {
    await copyDir(TOOLS_DIR, path.join(SERVER_DIR, 'scripts'));
    log('   目录: scripts/  ← scripts/tools');
  }
  log('   目录: public/  ← frontend/dist');

  // 权限归一：**只针对我们自己的文件**（app/server 里的源码与前端产物、app/ui、cmd、wizard）。
  // 为什么需要：写文件的工具/编辑器权限各不相同（本机实测：某些源文件是 600、前端产物是 755），
  // 一路 cpSync 下来就会带进成品。fnOS 安装时会把整个应用目录改成 niupic:niupic 775
  // （真机实测），所以这不是"能不能跑"的问题，而是"拆开包看见一堆 600 文件"的问题。
  // node_modules 不动 —— 里面可能有需要可执行位的预编译产物，动了会坏。
  normalizeModes(SERVER_DIR);
  normalizeModes(path.join(PACK_DIR, 'app', 'ui'));

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

    // 有锁文件就锁定安装（--frozen-lockfile 会在 package.json 与锁文件不一致时报错退出，
    // 正好挡住"改了 backend/package.json 但忘了更新锁文件"这种情况）；
    // 想更新锁文件：node scripts/build-fpk.js --update-lockfile
    const haveLock = fs.existsSync(DEPS_LOCK);
    if (haveLock && !UPDATE_LOCK) {
      fs.copyFileSync(DEPS_LOCK, path.join(DEPS_DIR, 'pnpm-lock.yaml'));
      log(`   使用锁文件 scripts/server-deps/pnpm-lock.yaml（依赖版本锁定）`);
      run(pm, ['install', '--prod', '--ignore-scripts', '--frozen-lockfile'], { cwd: DEPS_DIR });
    } else {
      if (UPDATE_LOCK) log('   --update-lockfile：重新解析依赖并写回锁文件');
      else if (!haveLock) log('   没有锁文件，首次解析依赖（之后会写入 scripts/server-deps/）');
      run(pm, ['install', '--prod', '--ignore-scripts'], { cwd: DEPS_DIR });
      const generated = path.join(DEPS_DIR, 'pnpm-lock.yaml');
      if (fs.existsSync(generated)) {
        fs.mkdirSync(DEPS_LOCK_DIR, { recursive: true });
        fs.copyFileSync(generated, DEPS_LOCK);
        log('   已写入 scripts/server-deps/pnpm-lock.yaml（记得一起提交）');
      }
    }

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
  await copyDir(depsNodeModules, nm(''));
  log(`   node_modules 就位: ${(fs.readdirSync(nm('')).length)} 个顶层条目`);

  // pnpm 在 Linux/macOS 上会把 node_modules/.bin 建成**软链接**，而且指向构建机的
  // 绝对路径（例如 /home/me/project/build/server-deps/node_modules/...）。
  // 这些链接打进 fpk 后目标根本不存在，飞牛安装器解压 app.tgz 会直接失败，
  // 报错就是「解压app.tgz失败」。.bin 只是给命令行用的 shim，运行时不依赖它，
  // 所以整目录删掉即可（Windows 上生成的是 .CMD/.ps1 文件，删掉同样无害）。
  stripBinAndSymlinks(nm(''));
  log('   已清理 node_modules/.bin 与残留软链接（否则飞牛解压会失败）');

  // pnpm 的记账文件里记着**构建机的绝对路径**（storeDir、workspace 路径）。
  // 这些文件只在 pnpm 自己管理依赖树时有用，运行 node_modules 里的代码时根本不读，
  // 留着等于把构建机的目录结构随成品发出去（规范里明确不允许主机专属路径进交付物）。
  const pnpmBookkeeping = [
    '.modules.yaml',
    '.pnpm-workspace-state-v1.json',
    '.pnpm-workspace-state.json',
    '.package-map.json',   // pnpm 的包路径映射表，运行时不读
    '.pnpm',               // 里面还有一份 lock.yaml 副本，同样只是记账
  ];
  for (const f of pnpmBookkeeping) {
    const target = path.join(nm(''), f);
    if (fs.existsSync(target)) {
      // recursive 必须带上：.pnpm 是目录，不带 recursive 会 EISDIR 直接崩
      fs.rmSync(target, { recursive: true, force: true });
      log(`   已移除 pnpm 记账文件: node_modules/${f}（内含构建机路径，运行时不需要）`);
    }
  }

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

  // ---------- 5. 统一脚本换行符与包内权限 ----------
  step(stepNo++, TOTAL_STEPS, '修正 cmd/ 脚本换行符与权限 (CRLF -> LF, chmod 755)');
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

  // 包内权限：cmd/* 必须 755，其余文件 644。
  //
  // 为什么必须在构建期强制：**fnpack 按源文件权限打包**，而权限位跟着文件系统走 ——
  // 在 Windows / WSL 的 /mnt 下解开源码包再构建时，cmd/main 很可能没有执行位，
  // 进包后应用中心直接起不来（规范 9.3 与坑 15；本项目已经犯过两次）。
  // 所以这里不赌 git 的 core.fileMode，构建前一律重设。
  // normalizeModes 会跳过 node_modules（里面有需要可执行位的预编译产物）。
  normalizeModes(PACK_DIR);
  if (fs.existsSync(cmdDir)) {
    for (const name of fs.readdirSync(cmdDir)) {
      const file = path.join(cmdDir, name);
      if (fs.statSync(file).isFile()) fs.chmodSync(file, 0o755);
    }
    log('   cmd/* -> 755，其余文件 -> 644');
  }

  // ---------- 6. 调用 fnpack 生成 fpk ----------
  step(stepNo++, TOTAL_STEPS, '调用 fnpack 生成 .fpk');
  run(fnpack, ['build', '--directory', PACK_DIR], { cwd: ROOT });

  const produced = path.join(ROOT, 'niupic.fpk');
  if (!fs.existsSync(produced)) fail('fnpack 未生成 niupic.fpk');

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const finalName = `niupic_${version}_x86.fpk`;
  const finalPath = path.join(DIST_DIR, finalName);
  fs.rmSync(finalPath, { force: true });
  fs.renameSync(produced, finalPath);

  // 权限位后处理 + 自校验（Windows 版 fnpack 会把 cmd/main 写成 0666 → 装上去起不来）
  fixFpkModes(finalPath);

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
