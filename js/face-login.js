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

  async function faceLogin() {
    const btn = $('lgFaceBtn'); if (!btn || btn.classList.contains('is-loading')) return;
    if (!(await supported())) { toast('当前设备不支持面容/指纹登录，请用密码或扫码'); return; }
    btn.classList.add('is-loading');
    try {
      const opt = await api('passkey/options', { method: 'POST', body: { mode: 'login' } });
      if (!opt.ok) throw new Error(opt.error || '无法开始面容登录');
      const cred = await navigator.credentials.get({ mediation: 'required', publicKey: decodeCred(opt.publicKey) });
      if (!cred) throw new Error('已取消');
      const r = await api('passkey/verify', {
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
      });
      if (!r.ok || !r.token) throw new Error(r.error || '面容验证失败');
      if (window.LGAuth && window.LGAuth.enterApp) await window.LGAuth.enterApp(r.token, r.user);
      else { localStorage.setItem('stating_token', r.token); location.reload(); }
    } catch (e) {
      console.warn('face login failed', e);
      toast(e.message || '面容登录失败');
    } finally {
      btn.classList.remove('is-loading');
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