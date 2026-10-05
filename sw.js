/* 記帳本 Service Worker — 讓 App 離線也能開啟
 *
 * 更新 App 時：index.html 本身採「網路優先」，連線時永遠拿到最新版；
 * 若改了 sw.js 或想強制清掉舊快取，把 VERSION 加一即可。
 */
const VERSION = 'v1';
const CORE_CACHE = `kakeibo-core-${VERSION}`;
const RUNTIME_CACHE = `kakeibo-runtime-${VERSION}`;

const INDEX = './index.html';
const CORE_ASSETS = ['./', INDEX, './manifest.json', './icon.png'];

// 安裝時預先快取的第三方資源（版本號需與 index.html 一致）
const FB_BASE = 'https://www.gstatic.com/firebasejs/10.12.2/';
const FB_ENTRIES = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => FB_BASE + f);
const FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Noto+Sans+TC:wght@400;500;700&display=swap';

function isCacheableThirdParty(url) {
  return (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com' ||
    (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'))
  );
}

const okToCache = res => res && (res.ok || res.type === 'opaque');

/* 抓取並快取 ES 模組，順便遞迴處理它 import 的其他模組 */
async function precacheModule(url, cache, seen) {
  if (seen.has(url)) return;
  seen.add(url);
  try {
    let res = await cache.match(url);
    if (!res) {
      res = await fetch(url);
      if (!okToCache(res)) return;
      await cache.put(url, res.clone());
    }
    const text = await res.clone().text();
    const re = /(?:\bfrom|\bimport)\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(text))) {
      let next;
      try { next = new URL(m[1], url).href; } catch (e) { continue; }
      if (next.startsWith(FB_BASE)) await precacheModule(next, cache, seen);
    }
  } catch (e) { /* 離線或失敗：之後由 runtime 快取補上 */ }
}

/* 抓取字型 CSS，並把裡面引用的字型檔一起快取 */
async function precacheFonts(cache) {
  try {
    const res = await fetch(FONT_CSS);
    if (!okToCache(res)) return;
    await cache.put(FONT_CSS, res.clone());
    const css = await res.text();
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].replace(/["']/g, ''));
    await Promise.all(urls.map(async u => {
      try {
        if (await cache.match(u)) return;
        const r = await fetch(u);
        if (okToCache(r)) await cache.put(u, r);
      } catch (e) {}
    }));
  } catch (e) {}
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE_CACHE);
    await Promise.all(CORE_ASSETS.map(u =>
      core.add(new Request(u, { cache: 'reload' })).catch(err => console.warn('[SW] 無法快取', u, err))
    ));
    const rt = await caches.open(RUNTIME_CACHE);
    const seen = new Set();
    await Promise.all([
      ...FB_ENTRIES.map(u => precacheModule(u, rt, seen)),
      precacheFonts(rt)
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([CORE_CACHE, RUNTIME_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('kakeibo-') && !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* 網路優先（逾時改用快取）：用於頁面本身 */
async function handleNavigation(request) {
  const cache = await caches.open(CORE_CACHE);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (res && res.ok) {
      cache.put(request, res.clone());
      cache.put(INDEX, res.clone());
    }
    return res;
  } catch (e) {
    return (
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match(INDEX)) ||
      (await cache.match('./')) ||
      new Response('離線中，且尚未快取 App。請先在有網路時開啟一次。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })
    );
  }
}

/* 先給快取、背景更新：用於 icon / manifest / 字型 CSS */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(res => { if (okToCache(res)) cache.put(request, res.clone()); return res; })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

/* 快取優先：用於有版本號、內容不變的 Firebase 模組與字型檔 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (okToCache(res)) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, CORE_CACHE));
    return;
  }

  if (isCacheableThirdParty(url)) {
    const strategy = url.hostname === 'fonts.googleapis.com' ? staleWhileRevalidate : cacheFirst;
    event.respondWith(strategy(req, RUNTIME_CACHE));
  }
  // 其他（Firestore、Google 登入等 API）不攔截，直接走網路
});
