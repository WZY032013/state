/* Stating · main */
'use strict';

/* ============================================================
   19 · 二维码库懒加载 / 扫码
   ============================================================ */
const libCache = {};
function loadLib(src) {
  if (libCache[src]) return libCache[src];
  libCache[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve; s.onerror = () => reject(new Error('组件加载失败'));
    document.body.appendChild(s);
  });
  return libCache[src];
}
async function drawQR(box, text) {
  try {
    await loadLib('lib/qrcode/qrcode.min.js');
    box.innerHTML = '';
    const Q = window.qrcode || window.QRCode;
    const gen = typeof Q === 'function' ? Q(0, 'M') : null;
    if (gen && typeof gen.addData === 'function' && typeof gen.createSvgTag === 'function') {
      gen.addData(text);
      if (typeof gen.make === 'function') gen.make();
      box.innerHTML = gen.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
      const svg = box.querySelector('svg');
      if (svg) { svg.setAttribute('width', '220'); svg.setAttribute('height', '220');
        svg.style.width = '220px'; svg.style.height = '220px'; svg.style.display = 'block'; }
      box._qr = gen;
    } else if (window.QRCode && QRCode.toCanvas) {
      const cv = document.createElement('canvas');
      await new Promise((res, rej) => QRCode.toCanvas(cv, text, { width: 220, margin: 1 }, e => e ? rej(e) : res()));
      box.appendChild(cv);
    } else if (typeof Q === 'function') {
      new Q(box, { text, width: 220, height: 220 });
    } else throw new Error('二维码组件不可用');
  } catch (err) { box.innerHTML = `<span class="empty-hint">${esc(err.message)}</span>`; }
}

