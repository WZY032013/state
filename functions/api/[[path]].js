/* ============================================================
   Stating — Cloudflare Pages Functions API
   D1 SQLite 存储，密码登录，无验证码
   ============================================================ */

const ADMIN_PHONE = '13385387338';
const ADMIN_KEY = '032013';
const MSG_TTL = 30 * 24 * 60 * 60 * 1000; // 30天
const MAX_MSGS = 500; // 每群最多保留500条
const TOKEN_TTL = 60 * 60 * 24 * 30; // token 30天
const PRESENCE_TTL = 60000; // 在线状态60秒过期
const LOCATION_TTL = 120000; // 位置120秒过期
const CALL_TTL = 3600000; // 通话1小时过期

// ============ 工具函数 ============

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function ok(data) { return json({ ok: true, ...data }); }
function fail(msg, status = 400) { return json({ ok: false, error: msg }, status); }

// 密码：PBKDF2-SHA256 10万次迭代；兼容旧 sha256，登录时透明升级
async function legacyHash(password, salt) {
  const enc = new TextEncoder();
  const keyData = await crypto.subtle.digest('SHA-256', enc.encode(password + ':' + salt));
  return Array.from(new Uint8Array(keyData), b => b.toString(16).padStart(2, '0')).join('');
}
async function pbkdf2Hash(password, salt) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, km, 256);
  return 'pbkdf2$' + b64uEnc(new Uint8Array(bits));
}
async function verifyPassword(password, salt, stored) {
  if (typeof stored === 'string' && stored.startsWith('pbkdf2$')) return (await pbkdf2Hash(password, salt)) === stored;
  return (await legacyHash(password, salt)) === stored;
}
async function hashPassword(password, salt) { return pbkdf2Hash(password, salt); }
function passwordOk(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 64) return false;
  return /[a-zA-Z]/.test(pw) && /\d/.test(pw);
}

function makeSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function makeToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// base64url（WebAuthn/签名用，Workers 无 Buffer）
function b64uEnc(u8) {
  let s = ''; for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDec(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function parseArr(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }
function parseObj(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// ============ D1 数据操作 ============

async function getUser(env, phone) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first();
  if (!row) return null;
  row.joinedGroups = parseArr(row.joinedGroups);
  return row;
}

async function saveUser(env, user) {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO users (phone, nickname, avatar, email, passHash, passSalt, joinedGroups, createdAt, bubble_style, focus_start, focus_end, wx_openid, wx_unionid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    user.phone, user.nickname, user.avatar || '😀', user.email || '无',
    user.passHash, user.passSalt,
    JSON.stringify(user.joinedGroups || []), user.createdAt,
    user.bubble_style || '', user.focus_start || '', user.focus_end || '',
    user.wx_openid || '', user.wx_unionid || ''
  ).run();
}

async function getUserIndex(env) {
  const res = await env.DB.prepare('SELECT phone FROM users').all();
  return res.results.map(r => r.phone);
}

async function getGroup(env, code) {
  code = code.toUpperCase();
  const row = await env.DB.prepare('SELECT * FROM groups WHERE code = ?').bind(code).first();
  if (!row) return null;
  row.members = parseArr(row.members);
  return row;
}

async function saveGroup(env, group) {
  group.code = group.code.toUpperCase();
  await env.DB.prepare(
    'INSERT OR REPLACE INTO groups (code, name, avatar, owner, members, createdAt) VALUES (?,?,?,?,?,?)'
  ).bind(
    group.code, group.name, group.avatar || '💬', group.owner,
    JSON.stringify(group.members || []), group.createdAt
  ).run();
}

async function deleteGroupKV(env, code) {
  code = code.toUpperCase();
  await env.DB.prepare('DELETE FROM groups WHERE code = ?').bind(code).run();
  await env.DB.prepare('DELETE FROM messages WHERE groupCode = ?').bind(code).run();
  await env.DB.prepare('DELETE FROM presence_group WHERE groupCode = ?').bind(code).run();
  await env.DB.prepare('DELETE FROM locations WHERE groupCode = ?').bind(code).run();
  await env.DB.prepare('DELETE FROM calls WHERE groupCode = ?').bind(code).run();
  await env.DB.prepare('DELETE FROM group_reads WHERE groupCode = ?').bind(code).run();
}

async function getGroupIndex(env) {
  const res = await env.DB.prepare('SELECT code FROM groups').all();
  return res.results.map(r => r.code);
}

async function getUsersByPhones(env, phones) {
  if (!phones || phones.length === 0) return {};
  const result = {};
  const chunks = [];
  for (let i = 0; i < phones.length; i += 20) {
    chunks.push(phones.slice(i, i + 20));
  }
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const res = await env.DB.prepare(
      `SELECT phone, nickname, avatar FROM users WHERE phone IN (${placeholders})`
    ).bind(...chunk).all();
    for (const row of res.results) {
      result[row.phone] = { nickname: row.nickname, avatar: row.avatar };
    }
  }
  return result;
}

async function getMessages(env, code) {
  code = code.toUpperCase();
  const cutoff = Date.now() - MSG_TTL;
  await env.DB.prepare('DELETE FROM messages WHERE groupCode = ? AND ts < ?').bind(code, cutoff).run();
  const res = await env.DB.prepare(
    'SELECT * FROM messages WHERE groupCode = ? ORDER BY ts ASC LIMIT ?'
  ).bind(code, MAX_MSGS).all();
  const phones = [...new Set(res.results.map(m => m.senderPhone))];
  const userMap = await getUsersByPhones(env, phones);
  const msgIds = res.results.map(m => m.id);
  const reactions = await getReactions(env, msgIds);
  return res.results.map(m => {
    m.readBy = parseArr(m.readBy);
    if (m.data) {
      try { Object.assign(m, JSON.parse(m.data)); } catch(e) {}
    }
    const u = userMap[m.senderPhone];
    if (u) { m.senderNickname = u.nickname; m.senderAvatar = u.avatar; }
    if (reactions[m.id]) m.reactions = reactions[m.id];
    return m;
  });
}

// 轻量查询：只获取ts之后的新消息，不做DELETE，用于SSE高频轮询
async function getNewMessages(env, code, sinceTs) {
  code = code.toUpperCase();
  const res = await env.DB.prepare(
    'SELECT * FROM messages WHERE groupCode = ? AND ts > ? ORDER BY ts ASC LIMIT 50'
  ).bind(code, sinceTs).all();
  if (res.results.length === 0) return [];
  const phones = [...new Set(res.results.map(m => m.senderPhone))];
  const userMap = await getUsersByPhones(env, phones);
  const msgIds = res.results.map(m => m.id);
  const reactions = await getReactions(env, msgIds);
  return res.results.map(m => {
    m.readBy = parseArr(m.readBy);
    if (m.data) {
      try { Object.assign(m, JSON.parse(m.data)); } catch(e) {}
    }
    const u = userMap[m.senderPhone];
    if (u) { m.senderNickname = u.nickname; m.senderAvatar = u.avatar; }
    if (reactions[m.id]) m.reactions = reactions[m.id];
    return m;
  });
}

// 获取群成员已读状态
async function getReadStatus(env, code) {
  code = code.toUpperCase();
  const res = await env.DB.prepare(
    'SELECT phone, lastReadTs FROM group_reads WHERE groupCode = ?'
  ).bind(code).all();
  const status = {};
  for (const r of res.results) { status[r.phone] = r.lastReadTs; }
  return status;
}

// 更新用户已读时间
async function updateReadStatus(env, code, phone) {
  code = code.toUpperCase();
  await env.DB.prepare(
    'INSERT INTO group_reads (groupCode, phone, lastReadTs) VALUES (?,?,?) ON CONFLICT(groupCode, phone) DO UPDATE SET lastReadTs = excluded.lastReadTs'
  ).bind(code, phone, Date.now()).run();
}

async function addMessage(env, code, msg) {
  code = code.toUpperCase();
  // 收集额外字段存入data
  const extra = {};
  for (const key of Object.keys(msg)) {
    if (!['id','senderPhone','type','content','ts','readBy','groupCode'].includes(key)) {
      extra[key] = msg[key];
    }
  }
  const dataJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
  await env.DB.prepare(
    'INSERT INTO messages (id, groupCode, senderPhone, type, content, ts, readBy, data) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(
    msg.id, code, msg.senderPhone, msg.type || 'text',
    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''),
    msg.ts, JSON.stringify(msg.readBy || []), dataJson
  ).run();
}

async function clearMessages(env, code) {
  await env.DB.prepare('DELETE FROM messages WHERE groupCode = ?').bind(code.toUpperCase()).run();
}

async function saveMessages(env, code, msgs) {
  code = code.toUpperCase();
  for (const msg of msgs) {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO messages (id, groupCode, senderPhone, type, content, ts, readBy) VALUES (?,?,?,?,?,?,?)'
    ).bind(
      msg.id, code, msg.senderPhone, msg.type || 'text',
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      msg.ts, JSON.stringify(msg.readBy || [])
    ).run();
  }
}

async function getGroupPresence(env, code) {
  code = code.toUpperCase();
  const cutoff = Date.now() - PRESENCE_TTL;
  await env.DB.prepare('DELETE FROM presence_group WHERE groupCode = ? AND lastSeen < ?').bind(code, cutoff).run();
  const res = await env.DB.prepare('SELECT * FROM presence_group WHERE groupCode = ?').bind(code).all();
  const result = {};
  for (const r of res.results) { result[r.phone] = { nickname: r.nickname, avatar: r.avatar, lastSeen: r.lastSeen }; }
  return result;
}

// 轻量版本：不做DELETE，只查询30秒内活跃的成员，用于SSE高频轮询
async function getGroupPresenceLight(env, code) {
  code = code.toUpperCase();
  const cutoff = Date.now() - 30000;
  const res = await env.DB.prepare('SELECT * FROM presence_group WHERE groupCode = ? AND lastSeen >= ?').bind(code, cutoff).all();
  const result = {};
  for (const r of res.results) { result[r.phone] = { nickname: r.nickname, avatar: r.avatar, lastSeen: r.lastSeen }; }
  return result;
}

async function updateGroupPresence(env, code, phone, info) {
  code = code.toUpperCase();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO presence_group (groupCode, phone, nickname, avatar, lastSeen)
     VALUES (?,?,?,?,?)
     ON CONFLICT(groupCode, phone) DO UPDATE SET nickname=excluded.nickname, avatar=excluded.avatar, lastSeen=excluded.lastSeen`
  ).bind(code, phone, info.nickname, info.avatar, now).run();
}

async function removeGroupPresence(env, code, phone) {
  await env.DB.prepare('DELETE FROM presence_group WHERE groupCode = ? AND phone = ?').bind(code.toUpperCase(), phone).run();
}

async function getGlobalPresence(env) {
  const cutoff = Date.now() - PRESENCE_TTL;
  await env.DB.prepare('DELETE FROM presence_global WHERE lastSeen < ?').bind(cutoff).run();
  const res = await env.DB.prepare('SELECT * FROM presence_global').all();
  const result = {};
  for (const r of res.results) { result[r.phone] = { nickname: r.nickname, avatar: r.avatar, lastSeen: r.lastSeen }; }
  return result;
}

async function updateGlobalPresence(env, phone, info) {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO presence_global (phone, nickname, avatar, lastSeen) VALUES (?,?,?,?)'
  ).bind(phone, info.nickname, info.avatar, Date.now()).run();
}

async function authUser(env, request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const row = await env.DB.prepare('SELECT * FROM tokens WHERE token = ?').bind(token).first();
  if (!row) return null;
  if (row.expires < Date.now()) {
    await env.DB.prepare('DELETE FROM tokens WHERE token = ?').bind(token).run();
    return null;
  }
  const user = await getUser(env, row.phone);
  if (user) user._currentToken = token;
  return user;
}

async function createToken(env, phone) {
  const token = makeToken();
  const expires = Date.now() + TOKEN_TTL * 1000;
  await env.DB.prepare('INSERT INTO tokens (token, phone, expires) VALUES (?,?,?)').bind(token, phone, expires).run();
  // 创建会话记录（表可能不存在，容错）
  try {
    const sessionId = makeId();
    const now = Date.now();
    await env.DB.prepare('INSERT INTO sessions (id, phone, token, userAgent, createdAt, lastActive) VALUES (?,?,?,?,?,?)').bind(sessionId, phone, token, 'Web', now, now).run();
  } catch(e) {}
  return token;
}

function publicUser(u) {
  return {
    phone: u.phone, nickname: u.nickname, avatar: u.avatar, email: u.email,
    joinedGroups: u.joinedGroups || [], createdAt: u.createdAt,
    isAdmin: u.phone === ADMIN_PHONE,
    bubbleStyle: u.bubble_style || '', focusStart: u.focus_start || '', focusEnd: u.focus_end || ''
  };
}

// ============ 注册/登录 ============

async function handleRegister(env, body) {
  const { phone, password, nickname, avatar, email, adminKey } = body;
  if (!phone || !password || !nickname) return fail('请填写完整信息');
  if (!/^\d{6,15}$/.test(phone)) return fail('手机号格式不正确');
  if (!passwordOk(password)) return fail('密码至少8位，需同时包含字母和数字');
  if (phone === ADMIN_PHONE) {
    if (!adminKey || adminKey !== ADMIN_KEY) return fail('管理员密钥错误');
  }
  const existing = await getUser(env, phone);
  if (existing) return fail('该手机号已注册，请直接登录');
  const salt = makeSalt();
  const passHash = await hashPassword(password, salt);
  const user = {
    phone, nickname, avatar: avatar || '😀', email: email || '无',
    passHash, passSalt: salt, joinedGroups: [], createdAt: Date.now()
  };
  await saveUser(env, user);
  await ensureMediaTable(env);
  const token = await createToken(env, phone);
  return ok({ token, user: publicUser(user) });
}

async function handleLogin(env, body) {
  const { phone, password, adminKey } = body;
  if (!phone || !password) return fail('请填写手机号和密码');
  if (phone === ADMIN_PHONE) {
    if (!adminKey || adminKey !== ADMIN_KEY) return fail('管理员密钥错误');
  }
  await ensureSecTables(env).catch(() => {});
  if (!(await rateHit(env, 'login:' + phone, 5, 15 * 60 * 1000))) return fail('尝试次数过多，请15分钟后再试', 429);
  const user = await getUser(env, phone);
  if (!user) { secLog(env, phone, 'login_fail', '账号不存在'); return fail('用户不存在'); }
  if (!(await verifyPassword(password, user.passSalt, user.passHash))) { secLog(env, phone, 'login_fail', '密码错误'); return fail('密码错误'); }
  await rateClear(env, 'login:' + phone);
  if (!String(user.passHash || '').startsWith('pbkdf2$')) { user.passHash = await pbkdf2Hash(password, user.passSalt); await saveUser(env, user); }
  await ensureMediaTable(env);
  const token = await createToken(env, phone);
  secLog(env, phone, 'login', '密码登录成功');
  return ok({ token, user: publicUser(user) });
}

// ============ 扫码登录（二维码只含一次性随机 qrId，不含任何账号密码） ============
const QRLOGIN_TTL = 2 * 60 * 1000; // 二维码 2 分钟有效

async function ensureQrTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS qr_sessions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    phone TEXT,
    login_token TEXT,
    expires INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`).run();
}

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

// PC 端：创建待扫码会话
async function handleQrCreate(env) {
  await ensureQrTable(env);
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  const qrId = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  await env.DB.prepare('INSERT INTO qr_sessions (id, status, expires, created_at) VALUES (?,?,?,?)')
    .bind(qrId, 'pending', now + QRLOGIN_TTL, now).run();
  return ok({ qrId, expiresIn: QRLOGIN_TTL / 1000 });
}

// PC 端：轮询状态；confirmed 一次性返回登录 token 并销毁会话
async function handleQrStatus(env, qrId) {
  await ensureQrTable(env);
  const s = await getQrSession(env, qrId);
  if (!s) return json({ ok: false, status: 'invalid', error: '二维码无效' });
  if (s.status === 'expired') return ok({ status: 'expired' });
  if (s.status === 'confirmed') {
    // 原子消费：只有一个请求能将 confirmed 改为 consumed，
    // 杜绝并发轮询（含截获 qrId 的攻击者）重复获取同一登录 token
    const upd = await env.DB.prepare(
      "UPDATE qr_sessions SET status = 'consumed' WHERE id = ? AND status = 'confirmed'"
    ).bind(s.id).run();
    if (!upd.meta || upd.meta.changes === 0) {
      // 已被其他请求消费（并发的另一方），返回 expired 让前端提示重新扫码
      return ok({ status: 'expired' });
    }
    const token = s.login_token;
    const row = await env.DB.prepare('SELECT * FROM tokens WHERE token = ?').bind(token).first();
    await env.DB.prepare('DELETE FROM qr_sessions WHERE id = ?').bind(s.id).run();
    if (!row || row.expires < Date.now()) return fail('登录态已失效，请重新扫码', 401);
    const u = await getUser(env, row.phone);
    return ok({ status: 'confirmed', token, user: publicUser(u) });
  }
  if (s.status === 'scanned') {
    const u = await getUser(env, s.phone);
    return ok({ status: 'scanned', scanner: u ? { nickname: u.nickname, avatar: u.avatar, phone: u.phone } : null });
  }
  return ok({ status: s.status });
}

