/* Stating · 面容/指纹一键登录（discoverable credential，免手机号密码） */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  async function supported() {
    if (!window.PublicKeyCredential || !window.isSecureContext) return false;
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
    catch { return false; }
  }
  async function api(path, opt) {
    const r = await fetch('/api/' + path, {
      method: opt.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) },
      body: opt.body ? JSON.stringify(opt.body) : undefined,
      credentials: 'same-origin',
    });
    return r.json();
  }
  function b64uEnc(buf) {
    const bytes = new Uint8Array(buf);
    let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDec(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return new Uint8Array(atob(s).split('').map(c => c.charCodeAt(0))).buffer;
  }
  function decodeCred(pk) {
    return Object.assign({}, pk, {
      challenge: b64uDec(pk.challenge),
      allowCredentials: (pk.allowCredentials || []).map(c => ({ type: c.type, id: b64uDec(c.id) })),
    });
  }
  function toast(msg) {
    if (window.LGAuth && window.LGAuth.toast) return window.LGAuth.toast(msg);
    let t = $('lgToast');
    if (!t) { t = document.createElement('div'); t.id = 'lgToast'; t.className = 'lg-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._tid); t._tid = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // Promise.race 超时包装：让面容登录不再"卡死"
  function withTimeout(promise, ms, msg) {
    let tid;
    const timeout = new Promise((_, rej) => { tid = setTimeout(() => rej(new Error(msg)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(tid));
  }
  // 友好错误提示
  function friendlyError(e) {
    const m = (e && e.message) || '';
    if (/cancel|abort|NotAllowed/i.test(m)) return '已取消面容验证';
    if (/timeout|超时/i.test(m)) return '面容验证超时，请重试';
    if (/network|fetch|Failed to|NetworkError/i.test(m)) return '网络异常，请检查后重试';
    return m || '面容验证失败，请重试';
  }

  async function faceLogin() {
    const btn = $('lgFaceBtn'); if (!btn || btn.classList.contains('is-loading')) return;
    if (!(await supported())) { toast('当前设备不支持面容/指纹登录，请用密码或扫码'); return; }
    btn.classList.add('is-loading');
    btn.disabled = true;            // 防双击
    btn.setAttribute('aria-busy', 'true');
    const t0 = performance.now();
    try {
      // 6s 内未拿到 server options 视为网络慢
      const opt = await withTimeout(
        api('passkey/options', { method: 'POST', body: { mode: 'login' } }),
        6000, '服务器响应超时'
      );
      if (!opt || !opt.ok) throw new Error((opt && opt.error) || '无法开始面容登录');
      toast('请看镜头或按下指纹…');
      // mediation: 'silent' 在 discoverable credential 上免交互确认，速度更快
      // 兼容性回退：旧版浏览器降级为 'required'
      const mediation = (window.PublicKeyCredential && 'silent' in window.PublicKeyCredential.prototype)
        ? 'silent' : 'required';
      // 30s 内未完成生物识别视为超时
      const cred = await withTimeout(
        navigator.credentials.get({
          mediation: mediation,
          publicKey: decodeCred(opt.publicKey),
        }),
        30000, '面容验证超时（30秒未完成）'
      );
      if (!cred) throw new Error('已取消');
      const r = await withTimeout(
        api('passkey/verify', {
          method: 'POST',
          body: {
            challengeId: opt.challengeId, mode: 'login', id: cred.id, type: cred.type,
            response: {
              clientDataJSON: b64uEnc(cred.response.clientDataJSON),
              authenticatorData: b64uEnc(cred.response.authenticatorData),
              signature: b64uEnc(cred.response.signature),
              userHandle: cred.response.userHandle ? b64uEnc(cred.response.userHandle) : '',
            },
          },
        }),
        6000, '验证响应超时'
      );
      if (!r.ok || !r.token) throw new Error(r.error || '面容验证失败');
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      toast('已通过 · ' + dt + 's');
      if (window.LGAuth && window.LGAuth.enterApp) await window.LGAuth.enterApp(r.token, r.user);
      else { localStorage.setItem('stating_token', r.token); location.reload(); }
    } catch (e) {
      console.warn('face login failed', e);
      toast(friendlyError(e));
    } finally {
      btn.classList.remove('is-loading');
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  }

  function injectIcon() {
    const btn = $('lgFaceBtn'); if (!btn || btn.dataset.iconDone) return;
    const span = btn.querySelector('[data-lgicon]');
    if (span && window.svgIcon) span.innerHTML = window.svgIcon('faceid', 15).replace(/<span[^>]*>|<\/span>/g, '');
    btn.dataset.iconDone = '1';
  }

  function init() {
    const btn = $('lgFaceBtn');
    if (btn && !btn.dataset.bound) { btn.dataset.bound = '1'; btn.addEventListener('click', faceLogin); }
    supported().then(ok => { if (btn) btn.hidden = !ok; });
    if (window.ICONS) injectIcon();
    else document.addEventListener('DOMContentLoaded', injectIcon);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.LGFace = { supported, faceLogin };
})();
