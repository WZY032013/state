/* Stating 本地测试服务器 — 模拟 Cloudflare Pages Functions + KV */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8788;
const ADMIN_PHONE = '13385387338';
const MSG_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_MSGS = 500;
const TOKEN_TTL = 60 * 60 * 24 * 30;

// 内存 KV
const KV = {};
const kvGet = (k) => KV[k] ? JSON.parse(KV[k]) : null;
const kvSet = (k, v) => { KV[k] = JSON.stringify(v); };
const kvDel = (k) => { delete KV[k]; };

// 工具（密码：PBKDF2-SHA256 10万次迭代；兼容旧 sha256，登录时透明升级）
const PBKDF2_ITERS = 100000;
function pbkdf2Hash(pw, salt) {
  return 'pbkdf2$' + crypto.pbkdf2Sync(String(pw), String(salt), PBKDF2_ITERS, 32, 'sha256').toString('base64');
}
function legacyHash(pw, salt) {
  return crypto.createHash('sha256').update(pw + ':' + salt).digest('base64');
}
function verifyPassword(pw, salt, stored) {
  if (typeof stored === 'string' && stored.startsWith('pbkdf2$')) return pbkdf2Hash(pw, salt) === stored;
  return legacyHash(pw, salt) === stored;
}
function hashPassword(pw, salt) { return pbkdf2Hash(pw, salt); }
function passwordOk(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 64) return false;
  return /[a-zA-Z]/.test(pw) && /\d/.test(pw);
}
function makeSalt() { return crypto.randomBytes(16).toString('base64'); }
function makeToken() { return crypto.randomUUID() + crypto.randomBytes(8).toString('hex'); }
function makeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function publicUser(u) {
  if (!u) return null;
  return { phone: u.phone, nickname: u.nickname, avatar: u.avatar, email: u.email || '无', isAdmin: u.phone === ADMIN_PHONE, createdAt: u.createdAt, joinedGroups: u.joinedGroups || [] };
}

// 路由处理
async function handleRegister(body) {
  const { phone, password, nickname, avatar, email } = body;
  if (!phone || !password || !nickname) return { ok: false, error: '请填写完整信息' };
  if (!/^\d{6,15}$/.test(phone)) return { ok: false, error: '手机号格式不正确' };
  if (!passwordOk(password)) return { ok: false, error: '密码至少8位，需同时包含字母和数字' };
  if (kvGet('user:' + phone)) return { ok: false, error: '该手机号已注册' };
  const salt = makeSalt();
  const user = { phone, nickname, avatar: avatar || '😀', email: email || '无', passHash: hashPassword(password, salt), passSalt: salt, joinedGroups: [], createdAt: Date.now() };
  kvSet('user:' + phone, user);
  const idx = kvGet('user_index') || [];
  if (!idx.includes(phone)) { idx.push(phone); kvSet('user_index', idx); }
  const token = makeToken();
  kvSet('token:' + token, { phone, expires: Date.now() + TOKEN_TTL * 1000 });
  return { ok: true, token, user: publicUser(user) };
}

async function handleLogin(body) {
  const { phone, password } = body;
  if (!phone || !password) return { ok: false, error: '请输入手机号和密码' };
  if (!rateHit('login:' + phone, 5, 15 * 60 * 1000)) return { httpStatus: 429, ok: false, error: '尝试次数过多，请15分钟后再试' };
  const user = kvGet('user:' + phone);
  if (!user) { secLog(phone, 'login_fail', '账号不存在'); return { ok: false, error: '该手机号未注册' }; }
  if (!verifyPassword(password, user.passSalt, user.passHash)) { secLog(phone, 'login_fail', '密码错误'); return { ok: false, error: '密码错误' }; }
  rateClear('login:' + phone);
  if (!String(user.passHash || '').startsWith('pbkdf2$')) { user.passHash = pbkdf2Hash(password, user.passSalt); kvSet('user:' + phone, user); }
  const token = makeToken();
  kvSet('token:' + token, { phone, expires: Date.now() + TOKEN_TTL * 1000 });
  secLog(phone, 'login', '密码登录成功');
  return { ok: true, token, user: publicUser(user) };
}

function authUser(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  const data = kvGet('token:' + auth.slice(7));
  if (!data || data.expires < Date.now()) return null;
  return kvGet('user:' + data.phone);
}

// ============ 扫码登录（二维码一次性换票，二维码内不含任何账号密码） ============
const QRLOGIN_TTL = 2 * 60 * 1000; // 二维码 2 分钟有效
function qrSession(id) {
  const s = kvGet('qrlogin:' + id);
  if (!s) return null;
  if (s.expires < Date.now()) { kvDel('qrlogin:' + id); return { id, status: 'expired' }; }
  return s;
}

// PC 端：创建待扫码会话
function handleQrCreate() {
  const qrId = crypto.randomBytes(24).toString('hex');
  kvSet('qrlogin:' + qrId, { id: qrId, status: 'pending', expires: Date.now() + QRLOGIN_TTL, createdAt: Date.now() });
  return { ok: true, qrId, expiresIn: QRLOGIN_TTL / 1000 };
}

