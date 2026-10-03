/* Stating · auth */
'use strict';

/* ============================================================
   5 · 认证：登录 / 注册
   ============================================================ */
const AVATARS = ['😀', '😎', '🥳', '🤠', '🦊', '🐱', '🐼', '🐸', '🐵', '🦄', '🐝', '🌟'];
let regAvatar = '😀';

function buildAvatarPick(container) {
  container.innerHTML = AVATARS.map(a =>
    `<button type="button" class="avatar-opt ${a === regAvatar ? 'is-active' : ''}" data-a="${a}">${a}</button>`).join('');
  container.querySelectorAll('.avatar-opt').forEach(b => b.addEventListener('click', () => {
    regAvatar = b.dataset.a;
    container.querySelectorAll('.avatar-opt').forEach(x => x.classList.toggle('is-active', x === b));
  }));
}

function setAuthMode(mode) {
  const login = mode === 'login';
  $('#tabLogin').classList.toggle('is-active', login);
  $('#tabRegister').classList.toggle('is-active', !login);
  $('#tabLogin').setAttribute('aria-selected', login);
  $('#tabRegister').setAttribute('aria-selected', !login);
  $('#loginForm').hidden = !login;
  $('#registerForm').hidden = login;
}

/* 管理员密钥输入框：手机号为管理员号时显示 */
function watchAdminKey(form) {
  const phone = form.querySelector('[name="phone"]');
  const keyBox = form.querySelector('.admin-key');
  phone.addEventListener('input', () => { keyBox.hidden = phone.value.trim() !== '13385387338'; });
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type="submit"]');
  const payload = {
    phone: f.phone.value.trim(),
    password: f.password.value,
    adminKey: f.adminKey.value,
  };
  if (!payload.phone || !payload.password) return toast('请填写手机号和密码', 'error');
  btn.classList.add('is-loading'); btn.textContent = '';
  try {
    const r = await api('login', { method: 'POST', body: payload, auth: false });
    await completeAuth(r.token, r.user);
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.classList.remove('is-loading'); btn.textContent = '登录'; }
}

async function handleRegisterSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type="submit"]');
  const payload = {
    phone: f.phone.value.trim(),
    nickname: f.nickname.value.trim(),
    password: f.password.value,
    email: f.email.value.trim(),
    avatar: regAvatar,
    adminKey: f.adminKey.value,
  };
  if (!payload.phone || !payload.nickname || !payload.password) return toast('请填写完整信息', 'error');
  btn.classList.add('is-loading'); btn.textContent = '';
  try {
    const r = await api('register', { method: 'POST', body: payload, auth: false });
    toast('注册成功', 'success');
    await completeAuth(r.token, r.user);
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.classList.remove('is-loading'); btn.textContent = '创建账号'; }
}

async function completeAuth(token, user) {
  Store.token = token; Store.me = user;
  localStorage.setItem('stating_token', token);
  showApp();
  await bootApp();
}

function logout(clearToken = true) {
  closeSSE();
  Store.token = null; Store.me = null; Store.groups = [];
  if (clearToken) localStorage.removeItem('stating_token');
  closeRoom(false);
  $('#app').hidden = true;
  $('#auth').hidden = false;
}

/* ============================================================
   6 · 导航 / 视图
   ============================================================ */
const NAV_TITLES = { home: 'Stating', chat: '聊天', users: '用户', profile: '我的', feedback: '博采', admin: '管理后台' };

function switchNav(nav) {
  $$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.nav === nav));
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === nav));
  $('#topTitle').textContent = NAV_TITLES[nav] || 'Stating';
  $('#topSub').textContent = '';
  $('#roomBack').hidden = true;
  if (nav === 'home') loadHome();
  if (nav === 'chat') loadChatGate();
  if (nav === 'users') loadUsers();
  if (nav === 'profile') loadProfile();
  if (nav === 'feedback') loadFeedback();
  if (nav === 'admin') loadAdmin();
}

/* ============================================================
   7 · 首页
   ============================================================ */
