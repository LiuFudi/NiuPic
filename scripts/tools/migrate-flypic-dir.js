#!/usr/bin/env node
/**
 * 把素材库里的旧索引目录 .flypic 就地迁移成 .niupic
 *
 * 牛图 NiuPic 沿用了 FlyPic 的索引格式，只是目录名换了。
 * 跑一次这个脚本就不用重新扫描、不用重建缩略图（否则大库可能要几小时）。
 *
 * 用法（在 NAS 上以 root 执行）：
 *   node /vol3/@appcenter/niupic/server/scripts/migrate-flypic-dir.js /vol3/1000/色图
 *   可以一次传多个素材库路径
 *
 * 做的事：
 *   1. .flypic -> .niupic（重命名，不复制，瞬间完成）
 *   2. 把数据库里 thumbnail_path 的 .flypic/ 前缀改成 .niupic/
 *      （不改的话缩略图会全部找不到）
 * 已经是 .niupic 的素材库会自动跳过；两个目录同时存在时也会跳过，请自行确认。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function migrate(libPath) {
  const abs = path.resolve(libPath);
  const oldDir = path.join(abs, '.flypic');
  const newDir = path.join(abs, '.niupic');

  if (!fs.existsSync(oldDir)) {
    console.log(`跳过（没有 .flypic）: ${abs}`);
    return;
  }
  if (fs.existsSync(newDir)) {
    console.log(`跳过（.niupic 已存在，请自行确认哪个是有效的）: ${abs}`);
    return;
  }

  fs.renameSync(oldDir, newDir);
  console.log(`已重命名: ${abs}/.flypic -> .niupic`);

  const dbPath = path.join(newDir, 'metadata.db');
  if (!fs.existsSync(dbPath)) {
    console.log('  没有 metadata.db，无需更新数据库');
    return;
  }

  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  try {
    const r = db.prepare(
      "UPDATE images SET thumbnail_path = REPLACE(thumbnail_path, '.flypic/', '.niupic/') " +
      "WHERE thumbnail_path LIKE '.flypic/%'"
    ).run();
    console.log(`  已更新 ${r.changes} 条缩略图路径`);
    db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)')
      .run('last_modified', Date.now().toString(), Date.now());
  } finally {
    db.close();
  }
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('用法: node migrate-flypic-dir.js <素材库路径> [更多路径...]');
  process.exit(1);
}
targets.forEach(migrate);
console.log('\n完成。回到牛图 NiuPic 里「添加素材库」指向同一路径即可，会直接识别到已有索引。');
