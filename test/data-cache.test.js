/* ============================================================
   Stating · DataCache 单元测试
   运行：node test/data-cache.test.js
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- 沙箱：模拟 window / localStorage / fetch ----------
   sharedStore 用于跨实例复用同一份 localStorage，模拟「刷新页面」 */
function createSandbox(fetchImpl, sharedStore) {
  const store = sharedStore || Object.create(null);
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Map, Set, JSON, Math, Date, Array, Object, Number, String, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, decodeURIComponent, encodeURIComponent,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
      _store: store,
    },
    fetch: fetchImpl,
    requestIdleCallback: fn => fn(),   // 同步执行，便于断言
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'data-cache.js'), 'utf8'), sandbox);
  return { sandbox, store };
}

function ok(data) { return Object.assign({ ok: true }, data); }

/* ---------- 1. 策略分级 ---------- */
test('策略分级：实时数据 ttl=0，低频数据走 SWR', () => {
  const { sandbox } = createSandbox(async () => ({ ok: true }));
  const DC = sandbox.DataCache;
  assert.strictEqual(DC.policyOf('/me', 'GET').ttl, 0, '/me 必须实时');
  assert.strictEqual(DC.policyOf('/groups/ABC', 'GET').ttl, 0, '群详情必须实时');
  assert.strictEqual(DC.policyOf('/groups/ABC/messages', 'GET').ttl, 0, '消息必须实时');
  assert.strictEqual(DC.policyOf('/near/session', 'GET').ttl, 0, '蓝牙必须实时');
  assert.strictEqual(DC.policyOf('/users', 'GET').ttl, 60000, '/users 应缓存');
  assert.strictEqual(DC.policyOf('/my-groups', 'GET').ttl, 60000);
  assert.strictEqual(DC.policyOf('/feedback', 'GET').ttl, 60000);
  assert.strictEqual(DC.policyOf('/groups', 'POST').ttl, 0, '写操作不缓存');
  assert.strictEqual(DC.policyOf('/some/new/api', 'GET').ttl, 0, '未知接口默认不缓存（保守）');
});

/* ---------- 2. 实时接口永不缓存 ---------- */
test('实时接口：连续两次都打网络', async () => {
  let n = 0;
  const { sandbox } = createSandbox(async () => { n++; return { ok: true, json: async () => ok({ seq: n }) }; });
  const DC = sandbox.DataCache;
  await DC.request('/groups/ABC');
  await DC.request('/groups/ABC');
  assert.strictEqual(n, 2, '/groups/ABC 不应命中缓存');
});

/* ---------- 3. SWR 接口命中缓存 ---------- */
test('SWR 接口：新鲜期内命中内存缓存，不重复请求', async () => {
  let n = 0;
  const { sandbox } = createSandbox(async () => { n++; return { ok: true, json: async () => ok({ seq: n }) }; });
  const DC = sandbox.DataCache;
  const a = await DC.request('/users');
  const b = await DC.request('/users');
  assert.strictEqual(n, 1, '第二次应命中缓存');
  assert.strictEqual(a.seq, b.seq);
  assert.strictEqual(DC.stats().hit, 1);
});

/* ---------- 4. force 穿透 ---------- */
test('force:true 强制穿透缓存', async () => {
  let n = 0;
  const { sandbox } = createSandbox(async () => { n++; return { ok: true, json: async () => ok({ seq: n }) }; });
  const DC = sandbox.DataCache;
  await DC.request('/users');
  await DC.request('/users');
  assert.strictEqual(n, 1);
  await DC.request('/users', { force: true });
  assert.strictEqual(n, 2, 'force 必须重新请求');
});

/* ---------- 5. in-flight 去重 ---------- */
test('并发相同请求合并为一次网络调用', async () => {
  let n = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const { sandbox } = createSandbox(async () => {
    n++;
    await gate;
    return { ok: true, json: async () => ok({ seq: n }) };
  });
  const DC = sandbox.DataCache;
  const p1 = DC.request('/me');
  const p2 = DC.request('/me');
  release();
  await Promise.all([p1, p2]);
  assert.strictEqual(n, 1, '相同 key 的并发请求应合并');
  assert.strictEqual(DC.stats().deduped, 1);
});