// PC 端：轮询状态；confirmed 一次性返回登录 token 并销毁会话
function handleQrStatus(query) {
  const s = qrSession(query.get('qrId') || '');
  if (!s) return { ok: false, status: 'invalid', error: '二维码无效' };
  if (s.status === 'confirmed') {
    kvDel('qrlogin:' + s.id);
    return { ok: true, status: 'confirmed', token: s.loginToken, user: s.loginUser };
  }
  if (s.status === 'scanned') {
    const u = kvGet('user:' + s.phone);
    return { ok: true, status: 'scanned', scanner: u ? { nickname: u.nickname, avatar: u.avatar, phone: u.phone } : null };
  }
  return { ok: true, status: s.status };
}

// 手机端：已登录用户扫码，标记"已扫码"
function handleQrScan(user, body) {
  const s = qrSession(body.qrId || '');
  if (!s || s.status === 'expired') return { ok: false, error: '二维码已过期' };
  if (s.status !== 'pending') return { ok: false, error: '二维码已被使用' };
  s.status = 'scanned';
  s.phone = user.phone;
  kvSet('qrlogin:' + s.id, s);
  return { ok: true, status: 'scanned' };
}

// 手机端：确认登录 → 服务端签发长期 token，PC 端下次轮询取走
function handleQrConfirm(user, body) {
  const s = qrSession(body.qrId || '');
  if (!s || s.status === 'expired') return { ok: false, error: '二维码已过期' };
  if (s.status !== 'scanned' || s.phone !== user.phone) return { ok: false, error: '请先扫码再确认' };
  const loginToken = makeToken();
  kvSet('token:' + loginToken, { phone: user.phone, expires: Date.now() + TOKEN_TTL * 1000 });
  s.status = 'confirmed';
  s.loginToken = loginToken;
  s.loginUser = publicUser(user);
  kvSet('qrlogin:' + s.id, s);
  return { ok: true, status: 'confirmed' };
}

// 手机端：取消登录
function handleQrCancel(user, body) {
  const s = qrSession(body.qrId || '');
  if (s && s.status !== 'confirmed' && (!s.phone || s.phone === user.phone)) {
    s.status = 'canceled';
    kvSet('qrlogin:' + s.id, s);
  }
  return { ok: true };
}

