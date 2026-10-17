/* ============================================================\n   Stating · DataCache v1\n   ------------------------------------------------------------\n   为 /api 提供「分级缓存 + SWR + 降级」，同时保证实时数据永不缓存。\n\n   1) 分级策略（POLICIES 自上而下匹配，第一条命中生效）\n      - no-cache（ttl=0）  实时数据：/me 登录态、/groups/** 群与消息、\n        /near/** 蓝牙、/beat、/users/:p/call。每次都走网络，\n        仅做 in-flight 合并，避免并发重复请求。\n      - SWR（ttl>0）        低频数据：用户列表、我的群聊、反馈、个人资料。\n        新鲜期直接返回；超过 swrAfter 后静默后台重验证（stale-while-revalidate），\n        界面不闪烁、不会出现「半旧半新」的列表。\n      - default             一律不缓存（保守默认：新增接口不会意外被缓存）。\n\n   2) 实时性保证\n      - 任何写操作成功后按规则连带失效相关缓存。\n      - opts.force = true 强制穿透（SSE 断线兜底轮询、进入群聊、重连补齐走它）。\n      - 可按 path / 前缀 / tag 批量失效。\n\n   3) 持久化（降级用）\n      仅 persist:true 的路径写入 localStorage，带总量上限与按时间淘汰。\n      断网或接口失败时命中快照即可直接渲染（降级展示），并广播 stale 事件。\n\n   4) 异常处理\n      - fetch 本身失败 → 判定为断网，切离线态；内存 → 持久化 → 抛「网络错误」\n      - HTTP 5xx 等     → 不伪装成离线；SWR 接口仍可降级到陈旧数据\n      - 401            → 不降级，清 token 并回调 onUnauthorized\n      - 快照过期        → 仍可返回（广播 stale），不阻塞界面\n   ============================================================ */\n(function (global) {\n  'use strict';\n\n  var LS_PREFIX = 'stating_dc:';\n  var LS_MAX_BYTES = 400 * 1024;    // 持久化总上限，超出按最旧淘汰\n  var SWR_AFTER_MAX = 20000;        // 新鲜期上限：20s 内直接返回缓存\n  var INFLIGHT_HOLD = 3000;         // 请求完成后仍保留 3s，吸收连续点击\n  var MEM_MAX_AGE = 10 * 60 * 1000; // 内存条目最长保留 10 分钟\n\n  /* ---------- 策略表 ---------- */\n  var POLICIES = [\n    { tag: 'auth',     re: /^\/me$/,                 ttl: 0,     persist: false, revalidate: false },\n    { tag: 'realtime', re: /^\/groups\//,             ttl: 0,     persist: false, revalidate: false },\n    { tag: 'realtime', re: /^\/(near|beat)(\/|$)/,   ttl: 0,     persist: false, revalidate: false },\n    { tag: 'realtime', re: /^\/users\/[^/]+\/call$/, ttl: 0,     persist: false, revalidate: false },\n    { tag: 'members',  re: /^\/users$/,              ttl: 60000, persist: true,  revalidate: true  },\n    { tag: 'groups',   re: /^\/my-groups$/,          ttl: 60000, persist: true,  revalidate: true  },\n    { tag: 'feedback', re: /^\/feedback$/,           ttl: 60000, persist: true,  revalidate: true  },\n    { tag: 'profile',  re: /^\/users\/[^/]+$/,       ttl: 60000, persist: true,  revalidate: true  },\n    { tag: 'default',  re: /.*/,                     ttl: 0,     persist: false, revalidate: false }\n  ];\n\n  /* ---------- 运行时状态 ---------- */\n  var cfg = {\n    base: '/api',\n    getToken: function () { try { return localStorage.getItem('stating_token') || ''; } catch (e) { return ''; } },\n    onUnauthorized: null,\n    onNetworkState: null,\n    onStale: null\n  };\n\n  var mem = new Map();       // key -> {ts, data, tag}\n  var inflight = new Map();  // key -> {p:Promise}（包装对象，便于识别「已完成但仍在窗口」）\n  var lsIndex = null;        // 懒加载的 localStorage 快照索引\n  var listeners = { invalidate: [], stale: [], refresh: [] };\n  var stats = { hit: 0, miss: 0, staleServed: 0, revalidated: 0, deduped: 0, network: 0, failures: 0 };\n\n  /* ================= 基础工具 ================= */\n\n  function policyOf(path, method) {\n    if ((method || 'GET').toUpperCase() !== 'GET') {\n      return { tag: 'write', ttl: 0, persist: false, revalidate: false };\n    }\n    for (var i = 0; i < POLICIES.length; i++) {\n      if (POLICIES[i].re.test(path)) return POLICIES[i];\n    }\n    return POLICIES[POLICIES.length - 1];\n  }\n\n  function keyOf(path, opts) {\n    var method = (opts.method || 'GET').toUpperCase();\n    if (method === 'GET') return 'GET:' + path;\n    var body = opts.body, raw;\n    if (body == null) raw = '';\n    else if (typeof body === 'string') raw = body;\n    else { try { raw = JSON.stringify(body); } catch (e) { raw = String(body); } }\n    return method + ':' + path + ':' + raw;\n  }\n\n  function pathOfKey(key) { var i = key.indexOf(':'); return i < 0 ? key : key.slice(i + 1); }\n\n  function emit(type, payload) {\n    var arr = listeners[type];\n    if (!arr) return;\n    for (var i = 0; i < arr.length; i++) {\n      try { arr[i](payload); } catch (e) { /* 单个监听器异常不影响主流程 */ }\n    }\n  }\n\n  function idle(fn) {\n    if (typeof global.requestIdleCallback === 'function') global.requestIdleCallback(fn, { timeout: 1500 });\n    else setTimeout(fn, 80);\n  }\n\n  /* ================= 持久化 ================= */\n\n  function loadIndex() {\n    if (lsIndex) return lsIndex;\n    try {\n      lsIndex = JSON.parse(localStorage.getItem('stating_dc_index') || '{}');\n      if (!lsIndex || typeof lsIndex !== 'object') lsIndex = {};\n    } catch (e) { lsIndex = {}; }\n    return lsIndex;\n  }\n\n  function lsRead(key) {\n    var idx = loadIndex();\n    if (!idx[key]) return null;\n    try {\n      var raw = localStorage.getItem(LS_PREFIX + key);\n      if (raw == null) { delete idx[key]; return null; }\n      return { ts: idx[key].ts, data: JSON.parse(raw), tag: idx[key].tag };
    } catch (e) { delete idx[key]; return null; }
  }

  function sizeOf(key) {
    try { return ((localStorage.getItem(LS_PREFIX + key)) || '').length + key.length; } catch (e) { return 0; }
  }

  function lsWrite(key, entry) {
    var idx = loadIndex();
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(entry.data));
      idx[key] = { ts: entry.ts, tag: entry.tag };
    } catch (e) { delete idx[key]; return; }   // 配额不足：放弃持久化，内存缓存仍有效
    evict(idx);
    try { localStorage.setItem('stating_dc_index', JSON.stringify(idx)); } catch (e) { /* 忽略 */ }
  }

  function evict(idx) {
    var keys = Object.keys(idx);
    if (!keys.length) return;
    var total = 0, i;
    for (i = 0; i < keys.length; i++) total += sizeOf(keys[i]);
    if (total <= LS_MAX_BYTES) return;
    keys.sort(function (a, b) { return (idx[a].ts || 0) - (idx[b].ts || 0); }); // 最旧先淘汰
    for (i = 0; i < keys.length && total > LS_MAX_BYTES; i++) {
      total -= sizeOf(keys[i]);
      try { localStorage.removeItem(LS_PREFIX + keys[i]); } catch (e) { /* 忽略 */ }
      delete idx[keys[i]];
    }
  }

  function lsDrop(key) {
    var idx = loadIndex();
    try { localStorage.removeItem(LS_PREFIX + key); } catch (e) { /* 忽略 */ }
    delete idx[key];
  }

  function lsClearAll() {
    var idx = loadIndex();
    Object.keys(idx).forEach(function (k) {
      try { localStorage.removeItem(LS_PREFIX + k); } catch (e) { /* 忽略 */ }
    });
    lsIndex = {};
    try { localStorage.removeItem('stating_dc_index'); } catch (e) { /* 忽略 */ }
  }

  /* ================= 读取与写入 ================= */

  function lookup(key) {
    var e = mem.get(key);
    if (e) return e;
    e = lsRead(key);
    if (e) mem.set(key, e);   // 命中持久化后回填内存，后续走内存
    return e;
  }

  /* 写入：内存始终保留；仅 persist 策略落盘。
     若不加此判断，/groups/** 与 /me 的响应会混进 localStorage，
     既撑爆配额，也会让「下次进入」先读到本不该缓存的实时数据。 */
  function store(key, data, policy) {
    var entry = { ts: Date.now(), data: data, tag: policy ? policy.tag : '' };
    mem.set(key, entry);
    if (policy && policy.persist) { try { lsWrite(key, entry); } catch (e) { /* 配额不足则仅保留内存 */ } }
    return entry;
  }

  function swrAfter(policy) {
    if (policy.swrAfter != null) return policy.swrAfter;
    return Math.min(SWR_AFTER_MAX, Math.floor(policy.ttl * 0.4));
  }

  /* ================= 失效 ================= */

  function matches(path, targets) {
    if (targets == null) return true;
    var list = Array.isArray(targets) ? targets : [targets];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t instanceof RegExp) { if (t.test(path)) return true; continue; }
      if (typeof t !== 'string') continue;
      if (t === path) return true;
      if (t.indexOf('tag:') === 0) { if (policyOf(path, 'GET').tag === t.slice(4)) return true; continue; }
      if (t.charAt(t.length - 1) === '/' && path.indexOf(t) === 0) return true; // 前缀失效
    }
    return false;
  }

  function invalidate(targets) {
    mem.forEach(function (_entry, key) { if (matches(pathOfKey(key), targets)) mem.delete(key); });
    var idx = loadIndex(), changed = false;
    Object.keys(idx).forEach(function (key) {
      if (matches(pathOfKey(key), targets)) { lsDrop(key); changed = true; }
    });
    if (changed) { try { localStorage.setItem('stating_dc_index', JSON.stringify(idx)); } catch (e) { /* 忽略 */ } }
    // 丢弃在途请求，避免失效后又被旧响应写回缓存
    inflight.forEach(function (_p, key) { if (matches(pathOfKey(key), targets)) inflight.delete(key); });
    emit('invalidate', { targets: targets == null ? '*' : targets, ts: Date.now() });
  }

  /* 写操作后的连带失效规则：只清真正会变的部分，避免无谓回源 */
  function invalidateAfterWrite(path) {
    if (/^\/groups\//.test(path)) { invalidate(['/my-groups', '/me', '/users']); return; } // 群/消息变更会影响成员与最后消息时间
    if (/^\/users/.test(path)) { invalidate(['/users', '/me']); return; }
    if (/^\/feedback/.test(path)) { invalidate(['/feedback']); return; }
    if (/^\/saved/.test(path)) { invalidate(['/saved']); return; }
    if (/^\/block/.test(path)) { invalidate(['/users']); return; }
    invalidate(null); // 其余写操作低频，全清代价可接受
  }

  /* ================= 网络 ================= */

  function fetchOnce(path, opts) {
    var headers = { 'Content-Type': 'application/json' };
    var token = cfg.getToken ? cfg.getToken() : '';
    if (token) headers.Authorization = 'Bearer ' + token;
    var init = { method: (opts.method || 'GET').toUpperCase(), headers: headers };
    if (opts.body != null) init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;
    stats.network++;
    return fetch(cfg.base + path, init);
  }

  function doFetch(path, opts, policy, key) {
    return fetchOnce(path, opts).then(function (res) {
      if (cfg.onNetworkState) cfg.onNetworkState(true);
      return res.json().catch(function () { return { ok: false, error: '服务器响应异常' }; })
        .then(function (json) {
          if (!json || json.ok === false) {
            var err = new Error((json && json.error) || ('请求失败（' + res.status + '）'));
            err.status = res.status;
            err.data = json;
            if (res.status === 401) {
              err.isAuth = true;
              try { localStorage.removeItem('stating_token'); } catch (e) { /* 忽略 */ }
              if (cfg.onUnauthorized) cfg.onUnauthorized();
            }
            throw err;
          }
          if ((opts.method || 'GET').toUpperCase() === 'GET') store(key, json, policy);
          emit('refresh', { path: path, ts: Date.now(), tag: policy.tag });
          return json;
        });
    }).catch(function (err) {
      if (err && err.isAuth) throw err;                 // 鉴权失败不降级，交上层跳登录
      var isNetwork = !(err && err.status);             // 没有 status = fetch 本身失败 = 断网
      if (isNetwork) {
        stats.failures++;
        if (cfg.onNetworkState) cfg.onNetworkState(false);
      }
      // 降级：内存 → 持久化（仅 SWR 接口、且调用方未禁止）
      if (policy.ttl > 0 && !opts.noFallback) {
        var e2 = lookup(key);
        if (e2) {
          stats.staleServed++;
          var age = Date.now() - e2.ts;
          emit('stale', { path: path, age: age, reason: (err && err.message) || 'error' });
          if (cfg.onStale) cfg.onStale(path, age, err);
          return e2.data;
        }
      }
      throw (err && err.status) ? err : new Error('网络错误');
    });
  }

  /* ================= 主入口 ================= */

  function request(path, opts) {
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var policy = policyOf(path, method);
    var key = keyOf(path, opts);

    /* 写操作：不读缓存，成功后连带失效 */
    if (method !== 'GET') {
      return doFetch(path, opts, policy, key).then(function (data) {
        invalidateAfterWrite(path);
        return data;
      });
    }

    /* 强制穿透：SSE 断线兜底轮询 / 进入群聊 / 重连补齐。
       刻意不复用 inflight —— 否则会拿到上一轮结果，force 形同虚设。 */
    if (opts.force) {
      stats.miss++;
      return inflightRun(key, path, opts, policy);
    }

    /* 实时接口：只做 in-flight 合并，保证每次都是新数据 */
    if (policy.ttl <= 0) {
      var r = inflight.get(key);
      if (r) { stats.deduped++; return r.p; }
      return inflightRun(key, path, opts, policy);
    }

    /* SWR 接口 */
    var entry = lookup(key);
    if (entry) {
      var age = Date.now() - entry.ts;
      if (age < swrAfter(policy)) { stats.hit++; return Promise.resolve(entry.data); }
      if (age < policy.ttl) {
        // 已进入重验证窗口：本次仍返回缓存，后台静默刷新，界面不闪烁
        stats.hit++;
        revalidate(key, path, opts, policy);
        return Promise.resolve(entry.data);
      }
      // 超过 TTL：陈旧数据先顶上，同时后台刷新
      revalidate(key, path, opts, policy);
      stats.staleServed++;
      emit('stale', { path: path, age: age, reason: 'expired' });
      if (cfg.onStale) cfg.onStale(path, age, null);
      return Promise.resolve(entry.data);
    }

    stats.miss++;
    return inflightRun(key, path, opts, policy);
  }

  /* in-flight 合并：
     实时接口（ttl=0）—— 仅合并「同一时刻」的并发请求，完成即释放，
       否则 3 秒窗口内的第二次请求会拿到上一次结果，破坏实时性；
     SWR 接口 —— 完成后保留 INFLIGHT_HOLD，吸收连续点击造成的重复回源。 */
  function inflightRun(key, path, opts, policy) {
    var p = doFetch(path, opts, policy, key);
    var rec = { p: p };
    inflight.set(key, rec);
    var clear = function () {
      if (policy.ttl > 0) {
        // SWR：完成后保留短窗口，吸收连续点击造成的重复回源
        setTimeout(function () { if (inflight.get(key) === rec) inflight.delete(key); }, INFLIGHT_HOLD);
      } else if (inflight.get(key) === rec) {
        // 实时：完成即释放，保证下一次调用一定回源
        inflight.delete(key);
      }
    };
    p.then(clear, clear);
    return p;
  }

  function revalidate(key, path, opts, policy) {
    if (inflight.has(key)) return;
    stats.revalidated++;
    idle(function () { inflightRun(key, path, opts, policy).catch(function () { /* 后台刷新失败静默 */ }); });
  }

  /* ================= 对外接口 ================= */

  function peek(path, opts) {
    var policy = policyOf(path, 'GET');
    if (policy.ttl <= 0) return null;
    var e = lookup(keyOf(path, opts || {}));
    return e ? { ts: e.ts, data: e.data, age: Date.now() - e.ts, tag: e.tag } : null;
  }

  function subscribe(type, fn) {
    if (!listeners[type]) return function () { };
    listeners[type].push(fn);
    return function () {
      var i = listeners[type].indexOf(fn);
      if (i >= 0) listeners[type].splice(i, 1);
    };
  }

  global.DataCache = {
    version: 1,
    configure: function (options) {
      if (!options) return;
      for (var k in options) if (Object.prototype.hasOwnProperty.call(options, k)) cfg[k] = options[k];
    },
    request: request,
    peek: peek,
    invalidate: invalidate,
    subscribe: subscribe,
    policyOf: policyOf,
    // 清扫过期内存条目（由宿主定时器每 30s 调用）
    sweep: function () {
      var now = Date.now(), n = 0;
      mem.forEach(function (entry, key) {
        if (now - entry.ts > MEM_MAX_AGE) { mem.delete(key); n++; }
      });
      return n;
    },
    clearMemory: function () { mem.clear(); },
    clearAll: function () { mem.clear(); lsClearAll(); },
    stats: function () {
      var s = {}, k;
      for (k in stats) if (Object.prototype.hasOwnProperty.call(stats, k)) s[k] = stats[k];
      s.memEntries = mem.size;
      s.total = s.hit + s.miss;
      s.hitRate = s.total ? +(s.hit / s.total).toFixed(3) : 0;
      return s;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);\n