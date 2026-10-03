/* Stating · room */
'use strict';

/* ============================================================
   9 · 房间：打开 / 关闭
   ============================================================ */
async function openRoom(code) {
  code = code.toUpperCase();
  Store.activeCode = code;
  let data;
  try { data = await api(`groups/${code}`); }
  catch (err) { toast(err.message, 'error'); return; }

  Store.room.group = data.group;
  Store.room.messages = (data.messages || []).map(normMessage);
  Store.room.presence = data.presence || {};
  Store.room.readStatus = data.readStatus || {};
  Store.esSince = data.messages.length ? data.messages[data.messages.length - 1].ts : 0;

  document.body.classList.add('room-open');
  $('#room').hidden = false;
  $('#chatGate').hidden = true;
  $('#roomBack').hidden = false;
  $('#topTitle').textContent = data.group.name;
  updateOnlineCount(data.oncomeMembers || data.onlineMembers || {});

  // 公告
  if (data.group.announcement && data.group.announcement.content) {
    $('#announceText').textContent = data.group.announcement.content;
    $('#announceBar').hidden = false;
  } else $('#announceBar').hidden = true;

  // 置顶
  await loadPinnedBar();

  // 渲染消息
  $('#messages').innerHTML = '';
  Store.room.messages.forEach(m => appendMessageNode(m, false));
  scrollToBottom(false);

  connectSSE(code);
}

function closeRoom(backToGate = true) {
  closeSSE();
  document.body.classList.remove('room-open');
  $('#room').hidden = true;
  $('#chatGate').hidden = false;
  Store.activeCode = null;
  $('#msgInput').value = '';
  autoGrow();
  if (backToGate) { loadChatGate(); switchNav('chat'); }
}

