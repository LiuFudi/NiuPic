// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 基础数据模型
 * 提供通用的数据库操作方法
 */

class BaseModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 执行查询并返回单条记录
   */
  findOne(query, params = []) {
    const stmt = this.db.prepare(query);
    return stmt.get(...params);
  }

  /**
   * 执行查询并返回多条记录
   */
  findMany(query, params = []) {
    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }

  /**
   * 执行插入/更新/删除操作
   */
  execute(query, params = []) {
    const stmt = this.db.prepare(query);
    return stmt.run(...params);
  }

  /**
   * 执行事务
   */
  transaction(fn) {
    const transaction = this.db.transaction(fn);
    return transaction();
  }
}

module.exports = BaseModel;