// 手机端：已登录用户扫码
async function handleQrScan(env, user, body) {
  await ensureQrTable(env);
  const s = await getQrSession(env, body.qrId || '');
  if (!s || s.status === 'expired') return fail('二维码已过期');
  if (s.status !== 'pending') return fail('二维码已被使用');
  await env.DB.prepare('UPDATE qr_sessions SET status = ?, phone = ? WHERE id = ?')
    .bind('scanned', user.phone, s.id).run();
  return ok({ status: 'scanned' });
}

// 手机端：确认登录 → 服务端签发长期 token，PC 端下次轮询取走
async function handleQrConfirm(env, user, body) {
  await ensureQrTable(env);
  const s = await getQrSession(env, body.qrId || '');
  if (!s || s.status === 'expired') return fail('二维码已过期');
  if (s.status !== 'scanned' || s.phone !== user.phone) return fail('请先扫码再确认');
  const loginToken = await createToken(env, user.phone);
  await env.DB.prepare('UPDATE qr_sessions SET status = ?, login_token = ? WHERE id = ?')
    .bind('confirmed', loginToken, s.id).run();
  return ok({ status: 'confirmed' });
}

// 手机端：取消登录
async function handleQrCancel(env, user, body) {
  const s = await getQrSession(env, body.qrId || '');
  if (s && s.status !== 'confirmed' && s.status !== 'expired' && (!s.phone || s.phone === user.phone)) {
    await env.DB.prepare('UPDATE qr_sessions SET status = ? WHERE id = ?').bind('canceled', s.id).run();
  }
  return ok({});
}

// ============ 用户管理 ============

async function handleUsers(env) {
  const phones = await getUserIndex(env);
  const presence = await getGlobalPresence(env);
  const now = Date.now();
  const users = [];
  for (const phone of phones) {
    const u = await getUser(env, phone);
    if (u) {
      const pub = publicUser(u);
      const p = presence[phone];
      pub.online = !!(p && now - p.lastSeen < PRESENCE_TTL);
      pub.lastSeen = p ? p.lastSeen : (u.createdAt || now);
      users.push(pub);
    }
  }
  return ok({ users, presence });
}

// ============ 群聊 ============

async function handleCreateGroup(env, user, body) {
  const { name, avatar, code: userCode } = body;
  if (!name) return fail('请输入群聊名称');
  let code;
  if (userCode && /^[A-Za-z0-9]{4,12}$/.test(userCode)) {
    code = userCode.toUpperCase();
    if (await getGroup(env, code)) return fail('该邀请码已被使用');
  } else {
    do { code = Math.floor(100000 + Math.random() * 900000).toString(); }
    while (await getGroup(env, code));
  }
  const group = {
    code, name, avatar: avatar || '💬', owner: user.phone,
    members: [user.phone], createdAt: Date.now()
  };
  await saveGroup(env, group);
  // 更新用户的joinedGroups
  const u = await getUser(env, user.phone);
  if (u && !u.joinedGroups.includes(code)) {
    u.joinedGroups.push(code);
    await saveUser(env, u);
  }
  group.isMember = true;
  group.isOwner = true;
  return ok({ group });
}

async function handleJoinGroup(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('邀请码无效', 404);
  // 入群审核：开启后新成员需群主批准
  if (!group.members.includes(user.phone) && group.owner !== user.phone) {
    const metaRow = await env.DB.prepare('SELECT meta FROM group_meta WHERE groupId = ?').bind(code).first().catch(() => null);
    let meta = {};
    if (metaRow && metaRow.meta) { try { meta = JSON.parse(metaRow.meta); } catch (e) {} }
    if (meta.joinReview) {
      await env.DB.prepare('INSERT INTO join_requests (groupId, phone, nickname, ts, status) VALUES (?,?,?,?,\'pending\') ON CONFLICT(groupId, phone) DO UPDATE SET ts = excluded.ts, status = \'pending\'')
        .bind(code, user.phone, user.nickname || '', Date.now()).run().catch(() => {});
      return fail('该群已开启入群审核，申请已提交，请等待群主批准', 403);
    }
  }
  if (!group.members.includes(user.phone)) {
    group.members.push(user.phone);
    await saveGroup(env, group);
  }
  const u = await getUser(env, user.phone);
  if (u && !u.joinedGroups.includes(code)) {
    u.joinedGroups.push(code);
    await saveUser(env, u);
  }
  group.isMember = true;
  group.isOwner = group.owner === user.phone;
  return ok({ group });
}

async function handleLeaveGroup(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner === user.phone) return fail('群主不能退出群聊，请注销群聊');
  group.members = group.members.filter(p => p !== user.phone);
  await saveGroup(env, group);
  await removeGroupPresence(env, code, user.phone);
  const u = await getUser(env, user.phone);
  if (u) { u.joinedGroups = u.joinedGroups.filter(c => c !== code); await saveUser(env, u); }
  return ok({ left: true });
}

async function handleDeleteGroup(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone && user.phone !== ADMIN_PHONE) return fail('无权限', 403);
  await deleteGroupKV(env, code);
  // 从所有用户的joinedGroups中移除
  const phones = await getUserIndex(env);
  for (const phone of phones) {
    const u = await getUser(env, phone);
    if (u && u.joinedGroups.includes(code)) {
      u.joinedGroups = u.joinedGroups.filter(c => c !== code);
      await saveUser(env, u);
    }
  }
  return ok({ deleted: true });
}

async function handleGetGroup(env, user, code, since) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone) && user.phone !== ADMIN_PHONE) return fail('你不是群成员', 403);
  const presence = await getGroupPresence(env, code);
  let msgs;
  if (since) {
    const sinceTs = parseInt(since, 10);
    msgs = isNaN(sinceTs) ? await getMessages(env, code) : await getNewMessages(env, code, sinceTs);
  } else {
    msgs = await getMessages(env, code);
  }
  // 标记当前用户已读
  await updateReadStatus(env, code, user.phone);
  // 获取已读状态
  const readStatus = await getReadStatus(env, code);
  // 过滤出在线的成员（30秒内有心跳）
  const now = Date.now();
  const onlineMembers = {};
  for (const [phone, info] of Object.entries(presence)) {
    if (now - info.lastSeen < 30000) onlineMembers[phone] = info;
  }
  group.isMember = group.members.includes(user.phone);
  group.isOwner = group.owner === user.phone;
  group.readStatus = readStatus;
  // 公告
  const annRow = await env.DB.prepare('SELECT * FROM group_announcements WHERE groupCode = ?').bind(code).first();
  group.announcement = annRow ? { content: annRow.content, authorPhone: annRow.authorPhone, ts: annRow.ts } : null;
  // 用户设置
  const setRow = await env.DB.prepare('SELECT pinned, muted FROM group_user_settings WHERE groupCode = ? AND phone = ?').bind(code, user.phone).first();
  group.userSettings = setRow ? { pinned: !!setRow.pinned, muted: !!setRow.muted } : { pinned: false, muted: false };
  return ok({ group, presence, onlineMembers, messages: msgs });
}

// ============ 消息 ============

async function handleGetMessages(env, user, code, since) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone) && user.phone !== ADMIN_PHONE) return fail('你不是群成员', 403);
  let msgs;
  if (since) {
    const sinceTs = parseInt(since, 10);
    msgs = isNaN(sinceTs) ? await getMessages(env, code) : await getNewMessages(env, code, sinceTs);
  } else {
    msgs = await getMessages(env, code);
  }
  return ok({ messages: msgs });
}

async function handleSendMessage(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone)) return fail('你不是群成员', 403);
  let { type, text, content, imageData, voiceData, voiceDuration, fileData, fileName, fileType, fileSize, mediaUrl, location, lat, lng, replyToId, ephemeral, ephemeralSec, unlockAt, whisper, bioSigned, bioSig } = body;
  // 禁言检查
  const banRow = await env.DB.prepare('SELECT * FROM group_bans WHERE groupId = ? AND phone = ? AND until > ?').bind(code, user.phone, Date.now()).first().catch(() => null);
  if (banRow) return fail('你已被禁言，无法发送消息');
  // 敏感词过滤（内置词库兜底，前端已过滤）
  if (typeof text === 'string' || typeof content === 'string') {
    const rawText = String(text || content || '');
    const dirty = ['傻逼', '妈的', '操你', 'fuck', 'shit'];
    let cleanText = rawText;
    for (const w of dirty) { if (w) cleanText = cleanText.split(w).join('*'.repeat(w.length)); }
    if (cleanText !== rawText) {
      if (typeof text === 'string') { body.text = cleanText; text = cleanText; }
      if (typeof content === 'string') { body.content = cleanText; content = cleanText; }
    }
  }

  
      const msg = {
    id: makeId(), senderPhone: user.phone, type: type || 'text',
    content: content || text || '', ts: Date.now(), readBy: [user.phone],
    senderNickname: user.nickname, senderAvatar: user.avatar
  };
  if (replyToId) msg.replyToId = replyToId;
  if (ephemeral) { msg.ephemeral = true; msg.ephemeralSec = parseInt(ephemeralSec) || 10; }
  if (unlockAt) { msg.unlockAt = parseInt(unlockAt); msg.capsule = true; }
  if (whisper) msg.whisper = true;
  if (bioSigned) { msg.bioSigned = true; msg.bioSig = bioSig || ''; }
  // 解析@提及
  const textContent = content || text || '';
  const mentionMatches = textContent.match(/@(\d{6,15})/g);
  if (mentionMatches) {
    msg.mentions = JSON.stringify([...new Set(mentionMatches.map(m => m.slice(1)))]);
  }
  if (mediaUrl) {
    msg.content = mediaUrl;
    if (voiceDuration) msg.voiceDuration = voiceDuration;
    if (fileName) { msg.fileName = fileName; msg.fileSize = fileSize || 0; }
  }
  if (imageData && !mediaUrl) msg.imageData = imageData;
  if (voiceData && !mediaUrl) { msg.voiceData = voiceData; msg.voiceDuration = voiceDuration || 0; }
  if (fileData && !mediaUrl) { msg.fileData = fileData; msg.fileName = fileName || '文件'; msg.fileType = fileType || ''; msg.fileSize = fileSize || 0; }
  if (location) msg.location = location;
  if (lat !== undefined) msg.lat = lat;
  if (lng !== undefined) msg.lng = lng;
  await addMessage(env, code, msg);
  return ok({ message: msg });
}

async function handleClearMessages(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone && user.phone !== ADMIN_PHONE) return fail('无权限', 403);
  await clearMessages(env, code);
  return ok({ cleared: true });
}

async function handleMyGroups(env, user) {
  const u = await getUser(env, user.phone);
  const settings = await getGroupSettings(env, user.phone);
  const groups = [];
  for (const code of (u?.joinedGroups || [])) {
    const g = await getGroup(env, code);
    if (g) {
      const lastMsg = await env.DB.prepare(
        'SELECT ts FROM messages WHERE groupCode = ? ORDER BY ts DESC LIMIT 1'
      ).bind(code.toUpperCase()).first();
      g.lastMsgTs = lastMsg ? lastMsg.ts : g.createdAt;
      g.isOwner = g.owner === user.phone;
      g.pinned = !!(settings[code.toUpperCase()]?.pinned);
      g.muted = !!(settings[code.toUpperCase()]?.muted);
      groups.push(g);
    }
  }
  // 置顶的排前面
  groups.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastMsgTs - a.lastMsgTs;
  });
  return ok({ groups });
}

async function handleUpdateProfile(env, user, body) {
  const { nickname, avatar, email } = body;
  const u = await getUser(env, user.phone);
  if (!u) return fail('用户不存在', 404);
  if (nickname) u.nickname = nickname;
  if (avatar !== undefined) u.avatar = avatar;
  if (email !== undefined) u.email = email;
  if (body.bubbleStyle !== undefined) u.bubble_style = body.bubbleStyle;
  if (body.focusStart !== undefined) u.focus_start = body.focusStart;
  if (body.focusEnd !== undefined) u.focus_end = body.focusEnd;
  await saveUser(env, u);
  return ok({ user: publicUser(u) });
}

async function handleRecallMessage(env, user, code, msgId) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone) && user.phone !== ADMIN_PHONE) return fail('你不是群成员', 403);
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
  if (!row) return fail('消息不存在', 404);
  if (row.senderPhone !== user.phone && user.phone !== ADMIN_PHONE) return fail('只能撤回自己的消息', 403);
  if (Date.now() - row.ts > 120000 && user.phone !== ADMIN_PHONE) return fail('超过撤回时限');
  await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(msgId).run();
  return ok({ recalled: true });
}

async function handleAdminDeleteUser(env, user, targetPhone) {
  if (user.phone !== ADMIN_PHONE) return fail('无权限', 403);
  if (targetPhone === ADMIN_PHONE) return fail('不能注销管理员账号');
  const target = await getUser(env, targetPhone);
  if (!target) return fail('用户不存在', 404);
  // 从所有群聊中移除
  for (const code of (target.joinedGroups || [])) {
    const g = await getGroup(env, code);
    if (g) {
      g.members = g.members.filter(p => p !== targetPhone);
      await saveGroup(env, g);
      await removeGroupPresence(env, code, targetPhone);
    }
  }
  await env.DB.prepare('DELETE FROM users WHERE phone = ?').bind(targetPhone).run();
  await env.DB.prepare('DELETE FROM presence_global WHERE phone = ?').bind(targetPhone).run();
  await env.DB.prepare('DELETE FROM tokens WHERE phone = ?').bind(targetPhone).run();
  return ok({ deleted: true });
}

async function handleAdminUserGroups(env, user, targetPhone) {
  if (user.phone !== ADMIN_PHONE) return fail('无权限', 403);
  const target = await getUser(env, targetPhone);
  if (!target) return fail('用户不存在', 404);
  const groups = [];
  for (const code of (target.joinedGroups || [])) {
    const g = await getGroup(env, code);
    if (g) {
      const allMsgs = await getMessages(env, code);
      const userMsgs = allMsgs.filter(m => m.senderPhone === targetPhone);
      groups.push({
        code: g.code,
        name: g.name,
        avatar: g.avatar,
        owner: g.owner,
        msgCount: userMsgs.length,
        lastMsgTs: userMsgs.length > 0 ? userMsgs[userMsgs.length - 1].ts : g.createdAt,
        messages: userMsgs
      });
    }
  }
  return ok({ user: publicUser(target), groups });
}

// ============ 心跳/在线状态 ============

async function handleBeat(env, user, code) {
  await updateGlobalPresence(env, user.phone, { nickname: user.nickname, avatar: user.avatar });
  if (code) {
    const group = await getGroup(env, code);
    if (group && group.members.includes(user.phone)) {
      await updateGroupPresence(env, code, user.phone, { nickname: user.nickname, avatar: user.avatar });
    }
  }
  return ok({});
}

async function handleDeleteAccount(env, user) {
  // 从所有群聊中移除
  const u = await getUser(env, user.phone);
  for (const code of (u?.joinedGroups || [])) {
    const g = await getGroup(env, code);
    if (g) {
      g.members = g.members.filter(p => p !== user.phone);
      await saveGroup(env, g);
      await removeGroupPresence(env, code, user.phone);
    }
  }
  await env.DB.prepare('DELETE FROM users WHERE phone = ?').bind(user.phone).run();
  await env.DB.prepare('DELETE FROM presence_global WHERE phone = ?').bind(user.phone).run();
  await env.DB.prepare('DELETE FROM tokens WHERE phone = ?').bind(user.phone).run();
  return ok({ deleted: true });
}

// ============ 博采反馈 ============

async function getFeedback(env) {
  const res = await env.DB.prepare('SELECT * FROM feedback ORDER BY ts DESC').all();
  return res.results.map(f => { f.replies = parseArr(f.replies); return f; });
}

async function handleReplyFeedback(env, user, fbId, body) {
  if (user.phone !== ADMIN_PHONE) return fail('无权限', 403);
  const { content } = body;
  if (!content) return fail('回复内容不能为空');
  const row = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?').bind(fbId).first();
  if (!row) return fail('反馈不存在', 404);
  const replies = parseArr(row.replies);
  replies.push({ content, ts: Date.now(), admin: user.nickname });
  await env.DB.prepare('UPDATE feedback SET replies = ? WHERE id = ?').bind(JSON.stringify(replies), fbId).run();
  return ok({ replied: true });
}

async function handleSubmitFeedback(env, user, body) {
  const { rating, content } = body;
  const fb = {
    id: makeId(), phone: user.phone, nickname: user.nickname, avatar: user.avatar,
    rating: parseInt(rating) || 0, content: content || '', ts: Date.now()
  };
  await env.DB.prepare(
    'INSERT INTO feedback (id, phone, nickname, avatar, rating, content, ts) VALUES (?,?,?,?,?,?,?)'
  ).bind(fb.id, fb.phone, fb.nickname, fb.avatar, fb.rating, fb.content, fb.ts).run();
  return ok({ feedback: fb });
}

