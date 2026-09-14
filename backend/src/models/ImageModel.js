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
   * 插入图片
   */
  insert(data) {
    const query = `
      INSERT OR REPLACE INTO images 
      (path, filename, folder, size, width, height, format, file_type,
       created_at, modified_at, file_hash, thumbnail_path, thumbnail_size, indexed_at, name_sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
   * 批量插入图片
   */
  insertBatch(images) {
    const query = `
      INSERT OR REPLACE INTO images 
      (path, filename, folder, size, width, height, format, file_type,
       created_at, modified_at, file_hash, thumbnail_path, thumbnail_size, indexed_at, name_sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    // 格式过滤
    if (filters.formats && filters.formats.length > 0) {
      const placeholders = filters.formats.map(() => '?').join(',');
      query += ` AND format IN (${placeholders})`;
      params.push(...filters.formats);
    }

    // 大小过滤
    if (filters.minSize) {
      query += ' AND size >= ?';
      params.push(filters.minSize);
    }
    if (filters.maxSize) {
      query += ' AND size <= ?';
      params.push(filters.maxSize);
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
