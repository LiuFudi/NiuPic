# 牛图 NiuPic

> 为飞牛 fnOS 设计的轻量、快速、稳定的图像素材检索浏览应用。
> 支持数十万级别图片流畅浏览，非侵入式设计，100% 开源免费。

![版本](https://img.shields.io/badge/version-2.0.6-blue)
![平台](https://img.shields.io/badge/platform-fnOS%20x86__64-green)

---

## 关于本项目 / 接手说明

**牛图 NiuPic 是 [FlyPic](https://github.com/ZangXincz/FlyPic) 的延续，不是从零开始的新项目。**

- **原作者：[ZangXincz](https://github.com/ZangXincz)** —— FlyPic 的作者。原项目已经归档，不再维护。
- **接手维护：[LiuFudi](https://github.com/LiuFudi)** —— 自 2.0.x 起接手开发与维护。

FlyPic 的作者把这样一个完成度很高、并且真正解决「几十万张图怎么快速找图」这个实际问题的项目开源了出来，
牛图是在他的成果上继续往前走。原始的架构设计、扫描与索引方案、缩略图与内存控制策略都来自 FlyPic，
这些是项目真正的骨架，特此致谢并保留署名。

如果你在使用中发现牛图好用，也请给[原项目](https://github.com/ZangXincz/FlyPic)点一个 star。

### 相比 FlyPic 最后一次发布（1.3.x）的变化

| 变更 | 说明 |
|---|---|
| 品牌 | FlyPic / 飞图 → **牛图 NiuPic** |
| 版本 | 1.3.0 → **2.0.6** |
| 应用 ID | `flypic` → `niupic`（安装目录、数据目录同步变更） |
| 素材库索引目录 | `.flypic` → `.niupic`（提供迁移脚本，见下） |
| 全屏查看器 | 新增。双击图片进入沉浸式查看：左右切换、滚轮缩放、旋转、幻灯片、文件信息面板，交互对齐 Windows「照片」 |
| 首页 | 直接展示素材库**全部层级**的图片，不必先点进子文件夹 |
| 修复 | 图片超过 50 张后双击无法打开全屏（虚拟滚动丢 `dblclick`） |
| 修复 | 分辨率显示成缩略图尺寸，导致缩放比例和显示大小都按缩略图算 |
| 修复 | 「全部图片」误进入素材库概览页，看不到任何照片 |
| 修复 | 打包时 bcrypt 原生模块路径错误导致应用无法启动 |
| 修复 | `LibraryService` 缺少 `logger` 导入导致「添加图库」报 500 |

---

## 从 FlyPic 迁移

牛图沿用了 FlyPic 的索引格式，**旧素材库不用重新扫描、不用重建缩略图**。

假设你有素材库 `/vol3/1000/色图`：

```bash
# 1. 安装牛图 NiuPic（应用中心 → 手动安装 → niupic_2.0.6_x86.fpk）
# 2. 在 NAS 上以 root 执行迁移脚本（把 .flypic 就地改成 .niupic）
node /vol3/@appcenter/niupic/server/scripts/migrate-flypic-dir.js /vol3/1000/色图
#    有多个素材库就一次传多个路径
# 3. 打开牛图 → 添加素材库 → 指向同一路径
#    会提示 "Library created with existing index"，图片和缩略图立刻可用
```

迁移脚本做两件事：重命名目录、把数据库里 `thumbnail_path` 的 `.flypic/` 前缀改成 `.niupic/`。
两步都是就地操作，秒级完成。不做迁移直接重新扫描也可以，只是大库会花不少时间重建缩略图。

> ⚠️ `appname` 从 `flypic` 改成了 `niupic`，所以牛图对 fnOS 来说是一个**新应用**：
> 素材库列表、访问密码、主题这些存在 `/vol3/@appdata/` 里的配置不会自动继承，需要重新设置一次。
> 但素材库里的索引（`.niupic/`）和图片本身都不受影响。

---

## 功能

- 🖼️ **双击全屏查看器** —— 滚轮以光标为锚点缩放、双击在「适应窗口 / 100%」间切换、拖拽平移、
  `[` `]` 旋转、`I` 文件信息、`F` 全屏、空格幻灯片、`←/→` 切换，工具栏自动隐藏
- 📚 **素材库管理** —— 多素材库、任意层级目录，首页即全部图片
- 🔍 **智能搜索** —— 多关键词组合、按格式 / 大小 / 方向 / 评分筛选
- ⚡ **大库友好** —— 虚拟滚动、分页加载、缩略图延迟生成、内存监控与自动清理
- 🎨 **现代界面** —— 固定行高瀑布流、亮色 / 暗色主题、响应式
- 🔒 **访问控制** —— 密码 + JWT，防暴力破解
- 🗂️ **文件操作** —— 重命名、移动、删除（走回收站）、评分、导出
- 🔌 **实时同步** —— Socket.IO 推送扫描进度与文件变化

---

## 技术栈

**前端**：React 18 · Vite 5 · TailwindCSS · Zustand · react-window · lucide-react

**后端**：Node.js 22 · Express · better-sqlite3 · Sharp · Socket.IO · chokidar

---

## 开发

```bash
# 前端
cd frontend && pnpm install --ignore-workspace && pnpm run dev

# 后端
cd backend && npm install && npm run dev
```

## 打包 fpk

```bash
node scripts/build-fpk.js          # 需要 fnpack 在 PATH 里
# 产物: dist/niupic_<version>_x86.fpk
```

---

## 目录结构

```
niupic/                 飞牛应用包骨架（manifest / cmd / config / wizard / app）
backend/                后端源码（真正参与构建的那份）
frontend/               前端源码
scripts/                构建脚本
```

---

## 致谢

- **[ZangXincz](https://github.com/ZangXincz)** —— FlyPic 原作者，本项目的全部基础来自他的工作
- [Sharp](https://sharp.pixelplumbing.com/) · [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) ·
  [react-window](https://github.com/bvaughn/react-window) · [lucide](https://lucide.dev/)

## 许可

MIT。原始版权归 ZangXincz 所有，接手后的修改版权归 LiuFudi 所有。详见 [LICENSE](./LICENSE)。
