/* Stating · groups */
'use strict';

/* ============================================================
   14 · 群详情 / 成员 / 群二维码 / 公告 / 编辑 / 设置
   ============================================================ */
function openGroupDetails() {
  const g = Store.room.group;
  const isOwner = g.owner === Store.me.phone || Store.me.isAdmin;
  const body = `
    <div class="details-head">
      <span class="details-avatar">${esc(g.avatar)}</span>
      <div><div class="details-name">${esc(g.name)}</div><div class="details-code">邀请码 ${g.code}</div></div>
    </div>
    <button class="sheet-row" data-go="announce"><span class="sr-icon">${icon('megaphone')}</span>群公告<span class="sr-right">${g.announcement ? '已设置' : ''}</span></button>
    <button class="sheet-row" data-go="members"><span class="sr-icon">${icon('users')}</span>群成员<span class="sr-right">${g.members.length}</span></button>
    <button class="sheet-row" data-go="qr"><span class="sr-icon">${icon('qrcode')}</span>群二维码</button>
    ${isOwner ? `<button class="sheet-row" data-go="edit"><span class="sr-icon">${icon('edit')}</span>编辑群信息</button>` : ''}
    <div class="sheet-row">
      <span class="sr-icon">${icon('bell-slash')}</span>免打扰
      <span class="sr-right"><label class="switch"><input type="checkbox" id="detMute" ${g.userSettings && g.userSettings.muted ? 'checked' : ''}><span class="switch-track"><span class="switch-thumb"></span></span></label></span>
    </div>
    <div class="sheet-row">
      <span class="sr-icon">${icon('pin')}</span>置顶群聊
      <span class="sr-right"><label class="switch"><input type="checkbox" id="detPin" ${g.userSettings && g.userSettings.pinned ? 'checked' : ''}><span class="switch-track"><span class="switch-thumb"></span></span></label></span>
    </div>
    ${isOwner
      ? `<button class="sheet-row danger" data-go="delete"><span class="sr-icon">${icon('trash')}</span>注销群聊</button>`
      : `<button class="sheet-row danger" data-go="leave"><span class="sr-icon">${icon('logout')}</span>退出群聊</button>`}`;
  const s = openSheet({ title: '群资料', body });

  s.el.querySelector('#detMute').addEventListener('change', async e => {
    await api(`groups/${g.code}/settings`, { method: 'POST', body: { muted: e.target.checked } });
    toast(e.target.checked ? '已开启免打扰' : '已关闭免打扰', 'success');
  });
  s.el.querySelector('#detPin').addEventListener('change', async e => {
    await api(`groups/${g.code}/settings`, { method: 'POST', body: { pinned: e.target.checked } });
    await refreshGroups();
    toast(e.target.checked ? '已置顶群聊' : '已取消置顶', 'success');
  });
  s.el.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
    const go = b.dataset.go; s.close();
    if (go === 'announce') announcementSheet();
    if (go === 'members') membersSheet();
    if (go === 'qr') groupQrSheet(g.code);
    if (go === 'edit') editGroupSheet();
    if (go === 'leave') leaveGroup();
    if (go === 'delete') deleteGroup();
  }));
}

async function announcementSheet() {
  const g = Store.room.group;
  const isOwner = g.owner === Store.me.phone || Store.me.isAdmin;
  const cur = g.announcement ? g.announcement.content : '';
  const body = `<textarea class="feedback-input" id="annInput" rows="4" ${isOwner ? '' : 'disabled'} placeholder="群公告…">${esc(cur)}</textarea>`;
  if (!isOwner) return openSheet({ title: '群公告', body });
  const s = openSheet({
    title: '群公告', body,
    actions: `<button class="btn btn-ghost" data-clear>清除</button>
              <button class="btn btn-primary" data-save>保存</button>`,
  });
  s.el.querySelector('[data-clear]').addEventListener('click', async () => {
    await api(`groups/${g.code}/announcement`, { method: 'POST', body: { content: '' } });
    g.announcement = null; $('#announceBar').hidden = true; s.close(); toast('已清除公告', 'success');
  });
  s.el.querySelector('[data-save]').addEventListener('click', async () => {
    const content = s.el.querySelector('#annInput').value.trim();
    if (!content) return toast('公告不能为空', 'error');
    await api(`groups/${g.code}/announcement`, { method: 'POST', body: { content } });
    g.announcement = { content };
    $('#announceText').textContent = content; $('#announceBar').hidden = false;
    s.close(); toast('公告已发布', 'success');
  });
}