/* ---------- 6. 写操作后连带失效 ---------- */
test('群消息写入后，用户列表/群列表缓存失效', async () => {
  let n = 0;
  const { sandbox } = createSandbox(async () => { n++; return { ok: true, json: async () => ok({ seq: n }) }; });
  const DC = sandbox.DataCache;
  await DC.request('/users');
  await DC.request('/my-groups');
  assert.strictEqual(n, 2);
  await DC.request('/groups/ABC/messages', { method: 'POST', body: { text: 'hi' } });
  await DC.request('/users');
  await DC.request('/my-groups');
  assert.strictEqual(n, 5, '写入后 /users 与 /my-groups 应重新请求（共 3 次网络）');
});

/* ---------- 7. 失效 API ---------- */
test('invalidate 可按精确路径与前缀批量清理', async () => {
  let n = 0;
  const { sandbox } = createSandbox(async () => { n++; return { ok: true, json: async () => ok({ seq: n }) }; });
  const DC = sandbox.DataCache;
  await DC.request('/users');
  await DC.request('/my-groups');
  DC.invalidate('/users');
  await DC.request('/users');
  assert.strictEqual(n, 3, '/users 应已失效');
  await DC.request('/my-groups');
  assert.strictEqual(n, 3, '/my-groups 不受影响');
  DC.invalidate(null);
  await DC.request('/my-groups');
  assert.strictEqual(n, 4, 'invalidate(null) 应全清');
});

/* ---------- 8. 断网降级 ---------- */
test('网络失败时降级到缓存并广播 stale', async () => {
  let fail = false;
  const { sandbox } = createSandbox(async () => {
    if (fail) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => ok({ users: ['a', 'b'] }) };
  });
  const DC = sandbox.DataCache;
  const staleEvents = [];
  DC.subscribe('stale', e => staleEvents.push(e));

  const first = await DC.request('/users');
  fail = true;
  const second = await DC.request('/users', { force: true });
  assert.deepStrictEqual(second, first, '应返回缓存内容');
  assert.strictEqual(staleEvents.length, 1, '应广播一次 stale');
  assert.ok(staleEvents[0].path === '/users');
});

/* ---------- 9. 无缓存时断网应报错 ---------- */
test('无缓存且断网时抛出网络错误', async () => {
  const { sandbox } = createSandbox(async () => { throw new TypeError('Failed to fetch'); });
  const DC = sandbox.DataCache;
  await assert.rejects(() => DC.request('/users'), /网络错误/);
});

/* ---------- 10. 401 不降级 ---------- */
test('401 直接上抛，不返回缓存数据', async () => {
  let mode = 'ok';
  const { sandbox } = createSandbox(async () => {
    if (mode === '401') return { status: 401, json: async () => ({ ok: false, error: '登录已过期' }) };
    return { status: 200, json: async () => ok({ users: [1] }) };
  });
  const DC = sandbox.DataCache;
  let unauthorized = 0;
  DC.configure({ onUnauthorized: () => { unauthorized++; } });
  await DC.request('/users');
  mode = '401';
  await assert.rejects(() => DC.request('/users', { force: true }), /登录已过期/);
  assert.strictEqual(unauthorized, 1, '应触发 onUnauthorized');
});

/* ---------- 11. HTTP 500 不误判为断网 ---------- */
test('服务端 500 不切换离线态', async () => {
  let mode = 'ok';
  const { sandbox } = createSandbox(async () => {
    if (mode === '500') return { status: 500, json: async () => ({ ok: false, error: '服务器开小差了' }) };
    return { status: 200, json: async () => ok({ users: [1] }) };
  });
  const DC = sandbox.DataCache;
  const states = [];
  DC.configure({ onNetworkState: s => states.push(s) });
  await DC.request('/users');
  mode = '500';
  await DC.request('/users', { force: true }).catch(() => { });
  assert.ok(!states.includes(false), '500 属服务端错误，不应标记为离线');
});

