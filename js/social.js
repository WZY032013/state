/* Stating · social */
'use strict';

/* ============================================================
   15 · 用户目录 / 用户名片
   ============================================================ */
let directory = [];
async function loadUsers() {
  const list = $('#userList');
  list.innerHTML = '<p class="empty-hint">加载中…</p>';
  directory = [];
  try {
    if (Store.me.isAdmin) {
      directory = (await api('users')).users.map(u => ({ ...u, online: u.online }));
    } else {
      // 聚合我所在群的成员
      if (!Store.groups.length) await refreshGroups();
      const map = new Map();
      for (const g of Store.groups) {
        const ms = (await api(`groups/${g.code}/members`)).members;
        ms.forEach(m => { if (!map.has(m.phone)) map.set(m.phone, { phone: m.phone, nickname: m.nickname, avatar: m.avatar, online: m.online, lastSeen: m.lastSeen }); });
      }
      directory = [...map.values()];
    }
    paintDirectory(directory);
  } catch (err) { list.innerHTML = `<p class="empty-hint">${esc(err.message)}</p>`; }
}
function paintDirectory(users) {
  const list = $('#userList');
  if (!users.length) { list.innerHTML = '<p class="empty-hint">暂未发现其他用户，先加入群聊吧</p>'; return; }
  users.sort((a, b) => (b.online - a.online));
  list.innerHTML = users.map(u => `
    <button class="user-row" data-phone="${u.phone}">
      <span class="row-avatar">${esc(u.avatar)}</span>
      <span class="row-body">
        <span class="row-title">${esc(u.nickname)}${u.isAdmin ? ` <span class="admin-tag">管理员</span>` : ''}</span>
        <span class="row-sub"><span class="online-dot ${u.online ? 'on' : ''}"></span>${u.online ? '在线' : relTime(u.lastSeen)}</span>
      </span>
      <span class="row-chevron">${icon('chevron-right')}</span>
    </button>`).join('');
  list.querySelectorAll('.user-row').forEach(b =>
    b.addEventListener('click', () => userCard(b.dataset.phone)));
}
async function userCard(phone) {
  try {
    const r = await api(`users/${phone}`);
    let p = r.profile;
    if (!p && Array.isArray(r.users)) p = r.users.find(u => u.phone === phone);
    if (!p) throw new Error('未找到该用户');
    p.groupCount = p.groupCount ?? (p.joinedGroups ? p.joinedGroups.length : 0);
    p.groups = p.groups || [];
    if (p.email === '无') p.email = '';
    const body = `
      <div class="details-head">
        <span class="details-avatar" style="width:56px;height:56px;font-size:30px">${esc(p.avatar)}</span>
        <div><div class="details-name">${esc(p.nickname)}</div><div class="details-code tabular">${esc(p.phone)}</div></div>
      </div>
      <div class="sheet-row"><span class="sr-icon">${icon('mail')}</span>${esc(p.email || '未填写')}</div>
      <div class="sheet-row"><span class="sr-icon">${icon('users')}</span>加入了 ${p.groupCount} 个群</div>
      ${p.groups.length ? `<div class="member-rows">${p.groups.map(g =>
        `<div class="member-line"><span class="row-avatar" style="width:36px;height:36px;font-size:19px">${esc(g.avatar)}</span>
          <span class="row-body"><span class="row-title">${esc(g.name)}</span><span class="row-sub">${g.code}${g.isOwner ? ' · 群主' : ''}</span></span></div>`).join('')}</div>` : ''}
      ${Store.me.isAdmin && phone !== Store.me.phone ? `<button class="btn btn-ghost" id="cardDelete" style="color:var(--danger)">删除该用户</button>` : ''}`;
    const s = openSheet({ title: '用户名片', body });
    const del = s.el.querySelector('#cardDelete');
    if (del) del.addEventListener('click', async () => {
      const ok = await confirmDialog('删除用户', '该用户及其所有会话将被删除。', '删除');
      if (!ok) return;
      await api(`admin/users/${phone}`, { method: 'DELETE' });
      s.close(); loadUsers(); toast('用户已删除', 'success');
    });
  } catch (err) { toast(err.message, 'error'); }
}

