/* Stating Service Worker v8 — Liquid Plus
   外壳/核心脚本：网络优先回退缓存（更新即时可见，免清缓存）
   静态资源：SWR（秒开 + 后台更新）；liquidGL 不预缓存（懒加载） */
const CACHE_NAME = 'stating-liquid-v9';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/lg.css',
  '/js/icons-sf.js',
  '/js/auth-adapter.js',
  '/js/bio-unlock.js',
  '/js/nfc-login.js',
  '/js/lens-manager.js',
  '/script.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/assets/logo.svg',
  '/lib/qrcode/qrcode.min.js',
  '/lib/qrcode/jsQR.js',
  '/lib/lz-string.min.js',
];
const STATIC_RE = /\.(?:css|js|png|jpg|jpeg|gif|webp|svg|ico|webmanifest|woff2?)$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const u = new URL(req.url);
  if (u.pathname.startsWith('/api/')) return; // 实时数据永远走网络
  // 导航与核心文件：网络优先，离线回退
  if (req.mode === 'navigate' || /\/(index\.html|sw\.js)$/.test(u.pathname) ||
      u.pathname === '/' || u.pathname === '/style.css' || u.pathname === '/lg.css' ||
      u.pathname === '/script.js' || u.pathname.startsWith('/js/')) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const res = await fetch(req);
        if (res && res.ok && (req.mode === 'navigate' || STATIC_RE.test(u.pathname))) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req, { ignoreSearch: true });
        return hit || caches.match('/index.html');
      }
    })());
    return;
  }

  // 其他静态资源：SWR
  if (STATIC_RE.test(u.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(req);
      const network = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || network;
    })());
  }
});