async function handleGetFeedback(env, user) {
  const list = await getFeedback(env);
  const avg = list.length > 0 ? list.reduce((s, f) => s + (f.rating || 0), 0) / list.length : 0;
  return ok({ list, avg: Math.round(avg * 10) / 10, isAdmin: user.phone === ADMIN_PHONE });
}

// ============ 位置共享 ============

async function getLocations(env, code) {
  code = code.toUpperCase();
  const cutoff = Date.now() - LOCATION_TTL;
  await env.DB.prepare('DELETE FROM locations WHERE groupCode = ? AND lastSeen < ?').bind(code, cutoff).run();
  const res = await env.DB.prepare('SELECT * FROM locations WHERE groupCode = ?').bind(code).all();
  const result = {};
  for (const r of res.results) { result[r.phone] = { lat: r.lat, lng: r.lng, lastSeen: r.lastSeen }; }
  return result;
}

async function handleUpdateLocation(env, user, code, body) {
  code = code.toUpperCase();
  const { lat, lng } = body;
  if (lat == null || lng == null) return fail('位置信息不完整');
  await env.DB.prepare(
    'INSERT OR REPLACE INTO locations (groupCode, phone, lat, lng, lastSeen) VALUES (?,?,?,?,?)'
  ).bind(code, user.phone, lat, lng, Date.now()).run();
  return ok({ updated: true });
}

async function handleGetLocations(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone)) return fail('你不是群成员', 403);
  const locs = await getLocations(env, code);
  return ok({ locations: locs });
}

async function handleStopLocation(env, user, code) {
  await env.DB.prepare('DELETE FROM locations WHERE groupCode = ? AND phone = ?').bind(code.toUpperCase(), user.phone).run();
  return ok({ stopped: true });
}

// ============ 通话状态 ============

async function getCall(env, code) {
  code = code.toUpperCase();
  const row = await env.DB.prepare('SELECT * FROM calls WHERE groupCode = ?').bind(code).first();
  if (!row) return null;
  row.participants = parseArr(row.participants);
  // 清理过期通话
  if (row.startedAt && Date.now() - row.startedAt > CALL_TTL) {
    await env.DB.prepare('DELETE FROM calls WHERE groupCode = ?').bind(code).run();
    return null;
  }
  return row;
}

async function handleGetCall(env, user, code) {
  const call = await getCall(env, code);
  if (!call) return ok({ active: false });
  const now = Date.now();
  const active = call.participants.filter(p => now - p.lastSeen < 30000);
  if (active.length === 0) {
    await env.DB.prepare('DELETE FROM calls WHERE groupCode = ?').bind(code.toUpperCase()).run();
    return ok({ active: false });
  }
  call.participants = active;
  return ok({ active: true, call });
}

async function handleStartCall(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone)) return fail('你不是群成员', 403);
  let call = await getCall(env, code);
  const type = body.type || 'voice';
  if (!call) {
    call = { groupCode: code, type, startedBy: user.phone, startedAt: Date.now(), participants: [] };
  }
  const existing = call.participants.find(p => p.phone === user.phone);
  if (existing) {
    existing.lastSeen = Date.now();
    if (body.signal !== undefined) existing.signal = body.signal;
  } else {
    call.participants.push({ phone: user.phone, nickname: user.nickname, avatar: user.avatar, lastSeen: Date.now(), signal: body.signal !== undefined ? body.signal : undefined });
  }
  await env.DB.prepare(
    'INSERT OR REPLACE INTO calls (groupCode, type, startedBy, startedAt, participants) VALUES (?,?,?,?,?)'
  ).bind(code, call.type, call.startedBy, call.startedAt, JSON.stringify(call.participants)).run();
  return ok({ call });
}

async function handleEndCall(env, user, code) {
  code = code.toUpperCase();
  let call = await getCall(env, code);
  if (!call) return ok({ ended: true });
  call.participants = call.participants.filter(p => p.phone !== user.phone);
  if (call.participants.length === 0 || call.startedBy === user.phone) {
    await env.DB.prepare('DELETE FROM calls WHERE groupCode = ?').bind(code).run();
    return ok({ ended: true });
  }
  await env.DB.prepare('UPDATE calls SET participants = ? WHERE groupCode = ?').bind(JSON.stringify(call.participants), code).run();
  return ok({ call });
}

// ============ 媒体存储 ============

async function ensureMediaTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS media (
    key TEXT PRIMARY KEY,
    mimeType TEXT NOT NULL,
    data TEXT NOT NULL,
    uploadedBy TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS group_reads (
    groupCode TEXT NOT NULL,
    phone TEXT NOT NULL,
    lastReadTs INTEGER NOT NULL,
    PRIMARY KEY (groupCode, phone)
  )`).run();
  // 消息表情回复
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS message_reactions (
    msgId TEXT NOT NULL,
    emoji TEXT NOT NULL,
    phone TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (msgId, emoji, phone)
  )`).run();
  // 群用户设置（置顶/免打扰）
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS group_user_settings (
    groupCode TEXT NOT NULL,
    phone TEXT NOT NULL,
    pinned INTEGER DEFAULT 0,
    muted INTEGER DEFAULT 0,
    PRIMARY KEY (groupCode, phone)
  )`).run();
  // 群公告
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS group_announcements (
    groupCode TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    authorPhone TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`).run();
  // 输入中状态
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS typing (
    groupCode TEXT NOT NULL,
    phone TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (groupCode, phone)
  )`).run();
  // 登录会话（多端管理）
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    token TEXT NOT NULL,
    userAgent TEXT,
    createdAt INTEGER NOT NULL,
    lastActive INTEGER NOT NULL
  )`).run();
  // messages表新增列（忽略已存在错误）
  try { await env.DB.prepare('ALTER TABLE messages ADD COLUMN replyToId TEXT').run(); } catch(e) {}
  try { await env.DB.prepare('ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0').run(); } catch(e) {}
  try { await env.DB.prepare('ALTER TABLE messages ADD COLUMN editedAt INTEGER').run(); } catch(e) {}
  try { await env.DB.prepare('ALTER TABLE messages ADD COLUMN mentions TEXT').run(); } catch(e) {}
  try { await env.DB.prepare('ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0').run(); } catch(e) {}
  // 置顶消息
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pinned_messages (
    groupCode TEXT NOT NULL,
    msgId TEXT NOT NULL,
    pinnedBy TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (groupCode, msgId)
  )`).run();
  // 个人收藏
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS saved_messages (
    phone TEXT NOT NULL,
    msgId TEXT NOT NULL,
    groupCode TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (phone, msgId)
  )`).run();
  // 草稿
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS drafts (
    phone TEXT NOT NULL,
    groupCode TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (phone, groupCode)
  )`).run();

  // 位置打卡
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS checkins (
    id TEXT PRIMARY KEY,
    groupCode TEXT NOT NULL,
    phone TEXT NOT NULL,
    nickname TEXT,
    avatar TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    address TEXT,
    ts INTEGER NOT NULL
  )`).run();
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN bubble_style TEXT').run(); } catch(e) {}
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN focus_start TEXT').run(); } catch(e) {}
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN focus_end TEXT').run(); } catch(e) {}}

async function handleUpload(env, user, body) {
  const { data, mimeType } = body;
  if (!data || !mimeType) return fail('缺少文件数据');
  if (mimeType.length > 100) return fail('类型无效');
  // 限制5MB
  if (data.length > 7 * 1024 * 1024) return fail('文件过大（最大5MB）');
  let base64Data = data;
  if (typeof data === 'string' && data.startsWith('data:')) {
    const idx = data.indexOf(',');
    if (idx > -1) base64Data = data.slice(idx + 1);
  }
  const key = makeId();
  await env.DB.prepare(
    'INSERT INTO media (key, mimeType, data, uploadedBy, createdAt) VALUES (?,?,?,?,?)'
  ).bind(key, mimeType, base64Data, user.phone, Date.now()).run();
  return ok({ key, url: '/api/media/' + key });
}

async function handleGetMedia(env, key) {
  const row = await env.DB.prepare('SELECT * FROM media WHERE key = ?').bind(key).first();
  if (!row) return new Response('Not Found', { status: 404 });
  try {
    const binary = atob(row.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Response(bytes, {
      headers: {
        'Content-Type': row.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=2592000, immutable',
        'Content-Length': bytes.length,
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return new Response('Invalid media data', { status: 500 });
  }
}

// ============ SSE 实时推送 ============

async function handleSSE(env, user, code, since) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone) && user.phone !== ADMIN_PHONE) return fail('你不是群成员', 403);

  const encoder = new TextEncoder();
  let lastTs = since ? parseInt(since, 10) : 0;
  if (isNaN(lastTs)) lastTs = 0;

  await updateGlobalPresence(env, user.phone, { nickname: user.nickname, avatar: user.avatar });
  await updateGroupPresence(env, code, user.phone, { nickname: user.nickname, avatar: user.avatar });
  await updateReadStatus(env, code, user.phone);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(`: connected ${Date.now()}\n\n`));
        const startTime = Date.now();
        let pollCount = 0;
        let lastStatusSend = 0;

        // 连接时推送一次新消息（轻量查询，不做DELETE）
        const initMsgs = await getNewMessages(env, code, lastTs);
        for (const msg of initMsgs) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
          lastTs = msg.ts;
        }
        // 推送初始在线状态和已读状态
        const initialPresence = await getGroupPresenceLight(env, code);
        controller.enqueue(encoder.encode(`event: presence\ndata: ${JSON.stringify(initialPresence)}\n\n`));
        const initRead = await getReadStatus(env, code);
        controller.enqueue(encoder.encode(`event: readstatus\ndata: ${JSON.stringify(initRead)}\n\n`));
        lastStatusSend = Date.now();

        while (Date.now() - startTime < 60000) {
          pollCount++;

          // 轻量查询：只取ts之后的新消息
          const fresh = await getNewMessages(env, code, lastTs);
          for (const msg of fresh) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
            lastTs = msg.ts;
          }

          // 每5秒推送在线状态+已读状态
          const now = Date.now();
          if (now - lastStatusSend >= 5000) {
            // 更新自己的在线和已读状态
            await updateGroupPresence(env, code, user.phone, { nickname: user.nickname, avatar: user.avatar }).catch(() => {});
            await updateReadStatus(env, code, user.phone).catch(() => {});

            const onlineMembers = await getGroupPresenceLight(env, code);
            controller.enqueue(encoder.encode(`event: presence\ndata: ${JSON.stringify(onlineMembers)}\n\n`));
            const readStatus = await getReadStatus(env, code);
            controller.enqueue(encoder.encode(`event: readstatus\ndata: ${JSON.stringify(readStatus)}\n\n`));
            lastStatusSend = now;
          }

          // 每20秒心跳
          if (pollCount % 20 === 0) {
            controller.enqueue(encoder.encode(`: hb ${Date.now()}\n\n`));
            // 顺便清理过期presence
            env.DB.prepare('DELETE FROM presence_group WHERE groupCode = ? AND lastSeen < ?').bind(code, Date.now() - PRESENCE_TTL).run().catch(() => {});
          }

          await new Promise(r => setTimeout(r, 1000));
        }

        controller.enqueue(encoder.encode(`event: reconnect\ndata: ${lastTs}\n\n`));
        controller.close();
      } catch (e) {
        try { controller.close(); } catch (_) {}
      }
    },
    cancel() {}
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}

// ============ 新功能处理函数 ============

// 编辑消息
async function handleEditMessage(env, user, code, msgId, body) {
  code = code.toUpperCase();
  const { content } = body;
  if (!content || !content.trim()) return fail('内容不能为空');
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ? AND groupCode = ?').bind(msgId, code).first();
  if (!row) return fail('消息不存在', 404);
  if (row.senderPhone !== user.phone) return fail('只能编辑自己的消息', 403);
  await env.DB.prepare('UPDATE messages SET content = ?, edited = 1, editedAt = ? WHERE id = ?').bind(content.trim(), Date.now(), msgId).run();
  return ok({ edited: true });
}

// 悄悄话查看即焚
async function handleWhisperView(env, user, code, msgId) {
  code = code.toUpperCase();
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ? AND groupCode = ?').bind(msgId, code).first();
  if (!row) return fail('消息不存在', 404);
  if (!row.data || !JSON.parse(row.data || '{}').whisper) return fail('非悄悄话', 400);
  if (row.senderPhone === user.phone) return fail('不能查看自己的悄悄话', 403);
  const content = row.content;
  await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(msgId).run();
  return ok({ content });
}

// 表情回复（切换：有则删，无则加）
async function handleReactMessage(env, user, code, msgId, body) {
  code = code.toUpperCase();
  const { emoji } = body;
  if (!emoji) return fail('缺少emoji');
  const existing = await env.DB.prepare('SELECT 1 FROM message_reactions WHERE msgId = ? AND emoji = ? AND phone = ?').bind(msgId, emoji, user.phone).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM message_reactions WHERE msgId = ? AND emoji = ? AND phone = ?').bind(msgId, emoji, user.phone).run();
  } else {
    await env.DB.prepare('INSERT INTO message_reactions (msgId, emoji, phone, ts) VALUES (?,?,?,?)').bind(msgId, emoji, user.phone, Date.now()).run();
  }
  return ok({ reacted: !existing });
}

// 获取消息的表情回复
async function getReactions(env, msgIds) {
  if (!msgIds || msgIds.length === 0) return {};
  const placeholders = msgIds.map(() => '?').join(',');
  const res = await env.DB.prepare(`SELECT msgId, emoji, COUNT(*) as cnt FROM message_reactions WHERE msgId IN (${placeholders}) GROUP BY msgId, emoji`).bind(...msgIds).all();
  const result = {};
  for (const r of res.results) {
    if (!result[r.msgId]) result[r.msgId] = [];
    result[r.msgId].push({ emoji: r.emoji, count: r.cnt });
  }
  return result;
}

// 搜索消息
async function handleSearchMessages(env, user, code, q) {
  code = code.toUpperCase();
  if (!q || q.trim().length < 1) return ok({ results: [] });
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone) && user.phone !== ADMIN_PHONE) return fail('不是群成员', 403);
  const res = await env.DB.prepare(
    'SELECT * FROM messages WHERE groupCode = ? AND type = ? AND content LIKE ? ORDER BY ts DESC LIMIT 50'
  ).bind(code, 'text', '%' + q.trim() + '%').all();
  const phones = [...new Set(res.results.map(m => m.senderPhone))];
  const userMap = await getUsersByPhones(env, phones);
  const results = res.results.map(m => {
    const u = userMap[m.senderPhone];
    if (u) { m.senderNickname = u.nickname; m.senderAvatar = u.avatar; }
    return m;
  });
  return ok({ results });
}

// 转发消息到另一个群
async function handleForwardMessage(env, user, code, msgId, body) {
  code = code.toUpperCase();
  const { targetCode } = body;
  if (!targetCode) return fail('缺少目标群聊');
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ? AND groupCode = ?').bind(msgId, code).first();
  if (!row) return fail('消息不存在', 404);
  const target = await getGroup(env, targetCode);
  if (!target) return fail('目标群聊不存在', 404);
  if (!target.members.includes(user.phone)) return fail('不是目标群成员', 403);
  const newMsg = {
    id: makeId(), senderPhone: user.phone, type: row.type,
    content: row.content, ts: Date.now(), readBy: [user.phone],
    senderNickname: user.nickname, senderAvatar: user.avatar
  };
  if (row.data) {
    try { Object.assign(newMsg, JSON.parse(row.data)); } catch(e) {}
  }
  newMsg.forwardedFrom = code;
  await addMessage(env, targetCode.toUpperCase(), newMsg);
  return ok({ forwarded: true, message: newMsg });
}

// 输入中状态
async function handleTyping(env, user, code) {
  code = code.toUpperCase();
  await env.DB.prepare(
    'INSERT INTO typing (groupCode, phone, ts) VALUES (?,?,?) ON CONFLICT(groupCode, phone) DO UPDATE SET ts = excluded.ts'
  ).bind(code, user.phone, Date.now()).run();
  return ok({ typing: true });
}

async function handleGetTyping(env, user, code) {
  code = code.toUpperCase();
  const cutoff = Date.now() - 5000; // 5秒内算正在输入
  await env.DB.prepare('DELETE FROM typing WHERE groupCode = ? AND ts < ?').bind(code, cutoff).run();
  const res = await env.DB.prepare('SELECT phone FROM typing WHERE groupCode = ? AND phone != ?').bind(code, user.phone).all();
  const phones = res.results.map(r => r.phone);
  const userMap = await getUsersByPhones(env, phones);
  const typers = phones.map(p => ({ phone: p, nickname: userMap[p]?.nickname || p, avatar: userMap[p]?.avatar || '😀' }));
  return ok({ typers });
}