async function handleAPI(req, parts, body, url) {
  if (parts[0] === 'register' && req.method === 'POST') return handleRegister(body);
  if (parts[0] === 'login' && req.method === 'POST') return handleLogin(body);

  // 扫码登录：PC 端公开接口（创建/轮询）
  if (parts[0] === 'qrlogin' && parts[1] === 'create' && req.method === 'POST') return handleQrCreate();
  if (parts[0] === 'qrlogin' && parts[1] === 'status' && req.method === 'GET') return handleQrStatus(url.searchParams);

  // ===== 安全中心：公开接口 =====
  if (parts[0] === 'passkey' && parts[1] === 'options' && req.method === 'POST') return handleWaOptions(body, url);
  if (parts[0] === 'passkey' && parts[1] === 'verify' && req.method === 'POST') return handleWaVerify(body, url);
  if (parts[0] === 'devicecode' && parts[1] === 'create' && req.method === 'POST') return handleDcCreate(req);
  if (parts[0] === 'devicecode' && parts[1] === 'status' && req.method === 'GET') return handleDcStatus(url.searchParams);
  if (parts[0] === 'recover' && parts[1] === 'methods' && req.method === 'POST') return handleRecoverMethods(body, req);
  if (parts[0] === 'recover' && parts[1] === 'admin' && req.method === 'POST') return handleRecoverAdmin(body, req);
  if (parts[0] === 'recover' && parts[1] === 'confirm' && req.method === 'POST') return handleRecoverConfirm(body);
  if (parts[0] === 'signkeys' && parts[1] && req.method === 'GET') return handleSignGet(parts[1]);

  const user = authUser(req);
  if (!user) return { status: 401, ok: false, error: '未登录或登录已过期' };

  try {
    if (parts[0] === 'me') return { ok: true, user: publicUser(user) };

    // 扫码登录：手机端已登录接口（扫码/确认/取消）
    if (parts[0] === 'qrlogin' && parts[1] === 'scan' && req.method === 'POST') return handleQrScan(user, body);
    if (parts[0] === 'qrlogin' && parts[1] === 'confirm' && req.method === 'POST') return handleQrConfirm(user, body);
    if (parts[0] === 'qrlogin' && parts[1] === 'cancel' && req.method === 'POST') return handleQrCancel(user, body);

    // ===== 安全中心：需登录 =====
    if (parts[0] === 'passkey' && parts[1] === 'register' && parts[2] === 'options' && req.method === 'POST') return handleWaRegOptions(user, body, url);
    if (parts[0] === 'passkey' && parts[1] === 'register' && req.method === 'POST') return handleWaRegister(user, body, url);
    if (parts[0] === 'passkeys' && parts.length === 1 && req.method === 'GET') return handlePasskeyList(user);
    if (parts[0] === 'passkey' && parts[1] === 'delete' && req.method === 'POST') return handlePasskeyDelete(user, body);
    if (parts[0] === 'devicecode' && parts[1] === 'authorize' && req.method === 'POST') return handleDcAuthorize(user, body);
    if (parts[0] === 'signkeys' && parts.length === 1 && req.method === 'POST') return handleSignUpload(user, body);
    if (parts[0] === 'security' && parts[1] === 'log' && req.method === 'GET') return handleSecLog(user);

    if (parts[0] === 'beat' && req.method === 'POST') {
      const up = kvGet('presence_u:' + user.phone) || {};
      kvSet('presence_u:' + user.phone, { nickname: user.nickname, avatar: user.avatar, lastSeen: Date.now() });
      if (body.code) {
        const g = kvGet('group:' + body.code.toUpperCase());
        if (g && g.members.includes(user.phone)) {
          const p = kvGet('presence_g:' + body.code.toUpperCase()) || {};
          p[user.phone] = { nickname: user.nickname, avatar: user.avatar, lastSeen: Date.now() };
          kvSet('presence_g:' + body.code.toUpperCase(), p);
        }
      }
      return { ok: true };
    }

    if (parts[0] === 'users') {
      const phones = kvGet('user_index') || [];
      const users = phones.map(p => {
        const u = kvGet('user:' + p);
        const pres = kvGet('presence_u:' + p);
        return u ? { ...publicUser(u), online: !!(pres && Date.now() - pres.lastSeen < 15000), lastSeen: pres ? pres.lastSeen : u.createdAt } : null;
      }).filter(Boolean);
      users.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
      return { ok: true, users };
    }

    if (parts[0] === 'my-groups') {
      const groups = (user.joinedGroups || []).map(code => {
        const g = kvGet('group:' + code);
        if (!g) return null;
        const msgs = (kvGet('msgs:' + code) || []).filter(m => m.ts > Date.now() - MSG_TTL);
        return { code: g.code, name: g.name, avatar: g.avatar, owner: g.owner, isOwner: g.owner === user.phone, memberCount: g.members.length, lastMsgTs: msgs.length ? msgs[msgs.length - 1].ts : g.createdAt };
      }).filter(Boolean);
      return { ok: true, groups };
    }

    if (parts[0] === 'groups' && parts.length === 1 && req.method === 'POST') {
      const { code, name, avatar } = body;
      if (!code || !name) return { ok: false, error: '请填写群聊名称和邀请码' };
      if (!/^[A-Za-z0-9]{6}$/.test(code)) return { ok: false, error: '邀请码必须是6位字母或数字' };
      const uc = code.toUpperCase();
      if (kvGet('group:' + uc)) return { ok: false, error: '该邀请码已被使用' };
      const g = { code: uc, name, avatar: avatar || '💬', createdBy: user.phone, owner: user.phone, members: [user.phone], createdAt: Date.now() };
      kvSet('group:' + uc, g);
      const idx = kvGet('group_index') || [];
      if (!idx.includes(uc)) { idx.push(uc); kvSet('group_index', idx); }
      if (!user.joinedGroups.includes(uc)) { user.joinedGroups.push(uc); kvSet('user:' + user.phone, user); }
      return { ok: true, group: g };
    }

    if (parts[0] === 'groups' && parts[1]) {
      const code = parts[1].toUpperCase();
      const g = kvGet('group:' + code);

      if (parts[2] === 'join' && req.method === 'POST') {
        if (!g) return { ok: false, error: '群聊不存在' };
        if (!g.members.includes(user.phone)) { g.members.push(user.phone); kvSet('group:' + code, g); }
        if (!user.joinedGroups.includes(code)) { user.joinedGroups.push(code); kvSet('user:' + user.phone, user); }
        return { ok: true, group: g };
      }

      if (parts[2] === 'leave' && req.method === 'POST') {
        if (!g) return { ok: false, error: '群聊不存在' };
        if (g.owner === user.phone) return { ok: false, error: '群主不能退出群聊，请注销群聊' };
        g.members = g.members.filter(p => p !== user.phone); kvSet('group:' + code, g);
        user.joinedGroups = user.joinedGroups.filter(c => c !== code); kvSet('user:' + user.phone, user);
        return { ok: true };
      }

      if (parts.length === 2 && req.method === 'DELETE') {
        if (!g) return { ok: false, error: '群聊不存在' };
        if (g.owner !== user.phone && user.phone !== ADMIN_PHONE) return { ok: false, error: '只有群主或管理员可以注销群聊' };
        g.members.forEach(p => {
          const u = kvGet('user:' + p);
          if (u) { u.joinedGroups = (u.joinedGroups || []).filter(c => c !== code); kvSet('user:' + p, u); }
        });
        kvDel('group:' + code); kvDel('msgs:' + code); kvDel('presence_g:' + code);
        const idx = kvGet('group_index') || [];
        const i = idx.indexOf(code); if (i >= 0) { idx.splice(i, 1); kvSet('group_index', idx); }
        return { ok: true };
      }

      if (parts[2] === 'messages' && parts.length === 3 && req.method === 'GET') {
        if (!g) return { ok: false, error: '群聊不存在' };
        let msgs = (kvGet('msgs:' + code) || []).filter(m => m.ts > Date.now() - MSG_TTL);
        kvSet('msgs:' + code, msgs);
        const pres = kvGet('presence_g:' + code) || {};
        const online = {};
        Object.entries(pres).forEach(([p, info]) => { if (Date.now() - info.lastSeen < 15000) online[p] = info; });
        return { ok: true, group: { ...g, isOwner: g.owner === user.phone, isMember: g.members.includes(user.phone) }, messages: msgs, onlineMembers: online, isAdmin: user.phone === ADMIN_PHONE };
      }

      if (parts[2] === 'messages' && parts.length === 3 && req.method === 'POST') {
        if (!g) return { ok: false, error: '群聊不存在' };
        if (!g.members.includes(user.phone)) return { ok: false, error: '你不是群成员' };
        const { text, type, imageData } = body;
        if (!text && !imageData) return { ok: false, error: '消息内容不能为空' };
        const msg = { id: makeId(), senderPhone: user.phone, senderNickname: user.nickname, senderAvatar: user.avatar, text: text || '', type: type || 'text', imageData: imageData || null, ts: Date.now() };
        let msgs = (kvGet('msgs:' + code) || []).filter(m => m.ts > Date.now() - MSG_TTL);
        msgs.push(msg); if (msgs.length > MAX_MSGS) msgs = msgs.slice(-MAX_MSGS);
        kvSet('msgs:' + code, msgs);
        return { ok: true, message: msg };
      }

      if (parts[2] === 'messages' && parts[3] === 'clear' && req.method === 'POST') {
        if (!g) return { ok: false, error: '群聊不存在' };
        if (g.owner !== user.phone && user.phone !== ADMIN_PHONE) return { ok: false, error: '只有群主或管理员可以清空消息' };
        kvSet('msgs:' + code, []);
        return { ok: true };
      }

      if (parts.length === 2 && req.method === 'GET') {
        if (!g) return { ok: false, error: '群聊不存在' };
        let msgs = (kvGet('msgs:' + code) || []).filter(m => m.ts > Date.now() - MSG_TTL);
        kvSet('msgs:' + code, msgs);
        const pres = kvGet('presence_g:' + code) || {};
        const online = {};
        Object.entries(pres).forEach(([p, info]) => { if (Date.now() - info.lastSeen < 15000) online[p] = info; });
        return { ok: true, group: { ...g, isOwner: g.owner === user.phone, isMember: g.members.includes(user.phone) }, messages: msgs, onlineMembers: online, isAdmin: user.phone === ADMIN_PHONE };
      }
    }

    if (parts[0] === 'admin' && parts[1] === 'users' && parts[3] === 'groups') {
      if (user.phone !== ADMIN_PHONE) return { ok: false, error: '无权限', status: 403 };
      const target = kvGet('user:' + parts[2]);
      if (!target) return { ok: false, error: '用户不存在' };
      const groups = (target.joinedGroups || []).map(code => {
        const g = kvGet('group:' + code);
        if (!g) return null;
        const msgs = (kvGet('msgs:' + code) || []).filter(m => m.ts > Date.now() - MSG_TTL);
        return { code: g.code, name: g.name, avatar: g.avatar, owner: g.owner, createdBy: g.createdBy, msgCount: msgs.length, lastMsgTs: msgs.length ? msgs[msgs.length - 1].ts : g.createdAt };
      }).filter(Boolean);
      return { ok: true, user: publicUser(target), groups };
    }

    if (parts[0] === 'delete-account' && req.method === 'POST') {
      (user.joinedGroups || []).forEach(code => {
        const g = kvGet('group:' + code);
        if (g) {
          if (g.owner === user.phone) {
            g.members.forEach(p => { if (p !== user.phone) { const u = kvGet('user:' + p); if (u) { u.joinedGroups = (u.joinedGroups || []).filter(c => c !== code); kvSet('user:' + p, u); } } });
            kvDel('group:' + code); kvDel('msgs:' + code); kvDel('presence_g:' + code);
            const idx = kvGet('group_index') || []; const i = idx.indexOf(code); if (i >= 0) { idx.splice(i, 1); kvSet('group_index', idx); }
          } else {
            g.members = g.members.filter(p => p !== user.phone); kvSet('group:' + code, g);
          }
        }
      });
      kvDel('user:' + user.phone); kvDel('presence_u:' + user.phone);
      const idx = kvGet('user_index') || []; const i = idx.indexOf(user.phone); if (i >= 0) { idx.splice(i, 1); kvSet('user_index', idx); }
      return { ok: true };
    }

    // 近场 P2P 信令（与 functions/api/[[path]].js 行为一致，含长轮询）
    if (parts[0] === 'near' && parts[1] === 'session') {
      return handleNearSession(req, url, user);
    }
    if (parts[0] === 'near' && parts[1] === 'signal') {
      return handleNearSignal(req, url, user, body);
    }

    return { ok: false, error: '未知路径' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============ 近场 P2P 信令（与 Cloudflare 后端行为一致，含长轮询） ============
const NEAR_TTL = 30 * 60 * 1000;
function nearCode() {
  const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let c = ''; for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
function nearCleanup() {
  const cutoff = Date.now() - NEAR_TTL;
  for (const k of Object.keys(KV)) {
    if (k.startsWith('near_session:') || k.startsWith('near_signals:')) {
      try { const v = JSON.parse(KV[k]); if ((v.ts || 0) < cutoff) { delete KV[k]; } } catch (e) { delete KV[k]; }
    }
  }
}

async function handleNearSession(req, url, user) {
  nearCleanup();
  if (req.method === 'POST') {
    let code; let tries = 0;
    do { code = nearCode(); tries++; } while (kvGet('near_session:' + code) && tries < 5);
    kvSet('near_session:' + code, { createdBy: user.phone, ts: Date.now() });
    return { ok: true, code };
  }
  if (req.method === 'DELETE') {
    const code = url.searchParams.get('code');
    if (!code) return { ok: false, error: '缺少会话码' };
    kvDel('near_session:' + code); kvDel('near_signals:' + code);
    return { ok: true, deleted: true };
  }
  const code = url.searchParams.get('code');
  if (!code) return { ok: false, error: '缺少会话码' };
  const s = kvGet('near_session:' + code);
  if (!s) return { ok: false, error: '会话不存在或已过期', status: 404 };
  s.ts = Date.now(); kvSet('near_session:' + code, s);
  return { ok: true, exists: true };
}

async function handleNearSignal(req, url, user, body) {
  nearCleanup();
  if (req.method === 'POST') {
    const code = url.searchParams.get('code') || body.code;
    if (!code) return { ok: false, error: '缺少会话码' };
    const to = String(body.to || '');
    const data = body.data;
    if (!to || data === undefined || data === null) return { ok: false, error: '缺少信令内容' };
    if (!kvGet('near_session:' + code)) return { ok: false, error: '会话不存在或已过期', status: 404 };
    const key = 'near_signals:' + code;
    const q = kvGet(key) || {};
    q[to] = q[to] || [];
    q[to].push({ data, ts: Date.now() });
    q.ts = Date.now();
    kvSet(key, q);
    return { ok: true, queued: true };
  }
  // GET（含长轮询 wait=1）
  const code = url.searchParams.get('code');
  if (!code) return { ok: false, error: '缺少会话码' };
  const peer = url.searchParams.get('peer') || '';
  if (!peer) return { ok: false, error: '缺少peer' };
  const wantWait = url.searchParams.get('wait') === '1';
  const pollMs = 300, maxHold = wantWait ? 18000 : 0;
  const deadline = Date.now() + maxHold;
  const drain = () => {
    const key = 'near_signals:' + code;
    const q = kvGet(key) || {};
    const arr = q[peer] || [];
    if (arr.length) {
      const out = arr.splice(0, arr.length);
      q[peer] = [];
      q.ts = Date.now(); kvSet(key, q);
      return out.map(r => r.data);
    }
    return null;
  };
  let first = drain();
  if (first) return { ok: true, signals: first };
  if (!wantWait) return { ok: true, signals: [] };
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const got = drain();
    if (got) return { ok: true, signals: got };
  }
  return { ok: true, signals: [] };
}

// MIME types
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);

  // API
  if (url.pathname.startsWith('/api/')) {
    let body = {};
    if (req.method === 'POST' || req.method === 'DELETE') {
      body = await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });
    }
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const result = await handleAPI(req, parts, body, url);
    res.writeHead(typeof result.httpStatus === 'number' ? result.httpStatus : (typeof result.status === 'number' ? result.status : 200), { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
    return;
  }

  // Static files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, filePath.split('?')[0]);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'index.html');
  }
  const ext = path.extname(filePath);
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => console.log('Stating dev server running at http://localhost:' + PORT));