function updateOnlineCount(online) {
  const n = Object.keys(online).filter(p => p !== Store.me.phone).length;
  $('#topSub').textContent = n ? `${n} 人在线` : (Store.room.group ? `${Store.room.group.members.length} 名成员` : '');
}
function scrollToBottom(smooth = true) {
  const m = $('#messages');
  m.scrollTo({ top: m.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

/* ============================================================
   10 · 消息节点构建
   ============================================================ */
function findMsg(id) { return Store.room.messages.find(m => m.id === id); }
function isRendered(id) { return !!$('#messages').querySelector(`[data-id="${id}"]`); }

/* 兼容：旧版/本地后端用 text 字段，生产用 content；统一到 content */
function normMessage(m) {
  if (m && m.content === undefined) m.content = m.text;
  return m;
}

function appendMessage(m) {
  normMessage(m);
  Store.esSince = Math.max(Store.esSince, m.ts);
  if (!Store.room.messages.some(x => x.id === m.id)) Store.room.messages.push(m);
  if (isRendered(m.id)) return;
  // 日期分隔
  const prev = Store.room.messages[Store.room.messages.indexOf(m) - 1];
  if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) {
    const d = h('div', 'sys-row');
    d.dataset.date = dayKey(m.ts);
    d.innerHTML = `<span class="sys-pill">${dateLabel(m.ts)}</span>`;
    $('#messages').appendChild(d);
  }
  appendMessageNode(m, true);
}

function appendMessageNode(m, scroll) {
  const mine = m.senderPhone === Store.me.phone;
  const row = h('div', `msg-row ${mine ? 'mine' : 'other'}`);
  row.dataset.id = m.id;

  // 分组：与上一条同发送者且间隔 <5 分钟则紧凑
  const idx = Store.room.messages.indexOf(m);
  const before = Store.room.messages[idx - 1];
  const clustered = before && before.senderPhone === m.senderPhone && (m.ts - before.ts) < 300000;

  let inner;
  if (m.type === 'image') inner = imageBubble(m);
  else if (m.type === 'voice') inner = voiceBubble(m);
  else inner = textBubble(m);

  if (mine) {
    row.innerHTML = `<div class="msg-stack">${inner}${reactionsHTML(m)}</div>`;
  } else {
    row.innerHTML =
      `<span class="msg-avatar" ${clustered ? 'style="visibility:hidden"' : ''}>${esc(m.senderAvatar || '😀')}</span>
       <div class="msg-stack">
         ${clustered ? '' : `<span class="msg-sender">${esc(m.senderNickname || m.senderPhone)}</span>`}
         ${inner}${reactionsHTML(m)}
       </div>`;
  }
  attachBubbleEvents(row, m);
  $('#messages').appendChild(row);
  if (scroll) scrollToBottom();
}

function textBubble(m) {
  return `<div class="bubble">${replyQuote(m)}${linkify(esc(m.content))}${readReceipt(m)}</div>`;
}
function imageBubble(m) {
  return `<div class="bubble bubble-image"><img src="${esc(m.content)}" alt="图片" loading="lazy" referrerpolicy="no-referrer"></div>`;
}
function voiceBubble(m) {
  const bars = seededBars(m.id, 26).map(v => `<i style="height:${v}px"></i>`).join('');
  return `<div class="bubble"><div class="voice-msg" data-url="${esc(m.content)}" data-id="${m.id}">
      <button class="voice-play" aria-label="播放">${icon('play')}</button>
      <span class="voice-bars">${bars}</span>
      <span class="voice-dur">${fmtDur(m.voiceDuration)}</span>
    </div></div>`;
}

function replyQuote(m) {
  if (!m.replyToId) return '';
  const r = findMsg(m.replyToId);
  const name = r ? (r.senderPhone === Store.me.phone ? '你' : (r.senderNickname || '')) : '消息';
  const text = r ? (r.type === 'image' ? '[图片]' : r.type === 'voice' ? '[语音]' : r.content) : '';
  return `<div class="reply-quote"><span class="rq-name">${esc(name)}</span>
    <span class="rq-text">${esc(text)}</span></div>`;
}

function reactionsHTML(m) {
  if (!m.reactions || !m.reactions.length) return '';
  return `<div class="reactions">${m.reactions.map(r =>
    `<span class="reaction-chip ${Store.myReacts.has(m.id + ':' + r.emoji) ? 'is-mine' : ''}">${r.emoji}<span>${r.count}</span></span>`).join('')}</div>`;
}

function readReceipt(m) {
  // 仅自己最新一条文字消息显示已读
  const mineMsgs = Store.room.messages.filter(x => x.senderPhone === Store.me.phone && x.type !== 'voice');
  const last = mineMsgs[mineMsgs.length - 1];
  if (!last || last.id !== m.id) return '';
  const others = Store.room.group.members.filter(p => p !== Store.me.phone);
  const read = others.filter(p => (Store.room.readStatus[p] || 0) >= m.ts).length;
  return read ? `<div class="read-label">已读 ${read}</div>` : '';
}

function linkify(text) {
  return text.replace(/@(\d{6,15})/g, '<span class="mention">@$1</span>')
    .replace(/(https?:\/\/[^\s]+)/g, '<span class="link">$1</span>');
}

/* 确定性伪随机（语音条高度稳定） */
function seededBars(seed, n) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  const out = [];
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; out.push(5 + (s % 20)); }
  return out;
}

/* 气泡交互：长按 / 右键菜单；图片点开；语音播放 */
let currentAudio = null;
function attachBubbleEvents(row, m) {
  const bubble = row.querySelector('.bubble');
  // 图片灯箱
  const img = row.querySelector('.bubble-image img');
  if (img) img.addEventListener('click', () => openImage(m.content));
  // 语音
  const vm = row.querySelector('.voice-msg');
  if (vm) vm.querySelector('.voice-play').addEventListener('click', () => toggleVoice(vm, row));

  if (!bubble) return;
  bubble.style.webkitTouchCallout = 'none';

  let pressTimer = null, moved = false;
  bubble.addEventListener('contextmenu', e => { e.preventDefault(); openMessageActions(m); });
  bubble.addEventListener('touchstart', () => {
    moved = false;
    pressTimer = setTimeout(() => { if (!moved) { navigator.vibrate && navigator.vibrate(12); openMessageActions(m); } }, 480);
  }, { passive: true });
  bubble.addEventListener('touchmove', () => { moved = true; clearTimeout(pressTimer); }, { passive: true });
  bubble.addEventListener('touchend', () => clearTimeout(pressTimer));
}