// 群公告
async function handleSetAnnouncement(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone && user.phone !== ADMIN_PHONE) return fail('只有群主可以设置公告', 403);
  const { content } = body;
  if (content === '' || content === null) {
    await env.DB.prepare('DELETE FROM group_announcements WHERE groupCode = ?').bind(code).run();
    return ok({ cleared: true });
  }
  await env.DB.prepare(
    'INSERT INTO group_announcements (groupCode, content, authorPhone, ts) VALUES (?,?,?,?) ON CONFLICT(groupCode) DO UPDATE SET content = excluded.content, authorPhone = excluded.authorPhone, ts = excluded.ts'
  ).bind(code, content, user.phone, Date.now()).run();
  return ok({ set: true });
}

async function handleGetAnnouncement(env, user, code) {
  code = code.toUpperCase();
  const row = await env.DB.prepare('SELECT * FROM group_announcements WHERE groupCode = ?').bind(code).first();
  if (!row) return ok({ announcement: null });
  const author = await getUser(env, row.authorPhone);
  return ok({ announcement: { content: row.content, authorNickname: author?.nickname || row.authorPhone, ts: row.ts } });
}

// 群用户设置（置顶/免打扰）
async function handleGroupSettings(env, user, code, body) {
  code = code.toUpperCase();
  const { pinned, muted } = body;
  const existing = await env.DB.prepare('SELECT * FROM group_user_settings WHERE groupCode = ? AND phone = ?').bind(code, user.phone).first();
  if (existing) {
    await env.DB.prepare('UPDATE group_user_settings SET pinned = ?, muted = ? WHERE groupCode = ? AND phone = ?').bind(
      pinned !== undefined ? (pinned ? 1 : 0) : existing.pinned,
      muted !== undefined ? (muted ? 1 : 0) : existing.muted,
      code, user.phone
    ).run();
  } else {
    await env.DB.prepare('INSERT INTO group_user_settings (groupCode, phone, pinned, muted) VALUES (?,?,?,?)').bind(
      code, user.phone, pinned ? 1 : 0, muted ? 1 : 0
    ).run();
  }
  return ok({ saved: true });
}

async function getGroupSettings(env, phone) {
  const res = await env.DB.prepare('SELECT groupCode, pinned, muted FROM group_user_settings WHERE phone = ?').bind(phone).all();
  const map = {};
  for (const r of res.results) { map[r.groupCode] = { pinned: !!r.pinned, muted: !!r.muted }; }
  return map;
}

// 导出聊天记录
async function handleExportChat(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone) && user.phone !== ADMIN_PHONE) return fail('不是群成员', 403);
  const msgs = await getMessages(env, code);
  let text = `=== ${group.name} (${code}) 聊天记录导出 ===\n导出时间: ${new Date().toLocaleString('zh-CN')}\n共 ${msgs.length} 条消息\n\n`;
  for (const m of msgs) {
    const time = new Date(m.ts).toLocaleString('zh-CN');
    const name = m.senderNickname || m.senderPhone;
    let content = m.content || '';
    if (m.type === 'image') content = '[图片]';
    else if (m.type === 'voice') content = `[语音 ${m.voiceDuration || 0}秒]`;
    else if (m.type === 'file') content = `[文件 ${m.fileName || ''}]`;
    else if (m.type === 'location') content = `[位置 ${m.lat},${m.lng}]`;
    if (m.edited) content += ' (已编辑)';
    text += `[${time}] ${name}: ${content}\n`;
  }
  return new Response(text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${code}_chat.txt"` }
  });
}

// 用户资料卡
async function handleGetUserProfile(env, user, phone) {
  const u = await getUser(env, phone);
  if (!u) return fail('用户不存在', 404);
  const groups = [];
  for (const code of (u.joinedGroups || [])) {
    const g = await getGroup(env, code);
    if (g) groups.push({ code: g.code, name: g.name, avatar: g.avatar, isOwner: g.owner === phone });
  }
  return ok({ profile: { phone: u.phone, nickname: u.nickname, avatar: u.avatar, email: u.email, createdAt: u.createdAt, groupCount: groups.length, groups } });
}

// 会话管理
async function handleGetSessions(env, user) {
  const res = await env.DB.prepare('SELECT id, userAgent, createdAt, lastActive, token FROM sessions WHERE phone = ? ORDER BY lastActive DESC').bind(user.phone).all();
  const currentToken = user._currentToken;
  return ok({ sessions: res.results.map(s => ({
    id: s.id,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
    lastActive: s.lastActive,
    isCurrent: s.token === currentToken
  })) });
}

async function handleDeleteSession(env, user, sessionId) {
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND phone = ?').bind(sessionId, user.phone).first();
  if (!row) return fail('会话不存在', 404);
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  await env.DB.prepare('DELETE FROM tokens WHERE token = ?').bind(row.token).run();
  return ok({ deleted: true });
}

