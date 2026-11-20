// スーパードットエディター・改 のデスクトップアプリ（Electron）。
// サイトと同じファイル（editor.html など）を、タブもアドレスバーも無い専用のウィンドウで開く。
// ・ログイン・クラウド保存・PEPORIS は使わない（editor.html が window.desktopApi を見て隠す）
// ・作品は「ドキュメント\SuperDotEditor」に作品ファイル（.dotkai.json）として保存する（preload.js の works）
const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

// 動作を確かめるとき用：SUPERDOT_USER_DATA を指定すると、自動保存や設定をそのフォルダに置く
// （入れてあるアプリの「前回の続きから」などを上書きしないように）
if (process.env.SUPERDOT_USER_DATA) app.setPath('userData', process.env.SUPERDOT_USER_DATA);

// サイトのファイルの場所：組み立てたアプリでは resources\web、開発中はこのフォルダの1つ上（リポジトリ）
const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..');
// 作品の保存先
// （SUPERDOT_WORKS_DIR を指定すると、そのフォルダを使う。動作を確かめるとき用）
const WORKS_DIR = process.env.SUPERDOT_WORKS_DIR || path.join(app.getPath('documents'), 'SuperDotEditor');
const THUMBS_DIR = path.join(WORKS_DIR, '.thumbs'); // ギャラリーの一覧に出す小さな絵
const EXT = '.dotkai.json';

// app://editor/editor.html のようにサイトのファイルを読む。
// file:// で開くより、保存（localStorage・IndexedDB）の場所が決まっていて安定する
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const START_URL = 'app://editor/editor.html';

app.setAppUserModelId('local.superdoteditor.kai');
// 2つ目を開こうとしたら、開いているウィンドウを前に出す
if (!app.requestSingleInstanceLock()) app.quit();

// ── ウィンドウの位置と大きさを覚える ──
const STATE_FILE = path.join(app.getPath('userData'), 'window.json');
async function readWindowState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch (err) { return null; }
}
function saveWindowState(win) {
  const state = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
  fs.writeFile(STATE_FILE, JSON.stringify(state)).catch(() => {});
}

let mainWindow = null;

async function createWindow() {
  const state = await readWindowState();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    ...(state && state.bounds ? state.bounds : {}),
    minWidth: 800,
    minHeight: 560,
    show: false,
    backgroundColor: '#f5f5f3',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 初めて開いたときは最大化する
  if (!state || state.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => saveWindowState(mainWindow));
  setupWebContents(mainWindow);
  mainWindow.loadURL(START_URL);
}

function setupWebContents(win) {
  const wc = win.webContents;
  // ヘルプなどアプリの中のページは別のウィンドウで、外のサイトはふだんのブラウザで開く
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('app://')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 900, height: 800, autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.ico') },
      };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 外のサイトへのページ移動は、ふだんのブラウザに回す
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith('app://')) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  // 保存していない変更があるときは、閉じる前に確かめる
  // （ページの「未保存の警告」は、アプリでは何も出さずに閉じるのを止めてしまうため、ここで聞く）
  wc.on('will-prevent-unload', e => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['閉じる', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      title: 'スーパードットエディター・改',
      message: '保存していない変更があります。閉じますか？',
      detail: '描いた絵は自動で保存されていて、次に開いたとき「前回の続きから」で戻せます。',
    });
    if (choice === 0) e.preventDefault(); // 止めずに閉じる
  });
  // メニューバーが無い代わりのキー：F11 で全画面、F12 で開発者ツール、Ctrl+R で読み込み直し
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.key === 'F12') { wc.toggleDevTools(); e.preventDefault(); }
    else if (input.key.toLowerCase() === 'r' && input.control && !input.alt) { wc.reload(); e.preventDefault(); }
  });
}

