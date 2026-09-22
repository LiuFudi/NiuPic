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
const fs = require('fs');
const os = require('os');
const path = require('path');

let configModule;
let configDir;
const originalPkgVar = process.env.TRIM_PKGVAR;

before(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-config-'));
  process.env.TRIM_PKGVAR = configDir;
  // 必须在设置 TRIM_PKGVAR 之后再 require，避免模块级缓存拿到别的目录
  configModule = require('../utils/config.js');
});

after(() => {
  if (originalPkgVar === undefined) delete process.env.TRIM_PKGVAR;
  else process.env.TRIM_PKGVAR = originalPkgVar;
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
