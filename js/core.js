/* Stating · core */
'use strict';

/* ============================================================
   1 · 基础工具
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function h(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function icon(name) {
  return `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(n => { n.innerHTML = icon(n.dataset.icon); });
}

/* 时间 */
const pad2 = n => String(n).padStart(2, '0');
function clock(ts) { const d = new Date(ts); return ` ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`; }
function dateLabel(ts) {
  const d = new Date(ts), now = new Date();
  const today = dayKey(now), yest = dayKey(now.getTime() - 86400000), k = dayKey(ts);
  if (k === today) return '今天';
  if (k === yest) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return dateLabel(ts);
}
function fmtDur(sec) { sec = Math.round(sec || 0); return `${Math.floor(sec / 60)}:${pad2(sec % 60)}`; }

/* ============================================================
   2 · Toast
   ============================================================ */
function toast(msg, type = '') {
  const t = h('div', `toast ${type}`);
  t.innerHTML = (type === 'success' ? icon('check') : type === 'error' ? icon('info') : '') + `<span>${esc(msg)}</span>`;
  $('#toastRoot').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; t.style.transition = 'all .2s'; }, 2200);
  setTimeout(() => t.remove(), 2500);
}

/* ============================================================
   3 · Sheet / Dialog 系统
   ============================================================ */
function openSheet({ title, sub = '', body = '', actions = '', onMount, dismissable = true, cls = '' }) {
  const overlay = h('div', 'overlay ' + cls);
  const scrim = h('div', 'scrim');
  const sheet = h('div', 'sheet glass glass-strong');
  sheet.innerHTML =
    (title ? `<div class="grabber"></div><div class="sheet-title">${esc(title)}</div>` : '') +
    (sub ? `<div class="sheet-sub">${esc(sub)}</div>` : '') +
    `<div class="sheet-body">${body}</div>` +
    (actions ? `<div class="sheet-actions">${actions}</div>` : '');
  overlay.append(scrim, sheet);
  $('#overlayRoot').appendChild(overlay);
  hydrateIcons(sheet);

  const close = () => {
    if (overlay.classList.contains('closing')) return;
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 190);
  };
  if (dismissable) scrim.addEventListener('click', close);
  const api = { close, el: sheet, overlay };
  if (onMount) onMount(api);
  return api;
}
function confirmDialog(title, sub, dangerLabel = '确定') {
  return new Promise(resolve => {
    const s = openSheet({
      title, sub,
      actions:
        `<button class="btn btn-ghost" data-cancel>取消</button>
         <button class="btn btn-primary" data-ok>${esc(dangerLabel)}</button>`,
    });
    s.el.querySelector('[data-cancel]').addEventListener('click', () => { s.close(); resolve(false); });
    s.el.querySelector('[data-ok]').addEventListener('click', () => { s.close(); resolve(true); });
  });
}

/* ============================================================
   4 · API 客户端
   ============================================================ */
const Store = {
  token: null, me: null, groups: [],
  activeCode: null,
  room: { group: null, messages: [], presence: {}, readStatus: {} },
  es: null, esSince: 0,
  replyTo: null, myReacts: new Set(),
  rating: 0, notify: true,
};

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && Store.token) headers.Authorization = 'Bearer ' + Store.token;
  const res = await fetch('/api/' + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { throw new Error('服务器响应异常'); }
  if (!data.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}