// 群聊二维码（返回SVG data URL）
async function handleGroupQR(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone) && user.phone !== ADMIN_PHONE) return fail('不是群成员', 403);
  // 简单SVG二维码占位（实际可用QR库，这里用文字+样式生成可扫描的简易码）
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <rect width="200" height="200" fill="white"/>
    <text x="100" y="90" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">${group.name}</text>
    <text x="100" y="120" text-anchor="middle" font-size="28" font-weight="bold" fill="#FF9F43">${code}</text>
    <text x="100" y="150" text-anchor="middle" font-size="11" fill="#999">Stating 邀请码</text>
  </svg>`;
  const dataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  return ok({ qr: dataUrl, code, name: group.name });
}

// ============ 第二批新功能处理函数 ============

// 群成员列表
async function handleGetMembers(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone) && user.phone !== ADMIN_PHONE) return fail('不是群成员', 403);
  const userMap = await getUsersByPhones(env, group.members);
  const presence = await getGroupPresence(env, code);
  const now = Date.now();
  const members = group.members.map(phone => {
    const u = userMap[phone] || {};
    const p = presence[phone];
    return {
      phone, nickname: u.nickname || phone, avatar: u.avatar || '😀',
      isOwner: group.owner === phone,
      online: !!(p && now - p.lastSeen < 30000),
      lastSeen: p ? p.lastSeen : null
    };
  });
  return ok({ members, isOwner: group.owner === user.phone });
}

// 踢人（群主）
async function handleKickMember(env, user, code, targetPhone) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone && user.phone !== ADMIN_PHONE) return fail('只有群主可以踢人', 403);
  if (targetPhone === group.owner) return fail('不能踢出群主');
  if (!group.members.includes(targetPhone)) return fail('该用户不在群聊中', 404);
  group.members = group.members.filter(p => p !== targetPhone);
  await saveGroup(env, group);
  // 从被踢用户的joinedGroups中移除
  const targetUser = await getUser(env, targetPhone);
  if (targetUser) {
    targetUser.joinedGroups = (targetUser.joinedGroups || []).filter(c => c !== code);
    await saveUser(env, targetUser);
  }
  return ok({ kicked: true });
}

// 编辑群信息（群主）
async function handleEditGroup(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone && user.phone !== ADMIN_PHONE) return fail('只有群主可以编辑', 403);
  const { name, avatar } = body;
  if (name) group.name = name.trim().substring(0, 30);
  if (avatar) group.avatar = avatar;
  group.updatedAt = Date.now();
  await saveGroup(env, group);
  return ok({ group: { code: group.code, name: group.name, avatar: group.avatar } });
}

// 置顶/取消置顶消息
async function handlePinMessage(env, user, code, msgId) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone && user.phone !== ADMIN_PHONE) return fail('只有群主可以置顶', 403);
  const existing = await env.DB.prepare('SELECT 1 FROM pinned_messages WHERE groupCode = ? AND msgId = ?').bind(code, msgId).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM pinned_messages WHERE groupCode = ? AND msgId = ?').bind(code, msgId).run();
    await env.DB.prepare('UPDATE messages SET pinned = 0 WHERE id = ?').bind(msgId).run();
    return ok({ pinned: false });
  } else {
    await env.DB.prepare('INSERT INTO pinned_messages (groupCode, msgId, pinnedBy, ts) VALUES (?,?,?,?)').bind(code, msgId, user.phone, Date.now()).run();
    await env.DB.prepare('UPDATE messages SET pinned = 1 WHERE id = ?').bind(msgId).run();
    return ok({ pinned: true });
  }
}

// 获取置顶消息
async function handleGetPinned(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone) && user.phone !== ADMIN_PHONE) return fail('不是群成员', 403);
  const res = await env.DB.prepare(
    'SELECT m.* FROM messages m JOIN pinned_messages p ON m.id = p.msgId WHERE p.groupCode = ? ORDER BY p.ts DESC'
  ).bind(code).all();
  const phones = [...new Set(res.results.map(m => m.senderPhone))];
  const userMap = await getUsersByPhones(env, phones);
  const pinned = res.results.map(m => {
    m.readBy = parseArr(m.readBy);
    if (m.data) { try { Object.assign(m, JSON.parse(m.data)); } catch(e) {} }
    const u = userMap[m.senderPhone];
    if (u) { m.senderNickname = u.nickname; m.senderAvatar = u.avatar; }
    return m;
  });
  return ok({ pinned });
}

// 收藏消息
async function handleSaveMessage(env, user, msgId, body) {
  const { groupCode } = body;
  const existing = await env.DB.prepare('SELECT 1 FROM saved_messages WHERE phone = ? AND msgId = ?').bind(user.phone, msgId).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM saved_messages WHERE phone = ? AND msgId = ?').bind(user.phone, msgId).run();
    return ok({ saved: false });
  }
  if (!groupCode) return fail('缺少群聊');
  await env.DB.prepare('INSERT INTO saved_messages (phone, msgId, groupCode, ts) VALUES (?,?,?,?)').bind(user.phone, msgId, groupCode.toUpperCase(), Date.now()).run();
  return ok({ saved: true });
}

// 获取收藏列表
async function handleGetSaved(env, user) {
  const res = await env.DB.prepare('SELECT * FROM saved_messages WHERE phone = ? ORDER BY ts DESC').bind(user.phone).all();
  const msgIds = res.results.map(r => r.msgId);
  if (msgIds.length === 0) return ok({ saved: [] });
  const placeholders = msgIds.map(() => '?').join(',');
  const msgs = await env.DB.prepare(`SELECT * FROM messages WHERE id IN (${placeholders})`).bind(...msgIds).all();
  const phones = [...new Set(msgs.results.map(m => m.senderPhone))];
  const userMap = await getUsersByPhones(env, phones);
  const saved = msgs.results.map(m => {
    m.readBy = parseArr(m.readBy);
    if (m.data) { try { Object.assign(m, JSON.parse(m.data)); } catch(e) {} }
    const u = userMap[m.senderPhone];
    if (u) { m.senderNickname = u.nickname; m.senderAvatar = u.avatar; }
    const sr = res.results.find(r => r.msgId === m.id);
    if (sr) m.savedAt = sr.ts;
    return m;
  });
  return ok({ saved });
}

// 草稿
async function handleGetDraft(env, user, code) {
  code = code.toUpperCase();
  const row = await env.DB.prepare('SELECT content FROM drafts WHERE phone = ? AND groupCode = ?').bind(user.phone, code).first();
  return ok({ content: row?.content || '' });
}

async function handleSaveDraft(env, user, code, body) {
  code = code.toUpperCase();
  const { content } = body;
  if (!content || !content.trim()) {
    await env.DB.prepare('DELETE FROM drafts WHERE phone = ? AND groupCode = ?').bind(user.phone, code).run();
    return ok({ saved: false });
  }
  await env.DB.prepare(
    'INSERT INTO drafts (phone, groupCode, content, ts) VALUES (?,?,?,?) ON CONFLICT(phone, groupCode) DO UPDATE SET content = excluded.content, ts = excluded.ts'
  ).bind(user.phone, code, content, Date.now()).run();
  return ok({ saved: true });
}


// ============ 第三批新功能处理函数 ============

// 位置打卡
async function handleCheckin(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group || !group.members.includes(user.phone)) return fail('不在群聊中', 403);
  const { lat, lng, address } = body;
  if (lat == null || lng == null) return fail('缺少位置信息');
  const id = makeId();
  await env.DB.prepare(
    'INSERT INTO checkins (id, groupCode, phone, nickname, avatar, lat, lng, address, ts) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(id, code, user.phone, user.nickname, user.avatar, lat, lng, address || '', Date.now()).run();
  return ok({ id });
}

async function handleGetCheckins(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group || !group.members.includes(user.phone)) return fail('不在群聊中', 403);
  const res = await env.DB.prepare(
    'SELECT * FROM checkins WHERE groupCode = ? ORDER BY ts DESC LIMIT 100'
  ).bind(code).all();
  return ok({ checkins: res.results });
}

// 群相册回忆（一年前今天的图片消息）
async function handleMemories(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group || !group.members.includes(user.phone)) return fail('不在群聊中', 403);
  const now = new Date();
  const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const startTs = new Date(oneYearAgo.getFullYear(), oneYearAgo.getMonth(), oneYearAgo.getDate()).getTime();
  const endTs = startTs + 86400000;
  const res = await env.DB.prepare(
    "SELECT * FROM messages WHERE groupCode = ? AND type = 'image' AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 20"
  ).bind(code, startTs, endTs).all();
  return ok({ memories: res.results, date: (oneYearAgo.getMonth()+1) + '月' + oneYearAgo.getDate() + '日' });
}
// ============ 路由 ============

// ============ 近场 P2P 信令（WebRTC 全浏览器兜底） ============

const NEAR_TTL = 30 * 60 * 1000; // 会话30分钟过期

async function ensureNearTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS near_sessions (
    code TEXT PRIMARY KEY, createdBy TEXT NOT NULL, updatedAt INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS near_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, peer TEXT NOT NULL,
    data TEXT NOT NULL, ts INTEGER NOT NULL
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_near_signal ON near_signals(code, peer)').run();
}

function nearCode() {
  const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

async function handleNearSession(env, user, url, method) {
  await ensureNearTable(env);
  // 清理过期会话与信令
  const cutoff = Date.now() - NEAR_TTL;
  await env.DB.prepare('DELETE FROM near_sessions WHERE updatedAt < ?').bind(cutoff).run();
  await env.DB.prepare('DELETE FROM near_signals WHERE ts < ?').bind(cutoff).run();

  if (method === 'POST') {
    let code = nearCode();
    let tries = 0;
    while (tries++ < 5) {
      const exist = await env.DB.prepare('SELECT code FROM near_sessions WHERE code = ?').bind(code).first();
      if (!exist) break;
      code = nearCode();
    }
    await env.DB.prepare('INSERT OR REPLACE INTO near_sessions (code, createdBy, updatedAt) VALUES (?,?,?)')
      .bind(code, user.phone, Date.now()).run();
    return ok({ code });
  }

  if (method === 'DELETE') {
    const code = url.searchParams.get('code');
    if (!code) return fail('缺少会话码');
    await env.DB.prepare('DELETE FROM near_sessions WHERE code = ?').bind(code).run();
    await env.DB.prepare('DELETE FROM near_signals WHERE code = ?').bind(code).run();
    return ok({ deleted: true });
  }

  // GET 查询
  const code = url.searchParams.get('code');
  if (!code) return fail('缺少会话码');
  const row = await env.DB.prepare('SELECT * FROM near_sessions WHERE code = ?').bind(code).first();
  if (!row) return fail('会话不存在或已过期', 404);
  await env.DB.prepare('UPDATE near_sessions SET updatedAt = ? WHERE code = ?').bind(Date.now(), code).run();
  return ok({ exists: true });
}

async function handleNearSignal(env, user, url, method, request) {
  await ensureNearTable(env);

  if (method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const code = url.searchParams.get('code') || body.code || null;
    if (!code) return fail('缺少会话码');
    const to = String(body.to || '');
    const data = body.data;
    if (!to || data === undefined || data === null) return fail('缺少信令内容');
    // 校验会话存在
    const sess = await env.DB.prepare('SELECT code FROM near_sessions WHERE code = ?').bind(code).first();
    if (!sess) return fail('会话不存在或已过期', 404);
    await env.DB.prepare('INSERT INTO near_signals (code, peer, data, ts) VALUES (?,?,?,?)')
      .bind(code, to, JSON.stringify(data), Date.now()).run();
    return ok({ queued: true });
  }

  // GET 拉取（拉取即消费）
  // wait=1 → 长轮询：内部每 300ms 查一次 DB，最长挂起 18s，信令一到立即返回
  // 把跨设备信令延迟从 ~1200ms（旧轮询间隔）压到 ~300ms
  if (method === 'GET') {
    const code = url.searchParams.get('code');
    if (!code) return fail('缺少会话码');
    const peer = url.searchParams.get('peer') || '';
    if (!peer) return fail('缺少peer');
    const wantWait = url.searchParams.get('wait') === '1';
    const pollIntervalMs = 300;     // 内部 DB 轮询步长
    const maxHoldMs = wantWait ? 18000 : 0; // 长轮询最长挂起 18s（Cloudflare 单请求 30s 内安全）
    const deadline = Date.now() + maxHoldMs;

    const drain = async () => {
      const rows = await env.DB.prepare('SELECT id, data FROM near_signals WHERE code = ? AND peer = ? ORDER BY id ASC LIMIT 200')
        .bind(code, peer).all();
      if (rows.results && rows.results.length) {
        // 只删除本次读取到的信号，避免 LIMIT 200 之外的信令被误删
        const ids = rows.results.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`DELETE FROM near_signals WHERE id IN (${placeholders})`).bind(...ids).run();
        return rows.results.map(r => JSON.parse(r.data));
      }
      return null;
    };

    // 首次立即拉一次（覆盖 wait=0 普通轮询 + wait=1 首检）
    let first = await drain();
    if (first) return ok({ signals: first });

    if (!wantWait) return ok({ signals: [] });

    // 长轮询：循环查 DB 直到命中或超时
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      const got = await drain();
      if (got) return ok({ signals: got });
    }
    return ok({ signals: [] });
  }

  return fail('不支持的请求方法', 405);
}

export async function onRequest(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const method = request.method;

    if (!env.DB) return fail('数据库未绑定', 500);
    await ensureEnhTables(env);

    // 公开路由：媒体访问（无需登录，通过不可猜测的key保护）
    if (parts[0] === 'media' && parts.length === 2 && method === 'GET') {
      return handleGetMedia(env, parts[1]);
    }

    // SSE 实时推送（token通过query参数传递，因为EventSource不支持自定义header）
    if (parts[0] === 'events' && method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) return fail('缺少群聊代码');
      const sseToken = url.searchParams.get('token');
      let sseUser = null;
      if (sseToken) {
        const row = await env.DB.prepare('SELECT * FROM tokens WHERE token = ?').bind(sseToken).first();
        if (row && row.expires >= Date.now()) {
          sseUser = await getUser(env, row.phone);
        }
      }
      if (!sseUser) return fail('未登录', 401);
      return handleSSE(env, sseUser, code, url.searchParams.get('since'));
    }

    // 公开路由
    if (parts[0] === 'register' && method === 'POST') {
      return handleRegister(env, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'login' && method === 'POST') {
      return handleLogin(env, await request.json().catch(() => ({})));
    }

    // 扫码登录：PC 端公开接口（创建/轮询，无需登录）
    if (parts[0] === 'qrlogin' && parts[1] === 'create' && method === 'POST') {
      return handleQrCreate(env);
    }
    if (parts[0] === 'qrlogin' && parts[1] === 'status' && method === 'GET') {
      return handleQrStatus(env, url.searchParams.get('qrId') || '');
    }

    // ===== 安全中心：公开接口（Passkey 登录/找回、设备码、签名公钥查询、找回密码） =====
    if (parts[0] === 'passkey' && parts[1] === 'options' && method === 'POST') {
      await ensureSecTables(env);
      return handleWaOptions(env, await request.json().catch(() => ({})), url);
    }
    if (parts[0] === 'passkey' && parts[1] === 'verify' && method === 'POST') {
      await ensureSecTables(env);
      return handleWaVerify(env, await request.json().catch(() => ({})), url);
    }
    if (parts[0] === 'devicecode' && parts[1] === 'create' && method === 'POST') {
      await ensureSecTables(env);
      return handleDcCreate(env);
    }
    if (parts[0] === 'devicecode' && parts[1] === 'status' && method === 'GET') {
      return handleDcStatus(env, url.searchParams.get('deviceCode') || '');
    }
    if (parts[0] === 'recover' && parts[1] === 'methods' && method === 'POST') {
      return handleRecoverMethods(env, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'recover' && parts[1] === 'admin' && method === 'POST') {
      return handleRecoverAdmin(env, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'recover' && parts[1] === 'confirm' && method === 'POST') {
      return handleRecoverConfirm(env, await request.json().catch(() => ({})));
    }
    // ---- 本机号码：短信验证码登录/注册（WebOTP 自动填充） ----
    if (parts[0] === 'sms' && parts[1] === 'send' && method === 'POST') {
      await ensureLoginExtras(env);
      return handleSmsSend(env, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'sms' && parts[1] === 'login' && method === 'POST') {
      await ensureLoginExtras(env);
      return handleSmsLogin(env, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'sms' && parts[1] === 'register' && method === 'POST') {
      await ensureLoginExtras(env);
      return handleSmsRegister(env, await request.json().catch(() => ({})));
    }
    // ---- SIM 卡运营商一键取号（阿里云/腾讯云号码认证） ----
    if (parts[0] === 'sim' && parts[1] === 'start' && method === 'POST') return handleSimStart(env);
    if (parts[0] === 'sim' && parts[1] === 'login' && method === 'POST') {
      await ensureLoginExtras(env);
      return handleSimLogin(env, await request.json().catch(() => ({})), request.headers.get('user-agent') || '');
    }
    if (parts[0] === 'sim' && parts[1] === 'register' && method === 'POST') {
      await ensureLoginExtras(env);
      return handleSmsRegister(env, await request.json().catch(() => ({})));
    }
    // ---- 微信 OAuth2 登录/注册/绑定（配置 WX_APPID/WX_SECRET 后生效） ----
    if (parts[0] === 'wechat' && parts[1] === 'start' && method === 'POST') {
      await ensureLoginExtras(env);
      return handleWxStart(env, await request.json().catch(() => ({})), url);
    }
    if (parts[0] === 'wechat' && parts[1] === 'status' && method === 'GET') {
      await ensureLoginExtras(env);
      return handleWxStatus(env, url.searchParams);
    }
    if (parts[0] === 'wechat' && parts[1] === 'mockscan' && method === 'POST') {
      if (env.IS_DEV !== '1') return fail('Not Found', 404);
      await ensureLoginExtras(env);
      return handleWxMockScan(env, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'wechat' && parts[1] === 'callback' && method === 'GET') {
      await ensureLoginExtras(env);
      return handleWxCallback(env, url.searchParams, url);
    }
    if (parts[0] === 'wechat' && parts[1] === 'exchange' && method === 'POST') {
      await ensureLoginExtras(env);
      return handleWxExchange(env, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'wechat' && parts[1] === 'bind' && method === 'POST') {
      await ensureLoginExtras(env);
      return handleWxBind(env, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'signkeys' && parts[1] && method === 'GET') {
      return handleSignGet(env, parts[1]);
    }

    // 认证
    const user = await authUser(env, request);
    if (!user) return fail('未登录', 401);
    // 获取当前用户信息
    if (parts[0] === 'me' && parts.length === 1 && method === 'GET') {
      ensureMediaTable(env).catch(() => {});
      return ok({ user: publicUser(user) });
    }
    // 聊天统计 Q10/Q11
    if (parts[0] === 'me' && parts[1] === 'chat-stats' && method === 'GET') {
      const days = parseInt(url.searchParams.get('days')) || 365;
      const since = Date.now() - days * 86400000;
      const res = await env.DB.prepare('SELECT ts, groupCode FROM messages WHERE senderPhone = ? AND ts > ?').bind(user.phone, since).all();
      const stats = {}; const hourStats = new Array(24).fill(0);
      for (const row of res.results) {
        const d = new Date(row.ts);
        const key = d.toISOString().slice(0, 10);
        stats[key] = (stats[key] || 0) + 1;
        hourStats[d.getHours()]++;
      }
      return ok({ stats, hourStats, totalMsgs: res.results.length });
    }
    // 双人生物房间 N6
    if (parts[0] === 'bioroom' && parts.length === 1 && method === 'POST') {
      const code = 'BIO' + Math.random().toString(36).slice(2, 8).toUpperCase();
      await env.DB.prepare('INSERT INTO biorooms (code, createdBy, members, status, ts) VALUES (?, ?, ?, ?, ?)').bind(code, user.phone, JSON.stringify([user.phone]), 'pending', Date.now()).run();
      return ok({ code });
    }
    if (parts[0] === 'bioroom' && parts[1] && !['join','close','messages'].includes(parts[1]) && method === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM biorooms WHERE code = ?').bind(parts[1]).first();
      if (!row) return fail('房间不存在', 404);
      row.members = JSON.parse(row.members || '[]');
      return ok({ room: row });
    }
    if (parts[0] === 'bioroom' && parts[1] === 'join' && method === 'POST') {
      const room = await env.DB.prepare('SELECT * FROM biorooms WHERE code = ?').bind(body.code).first();
      if (!room) return fail('房间不存在', 404);
      let members = JSON.parse(room.members || '[]');
      if (!members.includes(user.phone)) members.push(user.phone);
      const status = members.length >= 2 ? 'active' : room.status;
      await env.DB.prepare('UPDATE biorooms SET members = ?, status = ? WHERE code = ?').bind(JSON.stringify(members), status, body.code).run();
      return ok({ room: { ...room, members, status } });
    }
    if (parts[0] === 'bioroom' && parts[1] === 'close' && method === 'POST') {
      await env.DB.prepare('DELETE FROM biorooms WHERE code = ?').bind(body.code).run();
      await env.DB.prepare('DELETE FROM bioroom_msgs WHERE code = ?').bind(body.code).run();
      return ok({ closed: true });
    }
    if (parts[0] === 'bioroom' && parts[1] === 'messages' && method === 'POST') {
      const room = await env.DB.prepare('SELECT * FROM biorooms WHERE code = ?').bind(body.code).first();
      if (!room || room.status !== 'active') return fail('房间未激活', 400);
      await env.DB.prepare('INSERT INTO bioroom_msgs (code, senderPhone, text, ts) VALUES (?, ?, ?, ?)').bind(body.code, user.phone, body.text, Date.now()).run();
      return ok({});
    }
    if (parts[0] === 'bioroom' && parts[1] === 'messages' && method === 'GET') {
      const code = url.searchParams.get('code');
      const res = await env.DB.prepare('SELECT * FROM bioroom_msgs WHERE code = ? ORDER BY ts ASC').bind(code).all();
      return ok({ messages: res.results });
    }
    // 登录会话列表（伪登录警告 Q1）
    if (parts[0] === 'me' && parts[1] === 'sessions' && method === 'GET') {
      const res = await env.DB.prepare('SELECT id as token, userAgent as ua, createdAt as ts FROM sessions WHERE phone = ? ORDER BY createdAt DESC LIMIT 10').bind(user.phone).all();
      return ok({ sessions: res.results });
    }
    if (parts[0] === 'me' && parts[1] === 'sessions' && parts[2] && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM tokens WHERE token = ?').bind(parts[2]).run();
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(parts[2]).run();
      return ok({});
    }

    // 扫码登录：手机端已登录接口（扫码/确认/取消）
    if (parts[0] === 'qrlogin' && parts[1] === 'scan' && method === 'POST') {
      return handleQrScan(env, user, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'qrlogin' && parts[1] === 'confirm' && method === 'POST') {
      return handleQrConfirm(env, user, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'qrlogin' && parts[1] === 'cancel' && method === 'POST') {
      return handleQrCancel(env, user, await request.json().catch(() => ({})));
    }

    // ===== 安全中心：需登录（Passkey 管理、设备授权、签名公钥托管、安全日志） =====
    if (parts[0] === 'passkey' && parts[1] === 'register' && parts[2] === 'options' && method === 'POST') {
      await ensureSecTables(env);
      return handleWaRegOptions(env, user, await request.json().catch(() => ({})), url);
    }
    if (parts[0] === 'passkey' && parts[1] === 'register' && method === 'POST') {
      await ensureSecTables(env);
      return handleWaRegister(env, user, await request.json().catch(() => ({})), url);
    }
    if (parts[0] === 'passkeys' && parts.length === 1 && method === 'GET') {
      return handlePasskeyList(env, user);
    }
    if (parts[0] === 'passkey' && parts[1] === 'delete' && method === 'POST') {
      return handlePasskeyDelete(env, user, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'devicecode' && parts[1] === 'authorize' && method === 'POST') {
      return handleDcAuthorize(env, user, await request.json().catch(() => ({})), url);
    }
    if (parts[0] === 'signkeys' && parts.length === 1 && method === 'POST') {
      await ensureSecTables(env);
      return handleSignUpload(env, user, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'security' && parts[1] === 'log' && method === 'GET') {
      return handleSecLog(env, user);
    }

    // 近场 P2P 信令（WebRTC 全浏览器兜底）
    if (parts[0] === 'near' && parts[1] === 'session') {
      return handleNearSession(env, user, url, method);
    }
    if (parts[0] === 'near' && parts[1] === 'signal') {
      return handleNearSignal(env, user, url, method, request);
    }

    // 心跳
    if (parts[0] === 'beat' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return handleBeat(env, user, body.code || null);
    }

    // 媒体上传
    if (parts[0] === 'upload' && method === 'POST') {
      await ensureMediaTable(env);
      return handleUpload(env, user, await request.json().catch(() => ({})));
    }

    // 用户列表（仅管理员）
    if (parts[0] === 'users' && method === 'GET') {
      if (user.phone !== ADMIN_PHONE) return fail('无权限', 403);
      return handleUsers(env);
    }

    // 我的群聊
    if (parts[0] === 'my-groups' && method === 'GET') {
      return handleMyGroups(env, user);
    }

    // 更新个人资料
    if (parts[0] === 'profile' && method === 'PATCH') {
      return handleUpdateProfile(env, user, await request.json().catch(() => ({})));
    }

    // 注销账号
    if (parts[0] === 'delete-account' && method === 'POST') {
      return handleDeleteAccount(env, user);
    }
    // 用户资料卡
    if (parts[0] === 'users' && parts.length === 2 && method === 'GET') {
      return handleGetUserProfile(env, user, parts[1]);
    }
    // 会话管理
    if (parts[0] === 'sessions' && method === 'GET') {
      return handleGetSessions(env, user);
    }
    if (parts[0] === 'sessions' && parts.length === 2 && method === 'DELETE') {
      return handleDeleteSession(env, user, parts[1]);
    }
    // 收藏消息
    if (parts[0] === 'saved' && method === 'GET') {
      return handleGetSaved(env, user);
    }
    if (parts[0] === 'saved' && parts.length === 2 && method === 'POST') {
      return handleSaveMessage(env, user, parts[1], await request.json().catch(() => ({})));
    }
    if (parts[0] === 'saved' && parts.length === 2 && method === 'DELETE') {
      return handleSaveMessage(env, user, parts[1], { groupCode: '' });
    }

    // 博采
    // 管理员回复反馈（必须在 feedback POST 之前）
    if (parts[0] === 'feedback' && parts[2] === 'reply' && method === 'POST') {
      return handleReplyFeedback(env, user, parts[1], await request.json().catch(() => ({})));
    }
    if (parts[0] === 'feedback' && parts.length === 1 && method === 'POST') {
      return handleSubmitFeedback(env, user, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'feedback' && method === 'GET') {
      return handleGetFeedback(env, user);
    }

    // 管理员：删除用户
    if (parts[0] === 'admin' && parts[1] === 'users' && method === 'DELETE') {
      return handleAdminDeleteUser(env, user, parts[2]);
    }
    // 管理员：查看用户的群聊和消息
    if (parts[0] === 'admin' && parts[1] === 'users' && parts[3] === 'groups' && method === 'GET') {
      return handleAdminUserGroups(env, user, parts[2]);
    }

    // 拉黑（防骚扰）
    if (parts[0] === 'block' && method === 'POST') {
      return handleBlockUser(env, user, await request.json().catch(() => ({})));
    }

    // 群聊相关
    if (parts[0] === 'groups') {
      // 创建群聊
      if (parts.length === 1 && method === 'POST') {
        return handleCreateGroup(env, user, await request.json().catch(() => ({})));
      }
      // 获取群聊详情
      if (parts.length === 2 && method === 'GET') {
        return handleGetGroup(env, user, parts[1], url.searchParams.get('since'));
      }
      // 加入群聊
      if (parts[2] === 'join' && method === 'POST') {
        return handleJoinGroup(env, user, parts[1]);
      }
      // 退出群聊
      if (parts[2] === 'leave' && method === 'POST') {
        return handleLeaveGroup(env, user, parts[1]);
      }
      // 注销群聊
      if (parts[2] === 'delete' && method === 'DELETE') {
        return handleDeleteGroup(env, user, parts[1]);
      }
      // 读取消息列表
      if (parts[2] === 'messages' && method === 'GET') {
        return handleGetMessages(env, user, parts[1], url.searchParams.get('since'));
      }
      // 发送消息
      if (parts[2] === 'messages' && method === 'POST') {
        return handleSendMessage(env, user, parts[1], await request.json().catch(() => ({})));
      }
      // 清空消息
      if (parts[2] === 'messages' && method === 'DELETE') {
        return handleClearMessages(env, user, parts[1]);
      }
      // 撤回消息
      if (parts[2] === 'messages' && parts[4] === 'recall' && method === 'POST') {
        return handleRecallMessage(env, user, parts[1], parts[3]);
      }
      // 编辑消息
      if (parts[2] === 'messages' && parts[4] === 'edit' && method === 'POST') {
        return handleEditMessage(env, user, parts[1], parts[3], await request.json().catch(() => ({})));
      }
      // 表情回复
      if (parts[2] === 'messages' && parts[4] === 'react' && method === 'POST') {
        return handleReactMessage(env, user, parts[1], parts[3], await request.json().catch(() => ({})));
      }
      // 转发消息
      if (parts[2] === 'messages' && parts[4] === 'forward' && method === 'POST') {
        return handleForwardMessage(env, user, parts[1], parts[3], await request.json().catch(() => ({})));
      }
      // 悄悄话查看即焚
      if (parts[2] === 'messages' && parts[4] === 'whisper-view' && method === 'POST') {
        return handleWhisperView(env, user, parts[1], parts[3]);
      }
      // 搜索消息
      if (parts[2] === 'search' && method === 'GET') {
        return handleSearchMessages(env, user, parts[1], url.searchParams.get('q'));
      }
      // 输入中
      if (parts[2] === 'typing' && method === 'POST') {
        return handleTyping(env, user, parts[1]);
      }
      if (parts[2] === 'typing' && method === 'GET') {
        return handleGetTyping(env, user, parts[1]);
      }
      // 群公告
      if (parts[2] === 'announcement' && method === 'POST') {
        return handleSetAnnouncement(env, user, parts[1], await request.json().catch(() => ({})));
      }
      if (parts[2] === 'announcement' && method === 'GET') {
        return handleGetAnnouncement(env, user, parts[1]);
      }
      // 群设置
      if (parts[2] === 'settings' && method === 'POST') {
        return handleGroupSettings(env, user, parts[1], await request.json().catch(() => ({})));
      }
      // 群元数据（审核 / 邀请限制等）
      if (parts[2] === 'meta' && method === 'GET') { return handleGroupMeta(env, user, parts[1]); }
      if (parts[2] === 'meta' && method === 'POST') { return handleSetGroupMeta(env, user, parts[1], await request.json().catch(() => ({}))); }
      // 群名片
      if (parts[2] === 'card' && method === 'POST') { return handleGroupCard(env, user, parts[1], await request.json().catch(() => ({}))); }
      // 禁言
      if (parts[2] === 'ban' && method === 'POST') { return handleBanMember(env, user, parts[1], await request.json().catch(() => ({}))); }
      // 角色
      if (parts[2] === 'role' && method === 'POST') { return handleSetRole(env, user, parts[1], await request.json().catch(() => ({}))); }
      // 入群审核申请
      if (parts[2] === 'requests' && method === 'GET') { return handleGetRequests(env, user, parts[1]); }
      if (parts[2] === 'requests' && method === 'POST') { return handleReviewRequest(env, user, parts[1], await request.json().catch(() => ({}))); }
      // 导出聊天
      if (parts[2] === 'export' && method === 'GET') {
        return handleExportChat(env, user, parts[1]);
      }
      // 群二维码
      if (parts[2] === 'qr' && method === 'GET') {
        return handleGroupQR(env, user, parts[1]);
      }
      // 群成员
      if (parts[2] === 'members' && method === 'GET') {
        return handleGetMembers(env, user, parts[1]);
      }
      // 踢人
      if (parts[2] === 'members' && parts.length === 4 && method === 'DELETE') {
        return handleKickMember(env, user, parts[1], parts[3]);
      }
      // 编辑群信息
      if (parts.length === 2 && method === 'PATCH') {
        return handleEditGroup(env, user, parts[1], await request.json().catch(() => ({})));
      }
      // 置顶消息
      if (parts[2] === 'messages' && parts[4] === 'pin' && method === 'POST') {
        return handlePinMessage(env, user, parts[1], parts[3]);
      }
      if (parts[2] === 'pinned' && method === 'GET') {
        return handleGetPinned(env, user, parts[1]);
      }
      // 草稿
      if (parts[2] === 'draft' && method === 'GET') {
        return handleGetDraft(env, user, parts[1]);
      }
      if (parts[2] === 'draft' && method === 'PUT') {
        return handleSaveDraft(env, user, parts[1], await request.json().catch(() => ({})));
      }
      // 位置共享
      if (parts[2] === 'location' && method === 'POST') {
        return handleUpdateLocation(env, user, parts[1], await request.json().catch(() => ({})));
      }
      if (parts[2] === 'locations' && method === 'GET') {
        return handleGetLocations(env, user, parts[1]);
      }
      if (parts[2] === 'location' && method === 'DELETE') {
        return handleStopLocation(env, user, parts[1]);
      }
      // 通话
      if (parts[2] === 'call' && method === 'GET') {
        return handleGetCall(env, user, parts[1]);
      }
      if (parts[2] === 'call' && method === 'POST') {
        return handleStartCall(env, user, parts[1], await request.json().catch(() => ({})));
      }
      if (parts[2] === 'call' && method === 'DELETE') {
        return handleEndCall(env, user, parts[1]);
      }
      // 位置打卡
      if (parts[2] === 'checkin' && method === 'POST') {
        return handleCheckin(env, user, parts[1], await request.json().catch(() => ({})));
      }
      if (parts[2] === 'checkins' && method === 'GET') {
        return handleGetCheckins(env, user, parts[1]);
      }
      // 群相册回忆
      if (parts[2] === 'memories' && method === 'GET') {
        return handleMemories(env, user, parts[1]);
      }
    }

    return fail('未知的API路径: ' + url.pathname, 404);
  } catch (e) {
    return fail('服务器错误: ' + e.message, 500);
  }
}

/* ============================================================
   安全中心：Passkey(WebAuthn) / 设备码授权 / 签名验签 / 找回密码
   —— D1 存储；挑战与票据一次性；频控 + 安全审计日志
   ============================================================ */
let secTablesReady = false;
async function ensureSecTables(env) {
  if (secTablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS passkeys (credential_id TEXT PRIMARY KEY, phone TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER DEFAULT 0, device TEXT DEFAULT '', created_at INTEGER, last_used INTEGER)`,
    `CREATE TABLE IF NOT EXISTS sec_challenges (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, mode TEXT NOT NULL, phone TEXT DEFAULT '', expires INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS device_codes (device_code TEXT PRIMARY KEY, user_code TEXT UNIQUE, phone TEXT, status TEXT NOT NULL, expires INTEGER NOT NULL, created_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS sign_keys (phone TEXT PRIMARY KEY, public_key TEXT NOT NULL, created_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS security_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, phone TEXT, event TEXT, detail TEXT)`,
    `CREATE TABLE IF NOT EXISTS sec_rate (k TEXT PRIMARY KEY, c INTEGER DEFAULT 0, ws INTEGER DEFAULT 0)`
  ];
  for (const s of stmts) await env.DB.prepare(s).run();
  secTablesReady = true;
}

