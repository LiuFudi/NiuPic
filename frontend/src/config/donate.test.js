// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 打赏功能的静态约束（《打赏功能规范》）
 *
 * 这些检查放在单元测试里而不是只靠端到端，是因为它们大多**在界面上看不出来**：
 * 比如"收款码是不是内嵌的"、"文案里有没有催促的措辞"、"README 那段有没有超长"，
 * 端到端跑一遍也未必发现。规范里每一条硬约束都在这里钉住。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import donateConfig from '../config/donate.json';
import { DONATE_QR } from '../assets/donateQr.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');   // 仓库根

describe('打赏入口：收款码内嵌', () => {
  it('微信与支付宝都在，且都是 data URI（不是图片文件路径）', () => {
    const keys = (donateConfig.qrcodes || []).map((q) => q.key);
    expect(keys).toEqual(['wechat', 'alipay']);
    for (const key of keys) {
      expect(typeof DONATE_QR[key]).toBe('string');
      expect(DONATE_QR[key].startsWith('data:image/')).toBe(true);
      // 内嵌是这条规范的核心：不能是 /xxx.png 这种路径
      expect(DONATE_QR[key]).not.toMatch(/^(\/|https?:)/);
    }
  });

  it('收款码是真实 PNG 且边长 ≥ 500px（规范 5.3）', () => {
    for (const key of Object.keys(DONATE_QR)) {
      const base64 = DONATE_QR[key].split(',')[1] || '';
      const head = Buffer.from(base64.slice(0, 64), 'base64');
      // PNG 签名 + IHDR 前 8 字节里就有宽高（大端 uint32）
      expect(head.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const width = head.readUInt32BE(16);
      const height = head.readUInt32BE(20);
      expect(width).toBeGreaterThanOrEqual(500);
      expect(height).toBeGreaterThanOrEqual(500);
    }
  });

  it('收款码体积不必很大（二值化后 600×600 只要几 KB —— 别用体积当质量指标）', () => {
    for (const key of Object.keys(DONATE_QR)) {
      const bytes = (DONATE_QR[key].split(',')[1] || '').length * 0.75;
      // 只是防止"整张图被误塞进来"（比如把整屏截图内嵌了）
      expect(bytes).toBeLessThan(120 * 1024);
    }
  });

  it('包内/安装目录里没有独立的收款码图片文件（否则拆包换一张就能换成别人的码）', () => {
    // 前端源码树里除了生成物，不该存在收款码图片
    const candidates = [
      join(ROOT, 'frontend', 'public', 'wechat.png'),
      join(ROOT, 'frontend', 'public', 'alipay.png'),
      join(ROOT, 'frontend', 'src', 'assets', 'wechat.png'),
      join(ROOT, 'frontend', 'src', 'assets', 'alipay.png'),
      join(ROOT, 'niupic', 'app', 'ui', 'wechat.png'),
      join(ROOT, 'niupic', 'app', 'ui', 'alipay.png'),
    ];
    expect(candidates.filter((p) => existsSync(p))).toEqual([]);
  });
});

describe('打赏入口：文案约束（规范第四节 + 附录 B）', () => {
  const texts = [donateConfig.title, donateConfig.message, donateConfig.note,
    ...(donateConfig.qrcodes || []).map((q) => q.label)].join('\n');

  it('不出现催促 / 祈使 / 情感绑架的措辞', () => {
    for (const bad of ['请支持', '请打赏', '您的支持', '你的支持', '是我更新的动力',
      '立即支持', '感谢您的慷慨', '支持一下作者吧']) {
      expect(texts).not.toContain(bad);
    }
  });

  it('不强调"入口关不掉 / 不会打扰"（那读起来像"你甩不掉它"）', () => {
    for (const bad of ['关不掉', '无法关闭', '没有关闭', '不会打扰', '不会自动弹出']) {
      expect(texts).not.toContain(bad);
    }
  });

  it('说清"自愿"与"不影响功能"', () => {
    expect(texts).toContain('自愿');
    expect(texts).toMatch(/不影响任何功能/);
  });

  it('有 enabled 开关（供分发者在源码层面整体关闭，界面里改不到）', () => {
    expect(typeof donateConfig.enabled).toBe('boolean');
  });
});

describe('打赏入口：README 文案（规范 4.4：不超过 5 行）', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const section = readme.split(/^## 打赏支持$/m)[1]?.split(/^## /m)[0] ?? '';

  it('有"打赏支持"这一节', () => {
    expect(readme).toMatch(/^## 打赏支持$/m);
  });

  it('正文不超过 5 行', () => {
    const body = section.split('\n').filter((l) => l.trim() !== '');
    expect(body.length).toBeLessThanOrEqual(5);
  });

  it('不写实现细节、不写"怎么替换收款码"、不说"关不掉"', () => {
    expect(section).not.toMatch(/donate\.json|donateQr|data URI|make-donate-qr/);
    expect(section).not.toMatch(/替换|换成自己的/);
    expect(section).not.toMatch(/关不掉|无法关闭|不会打扰|不会自动弹出/);
  });

  it('写明纯本地与自愿', () => {
    expect(section).toMatch(/纯本地|不联网/);
    expect(section).toMatch(/自愿/);
  });
});