app.on('web-contents-created', (_e, wc) => {
  // ヘルプなどのウィンドウでも、外のサイトはふだんのブラウザで開く
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return url.startsWith('app://') ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } } : { action: 'deny' };
  });
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', req => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'editor.html';
    const file = path.normalize(path.join(WEB_ROOT, rel));
    // サイトのフォルダの外は読ませない
    if (!file.startsWith(WEB_ROOT + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());

// ── 作品の保存（ギャラリー） ──
// 1作品＝1ファイル（<作品名>.dotkai.json）。中身は「作品ファイルとして保存」と同じなので、
// このフォルダのファイルはブラウザ版の「作品ファイルを開く」でもそのまま開ける。
// id はファイル名。一覧の小さな絵は .thumbs フォルダに同じ名前の .png で置く。

async function ensureWorksDir() {
  await fs.mkdir(THUMBS_DIR, { recursive: true });
  // .thumbs はエクスプローラーで見えなくてよいので隠しフォルダにする（できなくても困らない）
  if (process.platform === 'win32') execFile('attrib', ['+h', THUMBS_DIR], () => {});
}

// 渡された id が、保存先フォルダの中の作品ファイルの名前かを確かめる
function workPath(id) {
  if (typeof id !== 'string' || !id.endsWith(EXT) || id !== path.basename(id)) throw new Error('作品の名前が正しくありません');
  return path.join(WORKS_DIR, id);
}
const thumbPath = id => path.join(THUMBS_DIR, id.slice(0, -EXT.length) + '.png');
const nameOf = id => id.slice(0, -EXT.length);

// 作品名を、ファイル名に使える形にする
function safeFileBase(name) {
  let base = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '');
  if (!base) base = '無題';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = '_' + base;
  return base.slice(0, 60);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch (err) { return false; }
}

// 途中で落ちても壊れたファイルが残らないよう、別名で書いてから置き換える
async function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function writeThumb(id, dataUrl) {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (m) await fs.writeFile(thumbPath(id), Buffer.from(m[1], 'base64')).catch(() => {});
}

ipcMain.on('works:folder', e => { e.returnValue = WORKS_DIR; });

ipcMain.handle('works:list', async () => {
  await ensureWorksDir();
  const names = (await fs.readdir(WORKS_DIR)).filter(n => n.endsWith(EXT));
  const works = await Promise.all(names.map(async id => {
    const file = path.join(WORKS_DIR, id);
    const st = await fs.stat(file);
    // 大きさ（縦横のマス数）は、ファイルの頭に書いてある所だけを読んで調べる
    let cols = 0, rows = 0;
    const fh = await fs.open(file, 'r');
    try {
      const { bytesRead, buffer } = await fh.read(Buffer.alloc(300), 0, 300, 0);
      const head = buffer.toString('utf8', 0, bytesRead);
      cols = +((/"cols":(\d+)/.exec(head) || [])[1] || 0);
      rows = +((/"rows":(\d+)/.exec(head) || [])[1] || 0);
    } finally { await fh.close(); }
    let thumb = null;
    try { thumb = 'data:image/png;base64,' + (await fs.readFile(thumbPath(id))).toString('base64'); } catch (err) { /* 絵が無い作品（手で入れたファイルなど） */ }
    return { id, name: nameOf(id), updatedAt: st.mtimeMs, thumb, cols, rows };
  }));
  return works.sort((a, b) => b.updatedAt - a.updatedAt);
});

ipcMain.handle('works:load', async (_e, id) => JSON.parse(await fs.readFile(workPath(id), 'utf8')));

ipcMain.handle('works:create', async (_e, name, file, thumb) => {
  await ensureWorksDir();
  // 同じ名前の作品があれば「名前 (2)」のように番号を付ける
  const base = safeFileBase(name);
  let id = base + EXT;
  for (let n = 2; await exists(path.join(WORKS_DIR, id)); n++) id = `${base} (${n})${EXT}`;
  await writeAtomic(workPath(id), JSON.stringify(file));
  await writeThumb(id, thumb);
  return { id, name: nameOf(id) };
});

ipcMain.handle('works:update', async (_e, id, file, thumb) => {
  const p = workPath(id);
  if (!await exists(p)) throw new Error('作品が見つかりません');
  await ensureWorksDir();
  await writeAtomic(p, JSON.stringify(file));
  await writeThumb(id, thumb);
  return { id, name: nameOf(id) };
});

// 削除はごみ箱へ移す（まちがえても戻せる）
ipcMain.handle('works:remove', async (_e, id) => {
  await shell.trashItem(workPath(id));
  await fs.rm(thumbPath(id), { force: true });
});

ipcMain.handle('works:openFolder', async () => {
  await ensureWorksDir();
  await shell.openPath(WORKS_DIR);
});