// ---------- 频控（D1 滑动窗口） ----------
async function rateHit(env, key, limit, windowMs) {
  const now = Date.now();
  try {
    const row = await env.DB.prepare('SELECT c, ws FROM sec_rate WHERE k = ?').bind(key).first();
    if (!row) {
      await env.DB.prepare('INSERT INTO sec_rate (k, c, ws) VALUES (?, 1, ?)').bind(key, now).run();
      return true;
    }
    if (row.ws < now - windowMs) {
      await env.DB.prepare('UPDATE sec_rate SET c = 1, ws = ? WHERE k = ?').bind(now, key).run();
      return true;
    }
    const c = row.c + 1;
    await env.DB.prepare('UPDATE sec_rate SET c = ? WHERE k = ?').bind(c, key).run();
    return c <= limit;
  } catch { return true; } // 频控表故障不阻塞正常流程
}
async function rateClear(env, key) {
  try { await env.DB.prepare('DELETE FROM sec_rate WHERE k = ?').bind(key).run(); } catch {}
}
function tooMany(min) { return fail(min ? `操作过于频繁，请${min}分钟后再试` : '操作过于频繁，请稍后再试', 429); }

// ---------- 安全审计日志 ----------
function secLog(env, phone, event, detail) {
  if (!phone || !env) return;
  env.DB.prepare('INSERT INTO security_log (ts, phone, event, detail) VALUES (?,?,?,?)')
    .bind(Date.now(), phone, event, detail || '').run().catch(() => {});
}
async function handleSecLog(env, user) {
  const res = await env.DB.prepare('SELECT ts, event, detail FROM security_log WHERE phone = ? ORDER BY id DESC LIMIT 50').bind(user.phone).all();
  return ok({ logs: res.results || [] });
}

// ---------- WebAuthn 基础（纯 WebCrypto + 手写 CBOR） ----------
const SEC_TE = new TextEncoder();
async function secSha256(buf) { return new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); }

function cborDecode(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); let i = 0;
  const take = n => { const b = buf.subarray(i, i + n); i += n; return b; };
  function val() {
    const b = buf[i++]; const t = b >> 5, n = b & 31; let x;
    if (n < 24) x = n; else if (n === 24) x = buf[i++]; else if (n === 25) { x = dv.getUint16(i); i += 2; }
    else if (n === 26) { x = dv.getUint32(i); i += 4; } else if (n === 27) { x = Number(dv.getBigUint64(i)); i += 8; } else x = null;
    if (t === 0) return x;
    if (t === 1) return x === null ? null : (-1 - x);
    if (t === 2) return new Uint8Array(take(x));
    if (t === 3) return new TextDecoder().decode(take(x));
    if (t === 4) { const a = []; for (let k = 0; k < x; k++) a.push(val()); return a; }
    if (t === 5) { const m = {}; for (let k = 0; k < x; k++) { const key = val(); m[String(key)] = val(); } return m; }
    if (t === 6) { val(); return null; }
    return x;
  }
  return val();
}
function parseAuthData(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flags = b[32], counter = dv.getUint32(33);
  let off = 37, credId = null, cose = null;
  if (flags & 0x40) {
    off += 16; // aaguid
    const cl = dv.getUint16(off); off += 2;
    credId = b.subarray(off, off + cl); off += cl;
    cose = cborDecode(b.subarray(off));
  }
  return { rpIdHash: b64uEnc(b.subarray(0, 32)), flags, counter, credId, cose };
}
function coseToJwk(c) {
  if (c[1] === 2 && c[3] === -7) return { kty: 'EC', crv: 'P-256', x: b64uEnc(c[-2]), y: b64uEnc(c[-3]) };
  if (c[1] === 3 && c[3] === -257) return { kty: 'RSA', n: b64uEnc(c[-1]), e: b64uEnc(c[-2]) };
  if (c[1] === 1 && c[3] === -8) return { kty: 'OKP', crv: 'Ed25519', x: b64uEnc(c[-2]) };
  return null;
}
async function webVerify(jwk, sigU8, dataU8) {
  try {
    const data = dataU8.buffer.slice(dataU8.byteOffset, dataU8.byteOffset + dataU8.byteLength);
    if (jwk.kty === 'EC') {
      const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigU8, data);
    }
    if (jwk.kty === 'RSA') {
      const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigU8, data);
    }
    if (jwk.kty === 'OKP') {
      const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify('Ed25519', key, sigU8, data);
    }
  } catch { return false; }
  return false;
}

async function secChallenge(env, mode, phone) {
  const id = makeId() + makeToken().slice(0, 12);
  const ch = makeToken();
  await env.DB.prepare('INSERT INTO sec_challenges (id, challenge, mode, phone, expires) VALUES (?,?,?,?,?)')
    .bind(id, ch, mode, phone || '', Date.now() + 180000).run();
  return { id, ch };
}
async function takeChallenge(env, id, mode) {
  if (!id) return null;
  const row = await env.DB.prepare('SELECT * FROM sec_challenges WHERE id = ?').bind(id).first();
  if (!row) return null;
  await env.DB.prepare('DELETE FROM sec_challenges WHERE id = ?').bind(id).run(); // 一次性
  if (row.expires < Date.now() || row.mode !== mode) return null;
  return row;
}
function checkOrigin(cdj, url) {
  try { return new URL(cdj.origin).hostname === url.hostname; } catch { return false; }
}

// ---------- Passkey：注册 ----------
async function handleWaRegOptions(env, user, body, url) {
  const { id, ch } = await secChallenge(env, 'register', user.phone);
  const existing = await env.DB.prepare('SELECT credential_id FROM passkeys WHERE phone = ?').bind(user.phone).all();
  const isPlatform = body.attachment === 'platform';
  return ok({
    challengeId: id,
    publicKey: {
      challenge: ch, rp: { id: url.hostname, name: 'Stating' },
      user: { id: b64uEnc(SEC_TE.encode(user.phone)), name: user.phone, displayName: user.nickname || user.phone },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }, { type: 'public-key', alg: -8 }],
      timeout: 60000, attestation: 'none',
      authenticatorSelection: isPlatform
        ? { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' }
        : { residentKey: 'preferred', userVerification: 'preferred' },
      excludeCredentials: (existing.results || []).map(r => ({ type: 'public-key', id: r.credential_id }))
    }
  });
}
async function handleWaRegister(env, user, body, url) {
  if (!body.challengeId || !body.id || !body.response) return fail('参数不完整');
  const c = await takeChallenge(env, body.challengeId, 'register');
  if (!c || c.phone !== user.phone) return fail('挑战已过期，请重试');
  let cdj;
  try { cdj = JSON.parse(new TextDecoder().decode(b64uDec(body.response.clientDataJSON))); } catch { return fail('响应解析失败'); }
  if (cdj.type !== 'webauthn.create' || cdj.challenge !== c.challenge) return fail('挑战校验失败');
  if (!checkOrigin(cdj, url)) return fail('来源域不匹配');
  let ad;
  try { ad = parseAuthData(cborDecode(b64uDec(body.response.attestationObject)).authData); } catch { return fail('凭据解析失败'); }
  if (!(ad.flags & 0x01) || !ad.cose) return fail('凭据数据无效');
  const jwk = coseToJwk(ad.cose);
  if (!jwk) return fail('暂不支持该密钥算法');
  const device = body.attachment === 'cross-platform' ? '安全钥匙' : '本机生物识别';
  await env.DB.prepare('INSERT OR REPLACE INTO passkeys (credential_id, phone, public_key, counter, device, created_at, last_used) VALUES (?,?,?,?,?,?,0)')
    .bind(body.id, user.phone, JSON.stringify(jwk), ad.counter, device, Date.now()).run();
  secLog(env, user.phone, 'passkey_add', '新增 Passkey（' + device + '）');
  return ok({ device });
}

// ---------- Passkey：登录 / 找回验证 ----------
async function handleWaOptions(env, body, url) {
  const mode = body.mode === 'recover' ? 'recover' : 'login';
  const phone = String(body.phone || '').trim();
  if (mode === 'recover' && !/^\d{6,15}$/.test(phone)) return fail('请输入手机号');
  const existing = phone
    ? (await env.DB.prepare('SELECT credential_id FROM passkeys WHERE phone = ?').bind(phone).all()).results || []
    : [];
  if (mode === 'recover' && !existing.length) return fail('该账号未绑定 Passkey');
  const { id, ch } = await secChallenge(env, mode, phone);
  return ok({
    challengeId: id,
    publicKey: {
      challenge: ch, rpId: url.hostname, timeout: 60000, userVerification: 'preferred',
      allowCredentials: existing.map(r => ({ type: 'public-key', id: r.credential_id }))
    }
  });
}
async function handleWaVerify(env, body, url) {
  const mode = body.mode === 'recover' ? 'recover' : 'login';
  if (!body.challengeId || !body.id || !body.response) return fail('参数不完整');
  const c = await takeChallenge(env, body.challengeId, mode);
  if (!c) return fail('挑战已过期，请重试');
  let cdj;
  try { cdj = JSON.parse(new TextDecoder().decode(b64uDec(body.response.clientDataJSON))); } catch { return fail('响应解析失败'); }
  if (cdj.type !== 'webauthn.get' || cdj.challenge !== c.challenge) return fail('挑战校验失败');
  if (!checkOrigin(cdj, url)) return fail('来源域不匹配');
  const rec = await env.DB.prepare('SELECT * FROM passkeys WHERE credential_id = ?').bind(body.id).first();
  if (!rec) return fail('未知凭据');
  let userHandle = '';
  try { userHandle = new TextDecoder().decode(b64uDec(body.response.userHandle || '')); } catch {}
  if (mode === 'recover' && (c.phone !== rec.phone || (userHandle && userHandle !== rec.phone))) return fail('账号不匹配');
  const ad = b64uDec(body.response.authenticatorData);
  if (ad.length < 37) return fail('凭据数据无效');
  const parsed = parseAuthData(ad);
  if (parsed.rpIdHash !== b64uEnc(await secSha256(SEC_TE.encode(url.hostname)))) return fail('站点不匹配');
  if (!(parsed.flags & 0x01)) return fail('请先完成生物识别验证');
  if (parsed.counter < rec.counter && parsed.counter !== 0 && rec.counter !== 0) return fail('检测到凭据克隆，已拒绝');
  const clientHash = await secSha256(b64uDec(body.response.clientDataJSON));
  const signed = new Uint8Array(ad.length + clientHash.length);
  signed.set(ad); signed.set(clientHash, ad.length);
  const sigOk = await webVerify(parseObj(rec.public_key) || {}, b64uDec(body.response.signature), signed);
  if (!sigOk) { secLog(env, rec.phone, 'passkey_fail', '签名校验失败'); return fail('签名校验失败'); }
  await env.DB.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE credential_id = ?')
    .bind(Math.max(rec.counter, parsed.counter), Date.now(), body.id).run();
  if (mode === 'recover') {
    const resetToken = makeToken() + makeId();
    await env.DB.prepare('INSERT INTO sec_challenges (id, challenge, mode, phone, expires) VALUES (?,?,?,?,?)')
      .bind('reset:' + resetToken, '1', 'reset', rec.phone, Date.now() + 600000).run();
    secLog(env, rec.phone, 'recover_passkey', 'Passkey 身份验证通过');
    return ok({ resetToken });
  }
  const token = await createToken(env, rec.phone);
  secLog(env, rec.phone, 'passkey_login', 'Passkey 登录成功（' + rec.device + '）');
  return ok({ token, user: publicUser(await getUser(env, rec.phone)) });
}

