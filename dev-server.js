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

// 工具
function hashPassword(pw, salt) {
  return crypto.createHash('sha256').update(pw + ':' + salt).digest('base64');
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
  if (password.length < 4) return { ok: false, error: '密码至少4位' };
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
  const user = kvGet('user:' + phone);
  if (!user) return { ok: false, error: '该手机号未注册' };
  if (hashPassword(password, user.passSalt) !== user.passHash) return { ok: false, error: '密码错误' };
  const token = makeToken();
  kvSet('token:' + token, { phone, expires: Date.now() + TOKEN_TTL * 1000 });
  return { ok: true, token, user: publicUser(user) };
}

function authUser(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  const data = kvGet('token:' + auth.slice(7));
  if (!data || data.expires < Date.now()) return null;
  return kvGet('user:' + data.phone);
}

async function handleAPI(req, parts, body, url) {
  if (parts[0] === 'register' && req.method === 'POST') return handleRegister(body);
  if (parts[0] === 'login' && req.method === 'POST') return handleLogin(body);

  const user = authUser(req);
  if (!user) return { status: 401, ok: false, error: '未登录或登录已过期' };

  try {
    if (parts[0] === 'me') return { ok: true, user: publicUser(user) };

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
    res.writeHead(result.status || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => console.log('Stating dev server running at http://localhost:' + PORT));
