// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 筛选条件测试（含「排除模式」）
 *
 * 这一版把筛选从「前端本地筛已加载的那 100 张」搬到了后端 SQL，并新增：
 *   - filterMode = include / exclude（排除）
 *   - 文件大小改成 min/max 区间（来自双滑块，单位字节）
 *   - 方向（横/竖/方）、评分也下沉到 SQL
 *
 * 重点验证「排除」的语义：命中条件的剔除，其余保留，而且**不能误伤 NULL**。
 * （`format NOT IN (...)` 碰到 format 为 NULL 会得到 NULL，整行被悄悄丢掉 ——
 *  那不是用户理解的「排除」。所以统一用 COALESCE 兜住。）
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let LibraryDatabase = null;
let ImageModel = null;
let loadError = null;
try {
  LibraryDatabase = require('../database/db.js');
  ImageModel = require('../src/models/ImageModel.js');
} catch (error) {
  loadError = error;
}
if (!LibraryDatabase) {
  console.log(`  ⚠️  跳过筛选测试：加载依赖失败（${String(loadError.message).split('\n')[0]}）`);
}
const dbTest = LibraryDatabase ? test : test.skip;

let libraryDir;
let db;
let model;
let ids = {};

before(() => {
  if (!LibraryDatabase) return;
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-filter-'));
  db = new LibraryDatabase(libraryDir);
  model = new ImageModel(db.db);

  let id = 0;
  const add = (over) => {
    id += 1;
    db.insertImage({
      path: `f${id}/${over.filename || `img${id}.${over.format || 'jpg'}`}`,
      filename: over.filename || `img${id}.${over.format || 'jpg'}`,
      folder: over.folder || 'f1',
      size: over.size,
      width: over.width,
      height: over.height,
      format: over.format,
      file_type: over.fileType || 'image',
      created_at: 1700000000000 + id,
      modified_at: 1700000000000 + id,
      file_hash: `h${id}`,
      thumbnail_path: `t${id}.webp`,
      thumbnail_size: 100
    });
    return id;
  };

  // 5 张 jpg（横/竖/方各不同大小）+ 2 张 png（一个小一个大）+ 1 张没有 format 的
  const jpgSmall = add({ format: 'jpg', size: 100 * 1024, width: 1200, height: 800 });      // 横 100KB
  const jpgBig = add({ format: 'jpg', size: 8 * 1024 * 1024, width: 1200, height: 800 });   // 横 8MB
  const jpgVertical = add({ format: 'jpg', size: 500 * 1024, width: 800, height: 1200 });   // 竖 500KB
  const pngSmall = add({ format: 'png', size: 200 * 1024, width: 900, height: 900 });       // 方 200KB
  const pngBig = add({ format: 'png', size: 20 * 1024 * 1024, width: 2000, height: 1000 }); // 横 20MB
  const noFormat = add({ format: null, size: 300 * 1024, width: 1000, height: 500 });       // format 为 NULL

  ids = { jpgSmall, jpgBig, jpgVertical, pngSmall, pngBig, noFormat };

  // 按 id 更新最稳（filename 是动态生成的）
  db.db.prepare('UPDATE images SET rating = 5 WHERE id = ?').run(jpgSmall);
  db.db.prepare('UPDATE images SET rating = 3 WHERE id = ?').run(pngSmall);
});

after(() => {
  try {
    if (db && db.walCheckpointInterval) clearInterval(db.walCheckpointInterval);
    if (db && db.db) db.db.close();
  } catch { /* ignore */ }
  if (libraryDir) fs.rmSync(libraryDir, { recursive: true, force: true });
});

const namesOf = (result) => result.images.map((i) => i.id).sort((a, b) => a - b);
const expectIds = (...list) => list.slice().sort((a, b) => a - b);

dbTest('不带筛选时返回全部', () => {
  const r = model.search({}, null);
  assert.strictEqual(r.total, 6);
});

dbTest('筛选模式：只留选中的格式', () => {
  const r = model.search({ formats: ['png'] }, null);
  assert.deepStrictEqual(namesOf(r), expectIds(ids.pngSmall, ids.pngBig));
});

dbTest('**排除模式：剔除选中的格式，其余都留下（含 format 为空的）**', () => {
  const r = model.search({ formats: ['png'], filterMode: 'exclude' }, null);
  assert.deepStrictEqual(
    namesOf(r),
    expectIds(ids.jpgSmall, ids.jpgBig, ids.jpgVertical, ids.noFormat),
    'format 为 NULL 的那张不该被误伤'
  );
});

