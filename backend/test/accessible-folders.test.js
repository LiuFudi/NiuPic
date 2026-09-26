// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

/**
 * 可访问文件夹（飞牛授权目录）测试
 *
 * 这套逻辑依赖飞牛开放 API，而开放 API 只走本机 Unix Socket，
 * 在没有飞牛 NAS 的开发机上没法直连。所以这里自己做了一个
 * **mock 网关**（真的监听一个 Unix Socket、真的走 HTTP + Bearer Token），
 * 用来固定住协议契约；再通过替换 fnosApi 模块来验证清单来源的优先级与降级。
 *
 * 运行: cd backend && npm test
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const FNOS_API = require.resolve('../src/utils/fnosApi.js');
const SERVICE = require.resolve('../src/services/AccessibleFoldersService.js');
const { callFnosApi, FnosApiError } = require(FNOS_API);

const TOKEN = 'mock-token-for-test';

/**
 * mock 网关监听的地址。
 *
 * POSIX 上是临时目录里的 `.sock` 文件；**Windows 上不能这么写** ——
 * Node 的 AF_UNIX 在 Windows 上走命名管道，把 `C:\Users\…\niupic-mock-1.sock`
 * 交给 `server.listen()` 会直接 `listen EACCES: permission denied`（实测），
 * 于是整个文件的用例都会连带失败。所以 Windows 上换成 `\\.\pipe\<名字>`。
 *
 * 被测代码不用改：`callFnosApi` 只是把 `options.socketPath` 原样交给 `http.request`。
 */
