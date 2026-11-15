// オフラインでも開けるようにするための Service Worker（pwa.js が登録する）。
// つながっているときは常にサーバーから最新を取り（取れた物は控えておく）、
// つながらないときだけ控えを返す。こうすると、更新を push すれば次に開いたときに反映される。
const CACHE = 'superdot-v1';

// 最初に控えておくもの（エディタを開くのに必要なファイル）
const APP_SHELL = [
  './',
  'index.html',
  'editor.html',
  'help.html',
  'terms.html',
  'privacy.html',
  'legal.css',
  'style.css',
  'colorwheel.js',
  'script.js',
  'anim.js',
  'bones.js',
  'ai-bridge.js',
  'layout.js',
  'local-gallery.js',
  'tetris.js',
  'pwa.js',
  'manifest.webmanifest',
  'images/pixel-art_icon.png',
  'images/icon-192.png',
  'images/apple-touch-icon.png',
  'images/shape-icon.png',
  'images/heart.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // 名前の違う古い控えは消す
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // このサイトのファイルの読み込みだけを扱う（ログイン・クラウド保存などの通信には手を出さない）
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === 'navigate' ? caches.match('editor.html') : undefined))
        .then(hit => hit || Response.error())),
  );
});