dbTest('筛选模式：大小区间', () => {
  const mb = 1024 * 1024;
  const r = model.search({ minSize: 1 * mb, maxSize: 10 * mb }, null);
  // 只有 8MB 那张落在区间里（300KB 那张在区间下面）
  assert.deepStrictEqual(namesOf(r), expectIds(ids.jpgBig));
});

dbTest('**排除模式：剔除大小区间内的，两端之外的都留下**', () => {
  const mb = 1024 * 1024;
  const r = model.search({ minSize: 1 * mb, maxSize: 10 * mb, filterMode: 'exclude' }, null);
  assert.deepStrictEqual(namesOf(r),
    expectIds(ids.jpgSmall, ids.jpgVertical, ids.pngSmall, ids.pngBig, ids.noFormat));
});

dbTest('只给下限 / 只给上限', () => {
  const mb = 1024 * 1024;
  assert.deepStrictEqual(namesOf(model.search({ maxSize: 250 * 1024 }, null)),
    expectIds(ids.jpgSmall, ids.pngSmall));
  assert.deepStrictEqual(namesOf(model.search({ minSize: 15 * mb }, null)), expectIds(ids.pngBig));
});

dbTest('方向：横 / 竖 / 方', () => {
  assert.deepStrictEqual(namesOf(model.search({ orientations: ['horizontal'] }, null)),
    expectIds(ids.jpgSmall, ids.jpgBig, ids.pngBig, ids.noFormat));
  assert.deepStrictEqual(namesOf(model.search({ orientations: ['vertical'] }, null)),
    expectIds(ids.jpgVertical));
  assert.deepStrictEqual(namesOf(model.search({ orientations: ['square'] }, null)),
    expectIds(ids.pngSmall));
});

dbTest('方向：多选是「或」，排除则是「都不是」', () => {
  const r1 = model.search({ orientations: ['vertical', 'square'] }, null);
  assert.deepStrictEqual(namesOf(r1), expectIds(ids.jpgVertical, ids.pngSmall));

  const r2 = model.search({ orientations: ['vertical', 'square'], filterMode: 'exclude' }, null);
  assert.deepStrictEqual(namesOf(r2),
    expectIds(ids.jpgSmall, ids.jpgBig, ids.pngBig, ids.noFormat));
});

dbTest('评分筛选与排除', () => {
  assert.deepStrictEqual(namesOf(model.search({ ratings: [5] }, null)), expectIds(ids.jpgSmall));
  // 排除 5 星：其余全留（没打分的 rating 默认 0，也在「其余」里）
  const r = model.search({ ratings: [5], filterMode: 'exclude' }, null);
  assert.deepStrictEqual(namesOf(r),
    expectIds(ids.jpgBig, ids.jpgVertical, ids.pngSmall, ids.pngBig, ids.noFormat));
});

dbTest('多个条件叠加（筛选模式是 AND）', () => {
  const mb = 1024 * 1024;
  const r = model.search({ formats: ['jpg'], minSize: 1 * mb, maxSize: 10 * mb }, null);
  assert.deepStrictEqual(namesOf(r), expectIds(ids.jpgBig));
});

dbTest('多个条件叠加（排除模式是「都不命中」）', () => {
  const mb = 1024 * 1024;
  const r = model.search({
    formats: ['png'], minSize: 1 * mb, maxSize: 10 * mb, filterMode: 'exclude'
  }, null);
  // 排除 png（两张 png 都没了）再排除 1-10MB（8MB 那张也没了）
  // → 只剩 jpgSmall(100KB) / jpgVertical(500KB) / noFormat(300KB)
  assert.deepStrictEqual(namesOf(r),
    expectIds(ids.jpgSmall, ids.jpgVertical, ids.noFormat));
});

dbTest('筛选之后 total 和分页是对上的（不能只筛当前页）', () => {
  const r = model.search({ formats: ['jpg'] }, { offset: 0, limit: 2 });
  assert.strictEqual(r.total, 3, 'total 应该是符合筛选的总数');
  assert.strictEqual(r.images.length, 2);
  assert.strictEqual(r.hasMore, true);

  const r2 = model.search({ formats: ['jpg'] }, { offset: 2, limit: 2 });
  assert.strictEqual(r2.images.length, 1);
  assert.strictEqual(r2.hasMore, false);
});