/* ============================================================
   16 · 我的：资料 / 深色 / 通知 / 退出 / 注销
   ============================================================ */
function loadProfile() {
  const u = Store.me;
  $('#profileAvatar').textContent = u.avatar;
  $('#profileName').textContent = u.nickname;
  $('#profilePhone').textContent = u.phone;
  $('#tabAvatar').textContent = u.avatar;
  $('#swDark').checked = document.body.classList.contains('dark');
  $('#adminEntry').hidden = !u.isAdmin;
}
function editProfileSheet() {
  const u = Store.me;
  let avatar = u.avatar;
  const body = `
    <div class="avatar-pick member-pick" id="epAvatars"></div>
    <label class="field"><span class="field-icon">${icon('smiley')}</span><input type="text" id="epNick" value="${esc(u.nickname)}" maxlength="20"></label>
    <label class="field"><span class="field-icon">${icon('mail')}</span><input type="email" id="epEmail" value="${esc(u.email === '无' ? '' : u.email)}"></label>`;
  const s = openSheet({
    title: '编辑资料', body,
    actions: `<button class="btn btn-ghost" data-cancel>取消</button>
              <button class="btn btn-primary" data-save>保存</button>`,
  });
  const pick = s.el.querySelector('#epAvatars');
  pick.innerHTML = AVATARS.map(a => `<button type="button" class="avatar-opt ${a === avatar ? 'is-active' : ''}" data-a="${a}">${a}</button>`).join('');
  pick.querySelectorAll('.avatar-opt').forEach(b => b.addEventListener('click', () => {
    avatar = b.dataset.a; pick.querySelectorAll('.avatar-opt').forEach(x => x.classList.toggle('is-active', x === b));
  }));
  s.el.querySelector('[data-cancel]').addEventListener('click', s.close);
  s.el.querySelector('[data-save]').addEventListener('click', async () => {
    const nickname = s.el.querySelector('#epNick').value.trim();
    const email = s.el.querySelector('#epEmail').value.trim();
    if (!nickname) return toast('昵称不能为空', 'error');
    try {
      const r = await api('profile', { method: 'PATCH', body: { nickname, email, avatar } });
      Store.me = r.user;
      loadProfile();
      s.close(); toast('已保存', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

function toggleDark(on) {
  document.body.classList.toggle('dark', on);
  localStorage.setItem('stating_dark', on ? '1' : '0');
}

/* ============================================================
   17 · 博采 / 反馈
   ============================================================ */
async function loadFeedback() {
  setupStars();
  try {
    const r = await api('feedback');
    $('#ratingAvg').textContent = r.avg ? `平均 ${r.avg} 分` : '';
    paintFeedback(r.list, r.isAdmin);
  } catch (err) { toast(err.message, 'error'); }
}
function setupStars() {
  const box = $('#rateStars');
  Store.rating = 0;
  box.innerHTML = [1, 2, 3, 4, 5].map(i => `<button class="star-btn" data-i="${i}" role="radio" aria-label="${i}星">${icon('star')}</button>`).join('');
  const paint = n => box.querySelectorAll('.star-btn').forEach(b => {
    const on = +b.dataset.i <= n;
    b.classList.toggle('on', on); b.innerHTML = icon(on ? 'star-fill' : 'star');
  });
  box.querySelectorAll('.star-btn').forEach(b => {
    b.addEventListener('click', () => { Store.rating = +b.dataset.i; paint(Store.rating); });
  });
}
function paintFeedback(list, isAdmin) {
  const box = $('#feedbackList');
  if (!list.length) { box.innerHTML = '<p class="empty-hint">还没有博采，来抢沙发</p>'; return; }
  box.innerHTML = list.map(f => `
    <div class="feedback-item" data-id="${f.id}">
      <span class="fb-avatar">${esc(f.avatar)}</span>
      <span class="fb-body">
        <span class="fb-top"><span class="fb-name">${esc(f.nickname)}</span>
          <span class="fb-stars">${Array.from({ length: 5 }, (_, i) => icon(i < f.rating ? 'star-fill' : 'star')).join('')}</span>
          <span class="fb-time">${relTime(f.ts)}</span></span>
        ${f.content ? `<p class="fb-content">${esc(f.content)}</p>` : ''}
        ${(f.replies || []).map(rp => `<div class="fb-reply"><b>官方：</b>${esc(rp.content)}</div>`).join('')}
        ${isAdmin ? `<input class="reply-input" placeholder="官方回复…" maxlength="200">` : ''}
      </span>
    </div>`).join('');
  hydrateIcons(box);
  if (isAdmin) box.querySelectorAll('.feedback-item').forEach(item => {
    const input = item.querySelector('.reply-input');
    input.addEventListener('keydown', async e => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      try {
        await api(`feedback/${item.dataset.id}/reply`, { method: 'POST', body: { content: input.value.trim() } });
        loadFeedback(); toast('已回复', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}
async function submitFeedback() {
  if (!Store.rating) return toast('请先选择评分', 'error');
  const content = $('#feedbackText').value.trim();
  try {
    await api('feedback', { method: 'POST', body: { rating: Store.rating, content } });
    $('#feedbackText').value = ''; setupStars();
    loadFeedback(); toast('感谢你的博采', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

/* ============================================================
   18 · 管理后台
   ============================================================ */
async function loadAdmin() {
  const box = $('#adminList');
  box.innerHTML = '<p class="empty-hint">加载中…</p>';
  try {
    const r = await api('users');
    const users = r.users;
    box.innerHTML = users.map(u => `
      <button class="admin-row" data-phone="${u.phone}">
        <span class="row-avatar">${esc(u.avatar)}</span>
        <span class="row-body">
          <span class="row-title">${esc(u.nickname)} ${u.isAdmin ? '<span class="admin-tag">管理员</span>' : ''}</span>
          <span class="row-sub tabular">${u.phone} · ${u.joinedGroups.length} 群</span>
        </span>
        <span class="online-dot ${u.online ? 'on' : ''}"></span>
      </button>`).join('');
    box.querySelectorAll('.admin-row').forEach(b =>
      b.addEventListener('click', () => adminDetail(b.dataset.phone)));
  } catch (err) { box.innerHTML = `<p class="empty-hint">${esc(err.message)}</p>`; }
}
async function adminDetail(phone) {
  try {
    const r = await api(`admin/users/${phone}/groups`);
    const u = r.user;
    const body = `
      <div class="details-head">
        <span class="details-avatar" style="width:54px;height:54px;font-size:28px">${esc(u.avatar)}</span>
        <div><div class="details-name">${esc(u.nickname)}</div><div class="details-code tabular">${esc(u.phone)}</div></div>
      </div>
      ${r.groups.map(g => `
        <div class="sheet-row"><span class="sr-icon">${icon('group-join')}</span>
          <span class="row-body"><span class="row-title">${esc(g.name)}（${g.code}）</span>
          <span class="row-sub">发言 ${g.msgCount} 条${g.owner === phone ? ' · 群主' : ''}</span></span></button>`).join('') || '<p class="empty-hint">未加入任何群</p>'}
      ${phone !== Store.me.phone ? `<button class="btn btn-ghost" id="adDel" style="color:var(--danger)">删除该用户</button>` : ''}`;
    const s = openSheet({ title: '用户详情', body });
    const del = s.el.querySelector('#adDel');
    if (del) del.addEventListener('click', async () => {
      const ok = await confirmDialog('删除用户', '账号、消息与会话将被删除。', '删除');
      if (!ok) return;
      await api(`admin/users/${phone}`, { method: 'DELETE' });
      s.close(); loadAdmin(); toast('用户已删除', 'success');
    });
  } catch (err) { toast(err.message, 'error'); }
}