/* ============================================================
   安全中心：Passkey(WebAuthn) / 设备码授权 / 签名验签 / 找回密码
   —— 全部数据仅存内存 KV；令牌一次性；带频控与安全审计日志
   ============================================================ */
const ADMIN_KEY = '032013';
const WACHAL_TTL = 180000;           // WebAuthn challenge 3分钟
const DC_TTL = 5 * 60 * 1000;        // 设备码 5分钟
const RESET_TTL = 10 * 60 * 1000;    // 找回票据 10分钟
const DC_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ---------- 频控（内存滑动窗口） ----------
const RL = {};
function rateHit(key, limit, windowMs) {
  const now = Date.now();
  let r = RL[key];
  if (!r || now - r.ws > windowMs) { r = { ws: now, c: 0 }; }
  r.c++; RL[key] = r;
  return r.c <= limit;
}
function rateClear(key) { delete RL[key]; }
function tooMany(min) { return { httpStatus: 429, ok: false, error: min ? `操作过于频繁，请${min}分钟后再试` : '操作过于频繁，请稍后再试' }; }

// ---------- 安全审计日志 ----------
function secLog(phone, event, detail) {
  if (!phone) return;
  const k = 'seclog:' + phone;
  const a = kvGet(k) || [];
  a.unshift({ ts: Date.now(), event, detail: detail || '' });
  kvSet(k, a.slice(0, 50));
}
function handleSecLog(user) {
  return { ok: true, logs: kvGet('seclog:' + user.phone) || [] };
}

