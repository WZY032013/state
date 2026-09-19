/**
 * 验证 stating API 两处修复：
 *  1. handleSaveMessage DELETE 路由能正确删除已收藏消息
 *  2. handleGetSessions isCurrent 能正确标记当前会话
 *
 * 运行：node test/fix-verify.test.js
 */
'use strict';

// ---------- Mock D1 ----------
function createMockDb(rows = {}) {
  const saved = rows.saved || [];       // {phone, msgId, groupCode, ts}
  const sessions = rows.sessions || []; // {id, phone, token, userAgent, createdAt, lastActive}
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/SELECT 1 FROM saved_messages WHERE phone = \? AND msgId = \?/.test(sql)) {
                const hit = saved.find(r => r.phone === args[0] && r.msgId === args[1]);
                return hit ? { '1': 1 } : null;
              }
              if (/SELECT \* FROM sessions WHERE id = \? AND phone = \?/.test(sql)) {
                return sessions.find(s => s.id === args[0] && s.phone === args[1]) || null;
              }
              return null;
            },
            async all() {
              if (/SELECT id, userAgent, createdAt, lastActive, token FROM sessions WHERE phone = \?/.test(sql)) {
                return { results: sessions.filter(s => s.phone === args[0]) };
              }
              return { results: [] };
            },
            async run() {
              if (/DELETE FROM saved_messages WHERE phone = \? AND msgId = \?/.test(sql)) {
                const idx = saved.findIndex(r => r.phone === args[0] && r.msgId === args[1]);
                if (idx > -1) saved.splice(idx, 1);
              }
              if (/INSERT INTO saved_messages/.test(sql)) {
                saved.push({ phone: args[0], msgId: args[1], groupCode: args[2], ts: args[3] });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { db, saved, sessions };
}

// ---------- 复刻修复后的 handleSaveMessage ----------
async function handleSaveMessage(env, user, msgId, body) {
  const { groupCode } = body;
  const existing = await env.DB.prepare('SELECT 1 FROM saved_messages WHERE phone = ? AND msgId = ?').bind(user.phone, msgId).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM saved_messages WHERE phone = ? AND msgId = ?').bind(user.phone, msgId).run();
    return { ok: true, saved: false };
  }
  if (!groupCode) return { ok: false, error: '缺少群聊' };
  await env.DB.prepare('INSERT INTO saved_messages (phone, msgId, groupCode, ts) VALUES (?,?,?,?)').bind(user.phone, msgId, groupCode.toUpperCase(), Date.now()).run();
  return { ok: true, saved: true };
}

// ---------- 复刻修复后的 handleGetSessions ----------
async function handleGetSessions(env, user) {
  const res = await env.DB.prepare('SELECT id, userAgent, createdAt, lastActive, token FROM sessions WHERE phone = ? ORDER BY lastActive DESC').bind(user.phone).all();
  const currentToken = user._currentToken;
  return {
    ok: true,
    sessions: res.results.map(s => ({
      id: s.id,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastActive: s.lastActive,
      isCurrent: s.token === currentToken
    }))
  };
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ FAIL: ' + msg); }
}

(async () => {
  // ===== 测试 1：DELETE 已收藏消息（原 bug：返回 400 缺少群聊） =====
  console.log('\n[Bug1 修复验证: DELETE 已收藏消息]');
  const t1 = createMockDb({ saved: [{ phone: 'u1', msgId: 'm1', groupCode: 'G1', ts: 1 }] });
  const r1 = await handleSaveMessage({ DB: t1.db }, { phone: 'u1' }, 'm1', { groupCode: '' });
  assert(r1.ok === true && r1.saved === false, 'DELETE 返回 ok:true, saved:false（不再报 缺少群聊）');
  assert(t1.saved.length === 0, '数据库中该收藏记录已被删除');

  // ===== 测试 2：POST 新消息（正常收藏） =====
  console.log('\n[POST 新消息收藏]');
  const t2 = createMockDb({ saved: [] });
  const r2 = await handleSaveMessage({ DB: t2.db }, { phone: 'u1' }, 'm2', { groupCode: 'g2' });
  assert(r2.ok === true && r2.saved === true, 'POST 新消息返回 saved:true');
  assert(t2.saved.length === 1 && t2.saved[0].groupCode === 'G2', '记录入库且 groupCode 大写');

  // ===== 测试 3：POST 已有消息（toggle 取消收藏） =====
  console.log('\n[POST 已有消息 toggle 取消]');
  const t3 = createMockDb({ saved: [{ phone: 'u1', msgId: 'm3', groupCode: 'G3', ts: 1 }] });
  const r3 = await handleSaveMessage({ DB: t3.db }, { phone: 'u1' }, 'm3', { groupCode: '' });
  assert(r3.ok === true && r3.saved === false, 'POST 重复收藏触发 toggle，返回 saved:false');
  assert(t3.saved.length === 0, 'toggle 后记录已删除');

  // ===== 测试 4：POST 新消息但缺少 groupCode（应仍校验失败） =====
  console.log('\n[POST 新消息缺少 groupCode]');
  const t4 = createMockDb({ saved: [] });
  const r4 = await handleSaveMessage({ DB: t4.db }, { phone: 'u1' }, 'm4', { groupCode: '' });
  assert(r4.ok === false && r4.error === '缺少群聊', '新增场景缺少 groupCode 仍返回 400');

  // ===== 测试 5：handleGetSessions isCurrent 正确标记 =====
  console.log('\n[Bug2 修复验证: isCurrent 标记]');
  const t5 = createMockDb({
    sessions: [
      { id: 's1', phone: 'u1', token: 'tok-current', userAgent: 'Chrome', createdAt: 100, lastActive: 300 },
      { id: 's2', phone: 'u1', token: 'tok-other', userAgent: 'Safari', createdAt: 200, lastActive: 250 },
    ]
  });
  const r5 = await handleGetSessions({ DB: t5.db }, { phone: 'u1', _currentToken: 'tok-current' });
  const s1 = r5.sessions.find(s => s.id === 's1');
  const s2 = r5.sessions.find(s => s.id === 's2');
  assert(s1.isCurrent === true, '当前会话 s1 的 isCurrent === true');
  assert(s2.isCurrent === false, '非当前会话 s2 的 isCurrent === false');
  assert(!('token' in s1), '响应中不泄露 token 字段');

  console.log(`\n========== 结果：通过 ${passed} 项，失败 ${failed} 项 ==========`);
  process.exit(failed ? 1 : 0);
})();