function toggleVoice(vm, row) {
  const url = vm.dataset.url;
  const playBtn = vm.querySelector('.voice-play');
  if (currentAudio && currentAudio.src === url && !currentAudio.paused) { currentAudio.pause(); return; }
  if (currentAudio) { currentAudio.pause(); currentAudio = null; resetVoiceIcons(); }
  const a = new Audio(url);
  currentAudio = a;
  playBtn.innerHTML = icon('pause');
  a.onended = () => { playBtn.innerHTML = icon('play'); currentAudio = null; };
  a.onerror = () => { toast('语音加载失败', 'error'); playBtn.innerHTML = icon('play'); };
  a.play().catch(() => toast('无法播放语音', 'error'));
}
function resetVoiceIcons() {
  $$('.voice-msg').forEach(v => v.querySelector('.voice-play').innerHTML = icon('play'));
}

function openImage(url) {
  openSheet({
    body: `<div style="text-align:center"><img src="${esc(url)}" style="max-width:100%;border-radius:16px"></div>`,
    cls: 'lightbox-sheet',
  });
}

/* ============================================================
   11 · 消息操作（回应 / 回复 / 复制 / 置顶 / 撤回）
   ============================================================ */
const QUICK_EMOJI = ['❤️', '👍', '👎', '😂', '‼️', '❓'];

function openMessageActions(m) {
  const mine = m.senderPhone === Store.me.phone;
  const isOwner = Store.room.group.owner === Store.me.phone || Store.me.isAdmin;
  const canRecall = mine && Date.now() - m.ts < 120000;
  const body = `
    <div class="react-row" role="group" aria-label="快速回应">
      ${QUICK_EMOJI.map(e => `<button class="react-quick" data-e="${e}">${e}</button>`).join('')}
    </div>
    <button class="sheet-row" data-act="reply"><span class="sr-icon">${icon('reply')}</span>回复</button>
    ${m.type !== 'image' && m.type !== 'voice' ? `<button class="sheet-row" data-act="copy"><span class="sr-icon">${icon('copy')}</span>复制</button>` : ''}
    ${isOwner ? `<button class="sheet-row" data-act="pin"><span class="sr-icon">${icon('pin')}</span>${m.pinned ? '取消置顶' : '置顶'}</button>` : ''}
    ${canRecall ? `<button class="sheet-row danger" data-act="recall"><span class="sr-icon">${icon('recall')}</span>撤回</button>` : ''}`;
  const s = openSheet({ body });

  s.el.querySelectorAll('.react-quick').forEach(b => b.addEventListener('click', () => doReact(m, b.dataset.e, s)));
  s.el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    s.close();
    if (act === 'reply') setReply(m);
    if (act === 'copy') { try { await navigator.clipboard.writeText(m.content); toast('已复制', 'success'); } catch (e) { toast('复制失败', 'error'); } }
    if (act === 'pin') doPin(m);
    if (act === 'recall') doRecall(m);
  }));
}

async function doReact(m, emoji, sheet) {
  const key = m.id + ':' + emoji;
  try {
    const r = await api(`groups/${Store.activeCode}/messages/${m.id}/react`, { method: 'POST', body: { emoji } });
    if (r.reacted) Store.myReacts.add(key); else Store.myReacts.delete(key);
    // 本地更新 reactions
    m.reactions = m.reactions || [];
    const ex = m.reactions.find(x => x.emoji === emoji);
    if (r.reacted) { if (ex) ex.count++; else m.reactions.push({ emoji, count: 1 }); }
    else if (ex) { ex.count--; if (!ex.count) m.reactions = m.reactions.filter(x => x !== ex); }
    refreshMessageNode(m);
    sheet.close();
  } catch (err) { toast(err.message, 'error'); }
}