dbTest('filter-options 只列出当前范围里真实存在的选项', () => {
  const opts = model.getFilterOptions({});
  assert.deepStrictEqual(opts.formats.map((f) => f.value), ['jpg', 'png'], '不应包含 NULL');
  assert.deepStrictEqual(opts.orientations.map((o) => o.value), ['horizontal', 'vertical', 'square']);
  assert.deepStrictEqual(opts.ratings.map((r) => r.value), [0, 3, 5]);
  // 条数：面板上要显示"这个选项有几张图"
  const jpg = opts.formats.find((f) => f.value === 'jpg');
  assert.ok(jpg.count > 0, 'jpg 应该有条数');
  assert.strictEqual(
    opts.formats.reduce((sum, f) => sum + f.count, 0) + 1,
    opts.count,
    '各格式条数之和 + 1 张无格式的图 = 总数'
  );
  assert.strictEqual(opts.size.min, 100 * 1024);
  assert.strictEqual(opts.size.max, 20 * 1024 * 1024);
  assert.strictEqual(opts.count, 6);
});

dbTest('filter-options 返回固定大小挡位（9 档，各档计数之和 = 总数）', () => {
  const MB = 1024 * 1024;
  const opts = model.getFilterOptions({});
  assert.strictEqual(opts.sizeBrackets.length, 9, '和需求里列的一样是 9 档');
  assert.deepStrictEqual(
    opts.sizeBrackets.map((b) => b.label),
    ['< 1 MB', '1 - 5 MB', '5 - 10 MB', '10 - 20 MB', '20 - 40 MB',
     '40 - 60 MB', '60 - 80 MB', '80 - 100 MB', '100 MB 以上']
  );
  assert.strictEqual(opts.sizeBrackets[0].minSize, null, '第一档没有下限');
  assert.strictEqual(opts.sizeBrackets[0].maxSize, 1 * MB);
  assert.strictEqual(opts.sizeBrackets[8].minSize, 100 * MB);
  assert.strictEqual(opts.sizeBrackets[8].maxSize, null, '最后一档没有上限');
  assert.strictEqual(
    opts.sizeBrackets.reduce((a, b) => a + b.count, 0),
    opts.count,
    '每张图只算进一个挡位：各档之和应当等于总数'
  );
  assert.ok(opts.sizeBrackets[0].count >= 1, '夹具里有 100KB 的图，第一档不该是 0');

  const empty = model.getFilterOptions({ folder: '不存在的文件夹' });
  assert.ok(empty.sizeBrackets.every((b) => b.count === 0), '空范围给全 0，不要 NaN');
  assert.strictEqual(empty.sizeBrackets.length, 9, '空范围也要给完整挡位表（界面才不会忽长忽短）');
});

dbTest('挡位和搜索条件对得上：按挡位筛出来的条数 = 挡位统计的条数', () => {
  const MB = 1024 * 1024;
  const opts = model.getFilterOptions({});
  // 夹具是 6 张：100KB / 2MB / 8MB / 20MB / 5MB / 15MB（大致）
  for (const b of opts.sizeBrackets) {
    if (b.count === 0) continue;
    const r = model.search({ minSize: b.minSize, maxSize: b.maxSize }, { offset: 0, limit: 100 });
    // 闭区间搜索 vs 半开区间统计：只有"恰好等于上边界"的文件会让两者差 1
    assert.ok(
      Math.abs(r.total - b.count) <= 1,
      `${b.label}：搜索 ${r.total} 张 / 统计 ${b.count} 张，差得太多说明口径不一致`
    );
    assert.strictEqual(opts.sizeBrackets.length, 9);
  }
});

dbTest('filter-options 的格式带类别，并按 图片 -> 视频 -> 其他 排序', () => {
  const opts = model.getFilterOptions({});
  assert.ok(opts.formats.every((f) => typeof f.kind === 'string'), '每个格式都带 kind');
  const rank = { image: 0, video: 1 };
  const ranks = opts.formats.map((f) => (rank[f.kind] ?? 2));
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i - 1] <= ranks[i], `格式顺序不对：${JSON.stringify(opts.formats)}`);
  }
});

dbTest('filter-options 按文件夹收窄', () => {
  const opts = model.getFilterOptions({ folder: 'f1' });
  assert.strictEqual(opts.count, 6);
  const empty = model.getFilterOptions({ folder: '不存在的文件夹' });
  assert.deepStrictEqual(empty.formats, []);
  assert.deepStrictEqual(empty.orientations, [], '空范围不应给出 0 条的选项');
  assert.strictEqual(empty.count, 0);
  assert.strictEqual(empty.size.max, 0, '空范围不应给出 NaN');
});

dbTest('筛选缺省时的兜底：null / 空数组都不报错', () => {
  for (const f of [{ formats: null }, { formats: [] }, { minSize: null, maxSize: null },
                   { orientations: [] }, { ratings: [] }, { filterMode: 'weird' }]) {
    const r = model.search(f, null);
    assert.strictEqual(r.total, 6, `${JSON.stringify(f)} 应该等于不筛`);
  }
});