function greet() {
  const hh = new Date().getHours();
  if (hh >= 5 && hh < 11) return '早上好';
  if (hh >= 11 && hh < 14) return '中午好';
  if (hh >= 14 && hh < 18) return '下午好';
  return '晚上好';
}
async function loadHome() {
  $('#heroGreet').textContent = greet();
  $('#heroName').textContent = Store.me.nickname;
  $('#heroAvatar').textContent = Store.me.avatar;
  await refreshGroups();
  renderGroupRows($('#homeGroups'), Store.groups.slice(0, 5), openRoom);
}

/* ============================================================
   8 · 群列表 / 邀请门 / 创建
   ============================================================ */
async function refreshGroups() {
  const r = await api('my-groups');
  Store.groups = r.groups;
  return r.groups;
}

function groupRowHTML(g) {
  return `<button class="group-row" data-code="${g.code}">
    <span class="row-avatar">${esc(g.avatar)}</span>
    <span class="row-body">
      <span class="row-title">${esc(g.name)}</span>
      <span class="row-sub">邀请码 ${g.code}${g.muted ? ' · 免打扰' : ''}</span>
    </span>
    <span class="row-chevron">${icon('chevron-right')}</span>
  </button>`;
}
function renderGroupRows(container, groups, onClick) {
  if (!groups.length) { container.innerHTML = '<p class="empty-hint">还没有群聊，去创建或加入一个吧</p>'; return; }
  container.innerHTML = groups.map(groupRowHTML).join('');
  container.querySelectorAll('.group-row').forEach(b =>
    b.addEventListener('click', () => onClick(b.dataset.code)));
}

async function loadChatGate() {
  await refreshGroups();
  renderGroupRows($('#gateGroups'), Store.groups, openRoom);
}

async function joinByCode(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) throw new Error('请输入邀请码');
  const r = await api(`groups/${code}/join`, { method: 'POST' });
  await refreshGroups();
  return r.group.code;
}

function createGroupSheet() {
  let avatar = '💬';
  const body = `
    <label class="field"><span class="field-icon">${icon('smiley')}</span>
      <input type="text" id="cgName" placeholder="群聊名称" maxlength="30"></label>
    <label class="field"><span class="field-icon">${icon('hash')}</span>
      <input type="text" id="cgCode" placeholder="自定义邀请码（选填，4–12位）" maxlength="12"></label>
    <div class="avatar-pick member-pick" id="cgAvatars"></div>`;
  const s = openSheet({
    title: '创建群聊', sub: '创建后你将成为群主', body,
    actions: `<button class="btn btn-ghost" data-cancel>取消</button>
              <button class="btn btn-primary" data-ok>创建</button>`,
  });
  const pick = s.el.querySelector('#cgAvatars');
  const opts = ['💬', '🎮', '🎵', '📚', '⚽', '🍜', '🌍', '✨'];
  pick.innerHTML = opts.map(a => `<button type="button" class="avatar-opt ${a === avatar ? 'is-active' : ''}" data-a="${a}">${a}</button>`).join('');
  pick.querySelectorAll('.avatar-opt').forEach(b => b.addEventListener('click', () => {
    avatar = b.dataset.a;
    pick.querySelectorAll('.avatar-opt').forEach(x => x.classList.toggle('is-active', x === b));
  }));
  s.el.querySelector('[data-cancel]').addEventListener('click', s.close);
  s.el.querySelector('[data-ok]').addEventListener('click', async b => {
    const name = s.el.querySelector('#cgName').value.trim();
    const code = s.el.querySelector('#cgCode').value.trim();
    if (!name) return toast('请输入群聊名称', 'error');
    const btn = b.target; btn.classList.add('is-loading'); btn.textContent = '';
    try {
      const r = await api('groups', { method: 'POST', body: { name, code, avatar } });
      await refreshGroups();
      s.close();
      switchNav('chat');
      openRoom(r.group.code);
    } catch (err) { toast(err.message, 'error'); btn.classList.remove('is-loading'); btn.textContent = '创建'; }
  });
}
