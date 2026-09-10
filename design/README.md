# 设计资源

## logo.png

牛图 NiuPic 的原始 logo，1254 × 1254 PNG（无透明通道）。

应用里用到的图标都是从这个文件等比缩放生成的，**只改这一个文件就能整站换标**：

```bash
# 需要 sharp（backend 的依赖里已经有）
node -e "
const sharp = require('./backend/node_modules/sharp');
const jobs = [
  [64 , '../niupic/ICON.PNG'],
  [256, '../niupic/ICON_256.PNG'],
  [64 , '../niupic/app/ui/images/icon-64.png'],
  [256, '../niupic/app/ui/images/icon-256.png'],
  [256, '../frontend/public/ICON_256.PNG'],
  [64 , '../frontend/public/favicon.png'],
];
(async () => {
  for (const [size, out] of jobs) {
    await sharp('logo.png')
      .resize(size, size, { fit: 'cover', position: 'center', kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log('✓', out);
  }
})();
"
```

## 各图标用在哪里

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `niupic/ICON.PNG` | 64×64 | 飞牛应用中心 小图标 |
| `niupic/ICON_256.PNG` | 256×256 | 飞牛应用中心 大图标 |
| `niupic/app/ui/images/icon-64.png` | 64×64 | 桌面图标（由 `ui/config` 的 `images/icon-{0}.png` 引用） |
| `niupic/app/ui/images/icon-256.png` | 256×256 | 桌面图标（高分屏） |
| `frontend/public/ICON_256.PNG` | 256×256 | 应用内登录页 logo |
| `frontend/public/favicon.png` | 64×64 | 浏览器标签页图标 |

六个文件必须是**正方形**、**不带透明通道**（与飞牛的图标规范一致）。