async function handlePasskeyList(env, user) {
  const res = await env.DB.prepare('SELECT credential_id, device, created_at, last_used FROM passkeys WHERE phone = ?').bind(user.phone).all();
  return ok({ passkeys: (res.results || []).map(r => ({ id: r.credential_id, device: r.device, createdAt: r.created_at, lastUsed: r.last_used })) });
}
async function handlePasskeyDelete(env, user, body) {
  const rec = await env.DB.prepare('SELECT phone, device FROM passkeys WHERE credential_id = ?').bind(String(body.id || '')).first();
  if (!rec || rec.phone !== user.phone) return fail('凭据不存在');
  await env.DB.prepare('DELETE FROM passkeys WHERE credential_id = ?').bind(String(body.id)).run();
  secLog(env, user.phone, 'passkey_remove', '删除 Passkey（' + rec.device + '）');
  return ok();
}

// ---------- 设备码授权（RFC 8628 风格） ----------
function dcUserCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = new Uint8Array(8); crypto.getRandomValues(b);
  let s = ''; for (let i = 0; i < 8; i++) s += A[b[i] % A.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
async function handleDcCreate(env) {
  const deviceCode = makeToken() + makeId();
  let userCode;
  for (let t = 0; t < 5; t++) {
    userCode = dcUserCode();
    const ex = await env.DB.prepare('SELECT device_code FROM device_codes WHERE user_code = ?').bind(userCode).first();
    if (!ex) break;
  }
  await env.DB.prepare('INSERT INTO device_codes (device_code, user_code, phone, status, expires, created_at) VALUES (?,?,?,?,?,?)')
    .bind(deviceCode, userCode, null, 'pending', Date.now() + 300000, Date.now()).run();
  return ok({ deviceCode, userCode, expiresIn: 300, interval: 3 });
}
async function handleDcStatus(env, deviceCode) {
  const s = await env.DB.prepare('SELECT * FROM device_codes WHERE device_code = ?').bind(deviceCode).first();
  if (!s) return ok({ status: 'expired' });
  if (s.expires < Date.now()) {
    await env.DB.prepare('DELETE FROM device_codes WHERE device_code = ?').bind(deviceCode).run();
    return ok({ status: 'expired' });
  }
  if (s.status !== 'authorized') return ok({ status: 'pending', interval: 3 });
  await env.DB.prepare('DELETE FROM device_codes WHERE device_code = ?').bind(deviceCode).run();
  const token = await createToken(env, s.phone);
  secLog(env, s.phone, 'device_login', '设备码授权登录（' + s.user_code + '）');
  return ok({ status: 'authorized', token, user: publicUser(await getUser(env, s.phone)) });
}
// 设备码授权断言校验（mode=dcauth，必须本机生物验证 UV=1）
async function verifyDcBio(env, user, bio, url) {
  if (!bio || !bio.challengeId || !bio.id || !bio.response) return fail('生物验证参数不完整');
  const c = await takeChallenge(env, bio.challengeId, 'dcauth');
  if (!c || c.phone !== user.phone) return fail('验证已过期，请重试');
  let cdj;
  try { cdj = JSON.parse(new TextDecoder().decode(b64uDec(bio.response.clientDataJSON))); } catch { return fail('响应解析失败'); }
  if (cdj.type !== 'webauthn.get' || cdj.challenge !== c.challenge) return fail('挑战校验失败');
  if (!checkOrigin(cdj, url)) return fail('来源域不匹配');
  const rec = await env.DB.prepare('SELECT * FROM passkeys WHERE credential_id = ? AND phone = ?').bind(bio.id, user.phone).first();
  if (!rec) return fail('该生物凭据不属于当前账号');
  const ad = b64uDec(bio.response.authenticatorData);
  if (ad.length < 37) return fail('凭据数据无效');
  const parsed = parseAuthData(ad);
  if (parsed.rpIdHash !== b64uEnc(await secSha256(SEC_TE.encode(url.hostname)))) return fail('站点不匹配');
  if (!(parsed.flags & 0x01)) return fail('请先完成生物识别验证');
  if (!(parsed.flags & 0x04)) return fail('需要本机面容/指纹/设备密码验证（UV）');
  if (parsed.counter < rec.counter && parsed.counter !== 0 && rec.counter !== 0) return fail('检测到凭据克隆，已拒绝');
  const clientHash = await secSha256(b64uDec(bio.response.clientDataJSON));
  const signed = new Uint8Array(ad.length + clientHash.length);
  signed.set(ad); signed.set(clientHash, ad.length);
  const sigOk = await webVerify(parseObj(rec.public_key) || {}, b64uDec(bio.response.signature), signed);
  if (!sigOk) { secLog(env, user.phone, 'passkey_fail', '设备码授权生物验证签名失败'); return fail('生物验证失败'); }
  await env.DB.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE credential_id = ?')
    .bind(Math.max(rec.counter, parsed.counter), Date.now(), bio.id).run();
  return null; // null = 通过
}
async function handleDcAuthorize(env, user, body, url) {
  const uc = String(body.userCode || '').toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(uc)) return fail('设备码格式不正确');
  // 已绑定 Passkey 的账号：授权新设备必须通过本机生物识别（原生设备联动）
  const pkRow = await env.DB.prepare('SELECT credential_id FROM passkeys WHERE phone = ? LIMIT 1').bind(user.phone).first();
  const hasBio = !!pkRow;
  if (hasBio) {
    if (!body.bio) {
      await ensureSecTables(env);
      const { id, ch } = await secChallenge(env, 'dcauth', user.phone);
      const rows = (await env.DB.prepare('SELECT credential_id FROM passkeys WHERE phone = ?').bind(user.phone).all()).results || [];
      return json({ ok: false, needBio: true, challengeId: id,
        publicKey: { challenge: ch, rpId: url.hostname, timeout: 60000, userVerification: 'required',
          allowCredentials: rows.map(r => ({ type: 'public-key', id: r.credential_id })) } });
    }
    const bad = await verifyDcBio(env, user, body.bio, url);
    if (bad) return bad;
  }
  if (!(await rateHit(env, 'dcauth:' + user.phone, 8, 10 * 60 * 1000))) return tooMany(10);
  const s = await env.DB.prepare('SELECT * FROM device_codes WHERE user_code = ?').bind(uc).first();
  if (!s || s.expires < Date.now()) return fail('设备码不存在或已过期');
  if (s.status !== 'pending') return fail('该设备码已被使用');
  await env.DB.prepare('UPDATE device_codes SET status = ?, phone = ? WHERE device_code = ?').bind('authorized', user.phone, s.device_code).run();
  secLog(env, user.phone, 'device_auth', (hasBio ? '生物识别通过，' : '') + '授权设备码 ' + uc + ' 登录');
  return ok({ bioVerified: hasBio });
}