// ---------- WebAuthn 基础 ----------
const TE8 = new TextEncoder();
function b64uEnc(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (const b of u) s += String.fromCharCode(b);
  return Buffer.from(s, 'binary').toString('base64url');
}
function b64uDec(str) { return new Uint8Array(Buffer.from(String(str), 'base64url')); }
async function sha256(buf) { return new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); }

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
    if (t === 3) return Buffer.from(take(x)).toString('utf8');
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
  let off = 37, aaguid = null, credId = null, cose = null;
  if (flags & 0x40) {
    aaguid = b64uEnc(b.subarray(off, off + 16)); off += 16;
    const cl = dv.getUint16(off); off += 2;
    credId = b.subarray(off, off + cl); off += cl;
    cose = cborDecode(b.subarray(off));
  }
  return { rpIdHash: b64uEnc(b.subarray(0, 32)), flags, counter, aaguid, credId, cose };
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
function passkeyList(phone) { return kvGet('passkeys:' + phone) || []; }
function getPasskey(cid) { return kvGet('passkey:' + cid); }
function savePasskey(rec) { kvSet('passkey:' + rec.credId, rec); }

function secChallenge(mode, phone) {
  const id = makeId() + crypto.randomBytes(6).toString('hex');
  const ch = b64uEnc(crypto.randomBytes(32));
  kvSet('wachal:' + id, { id, mode, phone: phone || '', ch, expires: Date.now() + WACHAL_TTL });
  return { id, ch };
}
function takeChallenge(id, mode) {
  const c = kvGet('wachal:' + id);
  if (!c || c.expires < Date.now() || c.mode !== mode) { if (c) kvDel('wachal:' + id); return null; }
  return c;
}
function dropChallenge(id) { kvDel('wachal:' + id); }
function checkOrigin(cdj, url) {
  try { return new URL(cdj.origin).hostname === url.hostname; } catch { return false; }
}