function mockSocketPath(name) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\niupic-${name}-${process.pid}`
    : path.join(os.tmpdir(), `niupic-${name}-${process.pid}.sock`);
}

/** 起一个假的飞牛开放 API 网关 */
function startMockGateway(handler, socketPath) {
  // 命名管道理不存在文件，清理只对 POSIX 的 .sock 有意义
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(socketPath); } catch {}
  }
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      calls.push({
        url: req.url,
        method: req.method,
        auth: req.headers.authorization,
        appName: payload.appName,
        reqName: payload.req,
        data: payload.data,
        reqId: payload.reqId
      });
      const out = handler(payload);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({
      calls,
      close: () => new Promise((done) => server.close(done))
    }));
  });
}

/** 用桩替换 fnosApi 后重新加载 Service，返回还原函数 */
function loadServiceWithStub(stub) {
  delete require.cache[SERVICE];
  const real = require(FNOS_API);
  const snapshot = { ...real };
  Object.assign(real, stub);
  const Service = require(SERVICE);
  return { Service, restore: () => Object.assign(real, snapshot) };
}

/** 临时改环境变量跑一段逻辑 */
async function withEnv(env, fn) {
  const keys = ['TRIM_DATA_ACCESSIBLE_PATHS', 'TRIM_DATA_SHARE_PATHS', 'TRIM_API_TOKEN'];
  const saved = {};
  for (const key of keys) { saved[key] = process.env[key]; delete process.env[key]; }
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

/** 造一套临时目录当作「素材库候选」 */
function makeFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'niupic-accessible-'));
  const writable = path.join(root, '可写库');
  const readOnly = path.join(root, '只读库');
  const withIndex = path.join(root, '已有索引库');
  for (const dir of [writable, readOnly, withIndex]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(withIndex, '.niupic'), { recursive: true });
  fs.writeFileSync(path.join(withIndex, '.niupic', 'metadata.db'), '');
  fs.chmodSync(readOnly, 0o555);
  return {
    root, writable, readOnly, withIndex,
    cleanup: () => {
      try { fs.chmodSync(readOnly, 0o755); } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

// ============================================================ 协议契约

test('callFnosApi 走固定路径 /api/v1/trimapp，带 Bearer Token 与 reqId', async () => {
  const socketPath = mockSocketPath('mock');
  const gateway = await startMockGateway(
    (payload) => ({ body: { reqId: payload.reqId, code: 0, msg: '', data: { paths: ['/vol1/1000/图片库'] } } }),
    socketPath
  );
  try {
    const data = await callFnosApi('trim.file.getSharedAccessibleFolders', {}, {
      socketPath, token: TOKEN, appName: 'niupic'
    });
    assert.deepStrictEqual(data, { paths: ['/vol1/1000/图片库'] });

    assert.strictEqual(gateway.calls.length, 1);
    assert.strictEqual(gateway.calls[0].url, '/api/v1/trimapp');
    assert.strictEqual(gateway.calls[0].method, 'POST');
    assert.strictEqual(gateway.calls[0].auth, `Bearer ${TOKEN}`);
    assert.strictEqual(gateway.calls[0].appName, 'niupic');
    assert.ok(gateway.calls[0].reqId, '请求必须带 reqId');
  } finally {
    await gateway.close();
  }
});

test('没有 TRIM_API_TOKEN 时不发请求（Token 只从环境读，不猜不落盘）', async () => {
  const socketPath = mockSocketPath('mock-noauth');
  const gateway = await startMockGateway(() => ({ body: { code: 0 } }), socketPath);
  try {
    await withEnv({}, async () => {
      await assert.rejects(
        () => callFnosApi('trim.file.getSharedAccessibleFolders', {}, { socketPath, token: '' }),
        /TRIM_API_TOKEN/
      );
    });
    assert.strictEqual(gateway.calls.length, 0, '不该发出任何请求');
  } finally {
    await gateway.close();
  }
});

test('HTTP 404 与业务 code != 0 都会被识别为错误', async () => {
  const socketPath = mockSocketPath('mock-err');
  const gateway = await startMockGateway((payload) => {
    if (payload.req === 'trim.not.exists') return { status: 404, body: { code: 200005, msg: 'Not Found' } };
    return { body: { reqId: payload.reqId, code: 3, msg: '业务失败' } };
  }, socketPath);
  try {
    await assert.rejects(
      () => callFnosApi('trim.not.exists', {}, { socketPath, token: TOKEN }),
      /HTTP 404/
    );
    await assert.rejects(
      () => callFnosApi('trim.file.something', {}, { socketPath, token: TOKEN }),
      (e) => e instanceof FnosApiError && e.apiCode === 3 && e.message === '业务失败'
    );
  } finally {
    await gateway.close();
  }
});

// ============================================================ 清单来源与降级

/**
 * 下面几条用例的真值依赖"POSIX 绝对路径"：产品里的 `normalizePath` 只认以 `/` 开头的路径
 * （飞牛是 Linux，素材库路径形如 `/vol1/1000/…`，这是刻意的），而 Windows 上
 * `makeFixtures()` 造出来的是 `C:\Users\…\可写库`，会被直接丢掉，用例于是"跑不出结果"。
 * 这是**环境差异，不是缺陷** —— 在 Linux/fnOS 上这些用例会真正执行（它们是安全回归的一部分）。
 * 与其在 Windows 上显示成 5 条失败（看着像坏掉了），不如明确标成跳过并写清原因。
 */
const POSIX_ONLY = process.platform === 'win32'
  ? '依赖 POSIX 绝对路径（产品只接受 /vol… 这类路径），Windows 上无法构造夹具'
  : false;

test('开放 API 可用时以它为准，并标记 canManage=true', { skip: POSIX_ONLY }, async () => {
  const fx = makeFixtures();
  try {
    await withEnv({ TRIM_DATA_ACCESSIBLE_PATHS: fx.readOnly }, async () => {
      const { Service, restore } = loadServiceWithStub({
        callFnosApi: async (req) => {
          if (req === 'trim.file.getSharedAccessibleFolders') return { paths: [fx.writable] };
          if (req === 'trim.file.convertPath') {
            return { result: [{ path: fx.writable, semanticPath: '存储空间1/可写库' }] };
          }
          throw new Error('未预期的请求: ' + req);
        },
        isUnavailableError: () => false
      });
      try {
        const result = await new Service({ getLibraries: () => [] }).list({ language: 'zh-CN' });
        assert.strictEqual(result.canManage, true);
        assert.deepStrictEqual(result.folders.map((f) => f.path), [fx.writable], '环境变量不该盖过 API');
        assert.strictEqual(result.folders[0].displayPath, '存储空间1/可写库', '应采用飞牛的语义路径');
        assert.strictEqual(result.folders[0].writable, true);
      } finally { restore(); }
    });
  } finally { fx.cleanup(); }
});

test('开放 API 不可用时回落到 TRIM_DATA_ACCESSIBLE_PATHS', { skip: POSIX_ONLY }, async () => {
  const fx = makeFixtures();
  try {
    await withEnv({ TRIM_DATA_ACCESSIBLE_PATHS: `${fx.writable}:${fx.readOnly}` }, async () => {
      const { Service, restore } = loadServiceWithStub({
        callFnosApi: async () => { throw new Error('connect ENOENT /var/run/trim_open_gateway_apiscope.socket'); },
        isUnavailableError: () => true
      });
      try {
        const result = await new Service({ getLibraries: () => [] }).list({ language: 'zh-CN' });
        assert.strictEqual(result.canManage, true);
        assert.deepStrictEqual(
          result.folders.map((f) => f.path).sort(),
          [fx.writable, fx.readOnly].sort()
        );
        assert.ok(result.folders.every((f) => f.source === 'authorized'));
      } finally { restore(); }
    });
  } finally { fx.cleanup(); }
});

test('只读目录排在最后且 writable=false（NiuPic 要在库里建 .niupic）', { skip: POSIX_ONLY }, async () => {
  const fx = makeFixtures();
  try {
    await withEnv({ TRIM_DATA_ACCESSIBLE_PATHS: `${fx.readOnly}:${fx.writable}` }, async () => {
      const { Service, restore } = loadServiceWithStub({
        callFnosApi: async () => { throw new Error('ENOENT'); },
        isUnavailableError: () => true
      });
      try {
        const result = await new Service({ getLibraries: () => [] }).list({ language: 'zh-CN' });
        assert.strictEqual(result.folders[0].path, fx.writable, '可写的排前面');
        const ro = result.folders.find((f) => f.path === fx.readOnly);
        assert.strictEqual(ro.writable, false);
        assert.strictEqual(ro.readable, true);
      } finally { restore(); }
    });
  } finally { fx.cleanup(); }
});

test('已添加的素材库标记 alreadyAdded，已有索引的标记 hasExistingIndex', { skip: POSIX_ONLY }, async () => {
  const fx = makeFixtures();
  try {
    await withEnv({ TRIM_DATA_ACCESSIBLE_PATHS: `${fx.writable}:${fx.withIndex}` }, async () => {
      const { Service, restore } = loadServiceWithStub({
        callFnosApi: async () => { throw new Error('ENOENT'); },
        isUnavailableError: () => true
      });
      try {
        const result = await new Service({
          getLibraries: () => [{ path: fx.writable }]
        }).list({ language: 'zh-CN' });

        assert.strictEqual(result.folders.find((f) => f.path === fx.writable).alreadyAdded, true);
        assert.strictEqual(result.folders.find((f) => f.path === fx.withIndex).hasExistingIndex, true);
        assert.strictEqual(result.folders.find((f) => f.path === fx.withIndex).alreadyAdded, false);
      } finally { restore(); }
    });
  } finally { fx.cleanup(); }
});

test('完全拿不到授权信息时 canManage=false，并给出可照做的说明', async () => {
  await withEnv({}, async () => {
    const { Service, restore } = loadServiceWithStub({
      callFnosApi: async () => { throw new Error('TRIM_API_TOKEN 不可用'); },
      isUnavailableError: () => true
    });
    try {
      const result = await new Service({ getLibraries: () => [] }).list({ language: 'zh-CN' });
      assert.strictEqual(result.canManage, false);
      assert.ok(result.folders.every((f) => f.source === 'scanned'), '只能来自扫描兜底');
      assert.ok(/可访问文件夹/.test(result.message), '说明里要给出操作入口');
    } finally { restore(); }
  });
});

// ============================================================ 路径授权校验

test('isPathAuthorized：授权内 true、授权外 false、拿不到清单 null', { skip: POSIX_ONLY }, async () => {
  await withEnv({}, async () => {
    const { Service, restore } = loadServiceWithStub({
      callFnosApi: async (req) => {
        if (req === 'trim.file.getSharedAccessibleFolders') return { paths: ['/vol1/1000/图片库'] };
        return { result: [] };
      },
      isUnavailableError: () => false
    });
    try {
      const service = new Service({ getLibraries: () => [] });
      assert.strictEqual(await service.isPathAuthorized('/vol1/1000/图片库'), true, '授权目录本身');
      assert.strictEqual(await service.isPathAuthorized('/vol1/1000/图片库/2024/旅行'), true, '子目录');
      assert.strictEqual(await service.isPathAuthorized('/vol1/1000/图片库备份'), false, '同前缀但不在授权内');
      assert.strictEqual(await service.isPathAuthorized('/vol2/other'), false, '完全无关');
    } finally { restore(); }
  });
});

test('isPathAuthorized：拿不到授权清单时返回 null（调用方自行决定是否放行）', async () => {
  await withEnv({}, async () => {
    const { Service, restore } = loadServiceWithStub({
      callFnosApi: async () => { throw new Error('ENOENT'); },
      isUnavailableError: () => true
    });
    try {
      const service = new Service({ getLibraries: () => [] });
      assert.strictEqual(await service.isPathAuthorized('/tmp/任何地方'), null);
    } finally { restore(); }
  });
});
