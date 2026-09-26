// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 配置备份测试
 *
 * 背景：飞牛在「手动安装新版本」时会先按卸载流程跑一遍旧版本，
 * 老版本的卸载脚本会把 config.json 删掉 —— 素材库列表、主题色、访问密码全丢，
 * 每次更新都等于重装。
 *
 * 现在的做法是两层保险：
 *   1. 卸载脚本默认保留数据（见 niupic/cmd/uninstall_callback，由 test-lifecycle.sh 覆盖）
 *   2. 每次保存配置都顺手写一份 config.json.bak，
 *      安装时 cmd/install_init 发现 config.json 不在就自动恢复
 *
 * 这里锁住第 2 层：保存必须同时写主文件和备份。
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let configModule;
let configDir;
const originalPkgVar = process.env.TRIM_PKGVAR;
const originalPkgEtc = process.env.TRIM_PKGETC;

before(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-config-'));
  process.env.TRIM_PKGVAR = configDir;
  // 配置目录的解析结果会被模块缓存，所以顺手把 TRIM_PKGETC 摘掉：
  // 否则在装了 NiuPic 的机器上跑测试，配置会写进真实的 etc/ 目录里去。
  delete process.env.TRIM_PKGETC;
  // 必须在设置 TRIM_PKGVAR 之后再 require，避免模块级缓存拿到别的目录
  configModule = require('../utils/config.js');
});

after(() => {
  if (originalPkgVar === undefined) delete process.env.TRIM_PKGVAR;
  else process.env.TRIM_PKGVAR = originalPkgVar;
  if (originalPkgEtc === undefined) delete process.env.TRIM_PKGETC;
  else process.env.TRIM_PKGETC = originalPkgEtc;
  fs.rmSync(configDir, { recursive: true, force: true });
});

const mainPath = () => path.join(configDir, 'config.json');
const backupPath = () => path.join(configDir, 'config.json.bak');

test('第一次读取配置会落盘，并且同时写出备份', () => {
  configModule.clearConfigCache();
  const config = configModule.loadConfig(true);

  assert.ok(fs.existsSync(mainPath()), 'config.json 应该被创建');
  assert.ok(fs.existsSync(backupPath()), 'config.json.bak 应该同时被创建');
  assert.strictEqual(config.themeColor, '', '默认主题色是空串（= 内置蓝）');
});

test('保存配置时备份跟着更新', () => {
  configModule.updateThemeColor('#ef4444');

  const main = JSON.parse(fs.readFileSync(mainPath(), 'utf8'));
  const backup = JSON.parse(fs.readFileSync(backupPath(), 'utf8'));

  assert.strictEqual(main.themeColor, '#ef4444');
  assert.deepStrictEqual(backup, main, '备份内容必须和主文件一致');
});

test('备份里带着恢复所需的关键字段', () => {
  configModule.updateTheme('dark');
  const backup = JSON.parse(fs.readFileSync(backupPath(), 'utf8'));

  for (const key of ['libraries', 'theme', 'themeColor', 'currentLibraryId', 'preferences']) {
    assert.ok(Object.prototype.hasOwnProperty.call(backup, key), `备份缺少 ${key}`);
  }
  assert.strictEqual(backup.theme, 'dark');
});

test('主文件被删掉后，备份还在（install_init 靠它恢复）', () => {
  configModule.updateThemeColor('#10b981');
  fs.rmSync(mainPath());

  assert.ok(!fs.existsSync(mainPath()));
  assert.ok(fs.existsSync(backupPath()), '备份不应该被连带删除');

  // 模拟 cmd/install_init 的恢复动作
  fs.copyFileSync(backupPath(), mainPath());
  configModule.clearConfigCache();
  const restored = configModule.loadConfig(true);

  assert.strictEqual(restored.themeColor, '#10b981', '恢复出来的配置应当完好');
});

test('备份写入失败不影响主流程', () => {
  // 把备份路径做成目录，copyFile 必然失败
  fs.rmSync(backupPath(), { force: true });
  fs.mkdirSync(backupPath());

  try {
    const ok = configModule.saveConfig({ libraries: [], theme: 'light', themeColor: '#3b82f6' });
    assert.strictEqual(ok, true, '备份失败也要返回保存成功');
    const main = JSON.parse(fs.readFileSync(mainPath(), 'utf8'));
    assert.strictEqual(main.themeColor, '#3b82f6', '主文件仍然写成功');
  } finally {
    fs.rmdirSync(backupPath());
  }
});

/**
 * 配置的正式位置是 etc/（TRIM_PKGETC，卸载不删），老位置是 var/（TRIM_PKGVAR）。
 *
 * 为什么必须锁住这条：把配置挪到 etc/ 是为了让"升级/重装"天然保住用户配置，
 * 但搬迁一旦写错，表现就是**用户升级后素材库列表和口令全没了**（比不搬更糟）。
 * 所以这里同时验证三件事：落在 etc/、老配置被带过来、老文件仍然留着。
 *
 * 目录解析结果在模块里缓存，同一个进程里没法重解析一次，所以用子进程跑干净的一次。
 */
test('配置优先落在 etc/，并把 var/ 里的老配置带过去（老文件保留）', () => {
  const etcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-etc-'));
  const varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-var-'));

  try {
    // 模拟"从 2.5.4 及更早升上来"的用户：配置还在 var/
    fs.writeFileSync(
      path.join(varDir, 'config.json'),
      JSON.stringify({ libraries: [], themeColor: '#abcdef' })
    );

    const script = `
      const cfg = require(${JSON.stringify(require.resolve('../utils/config.js'))});
      cfg.loadConfig(true);
    `;
    execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TRIM_PKGETC: etcDir, TRIM_PKGVAR: varDir },
    });

    const inEtc = path.join(etcDir, 'config.json');
    assert.ok(fs.existsSync(inEtc), '配置应该落在 etc/');
    assert.strictEqual(
      JSON.parse(fs.readFileSync(inEtc, 'utf8')).themeColor,
      '#abcdef',
      '老配置（var/）必须被带过来'
    );
    assert.ok(
      fs.existsSync(path.join(varDir, 'config.json')),
      '老位置那份要留着当兜底（是复制不是移动）'
    );
    assert.ok(
      !fs.readdirSync(etcDir).some((name) => name.startsWith('.niupic-write-test-')),
      '可写性探测文件不该残留'
    );
  } finally {
    fs.rmSync(etcDir, { recursive: true, force: true });
    fs.rmSync(varDir, { recursive: true, force: true });
  }
});
