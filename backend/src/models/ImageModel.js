// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 图片数据模型
 */

const BaseModel = require('./BaseModel');
const { mapImageForFrontend } = require('../utils/fieldMapper');
const { constants } = require('../config');
const { buildNameSortKey } = require('../../utils/nameSort');

class ImageModel extends BaseModel {
  /**
   * 根据 ID 查找图片
   */
  findById(id) {
    const query = 'SELECT * FROM images WHERE id = ?';
    const image = this.findOne(query, [id]);
    return image ? mapImageForFrontend(image) : null;
  }

  /**
   * 根据路径查找图片
   */
  findByPath(path) {
    const query = 'SELECT * FROM images WHERE path = ?';
    const image = this.findOne(query, [path]);
    return image ? mapImageForFrontend(image) : null;
  }

  /**
   * 搜索图片（支持分页）
   */
  search(filters = {}, pagination = null) {
    const { query, params } = this._buildSearchQuery(filters, pagination);
    
    // 获取总数（不包含分页参数）
    const { query: countQueryBase, params: countParams } = this._buildSearchQuery(filters, null);
    const countQuery = countQueryBase
      .replace('SELECT *', 'SELECT COUNT(*) as total')
      .split('ORDER BY')[0];
    const { total } = this.findOne(countQuery, countParams);
    
    // 获取数据
    const images = this.findMany(query, params).map(mapImageForFrontend);
    
    // 统一返回对象格式
    if (pagination) {
      return {
        images,
        total,
        offset: pagination.offset,
        limit: pagination.limit,
        hasMore: pagination.offset + images.length < total
      };
    }
    
    // 无分页时也返回对象格式
    return {
      images,
      total
    };
  }

  /**
   * 插入或更新图片（upsert）
   *
   * ⚠️ 这里**必须**用 ON CONFLICT DO UPDATE，不能再用 INSERT OR REPLACE：
   * `path` 是 UNIQUE，INSERT OR REPLACE 撞到已存在的路径是「先删旧行再插新行」，
   * 没列进 INSERT 的列（rating / favorite / tags）会全部回默认值 ——
   * 结果就是「重扫一次库，用户的评分和收藏全没了」。
   *
   * 同样刻意不更新 indexed_at：那是「加入图库的时间」，同一张图重扫不该变，
   * 否则按「添加时间」排序会乱。新增列时记得同步下面的 DO UPDATE 列表。
   */
  insert(data) {
    const query = `
      INSERT INTO images 
      (path, filename, folder, size, width, height, format, file_type,
       created_at, modified_at, file_hash, thumbnail_path, thumbnail_size, indexed_at, name_sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        filename = excluded.filename,
        folder = excluded.folder,
        size = excluded.size,
        width = excluded.width,
        height = excluded.height,
        format = excluded.format,
        file_type = excluded.file_type,
        created_at = excluded.created_at,
        modified_at = excluded.modified_at,
        file_hash = excluded.file_hash,
        thumbnail_path = excluded.thumbnail_path,
        thumbnail_size = excluded.thumbnail_size,
        name_sort = excluded.name_sort
    `;
    
    return this.execute(query, [
      data.path,
      data.filename,
      data.folder,
      data.size,
      data.width,
      data.height,
      data.format,
      data.fileType || 'image',
      data.createdAt,
      data.modifiedAt,
      data.fileHash,
      data.thumbnailPath,
      data.thumbnailSize,
      Date.now(),
      buildNameSortKey(data.filename)
    ]);
  }