// ============ 本机号码：短信验证码登录/注册 + 微信 OAuth2 ============
async function ensureLoginExtras(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sms_codes (
    k TEXT PRIMARY KEY, phone TEXT NOT NULL, scene TEXT NOT NULL,
    code TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER DEFAULT 0
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sms_tickets (
    id TEXT PRIMARY KEY, phone TEXT NOT NULL, expires INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wx_states (
    state TEXT PRIMARY KEY, status TEXT NOT NULL, ticket TEXT DEFAULT '', expires INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wx_tickets (
    ticket TEXT PRIMARY KEY, openid TEXT NOT NULL, unionid TEXT DEFAULT '',
    nickname TEXT DEFAULT '', avatar TEXT DEFAULT '', expires INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_events (
    token TEXT PRIMARY KEY, phone TEXT NOT NULL, ua TEXT DEFAULT '', ts INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS biorooms (
    code TEXT PRIMARY KEY, createdBy TEXT NOT NULL, members TEXT NOT NULL DEFAULT '[]',
    status TEXT DEFAULT 'pending', ts INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS bioroom_msgs (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, senderPhone TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL
  )`).run();
  // users 表迁移微信标识列（老库平滑升级）
  try { await env.DB.prepare("ALTER TABLE users ADD COLUMN wx_openid TEXT DEFAULT ''").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE users ADD COLUMN wx_unionid TEXT DEFAULT ''").run(); } catch {}
}
const SMS_TTL = 5 * 60 * 1000, SMS_RESEND = 60 * 1000, SMS_DAY_MAX = 10;
const smsPhoneOk = phone => /^\d{6,15}$/.test(String(phone || '').trim());
// 短信下发：生产对接腾讯云 SMS（env.SMS_SDKAPPID / SMS_SIGN / SMS_TEMPLATE_ID）；
// 未配置且 IS_DEV=1 时返回固定开发码 246810，其余环境拒绝，避免假装发送。
async function sendSmsCode(env, phone, code) {
  if (env.SMS_SDKAPPID && env.SMS_SECRETID && env.SMS_SIGN) {
    // 接入点：腾讯云 SendSms（签名 v3）。服务密钥只在 Workers 环境变量中，不落前端。
    // 因需要额外 SDK/签名封装，上线时在此实现；返回 503 可让前端给出明确提示。
    return { sent: false, error: '短信网关尚未完成对接，请配置 SMS_TEMPLATE_ID 并启用腾讯云 SMS 动作' };
  }
  if (env.IS_DEV === '1') return { sent: true, devCode: '246810' };
  return { sent: false, error: '短信服务暂未开通' };
}
async function handleSmsSend(env, body) {
  const phone = String(body.phone || '').trim();
  const scene = body.scene === 'bind' ? 'bind' : 'login';
  if (!smsPhoneOk(phone)) return fail('手机号格式不正确');
  if (!(await rateHit(env, 'sms60:' + phone + ':' + scene, 1, SMS_RESEND))) return fail('验证码发送过于频繁，请60秒后再试', 429);
  const day = new Date().toISOString().slice(0, 10);
  if (!(await rateHit(env, 'smsday:' + day + ':' + phone, SMS_DAY_MAX, 24 * 3600 * 1000))) return fail('今日验证码次数已达上限', 429);
  const code = env.IS_DEV === '1' ? '246810' : String(Math.floor(100000 + Math.random() * 900000));
  const r = await sendSmsCode(env, phone, code);
  if (!r.sent) return fail(r.error || '验证码发送失败', 503);
  await env.DB.prepare('INSERT OR REPLACE INTO sms_codes (k, phone, scene, code, expires, attempts) VALUES (?,?,?,?,?,0)')
    .bind(scene + ':' + phone, phone, scene, code, Date.now() + SMS_TTL).run();
  secLog(env, phone, 'sms_send', '下发短信验证码（' + scene + '）' + (r.devCode ? ' devCode=' + r.devCode : ''));
  return ok({ expiresIn: SMS_TTL / 1000, ...(r.devCode ? { devCode: r.devCode } : {}) });
}
async function smsConsume(env, phone, scene, code) {
  const k = scene + ':' + phone;
  const rec = await env.DB.prepare('SELECT * FROM sms_codes WHERE k = ?').bind(k).first();
  if (!rec) return '请先获取验证码';
  if (rec.expires < Date.now()) { await env.DB.prepare('DELETE FROM sms_codes WHERE k = ?').bind(k).run(); return '验证码已过期，请重新获取'; }
  if ((rec.attempts || 0) + 1 > 5) { await env.DB.prepare('DELETE FROM sms_codes WHERE k = ?').bind(k).run(); return '错误次数过多，请重新获取验证码'; }
  if (String(code) !== rec.code) {
    await env.DB.prepare('UPDATE sms_codes SET attempts = attempts + 1 WHERE k = ?').bind(k).run();
    return '验证码不正确';
  }
  await env.DB.prepare('DELETE FROM sms_codes WHERE k = ?').bind(k).run();
  return null;
}
async function makeSmsTicket(env, phone) {
  const id = makeToken() + makeId();
  await env.DB.prepare('INSERT INTO sms_tickets (id, phone, expires) VALUES (?,?,?)')
    .bind(id, phone, Date.now() + 10 * 60 * 1000).run();
  return id;
}
function smsOnlyUserRow(phone, nickname, avatar) {
  return { phone, nickname, avatar: avatar || '😀', email: '无', passHash: 'sms-only', passSalt: 'sms-only',
    joinedGroups: [], createdAt: Date.now(), bubble_style: '', focus_start: '', focus_end: '', wx_openid: '', wx_unionid: '' };
}
async function handleSmsLogin(env, body) {
  const phone = String(body.phone || '').trim();
  const code = String(body.code || '').trim();
  if (!smsPhoneOk(phone)) return fail('手机号格式不正确');
  if (!/^\d{6}$/.test(code)) return fail('请输入6位验证码');
  if (!(await rateHit(env, 'smslogin:' + phone, 10, 15 * 60 * 1000))) return fail('尝试过于频繁，请稍后再试', 429);
  const err = await smsConsume(env, phone, 'login', code);
  if (err) { secLog(env, phone, 'sms_login_fail', err); return fail(err); }
  const user = await getUser(env, phone);
  if (user) {
    const token = await createToken(env, phone);
    secLog(env, phone, 'sms_login', '本机号码验证码登录成功');
    return ok({ token, user: publicUser(user) });
  }
  return ok({ needRegister: true, smsTicket: await makeSmsTicket(env, phone) });
}
async function handleSmsRegister(env, body) {
  const t = await env.DB.prepare('SELECT * FROM sms_tickets WHERE id = ?').bind(String(body.smsTicket || '')).first();
  if (!t || t.expires < Date.now()) return fail('验证已过期，请重新获取验证码');
  const phone = t.phone;
  if (await getUser(env, phone)) return fail('该手机号已注册，请直接登录');
  const nickname = String(body.nickname || '').trim() || ('用户' + phone.slice(-4));
  const user = smsOnlyUserRow(phone, nickname, body.avatar);
  await saveUser(env, user);
  await env.DB.prepare('DELETE FROM sms_tickets WHERE id = ?').bind(t.id).run();
  const token = await createToken(env, phone);
  secLog(env, phone, 'sms_register', '本机号码注册成功（免密账号）');
  return ok({ token, user: publicUser(user) });
}

// ---------- SIM 卡运营商一键取号（阿里云/腾讯云号码认证 SDK） ----------
// 生产环境变量：SIM_PROVIDER=aliyun|tencent, SIM_APPID, SIM_APPKEY
const SIM_DEV_PHONE = '13900000099';
function handleSimStart(env) {
  const provider = env.SIM_PROVIDER || '';
  if (!provider) {
    return ok({ mock: true, phone: SIM_DEV_PHONE,
      hint: '未配置运营商号码认证（SIM_PROVIDER=aliyun|tencent），当前返回测试号。生产接入阿里云/腾讯云号码认证 SDK' });
  }
  return ok({ mock: false, provider, appid: env.SIM_APPID || '' });
}
async function handleSimLogin(env, body, ua) {
  const provider = env.SIM_PROVIDER || '';
  let phone;
  if (!provider) {
    phone = body.phoneToken === SIM_DEV_PHONE ? SIM_DEV_PHONE : '';
    if (!phone) return fail('取号失败');
  } else {
    phone = await verifySimToken(env, body.phoneToken, provider);
    if (!phone) return fail('运营商取号校验失败');
  }
  const user = await getUser(env, phone);
  if (user) {
    const token = await createToken(env, phone);
    secLog(env, phone, 'sim_login', 'SIM一键取号登录成功');
    return ok({ token, user: publicUser(user) });
  }
  const ticket = makeId();
  await env.DB.prepare('INSERT INTO sms_tickets (id, phone, expires) VALUES (?,?,?)').bind(ticket, phone, Date.now() + 600000).run();
  return ok({ needRegister: true, smsTicket: ticket, phone });
}
async function verifySimToken(env, token, provider) {
  // TODO: 生产对接阿里云/腾讯云号码认证校验接口
  // 阿里云 dypnsapi GetMobile；腾讯云号码认证
  return null;
}

// ---------- 微信 OAuth2（开放平台扫码 / 公众号内 H5） ----------
const WX_STATE_TTL = 5 * 60 * 1000, WX_TICKET_TTL = 10 * 60 * 1000;
async function handleWxStart(env, body, url) {
  const appid = env.WX_APPID || '';
  const state = makeToken() + makeId();
  await env.DB.prepare('INSERT INTO wx_states (state, status, ticket, expires) VALUES (?,?,?,?)')
    .bind(state, 'pending', '', Date.now() + WX_STATE_TTL).run();
  if (!appid) {
    return ok({ mock: true, state, expiresIn: WX_STATE_TTL / 1000,
      hint: '未配置 WX_APPID，当前为模拟模式；在 Pages 环境变量配置微信开放平台凭证后自动切换真实扫码' });
  }
  const redirect = encodeURIComponent(url.origin + '/api/wechat/callback');
  const authorizeUrl = body.mode === 'mp'
    ? 'https://open.weixin.qq.com/connect/oauth2/authorize?appid=' + appid + '&redirect_uri=' + redirect + '&response_type=code&scope=snsapi_userinfo&state=' + state + '#wechat_redirect'
    : 'https://open.weixin.qq.com/connect/qrconnect?appid=' + appid + '&redirect_uri=' + redirect + '&response_type=code&scope=snsapi_login&state=' + state;
  return ok({ mock: false, state, authorizeUrl, expiresIn: WX_STATE_TTL / 1000 });
}
async function handleWxMockScan(env, body) {
  const s = await env.DB.prepare('SELECT * FROM wx_states WHERE state = ?').bind(String(body.state || '')).first();
  if (!s || s.expires < Date.now()) return fail('二维码已过期，请刷新');
  const openid = 'mockwx_dev_tester';
  const ticket = makeToken() + makeId();
  await env.DB.prepare('INSERT INTO wx_tickets (ticket, openid, unionid, nickname, avatar, expires) VALUES (?,?,?,?,?,?)')
    .bind(ticket, openid, '', '微信用户', '💬', Date.now() + WX_TICKET_TTL).run();
  await env.DB.prepare("UPDATE wx_states SET status = 'confirmed', ticket = ? WHERE state = ?").bind(ticket, s.state).run();
  return ok();
}
async function handleWxStatus(env, sp) {
  const s = await env.DB.prepare('SELECT * FROM wx_states WHERE state = ?').bind(String(sp.get('state') || '')).first();
  if (!s) return ok({ status: 'invalid' });
  if (s.expires < Date.now()) { await env.DB.prepare('DELETE FROM wx_states WHERE state = ?').bind(s.state).run(); return ok({ status: 'expired' }); }
  if (s.status === 'confirmed') { await env.DB.prepare('DELETE FROM wx_states WHERE state = ?').bind(s.state).run(); return ok({ status: 'confirmed', ticket: s.ticket }); }
  return ok({ status: 'pending' });
}
async function handleWxCallback(env, sp, url) {
  const failHome = url.origin + '/?wxerr=1';
  const code = sp.get('code'), state = sp.get('state');
  const s = state ? await env.DB.prepare('SELECT * FROM wx_states WHERE state = ?').bind(state).first() : null;
  if (!code || !s || s.expires < Date.now()) return Response.redirect(failHome, 302);
  const appid = env.WX_APPID || '', secret = env.WX_SECRET || '';
  if (!appid || !secret) return Response.redirect(failHome, 302);
  try {
    const tokR = await fetch('https://api.weixin.qq.com/sns/oauth2/access_token?appid=' + appid + '&secret=' + secret + '&code=' + encodeURIComponent(code) + '&grant_type=authorization_code');
    const tok = await tokR.json();
    if (!tok.openid) return Response.redirect(failHome, 302);
    let nickname = '微信用户', avatar = '💬';
    try {
      const info = await (await fetch('https://api.weixin.qq.com/sns/userinfo?access_token=' + tok.access_token + '&openid=' + tok.openid)).json();
      if (info.nickname) { nickname = info.nickname; avatar = '💬'; }
    } catch {}
    const ticket = makeToken() + makeId();
    await env.DB.prepare('INSERT INTO wx_tickets (ticket, openid, unionid, nickname, avatar, expires) VALUES (?,?,?,?,?,?)')
      .bind(ticket, tok.openid, tok.unionid || '', nickname, avatar, Date.now() + WX_TICKET_TTL).run();
    await env.DB.prepare('DELETE FROM wx_states WHERE state = ?').bind(state).run();
    return Response.redirect(url.origin + '/#wxticket=' + ticket, 302);
  } catch {
    return Response.redirect(failHome, 302);
  }
}
async function handleWxExchange(env, body) {
  const t = await env.DB.prepare('SELECT * FROM wx_tickets WHERE ticket = ?').bind(String(body.ticket || '')).first();
  if (!t || t.expires < Date.now()) return fail('微信登录已过期，请重试');
  const u = await env.DB.prepare('SELECT phone FROM users WHERE wx_openid = ?').bind(t.openid).first();
  if (u && (await getUser(env, u.phone))) {
    await env.DB.prepare('DELETE FROM wx_tickets WHERE ticket = ?').bind(t.ticket).run();
    const token = await createToken(env, u.phone);
    secLog(env, u.phone, 'wx_login', '微信快捷登录成功');
    return ok({ bound: true, token, user: publicUser(await getUser(env, u.phone)) });
  }
  return ok({ bound: false, wxTicket: body.ticket, profile: { nickname: t.nickname, avatar: t.avatar } });
}
async function handleWxBind(env, body) {
  const t = await env.DB.prepare('SELECT * FROM wx_tickets WHERE ticket = ?').bind(String(body.wxTicket || '')).first();
  if (!t || t.expires < Date.now()) return fail('微信登录已过期，请重试');
  const phone = String(body.phone || '').trim();
  const code = String(body.code || '').trim();
  if (!smsPhoneOk(phone)) return fail('手机号格式不正确');
  if (!/^\d{6}$/.test(code)) return fail('请输入6位短信验证码');
  const err = await smsConsume(env, phone, 'bind', code);
  if (err) return fail(err);
  let user = await getUser(env, phone);
  const isNew = !user;
  if (isNew) {
    const nickname = String(body.nickname || '').trim() || t.nickname || ('微信用户' + phone.slice(-4));
    user = smsOnlyUserRow(phone, nickname, body.avatar || t.avatar);
    secLog(env, phone, 'wx_register', '微信授权 + 本机号码验证，注册成功');
  } else {
    secLog(env, phone, 'wx_bind', '微信账号绑定到已有账号');
  }
  user.wx_openid = t.openid;
  user.wx_unionid = t.unionid || '';
  await saveUser(env, user);
  await env.DB.prepare('DELETE FROM wx_tickets WHERE ticket = ?').bind(t.ticket).run();
  const token = await createToken(env, phone);
  return ok({ bound: true, isNew, token, user: publicUser(await getUser(env, phone)) });
}

// ---------- 签名验签（公钥托管，私钥不出本机） ----------
async function handleSignUpload(env, user, body) {
  const jwk = body.publicKeyJwk;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return fail('仅支持 ECDSA P-256 公钥');
  await env.DB.prepare('INSERT OR REPLACE INTO sign_keys (phone, public_key, created_at) VALUES (?,?,?)')
    .bind(user.phone, JSON.stringify(jwk), Date.now()).run();
  secLog(env, user.phone, 'signkey_set', '更新签名公钥');
  return ok();
}
async function handleSignGet(env, phone) {
  const k = await env.DB.prepare('SELECT public_key, created_at FROM sign_keys WHERE phone = ?').bind(phone).first();
  if (!k) return fail('该用户未注册签名钥匙');
  return ok({ phone, publicKeyJwk: parseObj(k.public_key), createdAt: k.created_at });
}

// ---------- 找回密码 ----------
async function issueResetToken(env, phone, via) {
  const resetToken = makeToken() + makeId();
  await env.DB.prepare('INSERT INTO sec_challenges (id, challenge, mode, phone, expires) VALUES (?,?,?,?,?)')
    .bind('reset:' + resetToken, '1', 'reset', phone, Date.now() + 600000).run();
  secLog(env, phone, 'recover_' + via, '身份验证通过，签发重置票据');
  return resetToken;
}
async function handleRecoverMethods(env, body) {
  const phone = String(body.phone || '').trim();
  if (!/^\d{6,15}$/.test(phone)) return fail('手机号格式不正确');
  if (!(await rateHit(env, 'recm:' + phone, 10, 60 * 60 * 1000))) return tooMany(60);
  secLog(env, phone, 'recover_methods', '查询可用找回方式');
  const exists = !!(await getUser(env, phone));
  const pk = exists ? (await env.DB.prepare('SELECT credential_id FROM passkeys WHERE phone = ?').bind(phone).first()) : null;
  return ok({ exists, passkey: !!pk });
}
async function handleRecoverAdmin(env, body) {
  const phone = String(body.phone || '').trim();
  if (!/^\d{6,15}$/.test(phone)) return fail('手机号格式不正确');
  if (!(await rateHit(env, 'reca:' + phone, 5, 15 * 60 * 1000))) return tooMany(15);
  if (body.adminKey !== ADMIN_KEY) { secLog(env, phone, 'recover_admin_fail', '管理员密钥错误'); return fail('管理员密钥错误'); }
  if (!(await getUser(env, phone))) return fail('该手机号未注册');
  return ok({ resetToken: await issueResetToken(env, phone, 'admin') });
}
async function handleRecoverConfirm(env, body) {
  const t = await env.DB.prepare('SELECT * FROM sec_challenges WHERE id = ?').bind('reset:' + String(body.resetToken || '')).first();
  if (!t || t.expires < Date.now()) {
    if (t) await env.DB.prepare('DELETE FROM sec_challenges WHERE id = ?').bind('reset:' + body.resetToken).run();
    return fail('重置票据已过期，请重新验证');
  }
  await env.DB.prepare('DELETE FROM sec_challenges WHERE id = ?').bind('reset:' + body.resetToken).run();
  if (!(await rateHit(env, 'recc:' + t.phone, 5, 15 * 60 * 1000))) return tooMany(15);
  if (!passwordOk(body.newPassword)) return fail('密码至少8位，需同时包含字母和数字');
  const user = await getUser(env, t.phone);
  if (!user) return fail('账号不存在');
  user.passHash = await pbkdf2Hash(body.newPassword, user.passSalt);
  await saveUser(env, user);
  // 逐出全部旧会话（所有设备强制重新登录）
  await env.DB.prepare('DELETE FROM tokens WHERE phone = ?').bind(t.phone).run();
  await rateClear(env, 'login:' + t.phone);
  secLog(env, t.phone, 'password_reset', '密码重置成功，已下线全部设备');
  return ok();
}


async function ensureEnhTables(env) {
  if (env._enhT) return;
  const stmts = [
    'CREATE TABLE IF NOT EXISTS group_meta (groupId TEXT PRIMARY KEY, meta TEXT DEFAULT \'{}\', ts INTEGER DEFAULT 0)',
    'CREATE TABLE IF NOT EXISTS join_requests (groupId TEXT NOT NULL, phone TEXT NOT NULL, nickname TEXT DEFAULT \'\', ts INTEGER DEFAULT 0, status TEXT DEFAULT \'pending\', PRIMARY KEY(groupId, phone))',
    'CREATE TABLE IF NOT EXISTS group_bans (groupId TEXT NOT NULL, phone TEXT NOT NULL, until INTEGER DEFAULT 0, byPhone TEXT DEFAULT \'\', ts INTEGER DEFAULT 0, PRIMARY KEY(groupId, phone))',
    'CREATE TABLE IF NOT EXISTS group_roles (groupId TEXT NOT NULL, phone TEXT NOT NULL, role TEXT DEFAULT \'member\', ts INTEGER DEFAULT 0, PRIMARY KEY(groupId, phone))',
    'CREATE TABLE IF NOT EXISTS group_cards (groupId TEXT NOT NULL, phone TEXT NOT NULL, nickname TEXT DEFAULT \'\', ts INTEGER DEFAULT 0, PRIMARY KEY(groupId, phone))',
    'CREATE TABLE IF NOT EXISTS blocklist (phone TEXT NOT NULL, blockedPhone TEXT NOT NULL, ts INTEGER DEFAULT 0, PRIMARY KEY(phone, blockedPhone))'
  ];
  for (const st of stmts) {
    try { await env.DB.prepare(st).run(); } catch (e) { return; }
  }
  // 兼容旧结构：group_meta 可能缺 ts 列
  try { await env.DB.prepare('ALTER TABLE group_meta ADD COLUMN ts INTEGER DEFAULT 0').run(); } catch (e) {}
  env._enhT = true;
}

// ============ 批次B–F 后端：群管理 / 审核 / 禁言 / 角色 / 名片 / 黑名单 ============
async function getGroupMetaMap(env, groupId) {
  const row = await env.DB.prepare('SELECT meta FROM group_meta WHERE groupId = ?').bind(groupId).first().catch(() => null);
  if (!row || !row.meta) return {};
  try { return JSON.parse(row.meta || '{}'); } catch (e) { return {}; }
}
async function setGroupMetaMap(env, groupId, patch) {
  const cur = await getGroupMetaMap(env, groupId);
  const next = Object.assign({}, cur, patch);
  await env.DB.prepare('INSERT INTO group_meta (groupId, meta, ts) VALUES (?,?,?) ON CONFLICT(groupId) DO UPDATE SET meta = excluded.meta, ts = excluded.ts')
    .bind(groupId, JSON.stringify(next), Date.now()).run();
  return next;
}
async function handleGroupMeta(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  return ok({ meta: await getGroupMetaMap(env, code) });
}
async function handleSetGroupMeta(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone) return fail('仅群主可操作', 403);
  const meta = await setGroupMetaMap(env, code, body);
  return ok({ meta });
}
async function handleGroupCard(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (!group.members.includes(user.phone)) return fail('你不是群成员', 403);
  await env.DB.prepare('INSERT INTO group_cards (groupId, phone, nickname, ts) VALUES (?,?,?,?) ON CONFLICT(groupId, phone) DO UPDATE SET nickname = excluded.nickname, ts = excluded.ts')
    .bind(code, user.phone, String(body.nickname || '').slice(0, 16), Date.now()).run();
  return ok({ nickname: body.nickname || '' });
}
async function handleBanMember(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone) return fail('仅群主可禁言', 403);
  const phone = String(body.phone || '');
  const until = parseInt(body.until, 10) || 0;
  if (!phone) return fail('缺少成员手机号');
  if (until <= 0) {
    await env.DB.prepare('DELETE FROM group_bans WHERE groupId = ? AND phone = ?').bind(code, phone).run();
  } else {
    await env.DB.prepare('INSERT INTO group_bans (groupId, phone, until, byPhone, ts) VALUES (?,?,?,?,?) ON CONFLICT(groupId, phone) DO UPDATE SET until = excluded.until, byPhone = excluded.byPhone, ts = excluded.ts')
      .bind(code, phone, until, user.phone, Date.now()).run();
  }
  return ok({ banned: until > 0 });
}
async function handleSetRole(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone) return fail('仅群主可设置角色', 403);
  const phone = String(body.phone || '');
  const role = body.role === 'admin' ? 'admin' : 'member';
  if (!phone) return fail('缺少成员手机号');
  await env.DB.prepare('INSERT INTO group_roles (groupId, phone, role, ts) VALUES (?,?,?,?) ON CONFLICT(groupId, phone) DO UPDATE SET role = excluded.role, ts = excluded.ts')
    .bind(code, phone, role, Date.now()).run();
  return ok({ role });
}
async function handleGetRequests(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone) return fail('仅群主可查看', 403);
  const rows = await env.DB.prepare('SELECT * FROM join_requests WHERE groupId = ? AND status = \'pending\' ORDER BY ts DESC').bind(code).all();
  return ok({ requests: (rows.results || []).map(r => ({ phone: r.phone, nickname: r.nickname, ts: r.ts })) });
}
async function handleReviewRequest(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail('群聊不存在', 404);
  if (group.owner !== user.phone) return fail('仅群主可审批', 403);
  const phone = String(body.phone || '');
  const action = body.action === 'approve' ? 'approve' : 'reject';
  const req = await env.DB.prepare('SELECT * FROM join_requests WHERE groupId = ? AND phone = ?').bind(code, phone).first().catch(() => null);
  if (!req) return fail('申请不存在');
  if (action === 'reject') {
    await env.DB.prepare('UPDATE join_requests SET status = \'rejected\' WHERE groupId = ? AND phone = ?').bind(code, phone).run();
    return ok({ approved: false });
  }
  if (!group.members.includes(phone)) {
    group.members.push(phone);
    await saveGroup(env, group);
  }
  const u = await getUser(env, phone);
  if (u && !u.joinedGroups.includes(code)) {
    u.joinedGroups.push(code);
    await saveUser(env, u);
  }
  await env.DB.prepare('UPDATE join_requests SET status = \'approved\' WHERE groupId = ? AND phone = ?').bind(code, phone).run();
  return ok({ approved: true });
}
async function handleBlockUser(env, user, body) {
  const blockedPhone = String(body.phone || '');
  if (!blockedPhone || blockedPhone === user.phone) return fail('参数错误');
  await env.DB.prepare('INSERT INTO blocklist (phone, blockedPhone, ts) VALUES (?,?,?) ON CONFLICT(phone, blockedPhone) DO NOTHING')
    .bind(user.phone, blockedPhone, Date.now()).run();
  return ok({ blocked: true });
}