async function membersSheet() {
  const code = Store.activeCode;
  const isOwner = Store.room.group.owner === Store.me.phone || Store.me.isAdmin;
  let members;
  try { members = (await api(`groups/${code}/members`)).members; }
  catch (err) { return toast(err.message, 'error'); }
  const body = `<div class="member-rows">${members.map(m => `
    <div class="member-line" data-phone="${m.phone}">
      <span class="row-avatar" style="width:40px;height:40px;font-size:21px">${esc(m.avatar)}</span>
      <span class="row-body">
        <span class="row-title">${esc(m.nickname)} ${m.isOwner ? icon('crown') : ''}</span>
        <span class="row-sub">${m.online ? '在线' : relTime(m.lastSeen)}</span>
      </span>
      ${isOwner && !m.isOwner ? `<button class="icon-btn kick-btn" aria-label="移出群聊" style="color:var(--danger)">${icon('trash')}</button>` : ''}
    </div>`).join('')}</div>`;
  const s = openSheet({ title: `群成员（${members.length}）`, body });
  hydrateIcons(s.el);
  s.el.querySelectorAll('.member-line').forEach(line => {
    const kick = line.querySelector('.kick-btn');
    if (kick) kick.addEventListener('click', async () => {
      const ok = await confirmDialog('移出群聊', `确定将 ${line.querySelector('.row-title').textContent} 移出群聊吗？`, '移出');
      if (!ok) return;
      try {
        await api(`groups/${code}/members/${line.dataset.phone}`, { method: 'DELETE' });
        s.close(); membersSheet();
      } catch (err) { toast(err.message, 'error'); }
    });
    else line.addEventListener('click', () => userCard(line.dataset.phone));
  });
}

async function groupQrSheet(code = Store.activeCode) {
  const body = `
    <div class="qr-stage">
      <div class="qr-box" id="qrBox"><span class="empty-hint">生成中…</span></div>
      <p class="qr-status">邀请码 <b>${code}</b>，扫码即可加入</p>
      <button class="btn btn-ghost" id="saveQr">保存二维码</button>
    </div>`;
  const s = openSheet({ title: '群二维码', body });
  const link = `${location.origin}/?join=${code}`;
  const box = s.el.querySelector('#qrBox');
  await drawQR(box, link);
  s.el.querySelector('#saveQr').addEventListener('click', () => {
    const qr = box._qr;
    if (!qr) return toast('二维码未就绪', 'error');
    const svg = qr.createSvgTag({ cellSize: 6, margin: 2 });
    const a = h('a');
    a.href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    a.download = `stating-${code}.svg`;
    a.click(); toast('已保存', 'success');
  });
}

function editGroupSheet() {
  const g = Store.room.group;
  let avatar = g.avatar;
  const body = `
    <label class="field"><span class="field-icon">${icon('smiley')}</span><input type="text" id="egName" value="${esc(g.name)}" maxlength="30"></label>
    <div class="avatar-pick member-pick" id="egAvatars"></div>`;
  const s = openSheet({
    title: '编辑群信息', body,
    actions: `<button class="btn btn-ghost" data-cancel>取消</button>
              <button class="btn btn-primary" data-save>保存</button>`,
  });
  const opts = ['💬', '🎮', '🎵', '📚', '⚽', '🍜', '🌍', '✨'];
  const pick = s.el.querySelector('#egAvatars');
  pick.innerHTML = opts.map(a => `<button type="button" class="avatar-opt ${a === avatar ? 'is-active' : ''}" data-a="${a}">${a}</button>`).join('');
  pick.querySelectorAll('.avatar-opt').forEach(b => b.addEventListener('click', () => {
    avatar = b.dataset.a; pick.querySelectorAll('.avatar-opt').forEach(x => x.classList.toggle('is-active', x === b));
  }));
  s.el.querySelector('[data-cancel]').addEventListener('click', s.close);
  s.el.querySelector('[data-save]').addEventListener('click', async () => {
    const name = s.el.querySelector('#egName').value.trim();
    try {
      await api(`groups/${g.code}`, { method: 'PATCH', body: { name, avatar } });
      g.name = name; g.avatar = avatar;
      $('#topTitle').textContent = name;
      await refreshGroups();
      s.close(); toast('已保存', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function leaveGroup() {
  const ok = await confirmDialog('退出群聊', '退出后将不再接收该群消息。', '退出');
  if (!ok) return;
  try {
    await api(`groups/${Store.activeCode}/leave`, { method: 'POST' });
    await refreshGroups();
    closeRoom();
    toast('已退出群聊', 'success');
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteGroup() {
  const ok = await confirmDialog('注销群聊', '群聊与全部消息将被永久删除，无法恢复。', '注销');
  if (!ok) return;
  try {
    await api(`groups/${Store.activeCode}/delete`, { method: 'DELETE' });
    await refreshGroups();
    closeRoom();
    toast('群聊已注销', 'success');
  } catch (err) { toast(err.message, 'error'); }
}