  /**
   * 批量插入图片（同样是保留用户数据的 upsert，理由见 insert）
   */
  insertBatch(images) {
    const query = `
      INSERT INTO images 
      (path, filename, folder, size, width, height, format, file_type,
       created_at, modified_at, file_hash, thumbnail_path, thumbnail_size, indexed_at, name_sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        filename = excluded.filename,
        folder = excluded.folder,
        size = excluded.size,
        width = excluded.width,
        height = excluded.height,
        format = excluded.format,
        file_type = excluded.file_type,
        created_at = excluded.created_at,
        modified_at = excluded.modified_at,
        file_hash = excluded.file_hash,
        thumbnail_path = excluded.thumbnail_path,
        thumbnail_size = excluded.thumbnail_size,
        name_sort = excluded.name_sort
    `;
    
    return this.transaction(() => {
      const stmt = this.db.prepare(query);
      for (const data of images) {
        stmt.run(
          data.path, data.filename, data.folder, data.size,
          data.width, data.height, data.format, data.fileType || 'image',
          data.createdAt, data.modifiedAt, data.fileHash,
          data.thumbnailPath, data.thumbnailSize, Date.now(),
          buildNameSortKey(data.filename)
        );
      }
    });
  }

  /**
   * 更新图片
   */
  update(path, data) {
    const fields = [];
    const params = [];
    
    Object.entries(data).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      params.push(value);
    });
    
    params.push(path);
    
    const query = `UPDATE images SET ${fields.join(', ')} WHERE path = ?`;
    return this.execute(query, params);
  }

  /**
   * 删除图片
   */
  deleteByPath(path) {
    const query = 'DELETE FROM images WHERE path = ?';
    return this.execute(query, [path]);
  }

  /**
   * 按文件夹前缀批量删除
   */
  deleteByFolderPrefix(folderPrefix) {
    const query = 'DELETE FROM images WHERE folder = ? OR folder LIKE ?';
    return this.execute(query, [folderPrefix, `${folderPrefix}/%`]);
  }

  /**
   * 获取图片总数
   */
  count(filters = {}) {
    const { query, params } = this._buildSearchQuery(filters);
    const countQuery = query
      .replace('SELECT *', 'SELECT COUNT(*) as count')
      .split('ORDER BY')[0];
    const { count } = this.findOne(countQuery, params);
    return count;
  }

  /**
   * 当前范围内的筛选选项
   *
   * 界面上的格式 / 大小 / 方向 / 评分只应该列出**当前文件夹里实际存在**的值，
   * 而不是把全库的种类都摆出来（点了没结果最让人困惑）。
   * 之前是前端从「已加载的那 100 张」里现算的，翻页之后还会变；
   * 这里改成后端按同样的范围（库 + 文件夹 + 搜索词）算一次 DISTINCT。
   *
   * @param {object} filters - 只需要 keywords / folder
   * @returns {{formats: Array, ratings: Array, orientations: Array, size: {min:number,max:number}, count:number}}
   */
  getFilterOptions(filters = {}) {
    let where = 'WHERE 1=1';
    const params = [];

    if (filters.keywords) {
      filters.keywords.trim().split(/\s+/).forEach((term) => {
        where += ' AND filename LIKE ?';
        params.push(`%${term}%`);
      });
    }
    if (filters.folder) {
      where += ' AND (folder = ? OR folder LIKE ?)';
      params.push(filters.folder, `${filters.folder}/%`);
    }

    // 带条数返回：面板上每个选项后面显示"这个格式有几张"，
    // 用户一眼能看出当前文件夹到底有什么可筛（这也正是"仅显示当前文件夹有的格式"的落点）。
    //
    // 排序：图片 -> 视频 -> 其他。库里 image / video / psd / pdf 混在一起时，
    // 直接按条数排会让 mp4/psd 插在 jpg/png 中间，找图片格式得来回扫。
    // 同组内按条数多的在前。
    const formats = this.findMany(
      `SELECT format AS value, file_type AS kind, COUNT(*) AS count FROM images ${where}
         AND format IS NOT NULL AND format != ''
       GROUP BY format, file_type
       ORDER BY CASE file_type WHEN 'image' THEN 0 WHEN 'video' THEN 1 ELSE 2 END,
                count DESC, format ASC`,
      params
    ).map((r) => ({ value: r.value, kind: r.kind || 'other', count: r.count }));

    const ratings = this.findMany(
      `SELECT COALESCE(rating, 0) AS value, COUNT(*) AS count FROM images ${where}
       GROUP BY value ORDER BY value ASC`,
      params
    ).map((r) => ({ value: r.value, count: r.count }));

    const agg = this.findOne(
      `SELECT COUNT(*) AS count, MIN(size) AS minSize, MAX(size) AS maxSize,
              SUM(CASE WHEN width > height THEN 1 ELSE 0 END) AS horizontal,
              SUM(CASE WHEN width < height THEN 1 ELSE 0 END) AS vertical,
              SUM(CASE WHEN width = height THEN 1 ELSE 0 END) AS square
       FROM images ${where}`,
      params
    ) || {};

    const orientations = [
      { value: 'horizontal', count: agg.horizontal || 0 },
      { value: 'vertical', count: agg.vertical || 0 },
      { value: 'square', count: agg.square || 0 },
    ].filter((o) => o.count > 0);

    const size = {
      min: Number.isFinite(agg.minSize) ? agg.minSize : 0,
      max: Number.isFinite(agg.maxSize) ? agg.maxSize : 0
    };

    return {
      formats,
      ratings,
      orientations,
      size,
      sizeBrackets: this._sizeBracketCounts(where, params),
      count: agg.count || 0
    };
  }

  /**
   * 各大小挡位里有多少张（面板上的「< 1 MB / 1 - 5 MB / …」）
   *
   * 挡位表在 constants.SIZE_BRACKETS（后端是唯一定义处，前端只负责显示，
   * 免得两边各写一份"1MB 到底算哪一档"）。
   *
   * 一条 SQL 用 SUM(CASE ...) 把所有挡位数出来，9 个挡位不要发 9 次查询。
   * 统计口径是 [minSize, maxSize)，各挡位计数之和正好等于总数。
   *
   * @returns {Array<{key,label,minSize,maxSize,count}>} 单位字节
   */
  _sizeBracketCounts(where, params) {
    const MB = 1024 * 1024;
    const brackets = constants.SIZE_BRACKETS || [];
    if (brackets.length === 0) return [];

    const selects = brackets.map((b, i) => {
      const min = b.minSize == null ? null : b.minSize * MB;
      const max = b.maxSize == null ? null : b.maxSize * MB;
      const conds = [];
      if (min != null) conds.push(`size >= ${min}`);
      if (max != null) conds.push(`size < ${max}`);
      return `SUM(CASE WHEN ${conds.join(' AND ')} THEN 1 ELSE 0 END) AS b${i}`;
    });

    const row = this.findOne(`SELECT ${selects.join(', ')} FROM images ${where}`, params) || {};

    return brackets.map((b, i) => ({
      key: b.key,
      label: b.label,
      minSize: b.minSize == null ? null : b.minSize * MB,
      maxSize: b.maxSize == null ? null : b.maxSize * MB,
      count: row[`b${i}`] || 0
    }));
  }

  /**
   * 构建 ORDER BY 子句
   *
   * 字段来自 constants.SORT.FIELDS 白名单，用户传什么都不会直接拼进 SQL。
   * 白名单里 sql 是数组，多列时各自套用同一个方向。
   * 末尾统一加 id 兜底 —— 排序值相同的记录顺序稳定，翻页才不会重复或漏图。
   *
   * @param {object} filters - 取 sort / order / seed 三个字段
   * @returns {string} 形如 "ORDER BY created_at DESC, id ASC"
   */
  _buildOrderBy(filters = {}) {
    const sortCfg = constants.SORT;
    const fieldKey = Object.prototype.hasOwnProperty.call(sortCfg.FIELDS, filters.sort)
      ? filters.sort
      : sortCfg.DEFAULT_FIELD;
    const field = sortCfg.FIELDS[fieldKey];

    let order = String(filters.order || '').toLowerCase();
    if (order !== 'asc' && order !== 'desc') {
      order = sortCfg.DESC_BY_DEFAULT.includes(fieldKey) ? 'desc' : 'asc';
    }
    const dir = order === 'asc' ? 'ASC' : 'DESC';

    // 随机：用 (id * 大质数 + seed) % 质数 做伪随机。
    // 同一个 seed 下顺序稳定，所以翻页不会重复或漏图；换个 seed 就重新洗牌。
    // seed 已强制转成整数，直接内联没有注入风险。
    if (fieldKey === 'random') {
      const n = Number(filters.seed);
      const seed = Number.isFinite(n) ? Math.floor(n) : 0;
      return `ORDER BY ((id * 2654435761 + ${seed}) % 2147483647) ${dir}, id ASC`;
    }

    const terms = field.sql.map((term) => `${term.trim()} ${dir}`);
    return `ORDER BY ${terms.join(', ')}, id ASC`;
  }

  /**
   * 构建搜索查询
   */
  _buildSearchQuery(filters = {}, pagination = null) {
    let query = 'SELECT * FROM images WHERE 1=1';
    const params = [];

    // 关键词搜索（AND 逻辑）
    if (filters.keywords) {
      const terms = filters.keywords.trim().split(/\s+/);
      terms.forEach(term => {
        query += ' AND filename LIKE ?';
        params.push(`%${term}%`);
      });
    }

    // 文件夹过滤（包含子文件夹）
    if (filters.folder) {
      query += ' AND (folder = ? OR folder LIKE ?)';
      params.push(filters.folder, `${filters.folder}/%`);
    }

    // ---------- 筛选条件（支持「筛选 / 排除」两种模式）----------
    //
    // filterMode = 'include'（默认）：命中条件的留下
    // filterMode = 'exclude'：命中条件的**剔除**，其余留下
    //
    // 排除时一律用 COALESCE 兜住 NULL —— 例如 `format NOT IN (...)` 遇到 format 为 NULL
    // 会得到 NULL（既不是真也不是假），整行就被悄悄丢掉了，那不是用户想要的「排除」。
    const excluding = filters.filterMode === 'exclude';
    const negate = (expr) => (excluding ? `NOT (${expr})` : `(${expr})`);
    const notIn = (column, list) => {
      const placeholders = list.map(() => '?').join(',');
      return excluding
        ? `COALESCE(${column}, '') NOT IN (${placeholders})`
        : `${column} IN (${placeholders})`;
    };

    // 格式
    if (filters.formats && filters.formats.length > 0) {
      query += ` AND ${notIn('format', filters.formats)}`;
      params.push(...filters.formats);
    }

    // 文件大小（字节）
    const minSize = Number(filters.minSize);
    const maxSize = Number(filters.maxSize);
    const hasMin = Number.isFinite(minSize) && minSize > 0;
    const hasMax = Number.isFinite(maxSize) && maxSize > 0;
    if (hasMin && hasMax) {
      query += excluding
        ? ' AND (size < ? OR size > ?)'
        : ' AND size >= ? AND size <= ?';
      params.push(minSize, maxSize);
    } else if (hasMin) {
      query += excluding ? ' AND size < ?' : ' AND size >= ?';
      params.push(minSize);
    } else if (hasMax) {
      query += excluding ? ' AND size > ?' : ' AND size <= ?';
      params.push(maxSize);
    }

    // 图片方向：horizontal 横图 / vertical 竖图 / square 方图
    if (filters.orientations && filters.orientations.length > 0) {
      const parts = [];
      if (filters.orientations.includes('horizontal')) parts.push('width > height');
      if (filters.orientations.includes('vertical')) parts.push('width < height');
      if (filters.orientations.includes('square')) parts.push('width = height');
      if (parts.length > 0) {
        query += ` AND ${negate(parts.join(' OR '))}`;
      }
    }

    // 评分
    if (filters.ratings && filters.ratings.length > 0) {
      query += ` AND ${notIn('rating', filters.ratings)}`;
      params.push(...filters.ratings);
    }

    // 日期过滤
    if (filters.startDate) {
      query += ' AND created_at >= ?';
      params.push(filters.startDate);
    }
    if (filters.endDate) {
      query += ' AND created_at <= ?';
      params.push(filters.endDate);
    }

    // 排序
    query += ` ${this._buildOrderBy(filters)}`;

    // 分页
    if (pagination) {
      query += ' LIMIT ? OFFSET ?';
      params.push(pagination.limit, pagination.offset);
    }

    return { query, params };
  }
}

module.exports = ImageModel;