/* 扫码（已登录）：识别群邀请 / PC登录码 */
let scanStream = null;
async function openScanner() {
  if (!navigator.mediaDevices) return toast('当前环境不支持扫码', 'error');
  const body = `
    <div class="scan-stage"><video id="scanVideo" playsinline muted></video></div>
    <p class="qr-status" id="scanHint">将二维码对准取景框</p>
    <button class="btn btn-ghost" id="scanManual">手动输入邀请码</button>`;
  const s = openSheet({ title: '扫一扫', body, dismissable: false });
  const video = s.el.querySelector('#scanVideo');
  let stopped = false, raf = null;
  const stop = () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    if (scanStream) scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  };
  // 覆盖关闭：加一个关闭按钮
  const closeBtn = h('button', 'sheet-close'); closeBtn.innerHTML = icon('xmark'); closeBtn.style.position = 'absolute';
  closeBtn.addEventListener('click', () => { stop(); s.close(); });
  s.el.appendChild(closeBtn);

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = scanStream; await video.play();
    await loadLib('lib/qrcode/jsQR.js');
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (stopped) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        cv.width = video.videoWidth; cv.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, cv.width, cv.height);
        const q = window.jsQR(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
        if (q && q.data) { handleScanResult(q.data, s, stop); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (err) { s.el.querySelector('#scanHint').textContent = '无法使用摄像头：' + err.message; }

  s.el.querySelector('#scanManual').addEventListener('click', () => {
    stop(); s.close();
    const ss = openSheet({
      title: '手动输入邀请码',
      body: `<label class="field"><span class="field-icon">${icon('hash')}</span><input type="text" id="manualCode" placeholder="邀请码" maxlength="12"></label>`,
      actions: `<button class="btn btn-ghost" data-cancel>取消</button><button class="btn btn-primary" data-ok>加入</button>`,
    });
    ss.el.querySelector('[data-cancel]').addEventListener('click', ss.close);
    ss.el.querySelector('[data-ok]').addEventListener('click', async () => {
      const code = ss.el.querySelector('#manualCode').value;
      try { const c = await joinByCode(code); ss.close(); switchNav('chat'); openRoom(c); }
      catch (err) { toast(err.message, 'error'); }
    });
  });
}

async function handleScanResult(data, sheet, stop) {
  let code = null;
  const m = data.match(/[?&]join=([A-Za-z0-9]{4,12})/);
  if (m) code = m[1].toUpperCase();
  else if (/^[A-Za-z0-9]{4,12}$/.test(data) && !/^[0-9a-f]{20,}$/.test(data)) code = data.toUpperCase();
  // PC 登录码（48位hex）
  const isQrLogin = /^[0-9a-f]{30,}$/.test(data);
  if (isQrLogin) {
    stop(); sheet.close();
    try {
      await api('qrlogin/scan', { method: 'POST', body: { qrId: data } });
      const cs = openSheet({
        title: '确认登录', sub: '你正在扫码登录 Stating 网页端',
        actions: `<button class="btn btn-ghost" data-cancel>取消</button><button class="btn btn-primary" data-ok>确认</button>`,
      });
      cs.el.querySelector('[data-cancel]').addEventListener('click', async () => { await api('qrlogin/cancel', { method: 'POST', body: { qrId: data } }); cs.close(); });
      cs.el.querySelector('[data-ok]').addEventListener('click', async () => {
        await api('qrlogin/confirm', { method: 'POST', body: { qrId: data } }); cs.close(); toast('已确认，请在电脑端查看', 'success');
      });
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (code) {
    stop(); sheet.close();
    try { const c = await joinByCode(code); switchNav('chat'); openRoom(c); }
    catch (err) { toast(err.message, 'error'); }
  } else {
    sheet.el.querySelector('#scanHint').textContent = '未识别该二维码';
    const restart = () => { sheet.el.querySelector('#scanHint').textContent = '将二维码对准取景框'; };
    setTimeout(restart, 1400);
  }
}

/* ============================================================
   20 · 扫码登录（认证页，展示本机码）
   ============================================================ */
function qrLoginSheet() {
  let poll = null, qrId = null;
  const body = `
    <div class="qr-stage">
      <div class="qr-box" id="qlBox"><span class="empty-hint">生成中…</span></div>
      <p class="qr-status" id="qlStatus">使用已登录的手机扫码</p>
      <button class="btn btn-ghost" id="qlRefresh" hidden>刷新二维码</button>
    </div>`;
  const s = openSheet({
    title: '扫码登录', body,
    onMount: start,
  });
  async function start() {
    try {
      const r = await api('qrlogin/create', { method: 'POST', auth: false });
      qrId = r.qrId;
      await drawQR(s.el.querySelector('#qlBox'), qrId);
      s.el.querySelector('#qlStatus').textContent = '等待扫码…';
      poll = setInterval(check, 2000);
    } catch (err) { s.el.querySelector('#qlStatus').textContent = err.message; }
  }
  async function check() {
    try {
      const r = await api(`qrlogin/status?qrId=${qrId}`, { auth: false });
      const st = r.status;
      const statusEl = s.el.querySelector('#qlStatus');
      if (st === 'scanned') statusEl.textContent = `已扫描（${r.scanner ? r.scanner.nickname : ''}），请在手机确认`;
      else if (st === 'expired') {
        clearInterval(poll);
        statusEl.textContent = '二维码已过期';
        const rb = s.el.querySelector('#qlRefresh'); rb.hidden = false;
        rb.onclick = () => { rb.hidden = true; start(); };
      } else if (st === 'confirmed') {
        clearInterval(poll);
        s.close();
        await completeAuth(r.token, r.user);
      }
    } catch (e) {}
  }
  // 关闭时停止轮询
  const origClose = s.close;
  s.close = () => { clearInterval(poll); origClose(); };
}

/* 忘记密码（管理员密钥重置） */
function forgotSheet() {
  const body = `
    <label class="field"><span class="field-icon">${icon('phone')}</span><input type="tel" id="fpPhone" placeholder="手机号" maxlength="15"></label>
    <label class="field"><span class="field-icon">${icon('key')}</span><input type="password" id="fpKey" placeholder="管理员密钥"></label>
    <label class="field"><span class="field-icon">${icon('lock')}</span><input type="password" id="fpNew" placeholder="新密码（≥8位，含字母和数字）"></label>
    <p class="form-hint">密码重置需管理员密钥；重置后所有设备需重新登录。</p>`;
  const s = openSheet({
    title: '重置密码', body,
    actions: `<button class="btn btn-ghost" data-cancel>取消</button><button class="btn btn-primary" data-ok>重置</button>`,
  });
  s.el.querySelector('[data-cancel]').addEventListener('click', s.close);
  s.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const phone = s.el.querySelector('#fpPhone').value.trim();
    const adminKey = s.el.querySelector('#fpKey').value;
    const newPassword = s.el.querySelector('#fpNew').value;
    try {
      const a = await api('recover/admin', { method: 'POST', body: { phone, adminKey }, auth: false });
      await api('recover/confirm', { method: 'POST', body: { resetToken: a.resetToken, newPassword }, auth: false });
      s.close(); toast('密码已重置，请登录', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ============================================================
   21 · 启动 / 事件绑定 / 深链
   ============================================================ */
function showApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
}

async function bootApp() {
  // 深色 / 通知偏好
  const dark = localStorage.getItem('stating_dark') === '1';
  toggleDark(dark);
  Store.notify = localStorage.getItem('stating_notify') !== '0';
  $('#swNotify').checked = Store.notify;

  // 刷新用户
  try { const r = await api('me'); Store.me = r.user; } catch (e) { return logout(); }

  showApp();
  switchNav('home');
}

function bindEvents() {
  // 认证
  $('#tabLogin').addEventListener('click', () => setAuthMode('login'));
  $('#tabRegister').addEventListener('click', () => setAuthMode('register'));
  $('#loginForm').addEventListener('submit', handleLoginSubmit);
  $('#registerForm').addEventListener('submit', handleRegisterSubmit);
  watchAdminKey($('#loginForm')); watchAdminKey($('#registerForm'));
  buildAvatarPick($('#regAvatarPick'));
  $('#openQrLogin').addEventListener('click', qrLoginSheet);
  $('#openForgot').addEventListener('click', forgotSheet);

  // 导航
  $$('.tab').forEach(t => t.addEventListener('click', () => switchNav(t.dataset.nav)));
  $('#roomBack').addEventListener('click', () => closeRoom());
  $('#topAction').addEventListener('click', () => {
    if (Store.activeCode) openGroupDetails();
    else createGroupSheet();
  });

  // 首页
  $('#qaCreate').addEventListener('click', createGroupSheet);
  $('#qaJoin').addEventListener('click', () => switchNav('chat'));
  $('#qaScan').addEventListener('click', openScanner);
  $('#qaFeedback').addEventListener('click', () => switchNav('feedback'));
  $('#homeGoChat').addEventListener('click', () => switchNav('chat'));

  // 邀请门
  $('#joinBtn').addEventListener('click', async () => {
    try { const c = await joinByCode($('#joinCode').value); openRoom(c); }
    catch (err) { toast(err.message, 'error'); }
  });
  $('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#gateCreate').addEventListener('click', createGroupSheet);

  // 房间：顶部标题点开群资料
  $('.topbar-titles').addEventListener('click', () => { if (Store.activeCode) openGroupDetails(); });
  $('#announceClose').addEventListener('click', () => $('#announceBar').hidden = true);
  $('#pinnedClose').addEventListener('click', async () => {
    const id = $('#pinnedBar').dataset.id;
    const m = findMsg(id);
    if (m) await doPin(m); else $('#pinnedBar').hidden = true;
  });
  $('#pinnedJump').addEventListener('click', () => {
    const id = $('#pinnedBar').dataset.id;
    const node = $('#messages').querySelector(`[data-id="${id}"]`);
    if (node) { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); node.querySelector('.bubble').style.boxShadow = '0 0 0 3px rgba(10,132,255,.5)'; setTimeout(() => node.querySelector('.bubble').style.boxShadow = '', 1200); }
  });

  // 输入区
  const input = $('#msgInput');
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });
  $('#sendBtn').addEventListener('click', sendText);
  $('#plusBtn').addEventListener('click', () => {
    const menu = $('#plusMenu');
    const open = menu.hidden;
    menu.hidden = !open;
    $('#plusBtn').setAttribute('aria-expanded', open);
  });
  $('#micBtn').addEventListener('click', startRecording);
  $('#pmImage').addEventListener('click', () => { $('#plusMenu').hidden = true; $('#fileImage').click(); });
  $('#pmCamera').addEventListener('click', () => { $('#plusMenu').hidden = true; $('#fileCamera').click(); });
  $('#pmVoice').addEventListener('click', () => { $('#plusMenu').hidden = true; startRecording(); });
  $('#fileImage').addEventListener('change', e => sendImageFile(e.target.files[0]));
  $('#fileCamera').addEventListener('change', e => sendImageFile(e.target.files[0]));

  // 用户搜索
  $('#userSearch').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    paintDirectory(directory.filter(u => u.nickname.toLowerCase().includes(q) || u.phone.includes(q)));
  });

  // 我的
  $('#editProfile').addEventListener('click', editProfileSheet);
  $('#swDark').addEventListener('change', e => toggleDark(e.target.checked));
  $('#swNotify').addEventListener('change', e => {
    Store.notify = e.target.checked;
    localStorage.setItem('stating_notify', e.target.checked ? '1' : '0');
    if (e.target.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  });
  $('#goFeedback').addEventListener('click', () => switchNav('feedback'));
  $('#goAbout').addEventListener('click', aboutSheet);
  $('#goAdmin').addEventListener('click', () => switchNav('admin'));
  $('#logoutBtn').addEventListener('click', async () => {
    const ok = await confirmDialog('退出登录', '确定退出当前账号吗？', '退出');
    if (ok) logout();
  });
  $('#deleteBtn').addEventListener('click', async () => {
    const ok = await confirmDialog('注销账号', '账号与所有消息将被永久删除，无法恢复。', '注销');
    if (ok) { try { await api('delete-account', { method: 'POST' }); logout(); toast('账号已注销', 'success'); } catch (err) { toast(err.message, 'error'); } }
  });

  // 博采
  $('#submitFeedback').addEventListener('click', submitFeedback);
}

function aboutSheet() {
  openSheet({
    title: '关于 Stating',
    body: `
      <div class="brand" style="margin-bottom:14px"><span class="brand-mark">${icon('chat')}</span></div>
      <p class="form-hint" style="font-size:13px">Stating · 果味液态玻璃即时通讯<br>iOS 26 Liquid Glass 设计语言<br>消息保留 30 天 · 数据随群自动清理</p>`,
  });
}

async function handleDeepLink() {
  const params = new URLSearchParams(location.search);
  const join = params.get('join');
  if (join && Store.token) {
    history.replaceState({}, document.title, location.pathname);
    try { const c = await joinByCode(join); openRoom(c); } catch (e) {}
  }
}

async function init() {
  hydrateIcons();
  bindEvents();

  // 恢复深色偏好（登录页也生效）
  if (localStorage.getItem('stating_dark') === '1') document.body.classList.add('dark');

  const token = localStorage.getItem('stating_token');
  if (!token) { $('#auth').hidden = false; return; }
  Store.token = token;
  try {
    const r = await api('me');
    Store.me = r.user;
    await bootApp();
    handleDeepLink();
  } catch (e) {
    logout();
  }

  // Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

document.addEventListener('DOMContentLoaded', init);
