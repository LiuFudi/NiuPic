# 更新日志

本项目由 [LiuFudi](https://github.com/LiuFudi) 接手维护，
上游原始项目为 [ZangXincz/FlyPic](https://github.com/ZangXincz/FlyPic)（已归档）。

---

## 2.0.6

首个以「牛图 NiuPic」名义发布的版本，在 FlyPic 1.3.x 基础上继续开发。

### 更名与品牌

- 项目更名为 **牛图 NiuPic**，换用新 logo
- 应用 ID 由 `flypic` 改为 `niupic`（安装目录、数据目录、共享目录名同步变更）
- 素材库内的索引目录由 `.flypic` 改为 `.niupic`
- 界面文案、浏览器标题、导出文件名、日志、安装向导全部更新为牛图 NiuPic
- **保留原作者署名**：原作者 [ZangXincz](https://github.com/ZangXincz)，
  在应用简介、更新日志、`package.json`、`LICENSE` 与 README 中均有标注

### 新增

- **双击图片进入沉浸式全屏查看器**，交互对齐 Windows「照片」：
  - 左右切换：`←` `→`、空格、Backspace、Home / End、鼠标拖拽、触屏滑动、两侧箭头按钮
  - 缩放：滚轮以光标为锚点缩放、双击在「适应窗口 / 100%」间切换、`+` `-`、拖拽平移、工具栏缩放条
  - 旋转：`[` 左旋、`]` 右旋，旋转后自动重算适应比例
  - 幻灯片播放；`I` 打开文件信息面板；`F` 切换全屏；`Esc` 退出
  - 工具栏与标题 2.6 秒无操作自动隐藏（沉浸式）
  - 打开期间吞掉全局键盘事件，避免网格的删除/评分等快捷键误触发
- 首页直接展示素材库**全部层级**的图片，不需要先点进子文件夹
- 从 FlyPic 迁移的辅助脚本 `scripts/tools/migrate-flypic-dir.js`
  （把 `.flypic` 就地改成 `.niupic`，免去重新扫描和重建缩略图）

### 修复

| 问题 | 原因 |
|---|---|
| 打包后应用无法启动 | `bcrypt` 原生模块被放到多一层的 libc 子目录，`node-pre-gyp` 找不到 |
| 「添加图库」报 `Internal server error` | `LibraryService` 用了 `logger.*` 却没有 `require` |
| 图片超过 50 张后双击无反应 | 超过 50 张走 react-window 虚拟列表，首次点击引发的重渲染会重建行 DOM，浏览器因此不派发 `dblclick`。改为在父组件按「同一张图 + 400ms 内两次点击」自行判定 |
| 分辨率显示成缩略图尺寸，缩放比例全错 | 扫描时把缩略图的宽高当成原图尺寸写进了数据库。现在记录原图真实像素，并在扫描时自动纠正历史数据 |
| 「全部图片」看不到任何照片 | `MainContent` 把「未选文件夹」当成了「什么都不显示」，直接跳过了图片加载 |
| 手机竖拍（EXIF 旋转）的缩略图被裁成横图 | 目标尺寸用了旋转前的宽高，`.rotate()` 之后 `fit:cover` 把竖图裁掉了 |

### 兼容性说明

- 素材库的**索引格式与 FlyPic 完全一致**，用迁移脚本改名后即可直接使用，无需重新扫描
- 素材库里遗留的旧 `.flypic` 目录会被自动忽略，不会被当作图片索引进来
- 因为应用 ID 变了，安装牛图后需要重新添加素材库、重设访问密码

---

## 上游版本（FlyPic）

2.0.6 之前的历史见原项目：[ZangXincz/FlyPic](https://github.com/ZangXincz/FlyPic)
