// インストールできるWebアプリ（PWA）にするための登録。
// オフラインでも開けるよう Service Worker（sw.js）を登録する。
// デスクトップアプリ（desktop フォルダ）の中では使わない（ファイルはアプリの中にあるため）。
if ('serviceWorker' in navigator && !window.desktopApi && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service Worker を登録できませんでした', err));
  });
}
