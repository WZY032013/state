/* ============================================================
   Stating · 新版登录页适配（与老版单体 script.js 共存）
   入口：#auth（lg- 命名空间隔离样式与图标）
   成功后写入老版全局 token(d)/用户(P) 并调用老版 Be()
   ============================================================ */
'use strict';
(function () {
  /* ---------- 自有 SF 风格图标（data-lgicon），不与老 data-icon 冲突 ---------- */
  const LG_ICONS = {
    chat: '<path d="M5.2 4.6h13.6A2.4 2.4 0 0 1 21.2 7v7.2a2.4 2.4 0 0 1-2.4 2.4H10l-4.6 3.6v-3.6H5.2A2.4 2.4 0 0 1 2.8 14.2V7a2.4 2.4 0 0 1 2.4-2.4Z"/>',
    phone: '<path d="M6.8 3.2h2.8l1.4 3.6-1.8 1.5c1 1.8 2.5 3.3 4.3 4.3l1.5-1.8 3.6 1.4v2.9c0 1-.8 1.9-1.9 1.9C9.8 17 6.6 13.8 4.9 6.9c-.5-1.7.7-3 1.9-3.7Z"/>',
    lock: '<path d="M7.6 10.8h8.8v8.4H7.6ZM9.8 10.8V8.4a2.2 2.2 0 0 1 4.4 0v2.4"/>',
    key: '<path d="M9.6 14.8a3.2 3.2 0 1 1 2.2 1l1-1 2.4 2.4M15.2 11.4l2-2M17.2 9.4l1.4 1.4"/>',
    smiley: '<path d="M12 3.8a8.2 8.2 0 1 0 .02 0M8.9 9.9h.05M15.1 9.9h.05M9.1 14.3c.8.9 1.8 1.4 2.9 1.4s2.1-.5 2.9-1.4"/>',
    mail: '<path d="M4 6.6h16v10.8H4ZM4.6 7.4 12 13l7.4-5.6"/>',
    qrcode: '<path d="M4.6 4.6H9v4.4H4.6ZM15 4.6h4.4V9H15ZM4.6 15H9v4.4H4.6ZM14.8 14.8h1.8v1.8h-1.8ZM18 14.8h1.4v1.4H18ZM14.8 18h1.4v1.4h-1.4ZM18 18h1.4v1.4H18ZM11 11h.05"/>',
    nfc: '<path d="M6.5 18.5a9 9 0 0 1 0-13M9.5 15.5a5 5 0 0 1 0-7M12 20.2a2.2 2.2 0 0 0 2.2-2.2V6a2.2 2.2 0 0 0-4.4 0v12c0 1.2 1 2.2 2.2 2.2ZM17.5 15.5a5 5 0 0 0 0-7"/>',
  };
  const svg = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${LG_ICONS[n] || ''}</svg>`;
  const hydrate = root => root.querySelectorAll('[data-lgicon]').forEach(el => { el.innerHTML = svg(el.dataset.lgicon); });

  /* ---------- 工具 ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const AVATARS = ['😀', '😎', '🥳', '🤠', '🦊', '🐱', '🐼', '🐸', '🐵', '🦄', '🐝', '🌟'];
  let regAvatar = '😀';

  function toast(msg, type) {
    const t = document.createElement('div');
    t.className = 'lg-toast ' + (type || '');
    t.textContent = msg;
    $('#lgSheetRoot').appendChild(t);
    setTimeout(() => { t.classList.add('out'); }, 2200);
    setTimeout(() => t.remove(), 2500);
  }

  async function api(path, opts = {}) {
    const headers = {};
    if (opts.body) headers['Content-Type'] = 'application/json';
    const token = localStorage.getItem('stating_token');
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch('/api/' + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => { throw new Error('服务器响应异常'); });
    if (!data.ok) throw new Error(data.error || '请求失败（' + res.status + '）');
    return data;
  }

  /* 老版业务逻辑封在 IIFE 闭包内（外部不可达），登录成功写 token 后刷新，
     由老脚本自身的 token 引导完成 /me 校验并进应用（无效则回到登录页） */
  async function enterApp(token) {
    localStorage.setItem('stating_token', token);
    location.reload();
  }

  /* ---------- Sheet ---------- */
  function openSheet({ title = '', bodyHtml = '', actionsHtml = '', onMount }) {
    const root = $('#lgSheetRoot');
    const ov = document.createElement('div');
    ov.className = 'lg-overlay';
    ov.innerHTML = `<div class="lg-scrim"></div><div class="lg-sheet">
      ${title ? '<div class="lg-grabber"></div><div class="lg-sheet-title">' + esc(title) + '</div>' : ''}
      <div class="lg-sheet-body">${bodyHtml}</div>
      ${actionsHtml ? '<div class="lg-sheet-actions">' + actionsHtml + '</div>' : ''}
    </div>`;
    root.appendChild(ov);
    hydrate(ov);
    ov.querySelector('.lg-scrim').addEventListener('click', () => close());
    function close() { ov.classList.add('closing'); setTimeout(() => ov.remove(), 180); }
    if (onMount) onMount(ov, close);
    return { el: ov, close };
  }

  /* ---------- 二维码 ---------- */
  const libCache = {};
  function loadLib(src) {
    if (libCache[src]) return libCache[src];
    libCache[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('组件加载失败'));
      document.body.appendChild(s);
    });
    return libCache[src];
  }
  async function drawQR(box, text) {
    await loadLib('lib/qrcode/qrcode.min.js');
    const Q = window.qrcode || window.QRCode;
    const gen = typeof Q === 'function' ? Q(0, 'M') : null;
    if (gen && gen.addData && gen.createSvgTag) {
      gen.addData(text); gen.make && gen.make();
      box.innerHTML = gen.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
      const svgEl = box.querySelector('svg');
      if (svgEl) { svgEl.setAttribute('width', '200'); svgEl.setAttribute('height', '200'); svgEl.style.cssText = 'width:200px;height:200px;display:block'; }
      box._qr = gen;
    } else if (window.QRCode && QRCode.toCanvas) {
      const cv = document.createElement('canvas');
      await new Promise((ok, no) => QRCode.toCanvas(cv, text, { width: 200, margin: 1 }, e => e ? no(e) : ok()));
      box.appendChild(cv);
    } else throw new Error('二维码组件不可用');
  }

  /* ---------- 扫码登录（PC 展示码，手机扫后确认） ---------- */
  function qrLoginSheet() {
    let poll = null, qrId = null;
    const s = openSheet({
      title: '扫码登录',
      bodyHtml: `<div class="lg-qr-stage"><div class="lg-qr-box" id="lgQrBox"><span class="lg-hint">生成中…</span></div>
        <p class="lg-qr-status" id="lgQrStatus">使用已登录的手机扫一扫</p>
        <button type="button" class="lg-btn lg-btn-ghost" id="lgQrRefresh" hidden>刷新二维码</button></div>`,
      onMount: start,
    });
    async function start() {
      try {
        const r = await api('qrlogin/create', { method: 'POST' });
        qrId = r.qrId;
        await drawQR(s.el.querySelector('#lgQrBox'), qrId);
        s.el.querySelector('#lgQrStatus').textContent = '等待扫码…';
        poll = setInterval(check, 2000);
      } catch (err) { s.el.querySelector('#lgQrStatus').textContent = err.message; }
    }
    async function check() {
      try {
        const r = await api('qrlogin/status?qrId=' + encodeURIComponent(qrId));
        const stEl = s.el.querySelector('#lgQrStatus');
        if (r.status === 'scanned') stEl.textContent = '已扫描' + (r.scanner ? '（' + r.scanner.nickname + '）' : '') + '，请在手机确认';
        else if (r.status === 'expired') { clearInterval(poll); stEl.textContent = '二维码已过期'; s.el.querySelector('#lgQrRefresh').hidden = false; }
        else if (r.status === 'confirmed') { clearInterval(poll); s.close(); await enterApp(r.token, r.user); }
      } catch (e) {}
    }
    s.el.addEventListener('click', e => { if (e.target.id === 'lgQrRefresh') { e.target.hidden = true; start(); } });
    const origClose = s.close;
    s.close = () => { clearInterval(poll); origClose(); };
  }

  /* ---------- 忘记密码 ---------- */
  function forgotSheet() {
    openSheet({
      title: '重置密码',
      bodyHtml: `
        <label class="lg-field"><span class="lg-field-ic" data-lgicon="phone"></span><input type="tel" id="lgFpPhone" placeholder="手机号" maxlength="15"></label>
        <label class="lg-field"><span class="lg-field-ic" data-lgicon="key"></span><input type="password" id="lgFpKey" placeholder="管理员密钥"></label>
        <label class="lg-field"><span class="lg-field-ic" data-lgicon="lock"></span><input type="password" id="lgFpNew" placeholder="新密码（≥8位，含字母和数字）" maxlength="64"></label>
        <p class="lg-form-hint">密码重置需管理员密钥；重置后所有设备需重新登录。</p>`,
      actionsHtml: '<button type="button" class="lg-btn lg-btn-ghost" data-c>取消</button><button type="button" class="lg-btn lg-btn-primary" data-ok>重置</button>',
      onMount: (ov, close) => {
        ov.querySelector('[data-c]').addEventListener('click', close);
        ov.querySelector('[data-ok]').addEventListener('click', async () => {
          const phone = ov.querySelector('#lgFpPhone').value.trim();
          const adminKey = ov.querySelector('#lgFpKey').value;
          const newPassword = ov.querySelector('#lgFpNew').value;
          try {
            const a = await api('recover/admin', { method: 'POST', body: { phone, adminKey } });
            await api('recover/confirm', { method: 'POST', body: { resetToken: a.resetToken, newPassword } });
            close(); toast('密码已重置，请登录', 'success');
          } catch (err) { toast(err.message, 'error'); }
        });
      },
    });
  }

  /* ---------- 表单 ---------- */
  function setMode(mode) {
    const login = mode === 'login';
    $('#lgTabLogin').classList.toggle('is-active', login);
    $('#lgTabRegister').classList.toggle('is-active', !login);
    $('#lgTabLogin').setAttribute('aria-selected', login);
    $('#lgTabRegister').setAttribute('aria-selected', !login);
    $('#lgLoginForm').hidden = !login;
    $('#lgRegForm').hidden = login;
  }
  function watchAdmin(form) {
    const phone = form.querySelector('[name="phone"]');
    const keyBoxes = form.querySelectorAll('.lg-admin-key');
    phone.addEventListener('input', () => keyBoxes.forEach(b => { b.hidden = phone.value.trim() !== '13385387338'; }));
  }
  function bindLoading(btn, loadingText) {
    const old = btn.textContent;
    btn.classList.add('is-loading'); btn.textContent = '';
    return () => { btn.classList.remove('is-loading'); btn.textContent = loadingText || old; };
  }
  async function onLogin(e) {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type="submit"]');
    const payload = { phone: f.phone.value.trim(), password: f.password.value, adminKey: f.adminKey.value };
    if (!payload.phone || !payload.password) return toast('请填写手机号和密码', 'error');
    const done = bindLoading(btn, '登录');
    try { const r = await api('login', { method: 'POST', body: payload }); await enterApp(r.token, r.user); }
    catch (err) { toast(err.message, 'error'); done(); }
  }
  async function onRegister(e) {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type="submit"]');
    const payload = {
      phone: f.phone.value.trim(), nickname: f.nickname.value.trim(),
      password: f.password.value, email: f.email.value.trim(),
      avatar: regAvatar, adminKey: f.adminKey.value,
    };
    if (!payload.phone || !payload.nickname || !payload.password) return toast('请填写完整信息', 'error');
    const done = bindLoading(btn, '创建账号');
    try {
      const r = await api('register', { method: 'POST', body: payload });
      toast('注册成功', 'success'); await enterApp(r.token, r.user);
    } catch (err) { toast(err.message, 'error'); done(); }
  }

  function paintAvatars() {
    $('#lgAvatarPick').innerHTML = AVATARS.map(a =>
      `<button type="button" class="lg-avatar-opt ${a === regAvatar ? 'is-active' : ''}" data-a="${a}">${a}</button>`).join('');
    $('#lgAvatarPick').querySelectorAll('.lg-avatar-opt').forEach(b => b.addEventListener('click', () => {
      regAvatar = b.dataset.a;
      $('#lgAvatarPick').querySelectorAll('.lg-avatar-opt').forEach(x => x.classList.toggle('is-active', x === b));
    }));
  }

  /* ---------- 与老版登录屏的显隐同步（老脚本控制 #authScreen/#mainApp） ---------- */
  function sync() {
    const auth = $('#auth'), oldAuth = $('#authScreen'), main = $('#mainApp');
    if (!auth || !main) return;
    const inApp = main.hidden === false;
    auth.hidden = inApp;
    if (!inApp && oldAuth && oldAuth.hidden) {
      // 老脚本尚未显示老登录屏（理论不会发生），保持 #auth 可见
      auth.hidden = false;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    hydrate(document);
    paintAvatars();
    $('#lgTabLogin').addEventListener('click', () => setMode('login'));
    $('#lgTabRegister').addEventListener('click', () => setMode('register'));
    $('#lgLoginForm').addEventListener('submit', onLogin);
    $('#lgRegForm').addEventListener('submit', onRegister);
    watchAdmin($('#lgLoginForm')); watchAdmin($('#lgRegForm'));
    $('#lgQrBtn').addEventListener('click', qrLoginSheet);
    $('#lgForgotBtn').addEventListener('click', forgotSheet);
    // NFC 按钮由 js/nfc-login.js 绑定（存在时）；未加载时给提示
    const nfcBtn = $('#lgNfcBtn');
    if (nfcBtn) nfcBtn.addEventListener('click', () => {
      if (!window.LGNfc) toast('NFC 登录需在 Android 版 Edge 中碰卡，电脑请使用扫码', 'error');
    });

    sync();
    new MutationObserver(sync).observe($('#mainApp'), { attributes: true, attributeFilter: ['hidden'] });
    const oldAuth = $('#authScreen');
    if (oldAuth) new MutationObserver(sync).observe(oldAuth, { attributes: true, attributeFilter: ['hidden'] });
    // 兜底：500ms 后校正一次
    setTimeout(sync, 500);
  });

  window.LGAuth = { api, toast, openSheet, enterApp, drawQR, loadLib, esc };
})();
