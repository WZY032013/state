/* ============================================================
   Stating · NFC 碰卡登录（Web NFC，Android Chromium）
   - 深链 ?nfclogin=<token> 碰卡打开 → 换 session
   - 登录页按钮：支持则刷卡，不支持显示引导
   - 我的页：写卡 / 卡片管理 / 注销
   ============================================================ */
'use strict';
(function () {
  const support = () => 'NDEFReader' in window && window.isSecureContext;
  const token = () => localStorage.getItem('stating_token');

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch('/api/' + path, {
      method: opts.method || 'GET', headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => { throw new Error('服务器响应异常'); });
    if (!data.ok) throw new Error(data.error || '请求失败');
    return data;
  }

  function sheetRoot() {
    let r = document.getElementById('lgSheetRoot');
    if (!r) { r = document.createElement('div'); r.id = 'lgSheetRoot'; document.body.appendChild(r); }
    return r;
  }
  function toast(msg, type) {
    if (window.LGAuth && LGAuth.toast) return LGAuth.toast(msg, type);
    alert(msg);
  }
  function openSheet({ title = '', bodyHtml = '', actionsHtml = '', onMount }) {
    const root = sheetRoot();
    const ov = document.createElement('div');
    ov.className = 'lg-overlay';
    ov.innerHTML = `<div class="lg-scrim"></div><div class="lg-sheet">
      ${title ? '<div class="lg-grabber"></div><div class="lg-sheet-title">' + title + '</div>' : ''}
      <div class="lg-sheet-body">${bodyHtml}</div>
      ${actionsHtml ? '<div class="lg-sheet-actions">' + actionsHtml + '</div>' : ''}
    </div>`;
    root.appendChild(ov);
    const close = () => { ov.classList.add('closing'); setTimeout(() => ov.remove(), 180); };
    ov.querySelector('.lg-scrim').addEventListener('click', close);
    if (onMount) onMount(ov, close);
    return { el: ov, close };
  }

  /* ---------- 深链碰卡直登 ---------- */
  async function handleDeepLink() {
    const p = new URLSearchParams(location.search);
    const raw = p.get('nfclogin');
    if (!raw) return;
    history.replaceState(null, '', location.pathname);
    try {
      const r = await api('nfc/login', { method: 'POST', body: { token: raw } });
      localStorage.setItem('stating_token', r.token);
      location.reload();
    } catch (e) {
      toast(e.message || 'NFC 登录失败', 'error');
    }
  }

  /* ---------- 登录页 NFC 流程 ---------- */
  function extractToken(message) {
    for (const rec of message.records || []) {
      if (rec.recordType === 'url') {
        try {
          const u = new URL(new TextDecoder().decode(rec.data));
          const t = new URLSearchParams(u.search).get('nfclogin');
          if (t) return t;
        } catch {}
      } else if (rec.recordType === 'text' || rec.recordType === 'mime') {
        try {
          const m = new TextDecoder().decode(rec.data).match(/nfclogin=([A-Za-z0-9_]+)/);
          if (m) return m[1];
        } catch {}
      }
    }
    return null;
  }

  async function tapToLoginSheet() {
    if (!support()) return guideSheet();
    let aborted = false;
    const s = openSheet({
      title: 'NFC 碰卡登录',
      bodyHtml: `<p class="lg-form-hint" style="margin:0;font-size:14px">请将 NFC 登录卡贴近手机背部…</p><div class="lg-qr-stage"><div class="bio-spinner" style="border-color:rgba(10,132,255,.2);border-top-color:#0a84ff"></div></div>`,
      actionsHtml: '<button type="button" class="lg-btn lg-btn-ghost" data-c>取消</button>',
      onMount: (ov, close) => ov.querySelector('[data-c]').addEventListener('click', () => { aborted = true; try { ac.abort(); } catch {} close(); }),
    });
    const ac = new AbortController();
    try {
      const ndef = new NDEFReader();
      await ndef.scan({ signal: ac.signal });
      ndef.onreading = async ev => {
        const raw = extractToken(ev.message);
        if (!raw) return;
        try {
          const r = await api('nfc/login', { method: 'POST', body: { token: raw } });
          localStorage.setItem('stating_token', r.token);
          location.reload();
        } catch (e) { s.close(); toast(e.message, 'error'); }
      };
      ndef.onreadingerror = () => {};
    } catch (e) {
      if (!aborted) { s.close(); toast('未能启动 NFC：' + (e.message || '请确认系统 NFC 已开启'), 'error'); }
    }
  }

  function guideSheet() {
    openSheet({
      title: 'NFC 碰卡登录',
      bodyHtml: `
        <p class="lg-form-hint" style="margin:0;font-size:14px;line-height:1.7">
        ① 此功能需在 <b>Android 手机的 Edge / Chrome</b> 中使用（电脑与 iPhone 浏览器不支持网页 NFC）。<br>
        ② 在手机浏览器登录后，于「我的 → NFC 登录卡」把登录凭证写入一张 NFC 标签卡。<br>
        ③ 之后用手机碰一下卡片即可自动登录。<br>
        电脑端请使用「扫码登录」或「密码登录」。</p>`,
      actionsHtml: '<button type="button" class="lg-btn lg-btn-primary" data-ok>我知道了</button>',
      onMount: (ov, close) => ov.querySelector('[data-ok]').addEventListener('click', close),
    });
  }

  /* ---------- 我的页：写卡 / 管理 ---------- */
  async function writeTag(url) {
    const ndef = new NDEFReader();
    await ndef.write({ records: [{ recordType: 'url', data: url }] });
  }

  function manageSheet() {
    if (!support()) return guideSheet();
    openSheet({
      title: 'NFC 登录卡',
      bodyHtml: '<p class="lg-hint">加载中…</p>',
      actionsHtml: '<button type="button" class="lg-btn lg-btn-ghost" data-c>关闭</button><button type="button" class="lg-btn lg-btn-primary" data-add>写新卡</button>',
      onMount: async (ov, close) => {
        ov.querySelector('[data-c]').addEventListener('click', close);
        const body = ov.querySelector('.lg-sheet-body');
        let cards = [];
        const paint = () => {
          body.innerHTML = cards.length
            ? cards.map(c => `<div class="lg-field" style="justify-content:space-between"><span style="font-size:14px">${c.label || 'NFC 登录卡'}<br><small style="color:var(--lg-ink-3)">${c.lastUsed ? '最近使用 ' + new Date(c.lastUsed).toLocaleDateString() : '未使用'}</small></span><span><button type="button" class="lg-btn-text" data-write="${encodeURIComponent(c.id)}">重写</button><button type="button" class="lg-btn-text" style="color:#ff3b30" data-del="${encodeURIComponent(c.id)}">注销</button></span></div>`).join('')
            : '<p class="lg-form-hint" style="margin:0">还没有登录卡，点击下方「写新卡」生成并贴近 NFC 标签写入</p>';
          body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
            const id = decodeURIComponent(b.dataset.del);
            await api('nfc/revoke', { method: 'POST', body: { token: id } });
            cards = (await api('nfc')).cards || []; paint();
            toast('已注销', 'success');
          }));
          body.querySelectorAll('[data-write]').forEach(b => b.addEventListener('click', async () => {
            const id = decodeURIComponent(b.dataset.write);
            const url = location.origin + '/?nfclogin=' + id;
            toast('请贴近 NFC 标签…');
            try { await writeTag(url); toast('写入成功', 'success'); }
            catch (e) { toast('写入失败：' + (e.message || '请确认标签可用'), 'error'); }
          }));
        };
        try { cards = (await api('nfc')).cards || []; paint(); } catch (e) { body.innerHTML = '<p class="lg-form-hint" style="color:#ff3b30;margin:0">' + e.message + '</p>'; }
        ov.querySelector('[data-add]').addEventListener('click', async () => {
          const btn = ov.querySelector('[data-add]');
          btn.classList.add('is-loading'); const old = btn.textContent; btn.textContent = '';
          try {
            const r = await api('nfc/enroll', { method: 'POST', body: { label: 'NFC 登录卡' } });
            toast('请贴近 NFC 标签…');
            await writeTag(r.url);
            cards = (await api('nfc')).cards || []; paint();
            toast('写卡成功', 'success');
          } catch (e) {
            toast(e.message || '写卡失败', 'error');
          } finally { btn.classList.remove('is-loading'); btn.textContent = old; }
        });
      },
    });
  }

  function injectProfile() {
    const pv = document.getElementById('profileView');
    if (!pv || document.getElementById('nfcManageBtn')) return;
    const btn = document.createElement('button');
    btn.className = 'btn-sessions';
    btn.id = 'nfcManageBtn';
    btn.textContent = 'NFC 登录卡';
    const anchor = document.getElementById('bioManageBtn') || document.getElementById('sessionsBtn');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    else pv.appendChild(btn);
    btn.addEventListener('click', manageSheet);
  }

  document.addEventListener('DOMContentLoaded', () => {
    handleDeepLink();
    const nfcBtn = document.getElementById('lgNfcBtn');
    if (nfcBtn) nfcBtn.addEventListener('click', tapToLoginSheet);
    injectProfile();
    new MutationObserver(injectProfile).observe(document.body, { childList: true, subtree: false });
  });

  window.LGNfc = { support, manageSheet, tapToLoginSheet };
})();