// ---------- Passkey：注册 ----------
function handleWaRegOptions(user, body, url) {
  const { id, ch } = secChallenge('register', user.phone);
  const existing = passkeyList(user.phone).map(cid => ({ type: 'public-key', id: cid }));
  return {
    ok: true, challengeId: id,
    publicKey: {
      challenge: ch, rp: { id: url.hostname, name: 'Stating' },
      user: { id: b64uEnc(TE8.encode(user.phone)), name: user.phone, displayName: user.nickname || user.phone },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }, { type: 'public-key', alg: -8 }],
      timeout: 60000, attestation: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      excludeCredentials: existing
    }
  };
}
async function handleWaRegister(user, body, url) {
  if (!body.challengeId || !body.id || !body.response) return { ok: false, error: '参数不完整' };
  const c = takeChallenge(body.challengeId, 'register');
  if (!c || c.phone !== user.phone) return { ok: false, error: '挑战已过期，请重试' };
  dropChallenge(c.id);
  let cdj;
  try { cdj = JSON.parse(Buffer.from(b64uDec(body.response.clientDataJSON)).toString('utf8')); } catch { return { ok: false, error: '响应解析失败' }; }
  if (cdj.type !== 'webauthn.create' || cdj.challenge !== c.ch) return { ok: false, error: '挑战校验失败' };
  if (!checkOrigin(cdj, url)) return { ok: false, error: '来源域不匹配' };
  let ad;
  try { ad = parseAuthData(cborDecode(b64uDec(body.response.attestationObject)).authData); } catch { return { ok: false, error: '凭据解析失败' }; }
  if (!(ad.flags & 0x01) || !ad.cose) return { ok: false, error: '凭据数据无效' };
  const jwk = coseToJwk(ad.cose);
  if (!jwk) return { ok: false, error: '暂不支持该密钥算法' };
  const rec = { credId: body.id, phone: user.phone, jwk, counter: ad.counter, device: body.attachment === 'cross-platform' ? '安全钥匙' : '本机生物识别', createdAt: Date.now(), lastUsed: 0 };
  savePasskey(rec);
  const list = passkeyList(user.phone).filter(x => x !== body.id); list.push(body.id);
  kvSet('passkeys:' + user.phone, list);
  secLog(user.phone, 'passkey_add', '新增 Passkey（' + rec.device + '）');
  return { ok: true, device: rec.device };
}

