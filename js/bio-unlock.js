/* ============================================================
   Stating · 生物门禁（每次进入 Face ID / 指纹 / Windows Hello）
   - 发现式平台凭证（residentKey + UV required，后端 passkey 接口）
   - 已注册凭证：每次进站先生物断言，通过后揭示应用，并预热 liquidGL
   - 未注册：不拦截，仅引导注册；不支持环境完全无感
   ============================================================ */
'use strict';
(function () {
  const SETTING_KEY = 'stating_bio_gate';   // '1' 默认开；'0' 关
  const PROMPTED_KEY = 'stating_bio_prompted_session';
  const token = () => localStorage.getItem('stating_token');

  /* ---------- base64url ---------- */
  const b64uEnc = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64uDec = s => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
  };
  const decodeCred = o => ({
    ...o,
    challenge: b64uDec(o.challenge),
    allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: b64uDec(c.id) })),
    user: o.user ? { ...o.user, id: b64uDec(o.user.id) } : o.user,
    excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: b64uDec(c.id) })),
  });

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

  let platformAvailable = null;
  async function supported() {
    if (platformAvailable !== null) return platformAvailable;
    try {
      platformAvailable = !!(window.PublicKeyCredential &&
        window.isSecureContext &&
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch { platformAvailable = false; }
    return platformAvailable;
  }

  /* ---------- 凭证操作 ---------- */
  async function listPasskeys() {
    try { return (await api('passkeys')).passkeys || []; } catch { return []; }
  }
  async function enroll() {
    const opt = await api('passkey/register/options', { method: 'POST', body: { attachment: 'platform' } });
    const cred = await navigator.credentials.create({ publicKey: decodeCred(opt.publicKey) });
    const r = await api('passkey/register', {
      method: 'POST',
      body: {
        challengeId: opt.challengeId,
        id: cred.id,
        type: cred.type,
        response: {
          clientDataJSON: b64uEnc(cred.response.clientDataJSON),
          attestationObject: b64uEnc(cred.response.attestationObject),
        },
        attachment: 'platform',
      },
    });
    return r;
  }
  async function assertOnce() {
    const opt = await api('passkey/options', { method: 'POST', body: { mode: 'login' } });
    const cred = await navigator.credentials.get({
      mediation: 'required',
      publicKey: decodeCred(opt.publicKey),
    });
    return await api('passkey/verify', {
      method: 'POST',
      body: {
        challengeId: opt.challengeId,
        mode: 'login',
        id: cred.id,
        type: cred.type,
        response: {
          clientDataJSON: b64uEnc(cred.response.clientDataJSON),
          authenticatorData: b64uEnc(cred.response.authenticatorData),
          signature: b64uEnc(cred.response.signature),
          userHandle: cred.response.userHandle ? b64uEnc(cred.response.userHandle) : '',
        },
      },
    });
  }
  async function removePasskey(id) {
    return api('passkey/delete', { method: 'POST', body: { id } });
  }

  /* ---------- liquidGL 预热（利用门禁停留时间） ---------- */
  function warmup() {
    if (document.getElementById('lg-lgl')) return;
    const s = document.createElement('script');
    s.id = 'lg-lgl'; s.type = 'module'; s.src = 'https://cdn.jsdelivr.net/npm/liquid-gl@2.2.2/liquidGL.js'; s.async = true;
    document.body.appendChild(s);
  }

  /* ---------- 门禁 UI ---------- */
  function gateEl() {
    let g = document.getElementById('bioGate');
    if (g) return g;
    g = document.createElement('div');
    g.id = 'bioGate';
    g.className = 'bio-gate';
    g.innerHTML = `
      <div class="bio-card">
        <div class="bio-glyph" id="bioGlyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 8.5V7a4.5 4.5 0 0 1 9 0v1.5"/><rect x="4.6" y="8.5" width="14.8" height="9.4" rx="2.4"/><path d="M9.2 13.2c.7 1 1.7 1.5 2.8 1.5s2.1-.5 2.8-1.5"/></svg></div>
        <h2 id="bioTitle">面容 / 指纹解锁</h2>
        <p id="bioSub">验证本机身份以进入 Stating</p>
        <div class="bio-spinner" id="bioSpinner"></div>
        <button type="button" class="lg-btn lg-btn-primary lg-btn-block" id="bioRetry" hidden>开始验证</button>
        <button type="button" class="lg-btn lg-btn-ghost lg-btn-block" id="bioSwitch" hidden>切换账号（密码登录）</button>
        <p class="bio-foot" id="bioFoot"></p>
      </div>`;
    document.body.appendChild(g);
    g.querySelector('#bioRetry').addEventListener('click', () => attempt(true));
    g.querySelector('#bioSwitch').addEventListener('click', () => {
      localStorage.removeItem('stating_token');
      location.reload();
    });
    return g;
  }
  function setGateState(st) {
    const g = gateEl();
    const spinner = g.querySelector('#bioSpinner');
    const title = g.querySelector('#bioTitle');
    const sub = g.querySelector('#bioSub');
    const retry = g.querySelector('#bioRetry');
    const foot = g.querySelector('#bioFoot');
    if (st === 'verifying') { spinner.hidden = false; retry.hidden = true; title.textContent = '面容 / 指纹解锁'; sub.textContent = '请完成本机验证…'; }
    if (st === 'manual') { spinner.hidden = true; retry.hidden = false; sub.textContent = '点击下方按钮，用面容 / 指纹 / Windows Hello 解锁'; }
    if (st === 'fail') { spinner.hidden = true; retry.hidden = false; sub.textContent = '未验证通过，可重试或改用密码'; }
    if (st === 'blocked') { spinner.hidden = true; retry.hidden = true; foot.textContent = '连续验证失败，请用密码登录'; }
  }
  function reveal() {
    const g = document.getElementById('bioGate');
    if (!g) return;
    g.classList.add('bio-hide');
    setTimeout(() => g.remove(), 400);
  }

  let fails = 0;
  async function attempt(manual) {
    setGateState('verifying');
    try {
      const r = await assertOnce();
      if (r && r.token) localStorage.setItem('stating_token', r.token);
      reveal();
    } catch (e) {
      fails++;
      if (fails >= 3) setGateState('blocked');
      else setGateState(fails ? 'fail' : 'manual');
      if (manual) console.warn('bio assert failed', e);
    }
  }

  /* ---------- 注册引导（无凭证时） ---------- */
  function onboardSheet() {
    if (sessionStorage.getItem(PROMPTED_KEY)) return;
    sessionStorage.setItem(PROMPTED_KEY, '1');
    const root = document.getElementById('lgSheetRoot') || (function () {
      const d = document.createElement('div'); d.id = 'lgSheetRoot'; document.body.appendChild(d); return d;
    })();
    const ov = document.createElement('div');
    ov.className = 'lg-overlay';
    ov.innerHTML = `<div class="lg-scrim"></div><div class="lg-sheet">
      <div class="lg-grabber"></div>
      <div class="lg-sheet-title">开启面容 / 指纹解锁</div>
      <div class="lg-sheet-body">
        <p class="lg-form-hint" style="font-size:13.5px;margin:0">用本机 Windows Hello / 面容 ID / 指纹解锁 Stating，之后每次进入只需一次验证。凭证仅保存在本机与你的账号下。</p>
      </div>
      <div class="lg-sheet-actions">
        <button type="button" class="lg-btn lg-btn-ghost" data-c>稍后再说</button>
        <button type="button" class="lg-btn lg-btn-primary" data-ok>立即开启</button>
      </div></div>`;
    root.appendChild(ov);
    const close = () => { ov.classList.add('closing'); setTimeout(() => ov.remove(), 180); };
    ov.querySelector('.lg-scrim').addEventListener('click', close);
    ov.querySelector('[data-c]').addEventListener('click', close);
    ov.querySelector('[data-ok]').addEventListener('click', async b => {
      const btn = b.target; btn.classList.add('is-loading'); const old = btn.textContent; btn.textContent = '';
      try {
        await enroll();
        btn.classList.remove('is-loading'); btn.textContent = old;
        close();
        // 开启门禁并立即上锁一次（下次进入生效）
        localStorage.setItem(SETTING_KEY, '1');
        syncProfileRow();
      } catch (e) {
        btn.classList.remove('is-loading'); btn.textContent = old;
        ov.querySelector('.lg-sheet-body').insertAdjacentHTML('beforeend',
          '<p class="lg-form-hint" style="color:#ff3b30;margin:0">' + (e.message || '开启失败') + '</p>');
      }
    });
  }

  /* ---------- 我的页注入：开关 + 管理入口 ---------- */
  function injectProfile() {
    const sessionsBtn = document.getElementById('sessionsBtn');
    if (!sessionsBtn || !sessionsBtn.parentNode || document.getElementById('bioToggleRow')) return;
    const container = sessionsBtn.parentNode;
    const row = document.createElement('div');
    row.id = 'bioToggleRow';
    row.className = 'dark-mode-row glass-pill';
    row.innerHTML = `<span class="dm-label">面容 / 指纹解锁</span>
      <label class="dm-switch"><input type="checkbox" id="bioToggle"><span class="dm-slider"></span></label>`;
    container.insertBefore(row, sessionsBtn);
    row.querySelector('#bioToggle').addEventListener('change', e => {
      localStorage.setItem(SETTING_KEY, e.target.checked ? '1' : '0');
      if (e.target.checked) manageOrEnroll();
    });

    const manage = document.createElement('button');
    manage.className = 'btn-sessions';
    manage.id = 'bioManageBtn';
    manage.textContent = '面容 / 指纹凭证管理';
    container.insertBefore(manage, row.nextSibling);
    manage.addEventListener('click', manageOrEnroll);
    syncProfileRow();
  }
  function syncProfileRow() {
    const t = document.getElementById('bioToggle');
    if (t) t.checked = localStorage.getItem(SETTING_KEY) !== '0';
  }
  async function manageOrEnroll() {
    if (!await supported()) { alert('当前设备/浏览器不支持本机生物识别（需 HTTPS 下 Edge/Chrome 安卓，或 Windows Hello / 面容 ID）'); return; }
    const list = await listPasskeys();
    const root = document.getElementById('lgSheetRoot') || (function () {
      const d = document.createElement('div'); d.id = 'lgSheetRoot'; document.body.appendChild(d); return d;
    })();
    const ov = document.createElement('div');
    ov.className = 'lg-overlay';
    ov.innerHTML = `<div class="lg-scrim"></div><div class="lg-sheet">
      <div class="lg-sheet-title">生物凭证</div>
      <div class="lg-sheet-body" id="bioListBody"></div>
      <div class="lg-sheet-actions">
        <button type="button" class="lg-btn lg-btn-ghost" data-c>关闭</button>
        <button type="button" class="lg-btn lg-btn-primary" data-add>${list.length ? '再添加一个' : '添加本机凭证'}</button>
      </div></div>`;
    root.appendChild(ov);
    const close = () => { ov.classList.add('closing'); setTimeout(() => ov.remove(), 180); };
    ov.querySelector('.lg-scrim').addEventListener('click', close);
    ov.querySelector('[data-c]').addEventListener('click', close);
    const paint = items => {
      ov.querySelector('#bioListBody').innerHTML = items.length
        ? items.map(p => `<div class="lg-field" style="justify-content:space-between"><span style="font-size:14px">${p.device || '本机生物识别'}<br><small style="color:var(--lg-ink-3)">${p.lastUsed ? '最近使用 ' + new Date(p.lastUsed).toLocaleDateString() : '未使用'}</small></span><button type="button" class="lg-btn-text" data-del="${p.id}" style="color:#ff3b30">删除</button></div>`).join('')
        : '<p class="lg-form-hint" style="margin:0">还没有生物凭证</p>';
      ov.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
        await removePasskey(b.dataset.del); close(); manageOrEnroll();
      }));
    };
    paint(list);
    ov.querySelector('[data-add]').addEventListener('click', async () => {
      try { await enroll(); close(); manageOrEnroll(); } catch (e) { alert(e.message || '添加失败'); }
    });
  }

  /* ---------- 启动 ---------- */
  document.addEventListener('DOMContentLoaded', async () => {
    injectProfile();
    new MutationObserver(injectProfile).observe(document.body, { childList: true, subtree: false });

    if (!token()) return;
    if (localStorage.getItem(SETTING_KEY) === '0') return;
    if (!await supported()) return;

    const list = await listPasskeys();
    if (!list.length) {
      // 已登录但从未注册：引导一次（应用正常可用，不拦截）
      if (document.getElementById('mainApp') && document.getElementById('mainApp').hidden === false) {
        setTimeout(onboardSheet, 1200);
      }
      return;
    }
    // 有凭证：每次进入强制门禁，期间预热 liquidGL
    gateEl();
    warmup();
    attempt(false);
  });

  window.LGBio = { supported, listPasskeys, enroll, removePasskey, warmup };
})();
