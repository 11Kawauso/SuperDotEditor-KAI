// ── PEPORIS（テトリス風の落ち物パズル） ─────────────────
// 今のキャンバスサイズがそのまま盤面になるネタ機能。
// サイズは自由に変えられるので、やろうと思えば横1000マス以上のテトリスもできる。
// ブロックの色はカスタムカラーに色があればその中から選び、無ければランダムな色にする。
// script.js のグローバル（cols, rows, layers, customColors, wrap, canvasArea, setZoom など）を
// 使うため、script.js の後に読み込むこと。
//
// 画面の流れ：
//   開始 … キャンバス以外がかくかくと画面外へ消える → キャンバスが右へ寄り、
//          左からサイドパネルが出てくる → READY / GO! で開始
//   終了 … サイドパネルが引っ込み、キャンバスが元の位置へ戻る → ほかの部品が戻ってくる
(() => {
  // 各ブロックの形（n×nの枠の中のマス座標[x, y]）。回転はこの枠の中で行う
  const PIECES = {
    I: { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
    O: { n: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    T: { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
    S: { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
    Z: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
    J: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
    L: { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  };

  // 図（#がブロック）から形を作る。回転の中心がずれないよう、正方形の枠の中央に置く
  function fromPattern(lines) {
    const h = lines.length, w = Math.max(...lines.map(l => l.length));
    const n = Math.max(w, h);
    const ox = Math.floor((n - w) / 2), oy = Math.floor((n - h) / 2);
    const cells = [];
    lines.forEach((line, y) => [...line].forEach((ch, x) => { if (ch === '#') cells.push([x + ox, y + oy]); }));
    return { n, cells };
  }

  // 100×100以上の盤面でだけ出てくる特殊ブロック
  const EXTRA_MIN_SIZE = 100;
  const EXTRA_PIECES = {
    PLUS: fromPattern(['.#.', '###', '.#.']),
    U: fromPattern(['#.#', '###']),
    BIG: fromPattern(['###', '###', '###']),
    LONG: fromPattern(['########']),
    HEART: fromPattern(['##.##', '#####', '#####', '.###.', '..#..']),
  };
  const BASE_TYPES = Object.keys(PIECES);
  const EXTRA_TYPES = Object.keys(EXTRA_PIECES);

  // ── ブロックの形 ──
  // 自分で描いたブロック（カスタムブロック）は最大1024×1024・100万マスにもなるため、
  // 形はマスの座標の配列（型付き配列）で持ち、回転した形や「下・左・右の端のマス」は使うときに作って覚えておく。
  // def: { type, n（回転の枠の大きさ）, xs, ys（マスの座標）, colors（マスごとの色。nullならブロック1色） }
  const DEFS = {};
  function makeDef(type, n, xs, ys, colors = null) {
    const def = { type, n, xs, ys, colors, rots: [] };
    DEFS[type] = def;
    return def;
  }
  Object.entries({ ...PIECES, ...EXTRA_PIECES }).forEach(([t, { n, cells }]) => {
    makeDef(t, n, Int16Array.from(cells, p => p[0]), Int16Array.from(cells, p => p[1]));
  });
  const isCustomType = type => type.startsWith('custom:');

  // 回転した形（右回転：(x, y) → (n-1-y, x)）。動かしたときに当たり判定が要るのは、
  // 動く向きの端のマスだけなので、下・左・右の端のマスの番号も作っておく
  function shapeOf(type, rot) {
    const def = DEFS[type];
    if (def.rots[rot]) return def.rots[rot];
    const { n, xs: bx, ys: by } = def;
    const count = bx.length;
    const xs = new Int16Array(count), ys = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const x = bx[i], y = by[i];
      if (rot === 0) { xs[i] = x; ys[i] = y; }
      else if (rot === 1) { xs[i] = n - 1 - y; ys[i] = x; }
      else if (rot === 2) { xs[i] = n - 1 - x; ys[i] = n - 1 - y; }
      else { xs[i] = y; ys[i] = n - 1 - x; }
    }
    let minX = n, minY = n, maxX = -1, maxY = -1;
    const mask = new Uint8Array(n * n);
    for (let i = 0; i < count; i++) {
      mask[ys[i] * n + xs[i]] = 1;
      if (xs[i] < minX) minX = xs[i];
      if (xs[i] > maxX) maxX = xs[i];
      if (ys[i] < minY) minY = ys[i];
      if (ys[i] > maxY) maxY = ys[i];
    }
    const has = (x, y) => x >= 0 && y >= 0 && x < n && y < n && mask[y * n + x] === 1;
    const edge = (dx, dy) => {
      const list = [];
      for (let i = 0; i < count; i++) if (!has(xs[i] + dx, ys[i] + dy)) list.push(i);
      return Int32Array.from(list);
    };
    const s = {
      xs, ys, count, minX, minY, maxX, maxY,
      bottoms: edge(0, 1), lefts: edge(-1, 0), rights: edge(1, 0),
      img: def.colors ? shapeImage(def, xs, ys, minX, minY, maxX, maxY) : null,
    };
    def.rots[rot] = s;
    return s;
  }

  // 色のあるブロック（カスタムブロック）の見た目を、形の範囲ぶんの小さなキャンバスに描いておく
  function shapeImage(def, xs, ys, minX, minY, maxX, maxY) {
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    const px = new Uint32Array(img.data.buffer);
    for (let i = 0; i < xs.length; i++) px[(ys[i] - minY) * w + (xs[i] - minX)] = def.colors[i];
    ctx.putImageData(img, 0, 0);
    return cv;
  }
  // 回転して壁や他のブロックにぶつかったとき、ずらして収まる位置を順に試す。
  // 通常の7種類は本家と同じSRS（スーパーローテーションシステム）の表を使う。
  // 表は本家の資料どおり上向きが+yで書き、下向きが+yの盤面に合わせて符号を反転する。
  // キーは「回転前の向き」「回転後の向き」（0=出現時, 1=右, 2=逆さ, 3=左）
  const flipY = table => Object.fromEntries(
    Object.entries(table).map(([k, list]) => [k, list.map(([x, y]) => [x, -y])])
  );
  const SRS_JLSTZ = flipY({
    '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  });
  const SRS_I = flipY({
    '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  });
  // 特殊ブロック用（SRSの表が無いので、左右・上に少しずらして試す）
  const EXTRA_KICKS = [[0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0], [-1, -1], [1, -1]];
  function kicksFor(type, from, to) {
    if (type === 'I') return SRS_I[`${from}${to}`];
    if (type in PIECES) return SRS_JLSTZ[`${from}${to}`]; // Oは回しても形が変わらないので(0,0)で収まる
    return EXTRA_KICKS; // 特殊ブロック・カスタムブロック
  }

  // 本家のブロックの色（ホーム画面から直接遊ぶとき）
  const STANDARD_COLORS = {
    I: '#31c7ef', O: '#f7d308', T: '#ad4d9c', S: '#42b642', Z: '#ef2029', J: '#5a65ad', L: '#ef7921',
  };
  const STANDARD_COLS = 10, STANDARD_ROWS = 20;

  const DAS = 170;             // 左右キーを押しっぱなしにしてから連続移動が始まるまで
  const ARR = 33;              // 連続移動の間隔
  const NEXT_COUNT = 3;        // 先に見せるブロックの数
  const SOFT_DROP_INTERVAL = 16;
  const LOCK_DELAY = 500;      // 着地してから固定されるまでの猶予
  const MAX_LOCK_RESETS = 15;  // ノーマルモードで、着地後に動かして猶予を延ばせる回数

  // ルールの違い
  //   normal … 本家（ガイドライン）と同じ。着地後も動かせば猶予が延び（15回まで）、
  //            ゆっくり落とすと1段1点、一気に落とすと1段2点も入る
  //   hard   … このサイト独自。着地後の猶予は延びず、得点はライン消去のみ
  const MODE_LABELS = { normal: 'NORMAL', hard: 'HARD' };
  const MODE_KEY = 'pixelart-tetris-mode'; // 前回選んだモードを覚えておく
  const FLASH_MS = 260;        // 揃った行が光ってから消えるまで
  const LINE_SCORES = [0, 100, 300, 500, 800];
  const LINE_NAMES = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'PEPORIS!']; // 4列同時はゲーム名で祝う

  // 画面の出入りの演出（CSSのアニメーション時間と合わせる）
  const UI_OUT_MS = 1200;      // エディタの部品が消える／戻る
  const SIDE_MS = 1000;        // サイドパネルが出る／引っ込む
  const MOVE_STEPS = 6;        // キャンバスの移動も、かくかくと6段階で動かす

  const side = document.getElementById('tetris-side');
  const pad = document.getElementById('tetris-pad');
  const elSize = document.getElementById('tetris-size');
  const elScore = document.getElementById('tetris-score');
  const elLines = document.getElementById('tetris-lines');
  const elLevel = document.getElementById('tetris-level');
  const elMsg = document.getElementById('tetris-msg');
  const elNote = document.getElementById('tetris-note');
  const colorsBox = document.getElementById('tetris-colors-box');
  const colorsEl = document.getElementById('tetris-colors');
  const nextCanvases = ['tetris-next', 'tetris-next2', 'tetris-next3'].map(id => document.getElementById(id));
  const holdCanvas = document.getElementById('tetris-hold');
  const modePanel = document.getElementById('tetris-mode-panel');
  const modeBtns = [...modePanel.querySelectorAll('.tetris-mode-btn')];
  const panel = document.getElementById('tetris-panel');
  const panelTitle = document.getElementById('tetris-panel-title');
  const btnPause = document.getElementById('btn-tetris-pause');
  const btnResume = document.getElementById('btn-tetris-resume');
  const btnKeep = document.getElementById('btn-tetris-keep');
  const btnRetryArt = document.getElementById('btn-tetris-retry-art');

  // 遊んでいる間のゲーム状態。遊んでいないときはnull。
  // state: 'intro'（画面切り替え中）| 'playing' | 'paused' | 'over' | 'outro'（終了演出中）
  let g = null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── 色 ──
  function randomHex() {
    // 真っ白・真っ黒に近い色だと背景に紛れて見えないので、明るさと鮮やかさは程々にする
    const h = Math.random() * 360;
    const s = 0.55 + Math.random() * 0.4;
    const l = 0.4 + Math.random() * 0.2;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  }

  function pickColor(type) {
    const hex = g.standard ? STANDARD_COLORS[type]
      : g.palette.length ? g.palette[Math.floor(Math.random() * g.palette.length)]
      : randomHex();
    const u32 = hexToU32(hex);
    g.hexOf.set(u32, hex); // レイヤーに残すときに色へ戻すため
    return { hex, u32 };
  }

  // 形を1巡ずつシャッフルして出す（同じ形ばかり続かないように）。
  // 出すのはブロック画面でチェックした形だけ。カスタムブロックは描いた色のままなので色を選ばない
  function nextPiece() {
    if (!g.bag.length) {
      g.bag = [...g.types];
      for (let i = g.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [g.bag[i], g.bag[j]] = [g.bag[j], g.bag[i]];
      }
    }
    const type = g.bag.pop();
    return { type, color: DEFS[type].colors ? null : pickColor(type) };
  }

  // ネクストの先頭を取り出し、列の最後に新しいブロックを足す
  function takeNext() {
    const piece = g.queue.shift();
    g.queue.push(nextPiece());
    return piece;
  }

  // ── 盤面 ──
  // list（マスの番号）を省くと全部のマスを調べる
  function collides(type, rot, x, y, list = null) {
    const { xs, ys, count } = shapeOf(type, rot);
    const { w, h, field } = g;
    const len = list ? list.length : count;
    for (let k = 0; k < len; k++) {
      const i = list ? list[k] : k;
      const cx = x + xs[i], cy = y + ys[i];
      if (cx < 0 || cx >= w || cy >= h) return true;
      if (cy >= 0 && field[cy * w + cx]) return true; // 盤面より上はまだ空いている扱い
    }
    return false;
  }

  // 今の位置から1マス動かせるか。今の位置では重なっていないので、動く向きの端のマスだけ調べればよい
  function blocked(c, dx, dy) {
    const s = shapeOf(c.type, c.rot);
    const list = dy > 0 ? s.bottoms : dx < 0 ? s.lefts : s.rights;
    return collides(c.type, c.rot, c.x + dx, c.y + dy, list);
  }

  // 各列について、その段から下で最初に埋まっている段（無ければ盤面の高さ）。
  // ゴースト（落下位置）を大きなブロックでもすぐ求められるよう、盤面が変わるたびに作り直す
  function updateBelow() {
    const { w, h, field } = g;
    if (!g.below || g.below.length !== w * h) g.below = new Int32Array(w * h);
    const below = g.below;
    for (let c = 0; c < w; c++) {
      let next = h;
      for (let r = h - 1; r >= 0; r--) {
        if (field[r * w + c]) next = r;
        below[r * w + c] = next;
      }
    }
  }

  function spawn(piece) {
    const n = DEFS[piece.type].n;
    g.cur = {
      ...piece,
      rot: 0,
      x: Math.floor((g.w - n) / 2),
      y: -shapeOf(piece.type, 0).minY, // 枠の上の空き段を詰めて、最上段に出す
    };
    g.lockAt = null;
    g.lockResets = 0;
    g.lowestY = g.cur.y; // これまでで一番下まで落ちた位置
    g.lastFall = performance.now();
    if (collides(g.cur.type, g.cur.rot, g.cur.x, g.cur.y)) {
      gameOver();
      return;
    }
    g.dirty = true;
  }

  function nextTurn() {
    g.holdUsed = false;
    spawn(takeNext());
    updateHud();
  }

  // これまでより下の段まで落ちたとき（段差から落ちた、回転で下にずれたなど）は、
  // 新しく着地したものとして猶予を最初から数え直す
  function updateLowest() {
    if (g.cur.y > g.lowestY) {
      g.lowestY = g.cur.y;
      g.lockAt = null;
      g.lockResets = 0;
    }
  }

  // 着地後に動かしたとき、ノーマルモードでは猶予を延ばす（15回まで）。
  // ハードモードでは延ばさない（下に着いたまま動き続けられないように）
  function afterMove() {
    updateLowest();
    if (g.mode === 'normal' && g.lockAt !== null && g.lockResets < MAX_LOCK_RESETS) {
      g.lockAt = performance.now() + LOCK_DELAY;
      g.lockResets++;
    }
    g.dirty = true;
  }

  function tryMove(dx, dy) {
    const c = g.cur;
    if (blocked(c, dx, dy)) return false;
    c.x += dx;
    c.y += dy;
    afterMove();
    return true;
  }

  function rotate(dir) {
    const c = g.cur;
    const rot = (c.rot + dir + 4) % 4;
    for (const [kx, ky] of kicksFor(c.type, c.rot, rot)) {
      if (!collides(c.type, rot, c.x + kx, c.y + ky)) {
        c.rot = rot;
        c.x += kx;
        c.y += ky;
        afterMove();
        return;
      }
    }
  }

  // 落下位置：下の端のマスそれぞれについて、その下で最初に埋まっている段までの距離の最小値
  function ghostY() {
    const c = g.cur;
    const { xs, ys, bottoms } = shapeOf(c.type, c.rot);
    const { w, h, below } = g;
    let drop = h;
    for (let k = 0; k < bottoms.length; k++) {
      const i = bottoms[k];
      const cx = c.x + xs[i], cy = c.y + ys[i];
      const r = cy + 1;
      const hit = r >= h ? h : below[Math.max(0, r) * w + cx];
      const d = hit - cy - 1;
      if (d < drop) drop = d;
    }
    return c.y + drop;
  }

  // ノーマルモードでは落とした段数×2点が入る（ハードモードは横一列が揃ったときだけ）
  function hardDrop() {
    const y = ghostY();
    if (g.mode === 'normal') g.score += (y - g.cur.y) * 2;
    g.cur.y = y;
    lockPiece();
  }

  function hold() {
    if (g.holdUsed) return;
    const { type, color } = g.cur;
    const held = g.hold;
    g.hold = { type, color };
    spawn(held || takeNext());
    g.holdUsed = true;
    updateHud();
  }

  function lockPiece() {
    const c = g.cur;
    const s = shapeOf(c.type, c.rot);
    const colors = DEFS[c.type].colors;
    const { w, field, rowFill } = g;
    let lockedOut = false;
    for (let i = 0; i < s.count; i++) {
      const cx = c.x + s.xs[i], cy = c.y + s.ys[i];
      if (cy < 0) { lockedOut = true; continue; } // 盤面からはみ出したまま積もった
      field[cy * w + cx] = colors ? colors[i] : c.color.u32;
      rowFill[cy]++;
    }
    // 盤面の画像は、ブロックが置かれた範囲だけ描き直す
    g.fieldCtx.putImageData(g.fieldImg, 0, 0,
      c.x + s.minX, c.y + s.minY, s.maxX - s.minX + 1, s.maxY - s.minY + 1);
    updateBelow();
    g.cur = null;
    if (lockedOut) { gameOver(); return; }
    const full = [];
    for (let r = 0; r < g.h; r++) if (g.rowFill[r] === g.w) full.push(r);
    if (full.length) {
      // すぐには消さず、少しだけ光らせてから消す（ループ側で処理する）
      g.clearing = { rows: full, start: performance.now() };
      return;
    }
    nextTurn();
  }

  // 揃った行を消し、上の行を詰めて落とす
  function clearLines(cleared) {
    const { w, h, field, rowFill } = g;
    let dst = h - 1;
    for (let r = h - 1; r >= 0; r--) {
      if (rowFill[r] === w) continue;
      if (dst !== r) {
        field.copyWithin(dst * w, r * w, r * w + w);
        rowFill[dst] = rowFill[r];
      }
      dst--;
    }
    field.fill(0, 0, (dst + 1) * w);
    rowFill.fill(0, 0, dst + 1);
    g.fieldCtx.putImageData(g.fieldImg, 0, 0);
    updateBelow();

    const n = Math.min(cleared, 4);
    g.score += LINE_SCORES[n] * currentLevel();
    g.lines += cleared;
    showMessage(LINE_NAMES[n]);
  }

  function currentLevel() {
    return 1 + Math.floor(g.lines / 10);
  }

  // 1段落ちるまでの時間。本家（ガイドライン）の式：(0.8 - (レベル-1)×0.007)^(レベル-1) 秒
  function fallInterval() {
    const lv = Math.min(currentLevel(), 20);
    return Math.max(16, 1000 * Math.pow(0.8 - (lv - 1) * 0.007, lv - 1));
  }

  // ── 表示 ──
  function renderPiece() {
    const ctx = g.pieceCtx;
    ctx.clearRect(0, 0, g.w, g.h);
    renderGhost();
    const c = g.cur;
    if (!c) return;
    const s = shapeOf(c.type, c.rot);
    if (s.img) { ctx.drawImage(s.img, c.x + s.minX, c.y + s.minY); return; } // 盤面より上の部分は自然に切れる
    ctx.fillStyle = c.color.hex;
    for (let i = 0; i < s.count; i++) {
      if (c.y + s.ys[i] >= 0) ctx.fillRect(c.x + s.xs[i], c.y + s.ys[i], 1, 1);
    }
  }

  // 色を暗くする（f=0.5なら明るさ半分）
  function shadeHex(hex, f) {
    return '#' + [1, 3, 5].map(i =>
      Math.round(parseInt(hex.slice(i, i + 2), 16) * f).toString(16).padStart(2, '0')
    ).join('');
  }

  // 落下位置の表示（ゴースト）。盤面のキャンバスは1マス=1ピクセルでマスの中に線を
  // 引けないため、ゴーストの範囲だけを覆う専用の小さなキャンバスに、1マスを
  // GHOST_PXピクセルで描く。ブロックの色を暗くした斜線と外周の線で、はっきり見せる。
  const GHOST_PX = 10;
  const GHOST_STRIPE = 5; // 斜線の間隔（1マスに2本）
  const GHOST_DETAIL_MAX = 200; // これより多いマスのブロックは、斜線を引かず薄く重ねるだけにする
  const CUSTOM_GHOST_COLOR = '#9a9aa8'; // 色がマスごとに違うカスタムブロックのゴーストの色
  function renderGhost() {
    const cv = g.ghostCanvas;
    const c = g.cur;
    if (!c) { cv.style.display = 'none'; return; }
    const s = shapeOf(c.type, c.rot);
    const gy = ghostY();
    // ゴーストの範囲（盤面より上は表示しない）
    const minX = c.x + s.minX, maxX = c.x + s.maxX;
    const minY = Math.max(0, gy + s.minY), maxY = gy + s.maxY;
    if (maxY < 0) { cv.style.display = 'none'; return; }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const detail = s.count <= GHOST_DETAIL_MAX;
    const P = detail ? GHOST_PX : 1;
    cv.width = bw * P;
    cv.height = bh * P;
    Object.assign(cv.style, {
      display: '',
      left: `${minX / g.w * 100}%`,
      top: `${minY / g.h * 100}%`,
      width: `${bw / g.w * 100}%`,
      height: `${bh / g.h * 100}%`,
    });
    const ctx = cv.getContext('2d');
    const hex = c.color ? c.color.hex : CUSTOM_GHOST_COLOR;

    if (!detail) {
      // 大きなブロックは、ブロックの形をそのまま薄く重ねる
      ctx.globalAlpha = 0.35;
      if (s.img) {
        ctx.drawImage(s.img, c.x + s.minX - minX, gy + s.minY - minY);
      } else {
        ctx.fillStyle = hex;
        for (let i = 0; i < s.count; i++) ctx.fillRect(c.x + s.xs[i] - minX, gy + s.ys[i] - minY, 1, 1);
      }
      ctx.globalAlpha = 1;
      return;
    }

    const cells = [];
    for (let i = 0; i < s.count; i++) {
      const y = gy + s.ys[i];
      if (y >= 0) cells.push([c.x + s.xs[i], y]);
    }
    const filled = new Set(cells.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of cells) {
      const ox = (x - minX) * P, oy = (y - minY) * P;
      // 薄い下地
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = hex;
      ctx.fillRect(ox, oy, P, P);
      ctx.globalAlpha = 1;
      // 斜線（キャンバス全体の座標で引くので、隣のマスとつながった線になる）
      ctx.fillStyle = shadeHex(hex, 0.55);
      for (let py = 0; py < P; py++) {
        for (let px = 0; px < P; px++) {
          if ((ox + px + oy + py) % GHOST_STRIPE === 0) ctx.fillRect(ox + px, oy + py, 1, 1);
        }
      }
      // 外周の線（隣がゴーストでない辺だけ）
      if (!filled.has(`${x},${y - 1}`)) ctx.fillRect(ox, oy, P, 1);
      if (!filled.has(`${x},${y + 1}`)) ctx.fillRect(ox, oy + P - 1, P, 1);
      if (!filled.has(`${x - 1},${y}`)) ctx.fillRect(ox, oy, 1, P);
      if (!filled.has(`${x + 1},${y}`)) ctx.fillRect(ox + P - 1, oy, 1, P);
    }
  }

  // 揃った行を白く光らせる。昔のゲームらしく、なめらかに消さず3段階で明るさを変える
  function renderFlash(t) {
    g.ghostCanvas.style.display = 'none';
    const ctx = g.pieceCtx;
    ctx.clearRect(0, 0, g.w, g.h);
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = t < 1 / 3 ? 0.85 : t < 2 / 3 ? 0.45 : 0.75;
    for (const r of g.clearing.rows) ctx.fillRect(0, r, g.w, 1);
    ctx.globalAlpha = 1;
  }

  // ネクスト・ホールドの小さな表示（中央寄せ。小さいブロックは1マス2ピクセル）
  function drawPreview(canvas, piece) {
    if (!piece) { canvas.width = canvas.height = 10; return; }
    drawShape(canvas, piece.type, piece.color ? piece.color.hex : null);
  }

  // 形を canvas の中央に描く（ブロック画面の一覧でも使う）。hex が null なら描いた色のまま
  function drawShape(canvas, type, hex) {
    const s = shapeOf(type, 0);
    const bw = s.maxX - s.minX + 1, bh = s.maxY - s.minY + 1;
    const size = Math.max(4, bw, bh) + 1; // 周りに少し余白を取る
    const scale = size <= 64 ? 2 : 1;
    canvas.width = canvas.height = size * scale;
    const ctx = canvas.getContext('2d');
    const ox = (size - bw) * scale / 2, oy = (size - bh) * scale / 2;
    if (s.img) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(s.img, ox, oy, bw * scale, bh * scale);
      return;
    }
    ctx.fillStyle = hex;
    for (let i = 0; i < s.count; i++) {
      ctx.fillRect(ox + (s.xs[i] - s.minX) * scale, oy + (s.ys[i] - s.minY) * scale, scale, scale);
    }
  }

  function updateHud() {
    elScore.textContent = g.score.toLocaleString();
    elLines.textContent = g.lines.toLocaleString();
    elLevel.textContent = currentLevel();
    nextCanvases.forEach((cv, i) => drawPreview(cv, g.queue[i]));
    drawPreview(holdCanvas, g.hold);
    holdCanvas.style.opacity = g.holdUsed ? 0.4 : 1;
  }

  let msgTimer = null;
  function showMessage(text, ms = 1200) {
    elMsg.textContent = text;
    clearTimeout(msgTimer);
    if (ms) msgTimer = setTimeout(() => { elMsg.textContent = ''; }, ms);
  }

  // サイドパネルに隠れていない、キャンバスが見えている範囲
  function playArea() {
    const a = canvasArea.getBoundingClientRect();
    const left = Math.max(a.left, side.offsetWidth);
    return { left, top: a.top, right: a.right, bottom: a.bottom };
  }

  // ── キャンバスの配置 ──
  function canvasCenter() {
    const r = wrap.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // 倍率を変え、キャンバスの中心が画面上の(x, y)に来るようにスクロールする
  function placeCanvas(z, x, y) {
    setZoom(z);
    const c = canvasCenter();
    canvasArea.scrollLeft += c.x - x;
    canvasArea.scrollTop += c.y - y;
  }

  // 今の位置から目的の倍率・位置まで、MOVE_STEPS段階に分けてかくかくと動かす
  async function moveCanvasStepped(z1, x1, y1, duration) {
    const z0 = zoom;
    const { x: x0, y: y0 } = canvasCenter();
    for (let i = 1; i <= MOVE_STEPS; i++) {
      await sleep(duration / MOVE_STEPS);
      const t = i / MOVE_STEPS;
      placeCanvas(z0 * Math.pow(z1 / z0, t), x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  }

  // テトリス画面でのキャンバスの置き場所：サイドパネルの右側の中央。
  // 見える範囲にちょうど収まる倍率にする。ただし巨大な盤面を丸ごと収めると
  // 1マスが見えないほど小さくなるので、1マスが画面上で3px未満になるほどは縮めない
  const MIN_CELL_ON_SCREEN = 3;
  function gameViewTarget() {
    const { left, top, right, bottom } = playArea();
    const { w, h } = canvasSize();
    const fit = Math.min((right - left) * 0.86 / w, (bottom - top) * 0.86 / h);
    const lower = Math.min(zoom, MIN_CELL_ON_SCREEN / cellPx());
    return {
      zoom: Math.max(lower, Math.min(fit, MAX_ZOOM)),
      x: (left + right) / 2,
      y: (top + bottom) / 2,
    };
  }

  // 画面の構成（キャンバスエリアの大きさ）が変わっても、キャンバスが画面上で動かないようにする
  function switchLayout(fn) {
    const pos = canvasScreenPos();
    fn();
    setZoom(zoom); // エリアの大きさに合わせてスクロール用の余白を取り直す
    restoreCanvasScreenPos(pos);
  }

  // ── ループ ──
  function horizontalDir() {
    const { left, right } = g.held;
    if (left && right) return g.lastDir;
    return left ? 'left' : right ? 'right' : null;
  }

  // 押しっぱなしの時間が長いほど1回に進むマス数を増やす。
  // 横1000マスの盤面を1マスずつ運んでいたら日が暮れるため（32マス程度の盤面では常に1マス）
  function shiftSteps(heldFor) {
    const max = Math.max(1, Math.floor(g.w / 32));
    return Math.min(max, 1 + Math.floor((heldFor - DAS) / 500));
  }

  function tick(now) {
    if (!g || g.state === 'outro') return;
    g.raf = requestAnimationFrame(tick);
    if (g.state !== 'playing') return;

    if (g.clearing) {
      const t = (now - g.clearing.start) / FLASH_MS;
      if (t < 1) { renderFlash(t); return; }
      clearLines(g.clearing.rows.length);
      g.clearing = null;
      nextTurn();
    }
    if (!g.cur) return;

    const dir = horizontalDir();
    if (dir) {
      const heldFor = now - g.held[dir];
      if (heldFor >= DAS && now - g.lastShift >= ARR) {
        const dx = dir === 'left' ? -1 : 1;
        for (let i = shiftSteps(heldFor); i > 0; i--) if (!tryMove(dx, 0)) break;
        g.lastShift = now;
      }
    }

    const c = g.cur;
    if (blocked(c, 0, 1)) {
      if (g.lockAt === null) g.lockAt = now + LOCK_DELAY;
      else if (now >= g.lockAt) lockPiece();
    } else {
      // 回転の壁蹴りなどで一瞬浮いても猶予は止めずに減らし続ける（浮かせて粘れないように）。
      // 猶予が切れた状態で再び着地すると、その場で固定される
      const interval = g.held.down ? Math.min(SOFT_DROP_INTERVAL, fallInterval()) : fallInterval();
      if (now - g.lastFall >= interval) {
        c.y++;
        g.lastFall = now;
        updateLowest();
        // ノーマルモードでは、ゆっくり落とした1段ごとに1点
        if (g.held.down && g.mode === 'normal') { g.score++; updateHud(); }
        g.dirty = true;
      }
    }

    if (g.dirty && g.cur) { renderPiece(); g.dirty = false; }
  }

  // ── 操作 ──
  function press(act) {
    if (!g || g.state !== 'playing' || !g.cur) return;
    const now = performance.now();
    switch (act) {
      case 'left':
      case 'right':
        g.held[act] = now;
        g.lastDir = act;
        g.lastShift = now;
        tryMove(act === 'left' ? -1 : 1, 0);
        break;
      case 'down':
        g.held.down = now;
        g.lastFall = 0; // 押した瞬間に1段落とす
        break;
      case 'cw': rotate(1); break;
      case 'ccw': rotate(-1); break;
      case 'drop': hardDrop(); break;
      case 'hold': hold(); break;
    }
    if (g && g.cur) renderPiece();
  }

  function release(act) {
    if (g && g.held && act in g.held) g.held[act] = 0;
  }

  const KEY_ACTIONS = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowDown: 'down', KeyS: 'down',
    ArrowUp: 'cw', KeyX: 'cw', KeyW: 'cw',
    KeyZ: 'ccw',
    Space: 'drop',
    KeyC: 'hold', ShiftLeft: 'hold', ShiftRight: 'hold',
  };

  // 遊んでいる間（出入りの演出中も含む）はエディタのショートカット（ツール切替・Undo・
  // Dキーの確認モードなど）を一切効かせないよう、どのリスナーより先に受け取って止める
  window.addEventListener('keydown', e => {
    if (!g) return;
    if (g.state === 'blocks') {
      // ブロック画面ではチェックや矢印キーでのスクロールなど、普通の操作に任せる
      // （チェックボックスにフォーカスがあっても、エディタのショートカットは効かせない）
      e.stopImmediatePropagation();
      if (e.code === 'Escape') { e.preventDefault(); closeBlocksScreen(); }
      return;
    }
    if (isTypingTarget(e.target)) return;
    e.stopImmediatePropagation();
    if (e.code === 'Escape' || e.code === 'KeyP') {
      e.preventDefault();
      if (g.state === 'playing') pause();
      else if (g.state === 'paused') resume();
      return;
    }
    // モード選択中は↑↓で選び、Enter・Spaceで決定（決定はボタン本来の動作に任せる）
    if (g.state === 'select' && ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS'].includes(e.code)) {
      e.preventDefault();
      const i = modeBtns.findIndex(b => b.classList.contains('is-selected'));
      const dir = e.code === 'ArrowUp' || e.code === 'KeyW' ? -1 : 1;
      selectModeBtn(modeBtns[(i + dir + modeBtns.length) % modeBtns.length]);
      return;
    }
    if (g.state !== 'playing') return; // ポーズ中などはパネルのボタン操作（Enter・Space）を妨げない
    const act = KEY_ACTIONS[e.code];
    if (!act) return;
    e.preventDefault();
    if (e.repeat) return; // 押しっぱなしはループ側で処理する
    press(act);
  }, true);

  window.addEventListener('keyup', e => {
    if (!g) return;
    e.stopImmediatePropagation();
    const act = KEY_ACTIONS[e.code];
    if (!act) return;
    if (g.state === 'playing') e.preventDefault();
    release(act);
  }, true);

  // 別のウィンドウに移ったらポーズ（押しっぱなしのキーの離した通知も来なくなるため）
  window.addEventListener('blur', () => { if (g && g.state === 'playing') pause(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && g && g.state === 'playing') pause();
  });

  pad.querySelectorAll('button').forEach(b => {
    const act = b.dataset.act;
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* 捕捉できなくても押している間は効く */ }
      press(act);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => {
      b.addEventListener(type, () => release(act));
    });
    b.addEventListener('contextmenu', e => e.preventDefault());
  });

  // テトリス中のキャンバスは、落下中のブロックとは関係なく自由に動かせる。
  // マウスのドラッグでの移動はここで扱う。ホイール・タッチパッドのスクロール、
  // Ctrl+ホイール・ピンチでの拡大縮小、タッチの1本指スクロールはエディタと同じ仕組みがそのまま効く
  let panDrag = null;
  canvasArea.addEventListener('pointerdown', e => {
    if (!g || e.pointerType !== 'mouse' || e.button !== 0) return;
    e.preventDefault();
    panDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, sl: canvasArea.scrollLeft, st: canvasArea.scrollTop };
    try { canvasArea.setPointerCapture(e.pointerId); } catch (err) { /* 捕捉できなくても動かせる */ }
    canvasArea.classList.add('tetris-grabbing');
  });
  canvasArea.addEventListener('pointermove', e => {
    if (!panDrag || e.pointerId !== panDrag.id) return;
    canvasArea.scrollLeft = panDrag.sl - (e.clientX - panDrag.x);
    canvasArea.scrollTop = panDrag.st - (e.clientY - panDrag.y);
  });
  ['pointerup', 'pointercancel'].forEach(type => {
    canvasArea.addEventListener(type, e => {
      if (!panDrag || e.pointerId !== panDrag.id) return;
      panDrag = null;
      canvasArea.classList.remove('tetris-grabbing');
    });
  });

  // ── ポーズ・ゲームオーバー ──
  function showPanel(title, mode) {
    panelTitle.textContent = title;
    btnResume.style.display = mode === 'paused' ? '' : 'none';
    btnRetryArt.style.display = g.standard ? 'none' : ''; // 本家モードのキャンバスには絵が無い
    btnKeep.disabled = !g.field.some(Boolean);
    side.scrollTop = 0; // 重ねる画面はパネルの最上部に置いているため、スクロールしていたら戻す
    panel.style.display = '';
  }

  function hidePanel() {
    panel.style.display = 'none';
  }

  function pause() {
    g.state = 'paused';
    g.held = { left: 0, right: 0, down: 0 };
    // 着地後の残り猶予を覚えておく（ポーズを繰り返して猶予を延ばせないように）
    g.lockRemain = g.lockAt !== null ? Math.max(0, g.lockAt - performance.now()) : null;
    showPanel('PAUSE', 'paused');
  }

  function resume() {
    g.state = 'playing';
    g.lastFall = performance.now();
    if (g.lockAt !== null) g.lockAt = performance.now() + g.lockRemain;
    hidePanel();
    if (document.activeElement) document.activeElement.blur(); // Spaceでボタンが押されないように
  }

  function gameOver() {
    g.state = 'over';
    g.cur = null;
    renderPiece(); // 落下中のブロックとゴーストを消す
    showPanel(`GAME OVER\nSCORE ${g.score.toLocaleString()}`, 'over');
  }

  // ── 盤面の準備 ──
  // useArtなら今の絵（見えているレイヤーを重ねた色）を積もったブロックとして置く
  function resetBoard(useArt) {
    const { w, h } = g;
    g.fieldImg = g.fieldCtx.createImageData(w, h);
    g.field = new Uint32Array(g.fieldImg.data.buffer);
    g.rowFill = new Int32Array(h);
    if (useArt) {
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const hex = compositeAt(r, c);
          if (!hex) continue;
          const u32 = hexToU32(hex);
          g.hexOf.set(u32, hex);
          g.field[r * w + c] = u32;
          g.rowFill[r]++;
        }
      }
    }
    g.fieldCtx.putImageData(g.fieldImg, 0, 0);
    updateBelow();
    g.cur = null;
    renderPiece();
    g.clearing = null;
    // 出すブロック（ブロック画面でチェックしてあり、この盤面で使えるもの）
    g.types = activeTypes();
    g.types.forEach(t => (DEFS[t].hexes || []).forEach(([u32, hex]) => g.hexOf.set(u32, hex)));
    updateNote();
    g.bag = [];
    g.score = 0;
    g.lines = 0;
    g.hold = null;
    g.holdUsed = false;
    g.held = { left: 0, right: 0, down: 0 };
    g.lastDir = null;
    g.lastShift = 0;
    g.queue = g.types.length ? Array.from({ length: NEXT_COUNT }, () => nextPiece()) : [];
    elMsg.textContent = '';
    hidePanel();
    updateHud();
  }

  function startRound() {
    g.state = 'playing';
    spawn(takeNext());
    updateHud();
  }

  function retry(useArt) {
    resetBoard(useArt);
    startRound();
    if (document.activeElement) document.activeElement.blur();
  }

  function makeLayerCanvas() {
    const cv = document.createElement('canvas');
    cv.className = 'tetris-layer';
    cv.width = cols;
    cv.height = rows;
    return cv;
  }

  // ── モード ──
  function loadMode() {
    try {
      const m = localStorage.getItem(MODE_KEY);
      if (m in MODE_LABELS) return m;
    } catch (err) { /* 読めなければノーマルにする */ }
    return 'normal';
  }

  function setMode(mode) {
    g.mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch (err) { /* 覚えられなくても遊ぶのに支障はない */ }
    elSize.textContent = `${g.w}×${g.h} · ${MODE_LABELS[mode]}`;
  }

  // メニュー（モード選択・ブロック・終了）を出し、選ばれたモードで解決するPromiseを返す。
  // ゲームオーバーやポーズからもここへ戻れるので、エディタに戻らずにPEPORISの画面にとどまれる
  function chooseMode() {
    g.state = 'select';
    side.scrollTop = 0; // 重ねる画面はパネルの最上部に置いているため
    menuNote.textContent = '';
    updateBlocksSummary();
    modePanel.style.display = '';
    selectModeBtn(modeBtns.find(b => b.dataset.mode === g.mode) || modeBtns[0]);
    return new Promise(resolve => { g.resolveMode = resolve; });
  }

  // ▶カーソルを付けてフォーカスする（:focusはウィンドウが非アクティブだと
  // 効かないことがあるため、見た目はクラスで付ける）
  function selectModeBtn(b) {
    modeBtns.forEach(o => o.classList.toggle('is-selected', o === b));
    b.focus();
  }

  modeBtns.forEach(b => {
    b.addEventListener('pointerenter', () => selectModeBtn(b)); // マウスを乗せた方に▶カーソルを移す
    b.addEventListener('focus', () => selectModeBtn(b));        // Tabキーで移ったとき
    b.addEventListener('click', () => {
      if (!g || g.state !== 'select') return;
      if (b.dataset.action === 'blocks') { openBlocksScreen(); return; }
      if (b.dataset.action === 'quit') { closeGame(false); return; }
      if (!activeTypes().length) {
        menuNote.textContent = '出てくるブロックがありません。BLOCKS で選んでください';
        return;
      }
      modePanel.style.display = 'none';
      b.blur(); // 遊んでいる間のSpaceでボタンが押されないように
      setMode(b.dataset.mode);
      const resolve = g.resolveMode;
      g.resolveMode = null;
      resolve(b.dataset.mode);
    });
  });

  function fillSidePanel() {
    setMode(g.mode);
    colorsEl.innerHTML = '';
    g.palette.forEach(hex => {
      const sw = document.createElement('i');
      sw.style.background = hex;
      colorsEl.appendChild(sw);
    });
    colorsBox.style.display = g.palette.length ? '' : 'none';
    updateNote();
  }

  function updateNote() {
    const notes = [];
    if (g.w >= 100) notes.push(`1列そろえるのに ${g.w.toLocaleString()} マス必要です`);
    const types = g.types || [];
    if (types.some(t => EXTRA_TYPES.includes(t))) notes.push('巨大盤面ボーナス：特殊ブロック出現中');
    const customs = types.filter(isCustomType).length;
    if (customs) notes.push(`カスタムブロック ${customs} 個出現中`);
    elNote.textContent = notes.join('\n');
  }

  // ── ブロックの選択とカスタムブロック ──
  // メニューの BLOCKS で開く画面。通常ブロックとカスタムブロックを並べ、右上のチェックで
  // ゲームに出すかどうかを選ぶ（初めは全部出す）。盤面以上の大きさのブロックは選べない。
  // カスタムブロックは、エディタで描いた絵（選択範囲があればその中だけ）を色のまま
  // ブロックにしたもので、このブラウザ（IndexedDB）に MAX_CUSTOM_BLOCKS 個まで保存できる。
  const BLOCKS_OFF_KEY = 'pixelart-peporis-blocks-off'; // 出さないことにしたブロック（初めは空＝全部出す）
  const MAX_CUSTOM_BLOCKS = 10;
  const BLOCK_DB = 'pixelart-peporis';
  const BLOCK_STORE = 'blocks';
  const blocksScreen = document.getElementById('tetris-blocks');
  const elBlocksNote = document.getElementById('tetris-blocks-note');
  const normalGrid = document.getElementById('tetris-normal-blocks');
  const customGrid = document.getElementById('tetris-custom-blocks');
  const elCustomCount = document.getElementById('tetris-custom-count');
  const btnBlockAdd = document.getElementById('btn-tetris-block-add');
  const elBlockAddHint = document.getElementById('tetris-block-add-hint');
  const btnBlocksBack = document.getElementById('btn-tetris-blocks-back');
  const blocksBtn = modeBtns.find(b => b.dataset.action === 'blocks');
  const elBlocksSummary = document.getElementById('tetris-blocks-summary');
  const menuNote = document.getElementById('tetris-menu-note');

  let customBlocks = [];       // 保存してあるカスタムブロック {id, name, w, h, type}（作った順）
  let blockStorageError = false;

  function loadOffTypes() {
    try {
      const list = JSON.parse(localStorage.getItem(BLOCKS_OFF_KEY));
      return new Set(Array.isArray(list) ? list : []);
    } catch (err) { return new Set(); }
  }
  function saveOffTypes(set) {
    try { localStorage.setItem(BLOCKS_OFF_KEY, JSON.stringify([...set])); } catch (err) { /* 覚えられなくても今回は効く */ }
  }

  const allTypes = () => [...BASE_TYPES, ...EXTRA_TYPES, ...customBlocks.map(b => b.type)];

  // この盤面で使えない理由（使えるならnull）
  function unusableReason(type) {
    if (EXTRA_TYPES.includes(type) && (g.standard || g.w < EXTRA_MIN_SIZE || g.h < EXTRA_MIN_SIZE)) {
      return `${EXTRA_MIN_SIZE}×${EXTRA_MIN_SIZE}以上の盤面で出現`;
    }
    if (DEFS[type].n >= Math.min(g.w, g.h)) return '盤面より大きい';
    return null;
  }

  function activeTypes() {
    const off = loadOffTypes();
    return allTypes().filter(t => !off.has(t) && !unusableReason(t));
  }

  function updateBlocksSummary() {
    elBlocksSummary.textContent = `出現 ${activeTypes().length} 種類`;
  }

  // ── 保存（IndexedDB） ──
  function openBlockDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(BLOCK_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(BLOCK_STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function blockDb(mode, fn) {
    const db = await openBlockDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(BLOCK_STORE, mode);
        const req = fn(tx.objectStore(BLOCK_STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読めませんでした')); };
      img.src = url;
    });
  }

  // 保存してある画像（PNG）から形と色を作る。透明なマスはブロックに含めない
  async function recordToDef(rec) {
    const type = 'custom:' + rec.id;
    if (DEFS[type]) return DEFS[type];
    const img = await loadImage(new Blob([rec.png], { type: 'image/png' }));
    const cv = document.createElement('canvas');
    cv.width = rec.w;
    cv.height = rec.h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = new Uint32Array(ctx.getImageData(0, 0, rec.w, rec.h).data.buffer);
    const n = Math.max(rec.w, rec.h);
    // 回転の中心がずれないよう、正方形の枠の中央に置く
    const ox = Math.floor((n - rec.w) / 2), oy = Math.floor((n - rec.h) / 2);
    const xs = [], ys = [], colors = [];
    const hexes = new Map();
    for (let y = 0; y < rec.h; y++) {
      for (let x = 0; x < rec.w; x++) {
        const v = px[y * rec.w + x];
        if ((v >>> 24) < 128) continue;
        const u32 = (v | 0xff000000) >>> 0;
        xs.push(x + ox);
        ys.push(y + oy);
        colors.push(u32);
        if (!hexes.has(u32)) {
          hexes.set(u32, '#' + [u32 & 255, (u32 >>> 8) & 255, (u32 >>> 16) & 255]
            .map(c => c.toString(16).padStart(2, '0')).join(''));
        }
      }
    }
    const def = makeDef(type, n, Int16Array.from(xs), Int16Array.from(ys), Uint32Array.from(colors));
    def.hexes = [...hexes]; // 盤面をレイヤーに残すときに色へ戻すため
    return def;
  }

  async function refreshCustomBlocks() {
    try {
      const records = (await blockDb('readonly', store => store.getAll())) || [];
      records.sort((a, b) => a.createdAt - b.createdAt);
      for (const rec of records) await recordToDef(rec);
      customBlocks = records.map(r => ({ id: r.id, name: r.name, w: r.w, h: r.h, type: 'custom:' + r.id }));
      blockStorageError = false;
    } catch (err) {
      customBlocks = [];
      blockStorageError = true; // プライベートブラウズなどで保存できない
    }
  }

  // 今の絵（見えているレイヤーを重ねた色）を、絵のある範囲ぴったりに切り出す。
  // 選択範囲があればその中だけ。何も描いていなければnull
  function artForBlock() {
    const px = new Uint32Array(cols * rows);
    let minX = cols, minY = rows, maxX = -1, maxY = -1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (selectionMask && !(selectionMask[r] && selectionMask[r][c])) continue;
        const hex = compositeAt(r, c);
        if (!hex) continue;
        px[r * cols + c] = hexToU32(hex);
        if (c < minX) minX = c;
        if (c > maxX) maxX = c;
        if (r < minY) minY = r;
        if (r > maxY) maxY = r;
      }
    }
    if (maxX < 0) return null;
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    const out = new Uint32Array(img.data.buffer);
    for (let y = 0; y < h; y++) out.set(px.subarray((y + minY) * cols + minX, (y + minY) * cols + minX + w), y * w);
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  // 今の絵をカスタムブロックとして保存する（ブロック画面とエディタの「保存 ▸ PEPORISに保存」で使う）。
  // 結果は { status: 'ok' | 'full' | 'empty' | 'storage', block }
  async function saveArtAsBlock() {
    await refreshCustomBlocks(); // ほかのタブで増減しているかもしれないので、保存の直前に数え直す
    if (blockStorageError) return { status: 'storage' };
    if (customBlocks.length >= MAX_CUSTOM_BLOCKS) return { status: 'full' };
    const cv = artForBlock();
    if (!cv) return { status: 'empty' };
    try {
      const blob = await new Promise(resolve => cv.toBlob(resolve, 'image/png'));
      const used = new Set(customBlocks.map(b => b.name));
      let k = 1;
      while (used.has(`BLOCK ${k}`)) k++;
      const rec = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: `BLOCK ${k}`,
        w: cv.width, h: cv.height,
        png: await blob.arrayBuffer(), // Blobのままだと保存できないブラウザがあるため
        createdAt: Date.now(),
      };
      await blockDb('readwrite', store => store.put(rec));
      await refreshCustomBlocks();
      return { status: 'ok', block: { name: rec.name, w: rec.w, h: rec.h } };
    } catch (err) {
      blockStorageError = true;
      return { status: 'storage' };
    }
  }

  async function addCustomBlock() {
    btnBlockAdd.disabled = true;
    await saveArtAsBlock();
    renderBlocksScreen();
  }

  // エディタの「ファイル ▸ 保存 ▸ PEPORISに保存」
  document.getElementById('btn-save-peporis').addEventListener('click', async () => {
    closeFileMenu();
    if (!started || g) return;
    const { status, block } = await saveArtAsBlock();
    if (status === 'ok') {
      showToast(`PEPORISのカスタムブロック「${block.name}」（${block.w}×${block.h}）として保存しました。`
        + '右下のブロックのボタンから遊べます');
    } else if (status === 'full') {
      showToast(`PEPORISのカスタムブロックは${MAX_CUSTOM_BLOCKS}個までです。PEPORISのメニューの BLOCKS で、いらないブロックを削除してください`, true);
    } else if (status === 'empty') {
      showToast(selectionMask ? '選択範囲の中に絵がありません' : '絵がありません。描いてから保存してください', true);
    } else {
      showToast('このブラウザではPEPORISのブロックを保存できません（プライベートブラウズなど）', true);
    }
  });

  async function deleteCustomBlock(block) {
    try {
      await blockDb('readwrite', store => store.delete(block.id));
    } catch (err) { /* 消せなかったときは一覧に残る */ }
    delete DEFS[block.type];
    const off = loadOffTypes();
    if (off.delete(block.type)) saveOffTypes(off);
    await refreshCustomBlocks();
    renderBlocksScreen();
  }

  // ── ブロック画面 ──
  function blockTile(type, name, block) {
    const reason = unusableReason(type);
    const off = loadOffTypes();
    const tile = document.createElement('label');
    tile.className = 'tetris-block-tile';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'tetris-block-check';
    check.checked = !off.has(type);
    check.disabled = !!reason;
    const sync = () => tile.classList.toggle('off', !check.checked || !!reason);
    check.addEventListener('change', () => {
      const set = loadOffTypes();
      if (check.checked) set.delete(type); else set.add(type);
      saveOffTypes(set);
      sync();
    });
    sync();
    tile.classList.toggle('unusable', !!reason);

    const frame = document.createElement('div');
    frame.className = 'tetris-block-frame';
    const cv = document.createElement('canvas');
    drawShape(cv, type, STANDARD_COLORS[type] || '#ffd23f');
    frame.appendChild(cv);

    const label = document.createElement('div');
    label.className = 'tetris-block-name';
    label.textContent = name;
    tile.append(check, frame, label);
    if (block) {
      const size = document.createElement('small');
      size.textContent = `${block.w}×${block.h}`;
      tile.appendChild(size);
    }
    if (reason) {
      const why = document.createElement('small');
      why.className = 'tetris-block-why';
      why.textContent = reason;
      tile.appendChild(why);
    }
    if (block) {
      // 削除は押し間違えないよう、もう一度押したときに消す
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'tetris-block-del';
      del.textContent = '削除';
      let armed = null;
      del.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (armed) { clearTimeout(armed); deleteCustomBlock(block); return; }
        del.textContent = 'もう一度で削除';
        armed = setTimeout(() => { armed = null; del.textContent = '削除'; }, 3000);
      });
      tile.appendChild(del);
    }
    return tile;
  }

  function renderBlocksScreen() {
    elBlocksNote.textContent = `盤面 ${g.w}×${g.h}。チェックしたブロックがゲームに出てきます`;
    normalGrid.replaceChildren(...[...BASE_TYPES, ...EXTRA_TYPES].map(t => blockTile(t, t)));
    customGrid.replaceChildren(...customBlocks.map(b => blockTile(b.type, b.name, b)));
    elCustomCount.textContent = `${customBlocks.length} / ${MAX_CUSTOM_BLOCKS}`;
    btnBlockAdd.disabled = blockStorageError || customBlocks.length >= MAX_CUSTOM_BLOCKS || !g.hasArt;
    elBlockAddHint.textContent = blockStorageError
      ? 'このブラウザでは保存できません（プライベートブラウズなど）'
      : customBlocks.length >= MAX_CUSTOM_BLOCKS
        ? `保存できるのは ${MAX_CUSTOM_BLOCKS} 個までです。いらないブロックを削除してください`
        : !g.hasArt
          ? '「ブロックを作る」でエディタに移って描き、「ファイル ▸ 保存 ▸ PEPORISに保存」で保存できます'
          : '「ブロックを作る」でエディタに移って描けます。「今の絵をブロックにする」は、エディタで描いてある絵を色のままブロックにします（選択範囲があればその中だけ）';
  }

  function openBlocksScreen() {
    g.state = 'blocks';
    // 絵があるかどうか（遊んでいる間は絵は変わらないので、最初に開いたときだけ調べる）
    if (g.hasArt === undefined) g.hasArt = !g.standard && artForBlock() !== null;
    renderBlocksScreen();
    blocksScreen.scrollTop = 0;
    blocksScreen.style.display = '';
    btnBlocksBack.focus();
  }

  function closeBlocksScreen() {
    blocksScreen.style.display = 'none';
    g.state = 'select';
    menuNote.textContent = '';
    updateBlocksSummary();
    selectModeBtn(blocksBtn);
  }

  btnBlocksBack.addEventListener('click', () => { if (g && g.state === 'blocks') closeBlocksScreen(); });
  btnBlockAdd.addEventListener('click', () => { if (g && g.state === 'blocks') addCustomBlock(); });
  // 「ブロックを作る」：PEPORISを終えてエディタに移る（ホームから来たときもホームには戻らない）
  document.getElementById('btn-tetris-block-draw').addEventListener('click', async () => {
    if (!g || g.state !== 'blocks') return;
    await closeGame(false, { toEditor: true });
    showToast('描いたら「ファイル ▸ 保存 ▸ PEPORISに保存」でブロックにできます（選択範囲があればその中だけ）');
  });

  // 画面にドット風の文字を使う（テトリスを始めたときにだけ読み込む）
  function loadRetroFont() {
    if (document.getElementById('tetris-font')) return;
    const link = document.createElement('link');
    link.id = 'tetris-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DotGothic16&display=swap';
    document.head.appendChild(link);
  }

  // ── 開始と終了 ──
  // standard: 本家と同じ設定（10×20・ブロックごとに決まった色）で遊ぶ
  // direct: ホーム画面から直接来た。エディタの部品を消す演出を省き、終了したらホームへ戻る
  async function openGame({ standard = false, direct = false } = {}) {
    loadRetroFont();
    const body = document.body;
    const center = canvasCenter();
    g = {
      state: 'intro',
      standard, direct,
      mode: loadMode(),
      w: cols, h: rows,
      palette: standard ? [] : customColors.filter(Boolean),
      hexOf: new Map(),
      saved: { zoom, x: center.x, y: center.y }, // 終わったらこの表示に戻す
      raf: 0,
    };
    if (document.activeElement) document.activeElement.blur();
    const customsReady = refreshCustomBlocks(); // 保存してあるカスタムブロックを、画面の切り替え中に読んでおく

    // ① キャンバス以外を画面外へ（直接来たときは一瞬で消す）
    if (direct) body.classList.add('tetris-instant');
    body.classList.add('tetris-playing', 'tetris-out');
    if (!direct) await sleep(UI_OUT_MS);

    // ② キャンバスエリアを画面いっぱいにして盤面を用意する
    switchLayout(() => body.classList.add('tetris-stage'));
    body.classList.toggle('tetris-plain', standard);
    const fieldCanvas = makeLayerCanvas();
    const pieceCanvas = makeLayerCanvas();
    const ghostCanvas = document.createElement('canvas');
    ghostCanvas.className = 'tetris-ghost';
    ghostCanvas.style.display = 'none';
    // ゴーストは落下中のブロックの下に来るよう、その前に置く（着地寸前で重なったときはブロックが見える）
    cMain.after(fieldCanvas, ghostCanvas, pieceCanvas);
    Object.assign(g, {
      fieldCanvas, pieceCanvas, ghostCanvas,
      fieldCtx: fieldCanvas.getContext('2d'),
      pieceCtx: pieceCanvas.getContext('2d'),
    });
    fillSidePanel();
    resetBoard(false);

    // ③ キャンバスを右へ寄せながら、サイドパネルを左から出す
    //    （直接来たときは最初から右に置いておき、隠していたページをここで見せる）
    const target = gameViewTarget();
    if (direct) {
      placeCanvas(target.zoom, target.x, target.y);
      document.documentElement.classList.remove('tetris-direct');
    }
    body.classList.add('tetris-side-in');
    await Promise.all([
      direct ? null : moveCanvasStepped(target.zoom, target.x, target.y, SIDE_MS),
      sleep(SIDE_MS),
    ]);

    await customsReady;
    await chooseMode();
    resetBoard(false); // メニューのブロック画面で選び直した分を反映する
    showMessage('READY', 0);
    await sleep(700);
    showMessage('GO!', 800);
    startRound();
    g.raf = requestAnimationFrame(tick);
  }

  // 盤面を新しいレイヤーとして残す（Undoで取り消せる）
  function keepBoardAsLayer() {
    pushHistory();
    addLayerAboveActive();
    const layer = layers[activeLayerIndex];
    layer.name = 'PEPORIS';
    for (let r = 0; r < g.h; r++) {
      const row = layer.cells[r];
      for (let c = 0; c < g.w; c++) {
        const v = g.field[r * g.w + c];
        if (v) row[c] = g.hexOf.get(v);
      }
    }
    drawCells();
    updateLayerPanel();
  }

  // keep: 盤面をレイヤーに残す / toEditor: ホームから来たときも、ホームに戻らずエディタに移る
  async function closeGame(keep, { toEditor = false } = {}) {
    if (!g || g.state === 'outro' || g.state === 'intro') return;
    if (keep) keepBoardAsLayer();
    const body = document.body;
    g.state = 'outro';
    cancelAnimationFrame(g.raf);
    hidePanel();
    modePanel.style.display = 'none';
    blocksScreen.style.display = 'none';
    clearTimeout(msgTimer);
    elMsg.textContent = '';

    // ③の逆：サイドパネルを引っ込めながら、キャンバスを元の倍率・位置へ戻す
    body.classList.remove('tetris-side-in');
    body.classList.add('tetris-side-out');
    if (g.direct && !keep && !toEditor) {
      // ホームから直接来たときは、パネルが引っ込んだらホームへ戻る
      await sleep(SIDE_MS);
      location.href = 'index.html';
      return;
    }
    if (g.direct) {
      // エディタに移るので（盤面を残す・ブロックを作る）、再読み込みでまたテトリスが始まらないようにする
      // （script.jsのグローバル変数historyはUndo用の配列なので、window.historyを明示する）
      window.history.replaceState(null, '', location.pathname);
    }
    await Promise.all([
      moveCanvasStepped(g.saved.zoom, g.saved.x, g.saved.y, SIDE_MS),
      sleep(SIDE_MS),
    ]);

    // ②の逆：盤面を片付けてエディタの配置に戻す（描いた絵がまた見えるようになる）
    g.fieldCanvas.remove();
    g.pieceCanvas.remove();
    g.ghostCanvas.remove();
    switchLayout(() => body.classList.remove('tetris-stage', 'tetris-side-out', 'tetris-plain'));

    // ①の逆：消えていた部品を戻す
    body.classList.remove('tetris-out', 'tetris-instant');
    body.classList.add('tetris-return');
    await sleep(UI_OUT_MS);
    body.classList.remove('tetris-return', 'tetris-playing');
    g = null;
  }

  document.getElementById('btn-tetris').addEventListener('click', () => {
    if (!started || g) return;
    openGame();
  });
  btnPause.addEventListener('click', () => { if (g && g.state === 'playing') pause(); });
  btnResume.addEventListener('click', () => { if (g && g.state === 'paused') resume(); });
  document.getElementById('btn-tetris-retry').addEventListener('click', () => { if (g) retry(false); });
  document.getElementById('btn-tetris-retry-art').addEventListener('click', () => { if (g) retry(true); });
  // メニューへ戻る（盤面を空にしてメニューを出し、選んだモードでもう一度始める）
  document.getElementById('btn-tetris-menu').addEventListener('click', async () => {
    if (!g || (g.state !== 'paused' && g.state !== 'over')) return;
    resetBoard(false);
    await chooseMode();
    retry(false);
  });
  btnKeep.addEventListener('click', () => closeGame(true));
  document.getElementById('btn-tetris-quit').addEventListener('click', () => closeGame(false));

  // ホーム画面のテトリスボタン（editor.html?tetris）から来たら、スタート画面を飛ばして
  // 本家と同じ10×20の盤面ですぐに始める。エディタの読み込み完了時にキャンバスを
  // 中央へ寄せる処理（script.jsのcenterCanvasOnBoot）が済んでから配置する。
  if (document.documentElement.classList.contains('tetris-direct')) {
    const boot = () => {
      cols = STANDARD_COLS;
      rows = STANDARD_ROWS;
      startEditor();
      syncSlidersToGrid();
      updatePresetHighlight();
      openGame({ standard: true, direct: true });
    };
    if (document.readyState === 'complete') setTimeout(boot, 0);
    else window.addEventListener('load', () => setTimeout(boot, 0));
  }
})();