// ---------- Passkey：登录 / 找回验证 ----------
function handleWaOptions(body, url) {
  const mode = body.mode === 'recover' ? 'recover' : 'login';
  const phone = String(body.phone || '').trim();
  if (mode === 'recover' && !/^\d{6,15}$/.test(phone)) return { ok: false, error: '请输入手机号' };
  if (mode === 'recover' && !passkeyList(phone).length) return { ok: false, error: '该账号未绑定 Passkey' };
  const { id, ch } = secChallenge(mode, phone);
  return {
    ok: true, challengeId: id,
    publicKey: {
      challenge: ch, rpId: url.hostname, timeout: 60000, userVerification: 'preferred',
      allowCredentials: (phone ? passkeyList(phone) : []).map(cid => ({ type: 'public-key', id: cid }))
    }
  };
}
async function handleWaVerify(body, url) {
  const mode = body.mode === 'recover' ? 'recover' : 'login';
  if (!body.challengeId || !body.id || !body.response) return { ok: false, error: '参数不完整' };
  const c = takeChallenge(body.challengeId, mode);
  if (!c) return { ok: false, error: '挑战已过期，请重试' };
  dropChallenge(c.id);
  let cdj;
  try { cdj = JSON.parse(Buffer.from(b64uDec(body.response.clientDataJSON)).toString('utf8')); } catch { return { ok: false, error: '响应解析失败' }; }
  if (cdj.type !== 'webauthn.get' || cdj.challenge !== c.ch) return { ok: false, error: '挑战校验失败' };
  if (!checkOrigin(cdj, url)) return { ok: false, error: '来源域不匹配' };
  const rec = getPasskey(body.id);
  if (!rec) return { ok: false, error: '未知凭据' };
  let userHandle = '';
  try { userHandle = Buffer.from(b64uDec(body.response.userHandle || '')).toString('utf8'); } catch {}
  if (mode === 'recover' && (c.phone !== rec.phone || (userHandle && userHandle !== rec.phone))) return { ok: false, error: '账号不匹配' };
  const ad = b64uDec(body.response.authenticatorData);
  if (ad.length < 37) return { ok: false, error: '凭据数据无效' };
  const parsed = parseAuthData(ad);
  if (parsed.rpIdHash !== b64uEnc(await sha256(TE8.encode(url.hostname)))) return { ok: false, error: '站点不匹配' };
  if (!(parsed.flags & 0x01)) return { ok: false, error: '请先完成生物识别验证' };
  if (parsed.counter < rec.counter && parsed.counter !== 0 && rec.counter !== 0) return { ok: false, error: '检测到凭据克隆，已拒绝' };
  const clientHash = await sha256(b64uDec(body.response.clientDataJSON));
  const signed = new Uint8Array(ad.length + clientHash.length);
  signed.set(ad); signed.set(clientHash, ad.length);
  const sigOk = await webVerify(rec.jwk, b64uDec(body.response.signature), signed);
  if (!sigOk) { secLog(rec.phone, 'passkey_fail', '签名校验失败'); return { ok: false, error: '签名校验失败' }; }
  rec.counter = Math.max(rec.counter, parsed.counter); rec.lastUsed = Date.now(); savePasskey(rec);
  if (mode === 'recover') {
    const resetToken = crypto.randomBytes(24).toString('hex');
    kvSet('pwreset:' + resetToken, { phone: rec.phone, expires: Date.now() + RESET_TTL });
    secLog(rec.phone, 'recover_passkey', 'Passkey 身份验证通过');
    return { ok: true, resetToken };
  }
  const token = makeToken();
  kvSet('token:' + token, { phone: rec.phone, expires: Date.now() + TOKEN_TTL * 1000 });
  secLog(rec.phone, 'passkey_login', 'Passkey 登录成功（' + rec.device + '）');
  return { ok: true, token, user: publicUser(kvGet('user:' + rec.phone)) };
}

function handlePasskeyList(user) {
  const list = passkeyList(user.phone).map(cid => {
    const r = getPasskey(cid);
    return r ? { id: r.credId, device: r.device, createdAt: r.createdAt, lastUsed: r.lastUsed } : null;
  }).filter(Boolean);
  return { ok: true, passkeys: list };
}
function handlePasskeyDelete(user, body) {
  const cid = String(body.id || '');
  const rec = getPasskey(cid);
  if (!rec || rec.phone !== user.phone) return { ok: false, error: '凭据不存在' };
  kvDel('passkey:' + cid);
  kvSet('passkeys:' + user.phone, passkeyList(user.phone).filter(x => x !== cid));
  secLog(user.phone, 'passkey_remove', '删除 Passkey（' + rec.device + '）');
  return { ok: true };
}