function refreshMessageNode(m) {
  const old = $('#messages').querySelector(`[data-id="${m.id}"]`);
  if (!old) return;
  const tmp = h('div');
  appendMessageNodeTo(tmp, m);
  const fresh = tmp.firstChild;
  if (fresh) old.replaceWith(fresh);
}
function appendMessageNodeTo(container, m) {
  const mine = m.senderPhone === Store.me.phone;
  const idx = Store.room.messages.indexOf(m);
  const before = Store.room.messages[idx - 1];
  const clustered = before && before.senderPhone === m.senderPhone && (m.ts - before.ts) < 300000;
  const inner = m.type === 'image' ? imageBubble(m) : m.type === 'voice' ? voiceBubble(m) : textBubble(m);
  const row = h('div', `msg-row ${mine ? 'mine' : 'other'}`);
  row.dataset.id = m.id;
  row.innerHTML = mine
    ? `<div class="msg-stack">${inner}${reactionsHTML(m)}</div>`
    : `<span class="msg-avatar" ${clustered ? 'style="visibility:hidden"' : ''}>${esc(m.senderAvatar || '😀')}</span>
       <div class="msg-stack">${clustered ? '' : `<span class="msg-sender">${esc(m.senderNickname || m.senderPhone)}</span>`}${inner}${reactionsHTML(m)}</div>`;
  attachBubbleEvents(row, m);
  container.appendChild(row);
}

function setReply(m) {
  Store.replyTo = m;
  const bar = $('#replyPreview') || makeReplyBar();
  bar.querySelector('.rp-name').textContent = m.senderPhone === Store.me.phone ? '你' : (m.senderNickname || '');
  bar.querySelector('.rp-text').textContent = m.type === 'image' ? '[图片]' : m.type === 'voice' ? '[语音]' : m.content;
  bar.hidden = false;
  $('#msgInput').focus();
}
function makeReplyBar() {
  const bar = h('div', 'reply-preview-bar');
  bar.id = 'replyPreview';
  bar.innerHTML = `<span class="rp-icon">${icon('reply')}</span>
    <span class="rp-body"><span class="rp-name"></span><span class="rp-text"></span></span>
    <button class="rp-cancel" aria-label="取消回复">${icon('xmark')}</button>`;
  bar.querySelector('.rp-cancel').addEventListener('click', () => { Store.replyTo = null; bar.hidden = true; });
  $('#composerSheet').parentNode.insertBefore(bar, $('#composer-sheet') || $('#composerSheet'));
  return bar;
}

async function doPin(m) {
  try {
    await api(`groups/${Store.activeCode}/messages/${m.id}/pin`, { method: 'POST' });
    m.pinned = m.pinned ? 0 : 1;
    await loadPinnedBar();
    toast(m.pinned ? '已置顶' : '已取消置顶', 'success');
  } catch (err) { toast(err.message, 'error'); }
}
async function loadPinnedBar() {
  try {
    const r = await api(`groups/${Store.activeCode}/pinned`);
    const p = r.pinned && r.pinned[r.pinned.length - 1];
    if (p) {
      $('#pinnedContent').textContent = p.type === 'image' ? '[图片]' : p.type === 'voice' ? '[语音]' : p.content;
      $('#pinnedBar').hidden = false;
      $('#pinnedBar').dataset.id = p.id;
    } else $('#pinnedBar').hidden = true;
  } catch (e) { $('#pinnedBar').hidden = true; }
}
async function doRecall(m) {
  try {
    await api(`groups/${Store.activeCode}/messages/${m.id}/recall`, { method: 'POST' });
    Store.room.messages = Store.room.messages.filter(x => x.id !== m.id);
    $('#messages').querySelector(`[data-id="${m.id}"]`)?.remove();
    toast('已撤回', 'success');
  } catch (err) { toast(err.message, 'error'); }
}
