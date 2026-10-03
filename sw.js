/* Stating Service Worker v6 — 极简：仅预缓存应用外壳，静态资源 SWR，HTML 网络优先 */
const CACHE_NAME = 'stating-shell-v6';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const STATIC_RE = /\.(css|js|png|svg|ico|webmanifest|woff2?|jpg|jpeg|gif)$/;

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // 实时数据始终走网络

  // 静态资源（含按需加载的二维码库）：stale-while-revalidate，秒开 + 后台更新
  if (STATIC_RE.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(hit => {
        const network = fetch(req).then(res => {
          if (res && res.ok) caches.open(CACHE_NAME).then(c => c.put(req, res.clone())).catch(() => {});
          return res;
        }).catch(() => hit);
        return hit || network;
      })
    );
    return;
  }

  // 导航 / HTML：网络优先，离线回退外壳
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) caches.open(CACHE_NAME).then(c => c.put(req, res.clone())).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
  );
});
