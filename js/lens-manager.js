/* ============================================================
   Stating · Liquid Glass 镜头管理器（plus 全量，带性能分级）
   - 仅 3 个关键表面：顶部胶囊 / 输入胶囊 / 登录卡（玻璃不叠玻璃）
   - 低端机/省流/reduced-motion/移动默认走 CSS 降级（不加镜头）
   - WebGL 上下文丢失自动降级
   ============================================================ */
'use strict';
(function () {
  const instances = [];
  let started = false;

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const narrow = Math.min(window.innerWidth, window.innerHeight) < 700;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  const mem = navigator.deviceMemory || 4;
  // 移动端默认降级（plus 镜头只给桌面/平板）；低内存/省流/减弱动效同降
  const plusAllowed = !coarse && !narrow && !reduce && !saveData && mem >= 4;

  // 多源兜底：仅 esm 分发（项目内无 liquidGL 本地副本、禁止 npm install），
  // 依次回退 jsDelivr → unpkg → fastly，任一失败自动落 CSS 档（lg-no-lens）
  const SOURCES = [
    'https://cdn.jsdelivr.net/npm/liquid-gl@2.2.2/liquidGL.js',
    'https://unpkg.com/liquid-gl@2.2.2/liquidGL.js',
    'https://fastly.jsdelivr.net/npm/liquid-gl@2.2.2/liquidGL.js'
  ];
  function loadLib() {
    if (window.liquidGL) return Promise.resolve();
    function trySrc(i) {
      if (i >= SOURCES.length) return Promise.reject(new Error('liquidGL load fail'));
      return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.type = 'module';
        s.src = SOURCES[i]; s.async = true;
        s.onload = () => res();
        s.onerror = () => { s.remove(); trySrc(i + 1).then(res, rej); };
        document.body.appendChild(s);
      });
    }
    return trySrc(0);
  }

  function baseOpts(extra) {
    return Object.assign({
      snapshot: 'body',
      resolution: 1.6,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
      powerPreference: 'high-performance',
      engine: 'auto',
      refraction: 0.012,
      aberration: 0.14,
      bevelDepth: 0.1,
      bevelWidth: 0.14,
      frost: 0.32,
      shadow: true,
      specular: true,
      reveal: 'fade',
      tilt: false,
      magnify: 1,
    }, extra || {});
  }

  function attach(selector, extra) {
    const el = document.querySelector(selector);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 12) return false;
    try {
      const inst = window.liquidGL(baseOpts(extra));
      instances.push(inst);
      el.classList.add('lg-lensed');
      return true;
    } catch (e) {
      console.warn('lens skip', selector, e);
      return false;
    }
  }

  /* liquidGL(target) 按选择器匹配；一个调用可带多个选择器 */
  function attachSelector(selector, extra) {
    try {
      const inst = window.liquidGL(baseOpts(Object.assign({ target: selector }, extra)));
      instances.push(inst);
      document.querySelectorAll(selector).forEach(el => el.classList.add('lg-lensed'));
    } catch (e) { console.warn('lens skip', selector, e); }
  }

  function start() {
    if (started) return;
    started = true;
    if (!plusAllowed) { document.body.classList.add('lg-no-lens'); return; }

    loadLib().then(() => {
      // 1) 顶部胶囊（常驻，仅一个顶栏镜头，玻璃不叠玻璃）
      attachSelector('nav.topbar.glass-pill');

      // 1b) 主页 hero + 功能卡玻璃面（评审要求扩展折射覆盖；hero 为品牌渐变，镜头叠加折射高光）
      attachSelector('.home-hero.glass');
      attachSelector('.feature-card.glass');

      // 2) 登录卡（可见时）
      const authCard = document.getElementById('lgAuthCard');
      const tryAuth = () => {
        const auth = document.getElementById('auth');
        if (auth && !auth.hidden) {
          // 800ms 内仍可见才挂镜头，避免老脚本引导期间瞬时可见就白挂
          setTimeout(() => {
            const a2 = document.getElementById('auth');
            if (a2 && !a2.hidden && !document.querySelector('#lgAuthCard.lg-lensed')) attachSelector('#lgAuthCard');
          }, 800);
        }
      };
      const observer = new MutationObserver(tryAuth);
      observer.observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });
      tryAuth();

      // 3) 输入胶囊（房间打开后一次性挂载）
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        const c = document.querySelector('.composer.glass-pill');
        if (c && c.getBoundingClientRect().width > 100 && (c.offsetParent !== null)) {
          attachSelector('.composer.glass-pill');
          clearInterval(iv);
        }
        if (tries > 240) clearInterval(iv); // 2 分钟未进房放弃（节省轮询）
      }, 500);

      // 4) 48 帧性能采样：均值过高则整体退回 CSS 档
      const frames = [];
      let last = performance.now();
      function tick(t) {
        frames.push(t - last); last = t;
        if (frames.length < 48) requestAnimationFrame(tick);
        else {
          const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
          if (mean > 32) document.body.classList.add('lg-lens-lowfps');
        }
      }
      requestAnimationFrame(tick);
    }).catch(() => document.body.classList.add('lg-no-lens'));

    // WebGL 上下文丢失 → CSS 档
    document.addEventListener('webglcontextlost', () => document.body.classList.add('lg-no-lens'));
    document.addEventListener('visibilitychange', () => {
      // 标签隐藏时让浏览器自己暂停 rAF；回前台无额外处理
    });
  }

  // 进入应用或门禁通过后启动；门禁预载已在 bio-unlock 发起
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kick, { once: true });
  else kick();
  function kick() {
    const ric = window.requestIdleCallback || ((fn) => setTimeout(fn, 2500));
    // 若生物门禁存在，等门禁揭示后再启动，避免门禁下白做快照
    const checkGate = setInterval(() => {
      if (!document.getElementById('bioGate')) {
        clearInterval(checkGate);
        ric(start, { timeout: 4000 });
      }
    }, 200);
    setTimeout(() => { clearInterval(checkGate); ric(start, { timeout: 4000 }); }, 15000);
  }

  window.LGLens = { start, plusAllowed };
})();
