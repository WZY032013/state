/**
 * 验证两处关键修复：
 *  1. QR 登录并发竞态：confirmed 状态只能被一个请求消费，杜绝 token 重复发放
 *  2. near_signal drain 数据丢失：LIMIT 200 读取后只删除已读 ID，超出部分保留
 *
 * 运行：node test/race-and-drain.test.js
 */
'use strict';

// ==================== Mock D1（支持 qr_sessions / tokens / near_signals） ====================
function createMockDb() {
  const qr = new Map();      // id -> row
  const tokens = new Map();  // token -> row
  const signals = [];        // {id, code, peer, data, ts}
  let signalSeq = 1;

  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/SELECT \* FROM qr_sessions WHERE id = \?/.test(sql)) {
                const row = qr.get(args[0]);
                // 返回快照（深拷贝），模拟两个请求在 UPDATE 提交前都读到 confirmed 的竞态
                return row ? JSON.parse(JSON.stringify(row)) : null;
              }
              if (/SELECT \* FROM tokens WHERE token = \?/.test(sql)) {
                const row = tokens.get(args[0]);
                return row ? JSON.parse(JSON.stringify(row)) : null;
              }
              return null;
            },
            async all() {
              if (/SELECT id, data FROM near_signals WHERE code = \? AND peer = \? ORDER BY id ASC LIMIT 200/.test(sql)) {
                const [code, peer] = args;
                const matched = signals
                  .filter(s => s.code === code && s.peer === peer)
                  .sort((a, b) => a.id - b.id)
                  .slice(0, 200);
                return { results: matched.map(s => ({ id: s.id, data: s.data })) };
              }
              return { results: [] };
            },
            async run() {
              // qr_sessions UPDATE（条件消费）
              if (/UPDATE qr_sessions SET status = 'consumed' WHERE id = \? AND status = 'confirmed'/.test(sql)) {
                const row = qr.get(args[0]);
                if (row && row.status === 'confirmed') {
                  row.status = 'consumed';
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              // qr_sessions DELETE
              if (/DELETE FROM qr_sessions WHERE id = \?/.test(sql)) {
                qr.delete(args[0]);
                return { success: true, meta: { changes: 1 } };
              }
              // near_signals DELETE BY IDS（修复后）
              if (/DELETE FROM near_signals WHERE id IN/.test(sql)) {
                const ids = new Set(args);
                for (let i = signals.length - 1; i >= 0; i--) {
                  if (ids.has(signals[i].id)) signals.splice(i, 1);
                }
                return { success: true, meta: { changes: args.length } };
              }
              // near_signals DELETE ALL（修复前的错误行为，用于对照）
              if (/DELETE FROM near_signals WHERE code = \? AND peer = \?/.test(sql)) {
                for (let i = signals.length - 1; i >= 0; i--) {
                  if (signals[i].code === args[0] && signals[i].peer === args[1]) signals.splice(i, 1);
                }
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  return { db, qr, tokens, signals };
}

// ==================== 复刻修复后的 getQrSession / handleQrStatus ====================
async function getQrSession(env, id) {
  if (!id) return null;
  const row = await env.DB.prepare('SELECT * FROM qr_sessions WHERE id = ?').bind(id).first();
  if (!row) return null;
  if (row.expires < Date.now()) {
    await env.DB.prepare('DELETE FROM qr_sessions WHERE id = ?').bind(id).run();
    return { id, status: 'expired' };
  }
  return row;
}

async function handleQrStatus(env, qrId) {
  const s = await getQrSession(env, qrId);
  if (!s) return { ok: false, status: 'invalid' };
  if (s.status === 'expired') return { ok: true, status: 'expired' };
  if (s.status === 'confirmed') {
    const upd = await env.DB.prepare(
      "UPDATE qr_sessions SET status = 'consumed' WHERE id = ? AND status = 'confirmed'"
    ).bind(s.id).run();
    if (!upd.meta || upd.meta.changes === 0) {
      return { ok: true, status: 'expired' };
    }
    const token = s.login_token;
    await env.DB.prepare('DELETE FROM qr_sessions WHERE id = ?').bind(s.id).run();
    return { ok: true, status: 'confirmed', token };
  }
  return { ok: true, status: s.status };
}

// ==================== 复刻修复后的 drain ====================
async function drainFixed(env, code, peer) {
  const rows = await env.DB.prepare(
    'SELECT id, data FROM near_signals WHERE code = ? AND peer = ? ORDER BY id ASC LIMIT 200'
  ).bind(code, peer).all();
  if (rows.results && rows.results.length) {
    const ids = rows.results.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM near_signals WHERE id IN (${placeholders})`).bind(...ids).run();
    return rows.results.map(r => r.data);
  }
  return null;
}

// ==================== 断言 ====================
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ FAIL: ' + msg); }
}

// ==================== 测试 ====================
(async () => {
  // ===== Bug1：QR 登录并发竞态 =====
  console.log('\n[Bug1 修复验证: QR 登录 token 只能被消费一次]');

  // 场景：两个请求几乎同时轮询同一个 confirmed 会话
  const t1 = createMockDb();
  t1.qr.set('qr-1', { id: 'qr-1', status: 'confirmed', login_token: 'tok-abc', expires: Date.now() + 60000, created_at: Date.now() });
  t1.tokens.set('tok-abc', { token: 'tok-abc', phone: '13800000000', expires: Date.now() + 86400000 });

  // 并发调用（JS 单线程下 await 点模拟交错）
  const [rA, rB] = await Promise.all([
    handleQrStatus({ DB: t1.db }, 'qr-1'),
    handleQrStatus({ DB: t1.db }, 'qr-1'),
  ]);

  const confirmedCount = [rA, rB].filter(r => r.status === 'confirmed').length;
  assert(confirmedCount === 1, '两个并发请求中恰好一个获得 confirmed（token 只发一次）');
  const expiredCount = [rA, rB].filter(r => r.status === 'expired').length;
  assert(expiredCount === 1, '另一个请求返回 expired（不再重复发放 token）');
  assert(!t1.qr.has('qr-1'), '会话已被删除（清理完成）');

  // 场景：单请求正常消费
  const t1b = createMockDb();
  t1b.qr.set('qr-2', { id: 'qr-2', status: 'confirmed', login_token: 'tok-xyz', expires: Date.now() + 60000, created_at: Date.now() });
  const rSingle = await handleQrStatus({ DB: t1b.db }, 'qr-2');
  assert(rSingle.status === 'confirmed' && rSingle.token === 'tok-xyz', '单请求正常消费，返回 token');

  // 场景：pending 状态不消费
  const t1c = createMockDb();
  t1c.qr.set('qr-3', { id: 'qr-3', status: 'pending', expires: Date.now() + 60000, created_at: Date.now() });
  const rPending = await handleQrStatus({ DB: t1c.db }, 'qr-3');
  assert(rPending.status === 'pending', 'pending 状态原样返回，不触发消费');
  assert(t1c.qr.get('qr-3').status === 'pending', 'pending 会话未被修改');

  // ===== Bug2：near_signal drain 不丢失超限信号 =====
  console.log('\n[Bug2 修复验证: drain 只删除已读信号，>200 的部分保留]');

  const t2 = createMockDb();
  const CODE = 'ABC123', PEER = 'p1';
  // 灌入 250 条信号
  for (let i = 0; i < 250; i++) {
    t2.signals.push({ id: i + 1, code: CODE, peer: PEER, data: 'sig-' + (i + 1), ts: Date.now() + i });
  }

  const out1 = await drainFixed({ DB: t2.db }, CODE, PEER);
  assert(out1.length === 200, '首次 drain 返回 200 条（LIMIT 生效）');
  assert(t2.signals.length === 50, '剩余 50 条信号未被删除（修复前会被全部删除）');
  assert(t2.signals.every(s => s.id > 200), '剩余的都是 id>200 的信号，无丢失');

  // 第二次 drain 取走剩余
  const out2 = await drainFixed({ DB: t2.db }, CODE, PEER);
  assert(out2.length === 50, '第二次 drain 返回剩余 50 条');
  assert(t2.signals.length === 0, '两次 drain 后信号全部消费完毕');

  // 对照：修复前的错误行为（DELETE code+peer 全量）
  console.log('\n[对照: 修复前的错误行为（验证 bug 存在）]');
  const t2b = createMockDb();
  for (let i = 0; i < 250; i++) {
    t2b.signals.push({ id: i + 1, code: CODE, peer: PEER, data: 'sig-' + (i + 1), ts: Date.now() + i });
  }
  // 模拟旧逻辑：LIMIT 200 读 + 全量 DELETE
  const rowsOld = await t2b.db.prepare(
    'SELECT id, data FROM near_signals WHERE code = ? AND peer = ? ORDER BY id ASC LIMIT 200'
  ).bind(CODE, PEER).all();
  await t2b.db.prepare('DELETE FROM near_signals WHERE code = ? AND peer = ?').bind(CODE, PEER).run();
  assert(rowsOld.results.length === 200, '旧逻辑只读 200 条');
  assert(t2b.signals.length === 0, '旧逻辑删除全部 250 条 → 50 条信号丢失（bug 复现）');

  console.log(`\n========== 结果：通过 ${passed} 项，失败 ${failed} 项 ==========`);
  process.exit(failed ? 1 : 0);
})();
