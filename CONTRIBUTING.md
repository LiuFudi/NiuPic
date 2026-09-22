# 参与开发

感谢愿意帮忙。提之前先看这一页，能省掉来回几轮。

## 提交 issue

**先搜一下**有没有同样的问题。提的时候请带上：

- 版本号（应用内「关于」，或仓库 `niupic/manifest` 的 `version`）
- 系统环境：fnOS 版本、CPU 架构（x86 / ARM）、素材库所在盘（SSD/HDD）、素材规模（多少张）
- 复现步骤，以及**实际看到什么**和**期望看到什么**
- 相关日志：应用数据目录下的 `logs/`（fnOS 上是 `/volN/@appdata/niupic/logs/`，`N` 是系统
  存储空间号，以你的 NAS 为准），贴报错附近几十行
- 截图 / 录屏（涉及界面问题时几乎必需）

**别贴**：访问口令、JWT token、真实文件路径里的私人信息（打码到只剩层级结构即可）。

## 提交代码

1. Fork → 从 `main` 拉分支，分支名 `fix/xxx` 或 `feat/xxx`
2. 改完**跑一遍测试**（下面有命令），并说明你实测了什么
3. 提交信息用 `type(scope): 说明`，例如 `fix(scan): 大库重扫不再重画未改动文件的缩略图`
4. 一个 PR 只做一件事；顺手的无关重构请单独开 PR

### 提交即同意以本项目协议授权

本项目以 **GNU GPL-3.0-or-later** 分发。你提交的贡献视为同意：

- 你对该贡献拥有版权，或已获得授权；
- 该贡献以 GPL-3.0-or-later 授权给本项目及所有下游使用者（inbound = outbound）；
- 你理解贡献一旦合并，就会随项目一起以 GPL-3.0-or-later 分发，且**不可撤回**
  （已经分发出的副本继续有效）。

不要提交从别处抄来的、协议不兼容的代码（例如 GPL-2-only、闭源、或来源不明的
"网上找的"片段）。引用了别人的思路请在 PR 里写明出处。

### 新增源文件必须带 SPDX 头

```js
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) <年份> LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.
```

提交前自己扫一遍：

```bash
node scripts/check-spdx.js      # 缺头会列出文件并以非 0 退出
```

## 本地跑起来

```bash
# 后端（Node 18+，本项目在 Node 22 上开发）
cd backend && npm install && node server.js        # 默认 http://127.0.0.1:15002

# 前端（另开一个终端）
cd frontend && npm install && npm run dev          # Vite dev server，代理到后端

# 测试
cd frontend && npx vitest run                      # 前端单测
cd backend  && node --test test/                   # 后端单测
```

打安装包见 [牛图打包部署指南](牛图打包部署指南.md)。

## 代码风格

- 跟现有文件保持一致：2 空格缩进、单引号、语句末尾分号、函数式组件 + hooks
- **注释写"为什么"，不写"是什么"**。特别是"看起来能简化、但简化就会出错"的地方，
  必须写清楚为什么不能动——这个项目已经因为这类地方的白屏和扫描清空复现过多次
- 前后端**不要有第二份真源**：排序字段、筛选参数、版本号这类东西，
  一处定义、别处引用。历史上同一个字段名在两处各写一遍造成过多次不一致
- 新增跨模块符号（函数/常量）后，跑一遍 `frontend/src/utils/undefined-symbols.test.js`
  能抓的静态检查——构建和单测都抓不到"用了但没 import"

## 我不太会接受的改动

- 把功能默认行为改成"更聪明"但破坏既有习惯的（例如自动删除素材、自动改文件）
- 引入体积很大或协议不兼容的依赖
- 未经讨论的大规模重写、换框架、换状态管理
- 只改测试让它过、不改实现

## 遇到问题

先开 issue 讨论，别直接怼 PR 上来大改。个人项目，回得可能不快，但都会看。
