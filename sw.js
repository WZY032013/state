/* Stating Service Worker v9 — 零缓存模式（network-only）
   ---------------------------------------------------------------
   1) 不注册任何 fetch 监听：所有资源直连网络，不再有 Cache Storage 读写，
      也不会在 install 阶段并发预拉 17 个文件与首屏争抢带宽/连接。
   2) activate 时清空历史版本（stating-liquid-*）遗留的全部缓存。
   3) 保留 SW 身份本身：Web Push 依赖 navigator.serviceWorker.ready，
      若彻底注销该 Promise 会永久挂起，导致「开启推送」按钮点击无响应。
   「始终最新」由 HTTP 层 Cache-Control: max-age=0, must-revalidate 保证（见 _headers）。 */
self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 无 fetch 监听 = 浏览器默认直连网络（network-only）