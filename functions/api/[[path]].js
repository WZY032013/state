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

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyData = await crypto.subtle.digest('SHA-256', enc.encode(password + ':' + salt));
  return Array.from(new Uint8Array(keyData), b => b.toString(16).padStart(2, '0')).join('');
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
    'INSERT OR REPLACE INTO users (phone, nickname, avatar, email, passHash, passSalt, joinedGroups, createdAt, bubble_style, focus_start, focus_end) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    user.phone, user.nickname, user.avatar || '😀', user.email || '无',
    user.passHash, user.passSalt,
    JSON.stringify(user.joinedGroups || []), user.createdAt,
    user.bubble_style || '', user.focus_start || '', user.focus_end || ''
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
  if (password.length < 4) return fail('密码至少4位');
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
  const user = await getUser(env, phone);
  if (!user) return fail('用户不存在');
  const passHash = await hashPassword(password, user.passSalt);
  if (passHash !== user.passHash) return fail('密码错误');
  await ensureMediaTable(env);
  const token = await createToken(env, phone);
  return ok({ token, user: publicUser(user) });
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
  const { type, text, content, imageData, voiceData, voiceDuration, fileData, fileName, fileType, fileSize, mediaUrl, location, lat, lng, replyToId } = body;
  const msg = {
    id: makeId(), senderPhone: user.phone, type: type || 'text',
    content: content || text || '', ts: Date.now(), readBy: [user.phone],
    senderNickname: user.nickname, senderAvatar: user.avatar
  };
  if (replyToId) msg.replyToId = replyToId;
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
  } else {
    call.participants.push({ phone: user.phone, nickname: user.nickname, avatar: user.avatar, lastSeen: Date.now() });
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
  const res = await env.DB.prepare('SELECT id, userAgent, createdAt, lastActive FROM sessions WHERE phone = ? ORDER BY lastActive DESC').bind(user.phone).all();
  const currentToken = user._currentToken;
  return ok({ sessions: res.results.map(s => ({ ...s, isCurrent: s.token === currentToken })) });
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
  if (!groupCode) return fail('缺少群聊');
  const existing = await env.DB.prepare('SELECT 1 FROM saved_messages WHERE phone = ? AND msgId = ?').bind(user.phone, msgId).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM saved_messages WHERE phone = ? AND msgId = ?').bind(user.phone, msgId).run();
    return ok({ saved: false });
  }
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

export async function onRequest(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const method = request.method;

    if (!env.DB) return fail('数据库未绑定', 500);

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

    // 认证
    const user = await authUser(env, request);
    if (!user) return fail('未登录', 401);

    // 获取当前用户信息
    if (parts[0] === 'me' && method === 'GET') {
      ensureMediaTable(env).catch(() => {});
      return ok({ user: publicUser(user) });
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