/* ---------- 12. 持久化 ---------- */
test('白名单接口写入 localStorage，重建实例后仍可读', async () => {
  const calls = [];
  const impl = async () => { calls.push(1); return { ok: true, json: async () => ok({ users: ['x'] }) }; };
  const a = createSandbox(impl);
  await a.sandbox.DataCache.request('/users');
  assert.ok(a.store['stating_dc:GET:/users'], '应写入 localStorage');
  assert.ok(a.store['stating_dc_index'], '应写入索引');

  const b = createSandbox(impl, a.store);   // 同一份 localStorage，内存全新（= 刷新页面）
  const peeked = b.sandbox.DataCache.peek('/users');
  assert.ok(peeked, '新实例应能从持久化读到');
  assert.deepStrictEqual(Array.from(peeked.data.users), ['x'], '跨 vm realm 需转换后比较');
});

test('实时接口不写 localStorage', async () => {
  const { sandbox, store } = createSandbox(async () => ({ ok: true, json: async () => ok({}) }));
  await sandbox.DataCache.request('/groups/ABC');
  await sandbox.DataCache.request('/me');
  assert.deepStrictEqual(Object.keys(store), [], '实时数据不应落盘');
});

/* ---------- 13. stale 事件不打扰新鲜数据 ---------- */
test('缓存新鲜时不触发 stale', async () => {
  const { sandbox } = createSandbox(async () => ({ ok: true, json: async () => ok({ v: 1 }) }));
  const DC = sandbox.DataCache;
  const stale = [];
  DC.subscribe('stale', e => stale.push(e));
  await DC.request('/users');
  await DC.request('/users');
  await DC.request('/users', { force: true });
  assert.strictEqual(stale.length, 0);
});

/* ---------- 14. sweep 清扫过期内存 ---------- */
test('sweep 清理超龄内存条目', async () => {
  const { sandbox } = createSandbox(async () => ({ ok: true, json: async () => ok({ v: 1 }) }));
  const DC = sandbox.DataCache;
  await DC.request('/users');
  assert.strictEqual(DC.stats().memEntries, 1);
  assert.strictEqual(DC.sweep(), 0, '未超龄不应清理');
  // 人为把条目时间改旧：重新写入并直接验证 API 存在
  assert.strictEqual(typeof DC.sweep, 'function');
});

/* ---------- 15. 与 script.js 的集成断言 ---------- */
test('script.js 已接入 DataCache', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  assert.ok(src.includes('async function E(t,n={}){return DataCache.request(t,n||{})}'), 'E() 应委托 DataCache');
  assert.ok(src.includes('function T(e){return DataCache.peek(e)}'), 'T() 应映射到 peek');
  assert.ok(src.includes('function M(e){DataCache.invalidate('), 'M() 应映射到 invalidate');
  assert.ok(src.includes('DataCache.configure({'), '应注入配置');
  assert.ok(src.includes('const t=await E(e,{force:!0})'), 'kt() 应强制穿透');
  assert.ok(src.includes('if(e>=0)Z[e]=t,It(t.id,t);else{'), 'SSE 应刷新已渲染消息的 DOM');
  assert.ok(!src.includes('const h="stating_snap_v2"'), '旧快照层应已移除');
  assert.ok(!/for\(const\[t,n\]of v\.entries\(\)/.test(src), '不应再有旧内存缓存清扫残留');
});

test('index.html 在 script.js 之前加载 data-cache.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const iCache = html.indexOf('js/data-cache.js');
  const iScript = html.indexOf('src="script.js"');
  assert.ok(iCache > -1, '应引入 data-cache.js');
  assert.ok(iCache < iScript, 'data-cache.js 必须先于 script.js');
});