// ---------- 设备码授权（RFC 8628 风格） ----------
function dcUserCode() {
  for (;;) {
    const b = crypto.randomBytes(8); let s = '';
    for (let i = 0; i < 8; i++) s += DC_ALPHABET[b[i] % DC_ALPHABET.length];
    const code = s.slice(0, 4) + '-' + s.slice(4);
    if (!kvGet('dcu:' + code)) return code;
  }
}
function handleDcCreate(req) {
  const ip = (req.socket && req.socket.remoteAddress) || 'ip';
  if (!rateHit('dccreate:' + ip, 15, 10 * 60 * 1000)) return tooMany(10);
  const deviceCode = crypto.randomBytes(24).toString('hex');
  const userCode = dcUserCode();
  kvSet('dc:' + deviceCode, { deviceCode, userCode, status: 'pending', expires: Date.now() + DC_TTL });
  kvSet('dcu:' + userCode, deviceCode);
  return { ok: true, deviceCode, userCode, expiresIn: DC_TTL / 1000, interval: 3 };
}
function handleDcStatus(query) {
  const s = kvGet('dc:' + (query.get('deviceCode') || ''));
  if (!s) return { ok: true, status: 'expired' };
  if (s.expires < Date.now()) { kvDel('dc:' + s.deviceCode); kvDel('dcu:' + s.userCode); return { ok: true, status: 'expired' }; }
  if (s.status !== 'authorized') return { ok: true, status: 'pending', interval: 3 };
  kvDel('dc:' + s.deviceCode); kvDel('dcu:' + s.userCode);
  const token = makeToken();
  kvSet('token:' + token, { phone: s.phone, expires: Date.now() + TOKEN_TTL * 1000 });
  secLog(s.phone, 'device_login', '设备码授权登录（' + s.userCode + '）');
  return { ok: true, status: 'authorized', token, user: publicUser(kvGet('user:' + s.phone)) };
}
function handleDcAuthorize(user, body) {
  const uc = String(body.userCode || '').toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(uc)) return { ok: false, error: '设备码格式不正确' };
  if (!rateHit('dcauth:' + user.phone, 8, 10 * 60 * 1000)) return tooMany(10);
  const dcId = kvGet('dcu:' + uc);
  const s = dcId && kvGet('dc:' + dcId);
  if (!s || s.expires < Date.now()) return { ok: false, error: '设备码不存在或已过期' };
  if (s.status !== 'pending') return { ok: false, error: '该设备码已被使用' };
  s.status = 'authorized'; s.phone = user.phone;
  kvSet('dc:' + s.deviceCode, s);
  secLog(user.phone, 'device_auth', '授权设备码 ' + uc + ' 登录');
  return { ok: true };
}

// ---------- 签名验签（公钥托管，私钥不出本机） ----------
function handleSignUpload(user, body) {
  const jwk = body.publicKeyJwk;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return { ok: false, error: '仅支持 ECDSA P-256 公钥' };
  kvSet('signkey:' + user.phone, { jwk, createdAt: Date.now() });
  secLog(user.phone, 'signkey_set', '更新签名公钥');
  return { ok: true };
}
function handleSignGet(phone) {
  const k = kvGet('signkey:' + phone);
  if (!k) return { ok: false, error: '该用户未注册签名钥匙' };
  return { ok: true, phone, publicKeyJwk: k.jwk, createdAt: k.createdAt };
}

// ---------- 找回密码 ----------
function issueResetToken(phone, via) {
  const resetToken = crypto.randomBytes(24).toString('hex');
  kvSet('pwreset:' + resetToken, { phone, expires: Date.now() + RESET_TTL });
  secLog(phone, 'recover_' + via, '身份验证通过，签发重置票据');
  return resetToken;
}
function handleRecoverMethods(body, req) {
  const phone = String(body.phone || '').trim();
  if (!/^\d{6,15}$/.test(phone)) return { ok: false, error: '手机号格式不正确' };
  if (!rateHit('recm:' + phone, 10, 60 * 60 * 1000)) return tooMany(60);
  secLog(phone, 'recover_methods', '查询可用找回方式');
  return { ok: true, exists: !!kvGet('user:' + phone), passkey: passkeyList(phone).length > 0 };
}
function handleRecoverAdmin(body, req) {
  const phone = String(body.phone || '').trim();
  if (!/^\d{6,15}$/.test(phone)) return { ok: false, error: '手机号格式不正确' };
  if (!rateHit('reca:' + phone, 5, 15 * 60 * 1000)) return tooMany(15);
  if (body.adminKey !== ADMIN_KEY) { secLog(phone, 'recover_admin_fail', '管理员密钥错误'); return { ok: false, error: '管理员密钥错误' }; }
  if (!kvGet('user:' + phone)) return { ok: false, error: '该手机号未注册' };
  return { ok: true, resetToken: issueResetToken(phone, 'admin') };
}
function handleRecoverConfirm(body) {
  const t = kvGet('pwreset:' + String(body.resetToken || ''));
  if (!t || t.expires < Date.now()) { if (t) kvDel('pwreset:' + body.resetToken); return { ok: false, error: '重置票据已过期，请重新验证' }; }
  if (!rateHit('recc:' + t.phone, 5, 15 * 60 * 1000)) return tooMany(15);
  if (!passwordOk(body.newPassword)) return { ok: false, error: '密码至少8位，需同时包含字母和数字' };
  const user = kvGet('user:' + t.phone);
  if (!user) return { ok: false, error: '账号不存在' };
  user.passHash = pbkdf2Hash(body.newPassword, user.passSalt);
  kvSet('user:' + t.phone, user);
  // 逐出全部旧会话（所有设备强制重新登录）
  for (const k of Object.keys(KV)) {
    if (!k.startsWith('token:')) continue;
    try { const v = JSON.parse(KV[k]); if (v.phone === t.phone) delete KV[k]; } catch {}
  }
  kvDel('pwreset:' + body.resetToken);
  rateClear('login:' + t.phone);
  secLog(t.phone, 'password_reset', '密码重置成功，已下线全部设备');
  return { ok: true };
}
