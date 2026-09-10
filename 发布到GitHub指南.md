# 发布到 GitHub 指南（小白版）

这份文档假设你没用过 Git。照着顺序做就行。

---

## 第 0 步：先确认你已经有的东西

这个文件夹里已经准备好了：

```
牛图-NiuPic/
├── README.md            项目说明（已写好，含接手说明）
├── CHANGELOG.md         更新日志
├── LICENSE              MIT 许可证（保留原作者版权 + 你的版权）
├── .gitignore           告诉 Git 哪些文件不要上传
├── package.json         项目信息（作者 / 仓库地址已填好）
├── backend/             后端源码
├── frontend/            前端源码
├── niupic/              飞牛应用包骨架（manifest / cmd / config / wizard / 图标）
├── scripts/             构建脚本 + 迁移工具
├── design/              设计资源（logo.png + 图标规格说明）
├── website/             官网静态页
└── 牛图打包部署指南.md    部署文档
```

图标**已经换成了你的新 logo**，六个尺寸都生成好了，不用再动。

---

## 第 1 步：在 GitHub 上创建仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `NiuPic`
3. **Description** 可以填：`牛图 NiuPic —— 飞牛 fnOS 上的图片素材库管理应用`
4. 选择 **Public**
5. ⚠️ **下面三个勾全部不要勾**（本地已经有了，勾了会冲突）：
   - ❌ Add a README file
   - ❌ Add .gitignore
   - ❌ Choose a license
6. 点 **Create repository**
7. 记下页面上的仓库地址，形如 `https://github.com/LiuFudi/NiuPic.git`

---

## 第 2 步：安装 Git

下载 https://git-scm.com/download/win ，一路「下一步」装完。

装完后**关掉所有已打开的 PowerShell 窗口**，重新打开一个，输入：

```powershell
git --version
```

能打印版本号就装好了。

---

## 第 3 步：上传代码

**这个文件夹已经是初始化好的 Git 仓库了**（已经有一次提交、分支名是 `main`），
所以你**不需要**再 `git init` / `git add` / `git commit`，只要接上远端推上去就行。

在这个文件夹里打开 PowerShell：
> 文件资源管理器进入 `牛图-NiuPic` 文件夹 → 在地址栏输入 `powershell` 回车

先确认 Git 能看到这个仓库：

```powershell
git log --oneline
```

应该打印出 `牛图 NiuPic 2.0.6：接手 FlyPic 后的首个版本`。

然后**一行一行**执行（地址换成你自己的）：

```powershell
git remote add origin https://github.com/LiuFudi/NiuPic.git
git push -u origin main
```

### 关于登录

`git push` 会弹窗让你登录。**不能用账号密码**（GitHub 已禁用），要用
**Personal Access Token**：

1. 打开 https://github.com/settings/tokens
2. **Generate new token** → **Generate new token (classic)**
3. Note 随便填（例如 `push`），Expiration 选 90 天
4. 勾选 **repo**（整个大项）
5. 拉到底点 **Generate token**
6. **立刻复制那串 `ghp_...`**（离开页面就看不到了！）
7. 回到 Git 弹窗：用户名填 GitHub 用户名，密码栏**粘贴这串 token**

推送成功后刷新 GitHub 页面就能看到代码了。

> **万一 `git log` 报错说不像是一个仓库**（例如你在 Windows 上重新复制过这个文件夹，
> 把隐藏的 `.git` 目录漏掉了），那就退回手动初始化：
> ```powershell
> git init
> git add .
> git commit -m "牛图 NiuPic 2.0.6：接手 FlyPic 后的首个版本"
> git branch -M main
> ```
> 然后执行上面的 `git remote add` 和 `git push`。

---

## 第 4 步：发布带安装包的 Release

### 4.1 本地打包

```powershell
npm install
npm run build:fpk
```

产物在 `dist\niupic_2.0.6_x86.fpk`。

> 打包需要 `fnpack`：https://developer.fnnas.com/docs/cli/fnpack/
> 下载后放进 PATH，或者用 `set FNPACK=完整路径\fnpack.exe` 指定。
> 前端如果报 esbuild 相关错误，先执行 `pnpm approve-builds --all`。

### 4.2 在 GitHub 上建 Release

1. 进入仓库 → 右侧 **Releases** → **Create a new release**
2. **Choose a tag** 输入 `v2.0.6` → 点 **Create new tag: v2.0.6 on publish**
3. **Release title** 填 `牛图 NiuPic 2.0.6`
4. 描述框里粘贴 `CHANGELOG.md` 里 2.0.6 那一段
5. 把 `dist\niupic_2.0.6_x86.fpk` **拖到附件区**上传
6. 点 **Publish release**

> 安装包不要提交进仓库（`.gitignore` 已排除）。走 Release 附件更好：
> 仓库体积小、下载有统计、用户一眼能看到版本。

---

## 以后怎么更新

```powershell
git add .
git commit -m "描述你改了什么"
git push
```

发新版本：改 `niupic/manifest` 里的 `version` → 重新打包 → 按第 4 步建一个新 tag 的 Release。

---

## 常见问题

**我在 Windows 上新加了脚本，上传后权限不对（不能执行）**
Windows 上的 Git 不跟踪「可执行」标记。如果新增的是需要执行的脚本
（例如 `niupic/cmd/` 下的、或 `scripts/` 下的），执行一次：
```powershell
git update-index --chmod=+x 文件路径
```
仓库里现有的 12 个可执行文件（飞牛的 9 个 cmd 脚本 + 3 个构建/迁移脚本）已经设置好了，
不用管。

**`git push` 报 `remote origin already exists`**
之前加过了，改用：`git remote set-url origin https://github.com/LiuFudi/NiuPic.git`

**`git push` 报 `rejected ... fetch first`**
远端有你本地没有的提交（通常建仓库时勾了 README）。执行：
```powershell
git pull --rebase origin main
git push
```

**上传后 GitHub 上有 node_modules 或 dist 目录**
`.gitignore` 没生效。执行 `git rm -r --cached node_modules dist` 再重新提交。

**中文文件名显示乱码**
```powershell
git config --global core.quotepath false
```

**想确认哪些文件会被上传**
`git status` 看改动，`git ls-files` 看已纳管的文件列表。

---

## 发布前最后检查

- [ ] GitHub 建仓库时**没有**勾 README / .gitignore / License
- [ ] `git ls-files` 里没有 `node_modules`、`dist`、`.fpk`
- [ ] Release 里上传了 `.fpk` 安装包
- [ ] README 里原作者的链接是对的（`https://github.com/ZangXincz/FlyPic`）
