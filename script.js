// ── 状態 ──────────────────────────────────────────────
const PALETTE_COLORS = [
  '#ffffff','#d0d0d0','#888888','#444444','#1a1a18','#000000',
  '#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db',
  '#9b59b6','#e91e8c','#ff7675','#fdcb6e','#55efc4','#74b9ff',
  '#a29bfe','#fd79a8','#dfe6e9','#b2bec3','#636e72','#2d3436',
  '#c0392b','#d35400','#f39c12','#27ae60','#16a085','#2980b9',
  '#8e44ad','#ff006e','#ff8c00','#00b894','#0984e3','#6c5ce7',
  '#fab1a0','#ffeaa7','#81ecec','#6366f1','#a0522d','#5d4037',
  '#2c3e50','#34495e','#7f8c8d','#95a5a6','#bdc3c7','#ecf0f1',
];

let cols = 32, rows = 32;
let layers = [];         // layers[i] = {name, visible, cells}（i=0が最下層）。今のコマのレイヤー
let activeLayerIndex = 0;
// アニメーションのコマ。各コマがそれぞれのレイヤー一式を持つ。
// layers / activeLayerIndex は今のコマ（frames[currentFrame]）のものを指す
// （描画ツールなどは今までどおり layers だけを見ればよい）。frames[i].active は
// 今のコマ以外の、最後に選んでいたレイヤー（今のコマの分は activeLayerIndex が正しい）
let frames = [];         // frames[i] = { layers, active }
let currentFrame = 0;
let animFps = 8;         // 再生・GIFの速さ（1秒あたりのコマ数）
const MAX_FPS = 50;      // GIFの1コマの最短表示時間は0.02秒のため
// コマの一覧（anim.js）に変化を知らせる。anim.js が window.onFrames〜 を用意する
let layerNameCounter = 1;
let cells = [];          // アクティブレイヤーのcellsへの参照。cells[row][col] = '#rrggbb' or null
let history = [];
let zoom = 1;
let currentTool = 'pen';
let currentColor = '#3a3a38';
let convertMethod = 'mode';
let convertColorCount = 32;
let showGrid = true;
let uploadedImage = null;
let isPainting = false;
let lastCell = null;
let started = false;
let brushSize = 1;
let drawStyle = 'normal';
let detectLine = false;
let selectionMode = 'none'; // 'none', 'range', 'color'
let selectionMask = null;   // null = all editable, or bool[][]
let rangeStart = null;
let rangeSelectMode = 'rect'; // 'rect' = 四角で囲う, 'free' = 自分で指定
let rangePath = [];
let floating = null;        // 移動ツールで動かしている最中の選択範囲（詳細は「選択範囲の移動」参照）
let moveDrag = null;        // 移動ツールのドラッグ状態
let clipboard = null;       // コピー／切り取りした内容
let shapeType = 'circle'; // 'line', 'circle', 'rect', 'diamond', 'heart'
let shapeFill = true;
let shapeStart = null;
let heartImage = null; // ハート図形に使う差し替え用の画像（用意されていれば数式の代わりに使う）
(() => {
  const img = new Image();
  img.onload = () => { heartImage = img; };
  img.src = 'images/heart.png';
})();

// ── DOM ───────────────────────────────────────────────
const cBg  = document.getElementById('canvas-bg');
const cTrace = document.getElementById('canvas-trace');
const cMain= document.getElementById('canvas-main');
const cOv  = document.getElementById('canvas-overlay');
const gridOverlay = document.getElementById('canvas-grid');
const wrap = document.getElementById('canvas-wrap');
const overlay = document.getElementById('start-overlay');
const statPos   = document.getElementById('stat-pos');
const statColor = document.getElementById('stat-color');
const statGrid  = document.getElementById('stat-grid');
const zoomLabel = document.getElementById('zoom-label');
// タブレット用レイアウトかどうか（判定は editor.html の head で行う）
const tabletUI = document.documentElement.classList.contains('tablet-ui');

// 1マスあたりのキャンバス上のピクセル数。
// 1マスは単色なので、拡大時の見た目の鮮明さは image-rendering: pixelated が
// 担保する（1マス=1ピクセルでも劣化しない）。ここで大きな値を使う理由は
// あくまで既定表示の大きさのためで、大きくするほどメモリを食うだけなので、
// グリッドが大きいときは小さくしてキャンバスの実サイズを1024px以内に収める。
function cellPx() {
  const n = Math.max(cols, rows);
  if (n <= 32)  return 14;
  if (n <= 64)  return 8;
  if (n <= 128) return 4;
  if (n <= 512) return 2;
  return 1;
}

// '#rrggbb' → ImageDataに1回で書き込める32bit値（リトルエンディアンのABGR）に
// 変換してキャッシュする。1024グリッドでは1回の再描画で100万マスを処理するため、
// 毎回パースしたり1バイトずつ書いたりすると重くなる。
const hexU32Cache = new Map();
function hexToU32(hex) {
  let v = hexU32Cache.get(hex);
  if (v === undefined) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    v = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    hexU32Cache.set(hex, v);
  }
  return v;
}

// セル配列を「1マス=1ピクセル」の画像として組み立てるための作業用キャンバス。
// これを拡大コピーすることで、1マスずつ矩形を塗るより大幅に速く描画できる。
let scratchCanvas = null;
function getScratch() {
  if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
  if (scratchCanvas.width !== cols || scratchCanvas.height !== rows) {
    scratchCanvas.width = cols;
    scratchCanvas.height = rows;
  }
  return scratchCanvas;
}

// レイヤーごとの描画結果（1マス=1ピクセルの画像）をキャッシュする。
// 描いている最中に変化するのはアクティブレイヤーだけなので、
// それ以外はキャッシュを使い回して再構築を省く。
// レイヤーオブジェクトをキーにしているため、並び替え・複製・削除では
// キャッシュがそのまま追従し、Undoや読み込みでレイヤーが作り直された
// 場合は自動的にキャッシュ無しとして再構築される。
const layerCanvasCache = new WeakMap();

function getLayerCanvas(layer, forceRebuild) {
  let entry = layerCanvasCache.get(layer);
  if (!entry) {
    entry = { canvas: document.createElement('canvas'), w: -1, h: -1 };
    layerCanvasCache.set(layer, entry);
    forceRebuild = true;
  }
  if (entry.w !== cols || entry.h !== rows) {
    entry.canvas.width = cols;
    entry.canvas.height = rows;
    entry.w = cols; entry.h = rows;
    forceRebuild = true;
  }
  if (forceRebuild) {
    const lctx = entry.canvas.getContext('2d');
    lctx.putImageData(layerImageData(lctx, layer.cells), 0, 0);
  }
  return entry.canvas;
}

// アクティブでないレイヤーの中身を直接書き換えたときに呼ぶ
function invalidateLayerCache(layer) {
  if (layer) layerCanvasCache.delete(layer);
}
function invalidateAllLayerCaches() {
  layers.forEach(l => layerCanvasCache.delete(l));
  frames.forEach(f => f.layers.forEach(l => layerCanvasCache.delete(l)));
}

// 1レイヤーぶんのセルを ImageData に詰める
function layerImageData(ctx, layerCells) {
  const img = ctx.createImageData(cols, rows);
  const buf = new Uint32Array(img.data.buffer); // 1マス=1要素として書き込む
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const row = layerCells[r];
    for (let c = 0; c < cols; c++, i++) {
      const hex = row[c];
      if (hex) buf[i] = hexToU32(hex); // 空セルは透明のまま
    }
  }
  return img;
}

// ── 初期化 ────────────────────────────────────────────
function makeCells(c, r) {
  return Array.from({length: r}, () => Array(c).fill(null));
}

function makeLayer(name) {
  return { name, visible: true, opacity: 1, locked: false, cells: makeCells(cols, rows) };
}

function activeLayerLocked() {
  return layers[activeLayerIndex] && layers[activeLayerIndex].locked;
}

// アクティブレイヤーのcellsをグローバル変数cellsに同期する。
// 既存の描画ツール群はcellsを直接読み書きするため、この参照の付け替えで
// 「どのレイヤーに描くか」が切り替わる。
function syncActiveCells() {
  activeLayerIndex = Math.max(0, Math.min(layers.length - 1, activeLayerIndex));
  cells = layers[activeLayerIndex].cells;
  // 別のレイヤーに切り替えたら、移動中の選択範囲はその位置で確定する
  if (floating && floating.activeLayer !== layers[activeLayerIndex]) floating = null;
}

function initCells(c, r, keepOld) {
  invalidateAllLayerCaches(); // 全レイヤーのセル配列を作り直すため
  cols = c; rows = r;
  if (keepOld && layers.length) {
    // 大きさは全部のコマで同じなので、どのコマのレイヤーも作り直す
    frames.forEach(f => f.layers.forEach(l => {
      const old = l.cells;
      l.cells = Array.from({length: r}, (_, ri) =>
        Array.from({length: c}, (_, ci) =>
          old[ri] && old[ri][ci] !== undefined ? old[ri][ci] : null
        )
      );
    }));
  } else {
    layerNameCounter = 1;
    layers = [makeLayer(`レイヤー${layerNameCounter++}`)];
    activeLayerIndex = 0;
    frames = [{ layers, active: 0 }];
    currentFrame = 0;
    if (typeof onFramesReset === 'function') onFramesReset();
  }
  syncActiveCells();
  document.getElementById('stat-grid').textContent = `${cols}×${rows}`;
  updateLayerPanel();
  if (keepOld && window.onFramesChanged) window.onFramesChanged(); // 大きさが変わったので、どのコマの小さな絵も描き直す
}

// 下の色の上に上の色を不透明度alphaで重ねた色を返す。
// セルはアルファ値を持てないため、下が透明の場合は上の色をそのまま使う。
function blendHex(bottomHex, topHex, alpha) {
  if (alpha >= 1 || !bottomHex) return topHex;
  const b = [1, 3, 5].map(i => parseInt(bottomHex.slice(i, i + 2), 16));
  const t = [1, 3, 5].map(i => parseInt(topHex.slice(i, i + 2), 16));
  return '#' + t.map((v, i) =>
    Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')
  ).join('');
}

// 指定位置の合成後の色（可視レイヤーを不透明度込みで下から重ねた色）を返す
function compositeAt(r, c) {
  let out = null;
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const v = layer.cells[r] && layer.cells[r][c];
    if (v) out = blendHex(out, v, layer.opacity);
  }
  return out;
}

function canvasSize() {
  const px = cellPx();
  return { w: cols * px, h: rows * px };
}

const scrollPad = document.querySelector('.canvas-scroll-pad');
const canvasArea = document.getElementById('canvas-area');

function updateScrollPadding() {
  const areaW = canvasArea.clientWidth;
  const areaH = canvasArea.clientHeight;
  const {w, h} = canvasSize();
  const canvasW = w * zoom;
  const canvasH = h * zoom;
  const padX = Math.max(areaW, canvasW);
  const padY = Math.max(areaH * 0.5, canvasH * 0.5);
  scrollPad.style.padding = `${padY}px ${padX}px`;
}

function resizeCanvases() {
  const {w, h} = canvasSize();
  [cBg, cTrace, cMain, cOv].forEach(c => { c.width = w; c.height = h; });
  wrap.style.width  = (w * zoom) + 'px';
  wrap.style.height = (h * zoom) + 'px';
  [cBg, cTrace, cMain, cOv].forEach(c => {
    c.style.width  = (w * zoom) + 'px';
    c.style.height = (h * zoom) + 'px';
  });
  updateScrollPadding();
  drawAll();
  drawTraceImage(); // width/height変更でクリアされるため描き直す
}

function drawAll() {
  drawBg();
  drawCells();
  updateGridOverlay();
}

function drawBg() {
  const px = cellPx();
  const ctx = cBg.getContext('2d');
  ctx.clearRect(0, 0, cBg.width, cBg.height);
  // 市松模様も1マス=1ピクセルで作ってから拡大する
  const scratch = getScratch();
  const sctx = scratch.getContext('2d');
  const img = sctx.createImageData(cols, rows);
  const buf = new Uint32Array(img.data.buffer);
  const light = 0xffeeeeee, dark = 0xffcccccc; // ABGR（グレーなので並び順は不問）
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, i++) {
      buf[i] = (r + c) % 2 === 0 ? dark : light;
    }
  }
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, cols, rows, 0, 0, cols * px, rows * px);
}

function drawCells() {
  const px = cellPx();
  const ctx = cMain.getContext('2d');
  ctx.clearRect(0, 0, cMain.width, cMain.height);
  ctx.imageSmoothingEnabled = false;
  const activeLayer = layers[activeLayerIndex];
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    // 各レイヤーを等倍で用意し、まとめて拡大コピーする。
    // 1マスずつfillRectするより速く、レイヤー単位の不透明度も従来どおり効く。
    // 描画対象のアクティブレイヤーだけは毎回作り直す。
    const lc = getLayerCanvas(layer, layer === activeLayer);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(lc, 0, 0, cols, rows, 0, 0, cols * px, rows * px);
  }
  ctx.globalAlpha = 1;
}

// グリッド線はキャンバスに描き込まず、CSSの繰り返しグラデーションで表示する。
// キャンバスに焼き込むと拡大時に線まで一緒に引き伸ばされて太くなるが、
// この方式なら倍率に関わらず常に1pxの細い線を保てる。
function updateGridOverlay() {
  const displayed = cellPx() * zoom; // 画面上での1マスの大きさ
  // マスが小さすぎると線だらけで潰れるので、その場合は出さない
  const visible = showGrid && displayed >= 4;
  gridOverlay.style.display = visible ? '' : 'none';
  if (visible) gridOverlay.style.setProperty('--cell-size', displayed + 'px');
  // 1マスの表示サイズやマス数が変わったので、定規と列・行の強調も合わせる
  updateLineHighlights();
  updateCenterLines();
}

// ── 中心線 ──
// キャンバスの縦・横それぞれの真ん中に線を出す。マス数が偶数なら真ん中のマスとマスの
// 境目に1本の線を、奇数なら真ん中の1列（1行）を薄く色付けして両側に線を引く。
// 位置はキャンバスに対する割合で指定するので、拡大縮小しても付いてくる。
// （起動直後にも呼ばれるため、要素や設定はその都度取り出す）
function updateCenterLines() {
  const show = document.getElementById('show-center-lines').checked;
  placeCenterLine(document.getElementById('center-line-v'), cols, 'left', 'width', show);
  placeCenterLine(document.getElementById('center-line-h'), rows, 'top', 'height', show);
}
function placeCenterLine(el, count, posProp, sizeProp, show) {
  el.style.display = show ? '' : 'none';
  const odd = count % 2 === 1;
  el.classList.toggle('odd', odd);
  el.style[posProp] = odd ? `${Math.floor(count / 2) / count * 100}%` : '50%';
  el.style[sizeProp] = odd ? `${100 / count}%` : '0';
}

function drawGrid() {
  drawBg();
  drawCells();
  updateGridOverlay();
}

function brushRect(col, row) {
  const half = Math.floor(brushSize / 2);
  return {
    c1: col - half,
    r1: row - half,
    c2: col - half + brushSize - 1,
    r2: row - half + brushSize - 1,
  };
}

function drawSelectionOverlay(ctx) {
  if (!selectionMask) return;
  const px = cellPx();
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!selectionMask[r][c]) {
        ctx.fillRect(c * px, r * px, px, px);
      }
    }
  }
}

function drawOverlayCell(col, row) {
  const px = cellPx();
  const ctx = cOv.getContext('2d');
  ctx.clearRect(0, 0, cOv.width, cOv.height);
  drawSelectionOverlay(ctx);
  if (selectionMode === 'range' && rangeStart) return;
  if (currentTool === 'move' && selectionMode === 'none') return; // 移動ツールにブラシ枠は不要
  if (col < 0 || col >= cols || row < 0 || row >= rows) return;
  const b = brushRect(col, row);
  const x1 = Math.max(0, b.c1) * px;
  const y1 = Math.max(0, b.r1) * px;
  const x2 = (Math.min(cols - 1, b.c2) + 1) * px;
  const y2 = (Math.min(rows - 1, b.r2) + 1) * px;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
}

// ── イベント：キャンバス ───────────────────────────────
function getCell(e) {
  const px = cellPx();
  const rect = cOv.getBoundingClientRect();
  const x = (e.clientX - rect.left) / zoom;
  const y = (e.clientY - rect.top)  / zoom;
  return { col: Math.floor(x / px), row: Math.floor(y / px) };
}

function isCellEditable(r, c) {
  if (activeLayerLocked()) return false;
  return !selectionMask || (selectionMask[r] && selectionMask[r][c]);
}

function paintBrush(col, row, value) {
  const b = brushRect(col, row);
  for (let r = b.r1; r <= b.r2; r++) {
    for (let c = b.c1; c <= b.c2; c++) {
      if (c >= 0 && c < cols && r >= 0 && r < rows && isCellEditable(r, c)) {
        cells[r][c] = value;
      }
    }
  }
}

function interpolateCells(c0, r0, c1, r1) {
  const points = [];
  let dx = Math.abs(c1 - c0), dy = Math.abs(r1 - r0);
  const sx = c0 < c1 ? 1 : -1, sy = r0 < r1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    points.push({col: c0, row: r0});
    if (c0 === c1 && r0 === r1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; c0 += sx; }
    if (e2 < dx)  { err += dx; r0 += sy; }
  }
  return points;
}

function applyToolLine(fromCol, fromRow, toCol, toRow) {
  const points = interpolateCells(fromCol, fromRow, toCol, toRow);
  for (const {col, row} of points) {
    applyToolSingle(col, row);
  }
  drawCells();
}

function brushColRange(col) {
  const half = Math.floor(brushSize / 2);
  return { c1: Math.max(0, col - half), c2: Math.min(cols - 1, col - half + brushSize - 1) };
}
function brushRowRange(row) {
  const half = Math.floor(brushSize / 2);
  return { r1: Math.max(0, row - half), r2: Math.min(rows - 1, row - half + brushSize - 1) };
}

// 「線を検知」用：描き始めたマスと同じ色（空白なら空白）が続いているかを調べる。
// 違う色にぶつかったところで止めるため、描き始めが空白なら「線にぶつかるまで」、
// 色の上から描き始めたなら「その色が続く範囲だけ」を塗る（色の上からでも描ける）。
// 描画サイズが2以上のときは、太さの範囲の各マスを、描き始めた行（列）の同じ位置のマスと比べる。
function snapshotSameInCols(snap, r, startRow, c1, c2) {
  for (let c = c1; c <= c2; c++) {
    if ((snap[r][c] || null) !== (snap[startRow][c] || null)) return false;
  }
  return true;
}
function snapshotSameInRows(snap, c, startCol, r1, r2) {
  for (let r = r1; r <= r2; r++) {
    if ((snap[r][c] || null) !== (snap[r][startCol] || null)) return false;
  }
  return true;
}

function paintRow(r, c1, c2, value) {
  for (let c = c1; c <= c2; c++) {
    if (c >= 0 && c < cols && r >= 0 && r < rows && isCellEditable(r, c)) {
      cells[r][c] = value;
    }
  }
}

function paintCol(c, r1, r2, value) {
  for (let r = r1; r <= r2; r++) {
    if (c >= 0 && c < cols && r >= 0 && r < rows && isCellEditable(r, c)) {
      cells[r][c] = value;
    }
  }
}

function paintStyle(col, row, value) {
  if (drawStyle === 'col' && (currentTool === 'pen' || currentTool === 'erase')) {
    const {c1, c2} = brushColRange(col);
    if (detectLine) {
      const snap = cells.map(r => [...r]);
      for (let r = row; r >= 0; r--) {
        if (!snapshotSameInCols(snap, r, row, c1, c2)) break;
        paintRow(r, c1, c2, value);
      }
      for (let r = row + 1; r < rows; r++) {
        if (!snapshotSameInCols(snap, r, row, c1, c2)) break;
        paintRow(r, c1, c2, value);
      }
    } else {
      for (let r = 0; r < rows; r++) paintRow(r, c1, c2, value);
    }
  } else if (drawStyle === 'row' && (currentTool === 'pen' || currentTool === 'erase')) {
    const {r1, r2} = brushRowRange(row);
    if (detectLine) {
      const snap = cells.map(r => [...r]);
      for (let c = col; c >= 0; c--) {
        if (!snapshotSameInRows(snap, c, col, r1, r2)) break;
        paintCol(c, r1, r2, value);
      }
      for (let c = col + 1; c < cols; c++) {
        if (!snapshotSameInRows(snap, c, col, r1, r2)) break;
        paintCol(c, r1, r2, value);
      }
    } else {
      for (let c = 0; c < cols; c++) paintCol(c, r1, r2, value);
    }
  } else {
    paintBrush(col, row, value);
  }
}

function applyToolSingle(col, row) {
  if (col < 0 || col >= cols || row < 0 || row >= rows) return;
  if (currentTool === 'pen') {
    paintStyle(col, row, currentColor);
  } else if (currentTool === 'erase') {
    paintStyle(col, row, null); // 消しゴムもペンと同じく、描画スタイル（縦・横・線を検知）に従う
  } else if (currentTool === 'pick') {
    const c = compositeAt(row, col);
    if (c) { setColor(c); }
  } else if (currentTool === 'fill') {
    floodFill(col, row, currentColor);
  }
}

// ── テンプレート図形 ──────────────────────────────────
// 定番のハート曲線（x=16sin³t, y=13cost-5cos2t-2cos3t-cos4t）を
// u,v それぞれ -1..1 に正規化したポリゴンとして用意し、内外判定する。
const HEART_POLYGON = (() => {
  const N = 36;
  const raw = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    raw.push([x, y]);
  }
  // 先端（t=π）の近くは接線がほぼ垂直になり、縦長の箱で描くと細い棒が
  // 飛び出て見える。先端に近すぎる点を間引いて先端まで直線でつなぎ、
  // 自然な対角線のテーパーにする。
  const tipIndex = N / 2;
  const TRIM = 5;
  const trimmed = raw.filter((_, i) => {
    const dist = Math.min(Math.abs(i - tipIndex), N - Math.abs(i - tipIndex));
    return dist === 0 || dist > TRIM;
  });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of raw) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  // y の最小値（曲線の先端）が v=+1（キャンバス下方向）にくるよう反転する
  return trimmed.map(([x, y]) => [
    ((x - minX) / (maxX - minX)) * 2 - 1,
    -(((y - minY) / (maxY - minY)) * 2 - 1),
  ]);
})();

function isInsideShape(type, u, v) {
  if (type === 'circle') return u * u + v * v <= 1;
  if (type === 'diamond') return Math.abs(u) + Math.abs(v) <= 1;
  return true; // rect：バウンディングボックス全体
}

// 水平線 v とハートの輪郭との交点の u 座標を求める（走査線法）。
// 偶奇の並びで区間ペア [x0,x1], [x2,x3], ... が「内側」を表す。
function heartRowIntersections(v) {
  const pts = HEART_POLYGON;
  const xs = [];
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ui, vi] = pts[i];
    const [uj, vj] = pts[j];
    if ((vi <= v && vj > v) || (vj <= v && vi > v)) {
      const t = (v - vi) / (vj - vi);
      xs.push(ui + t * (uj - ui));
    }
  }
  xs.sort((a, b) => a - b);
  return xs;
}

// u区間 [x0,x1] を列インデックスへ変換して塗る。区間がどの列中心も
// 含まないほど狭い場合は、区間の中央に最も近い列を1マスだけ塗る。
// これにより「本来塗られるべき行が丸ごと空になる」ことを避け、
// 先端が不自然に伸びたり途切れたりしない滑らかなテーパーになる。
function fillRowInterval(row, w, x0, x1) {
  const toColF = (x) => ((x + 1) / 2) * w - 0.5;
  let c0 = Math.max(0, Math.ceil(toColF(x0)));
  let c1 = Math.min(w - 1, Math.floor(toColF(x1)));
  if (c0 > c1) {
    const c = Math.max(0, Math.min(w - 1, Math.round(toColF((x0 + x1) / 2))));
    row[c] = true;
  } else {
    for (let c = c0; c <= c1; c++) row[c] = true;
  }
}

function buildShapeMask(type, minC, minR, maxC, maxR) {
  const w = maxC - minC + 1, h = maxR - minR + 1;
  const mask = Array.from({length: h}, () => Array(w).fill(false));
  for (let r = 0; r < h; r++) {
    const v = ((r + 0.5) / h) * 2 - 1;
    const row = mask[r];
    if (type === 'heart') {
      const xs = heartRowIntersections(v);
      for (let i = 0; i + 1 < xs.length; i += 2) fillRowInterval(row, w, xs[i], xs[i + 1]);
    } else {
      for (let c = 0; c < w; c++) {
        const u = ((c + 0.5) / w) * 2 - 1;
        row[c] = isInsideShape(type, u, v);
      }
    }
  }
  return mask;
}

function toOutlineMask(mask) {
  const h = mask.length, w = mask[0].length;
  const outline = Array.from({length: h}, () => Array(w).fill(false));
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!mask[r][c]) continue;
      const hasEmptyNeighbor =
        !(mask[r - 1] && mask[r - 1][c]) ||
        !(mask[r + 1] && mask[r + 1][c]) ||
        !mask[r][c - 1] ||
        !mask[r][c + 1];
      outline[r][c] = hasEmptyNeighbor;
    }
  }
  return outline;
}

// 枠線を描画サイズ(ブラシサイズ)ぶん太らせる。brushRect と同じ形で
// 各セルを膨らませる。太らせた分は図形の元のバウンディングボックスの外に
// はみ出すことがあるため、配列自体を必要な分だけパディングして拡張し、
// 端で切り詰められない（平らにならない）ようにする。呼び出し側は返り値の
// padTop/padLeft を使って元のキャンバス座標に変換する。
function thickenMask(mask, size) {
  const h = mask.length, w = mask[0].length;
  if (size <= 1) return {mask, padTop: 0, padLeft: 0};
  const half = Math.floor(size / 2);
  const newH = h + size - 1, newW = w + size - 1;
  const result = Array.from({length: newH}, () => Array(newW).fill(false));
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!mask[r][c]) continue;
      for (let dr = 0; dr < size; dr++) {
        for (let dc = 0; dc < size; dc++) {
          result[r + dr][c + dc] = true;
        }
      }
    }
  }
  return {mask: result, padTop: half, padLeft: half};
}

function shapeBounds(c1, r1, c2, r2) {
  return {
    minC: Math.max(0, Math.min(c1, c2)),
    maxC: Math.min(cols - 1, Math.max(c1, c2)),
    minR: Math.max(0, Math.min(r1, r2)),
    maxR: Math.min(rows - 1, Math.max(r1, r2)),
  };
}

function applyShapeToCells(type, fill, c1, r1, c2, r2) {
  const {minC, maxC, minR, maxR} = shapeBounds(c1, r1, c2, r2);
  if (minC > maxC || minR > maxR) return;
  let mask = buildShapeMask(type, minC, minR, maxC, maxR);
  let padTop = 0, padLeft = 0;
  if (!fill) {
    const t = thickenMask(toOutlineMask(mask), brushSize);
    mask = t.mask; padTop = t.padTop; padLeft = t.padLeft;
  }
  for (let r = 0; r < mask.length; r++) {
    for (let c = 0; c < mask[0].length; c++) {
      if (!mask[r][c]) continue;
      const rr = minR + r - padTop, cc = minC + c - padLeft;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      if (!isCellEditable(rr, cc)) continue;
      cells[rr][cc] = currentColor;
    }
  }
}

function drawShapePreview(type, fill, c1, r1, c2, r2) {
  const px = cellPx();
  const ctx = cOv.getContext('2d');
  ctx.clearRect(0, 0, cOv.width, cOv.height);
  const {minC, maxC, minR, maxR} = shapeBounds(c1, r1, c2, r2);
  if (minC > maxC || minR > maxR) return;
  let mask = buildShapeMask(type, minC, minR, maxC, maxR);
  let padTop = 0, padLeft = 0;
  if (!fill) {
    const t = thickenMask(toOutlineMask(mask), brushSize);
    mask = t.mask; padTop = t.padTop; padLeft = t.padLeft;
  }
  ctx.fillStyle = 'rgba(59,130,246,0.5)';
  for (let r = 0; r < mask.length; r++) {
    for (let c = 0; c < mask[0].length; c++) {
      if (!mask[r][c]) continue;
      const rr = minR + r - padTop, cc = minC + c - padLeft;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      ctx.fillRect(cc * px, rr * px, px, px);
    }
  }
  ctx.strokeStyle = 'rgba(59,130,246,0.8)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(minC * px + 0.5, minR * px + 0.5, (maxC - minC + 1) * px - 1, (maxR - minR + 1) * px - 1);
  ctx.setLineDash([]);
}

function applyLineToCells(c1, r1, c2, r2) {
  for (const {col, row} of interpolateCells(c1, r1, c2, r2)) {
    paintBrush(col, row, currentColor); // 描画サイズ（ブラシサイズ）を反映する
  }
}

function drawLinePreview(c1, r1, c2, r2) {
  const px = cellPx();
  const ctx = cOv.getContext('2d');
  ctx.clearRect(0, 0, cOv.width, cOv.height);
  ctx.fillStyle = 'rgba(59,130,246,0.6)';
  for (const {col, row} of interpolateCells(c1, r1, c2, r2)) {
    const b = brushRect(col, row);
    const x1 = Math.max(0, b.c1) * px;
    const y1 = Math.max(0, b.r1) * px;
    const x2 = (Math.min(cols - 1, b.c2) + 1) * px;
    const y2 = (Math.min(rows - 1, b.r2) + 1) * px;
    if (x2 > x1 && y2 > y1) ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  }
}

// 画像からシルエット（bool[][]）を作る。左上のピクセルを背景色とみなし、
// 背景色に近い（または透明な）部分を「外側」とする。色は使わず、選択中の
// 色で塗るための形だけを取り出す。
function buildImageSilhouetteMask(img, w, h) {
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const ctx = off.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const bgR = data[0], bgG = data[1], bgB = data[2], bgA = data[3];
  const THRESH = 40;
  const mask = Array.from({length: h}, () => Array(w).fill(false));
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = (r * w + c) * 4;
      if (data[i + 3] < 128) continue; // 透明はすべて外側
      if (bgA >= 128) {
        const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB;
        if (Math.sqrt(dr * dr + dg * dg + db * db) < THRESH) continue; // 背景色に近い
      }
      mask[r][c] = true;
    }
  }
  return mask;
}

function applyHeartImageToCells(fill, c1, r1, c2, r2) {
  const {minC, maxC, minR, maxR} = shapeBounds(c1, r1, c2, r2);
  if (minC > maxC || minR > maxR) return;
  const w = maxC - minC + 1, h = maxR - minR + 1;
  let mask = buildImageSilhouetteMask(heartImage, w, h);
  let padTop = 0, padLeft = 0;
  if (!fill) {
    const t = thickenMask(toOutlineMask(mask), brushSize);
    mask = t.mask; padTop = t.padTop; padLeft = t.padLeft;
  }
  for (let r = 0; r < mask.length; r++) {
    for (let c = 0; c < mask[0].length; c++) {
      if (!mask[r][c]) continue;
      const rr = minR + r - padTop, cc = minC + c - padLeft;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      if (!isCellEditable(rr, cc)) continue;
      cells[rr][cc] = currentColor;
    }
  }
}

function drawHeartImagePreview(fill, c1, r1, c2, r2) {
  const px = cellPx();
  const ctx = cOv.getContext('2d');
  ctx.clearRect(0, 0, cOv.width, cOv.height);
  const {minC, maxC, minR, maxR} = shapeBounds(c1, r1, c2, r2);
  if (minC > maxC || minR > maxR) return;
  const w = maxC - minC + 1, h = maxR - minR + 1;
  let mask = buildImageSilhouetteMask(heartImage, w, h);
  let padTop = 0, padLeft = 0;
  if (!fill) {
    const t = thickenMask(toOutlineMask(mask), brushSize);
    mask = t.mask; padTop = t.padTop; padLeft = t.padLeft;
  }
  ctx.fillStyle = 'rgba(59,130,246,0.5)';
  for (let r = 0; r < mask.length; r++) {
    for (let c = 0; c < mask[0].length; c++) {
      if (!mask[r][c]) continue;
      const rr = minR + r - padTop, cc = minC + c - padLeft;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      ctx.fillRect(cc * px, rr * px, px, px);
    }
  }
  ctx.strokeStyle = 'rgba(59,130,246,0.8)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(minC * px + 0.5, minR * px + 0.5, w * px - 1, h * px - 1);
  ctx.setLineDash([]);
}

function floodFill(startCol, startRow, newColor) {
  if (!isCellEditable(startRow, startCol)) return;
  const target = cells[startRow][startCol];
  if (target === newColor) return;
  const stack = [[startCol, startRow]];
  while (stack.length) {
    const [c, r] = stack.pop();
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    if (!isCellEditable(r, c)) continue;
    if (cells[r][c] !== target) continue;
    cells[r][c] = newColor;
    stack.push([c+1,r],[c-1,r],[c,r+1],[c,r-1]);
  }
}

cOv.addEventListener('mousedown', e => {
  if (!started || e.button !== 0) return;
  // タブレットで指でタップすると、ブラウザがマウス操作を真似して送ってくるため、それでは描かない
  // （Pencilで描くモードでは指のタップを止めずにスクロールへ回しているので、ここで弾く）
  if (isEmulatedMouse()) return;
  const {col, row} = getCell(e);
  if (selectionMode === 'range') {
    rangeStart = {col, row};
    rangePath = [{col, row}];
    return;
  }
  if (selectionMode === 'color') {
    applyColorSelection(col, row);
    selectionMode = 'none';
    updateSelectionButtons();
    return;
  }
  if (selectionMode === 'flood') {
    applyFloodSelection(col, row);
    selectionMode = 'none';
    updateSelectionButtons();
    return;
  }
  if (currentTool === 'move') {
    startMoveDrag(col, row);
    return;
  }
  if (currentTool === 'shape') {
    if (activeLayerLocked()) return;
    shapeStart = {col, row};
    return;
  }
  if (activeLayerLocked() && currentTool !== 'pick') return;
  pushHistory();
  isPainting = true;
  lastCell = {col, row};
  applyToolSingle(col, row);
  drawCells();
});
cOv.addEventListener('mousemove', e => {
  if (!started) return;
  // タップの直後にブラウザが真似して送ってくるマウス操作では、ガイドの枠を出さない
  // （出すとタップした所に枠が残り、その後 Pencil を動かしても付いてこない）
  if (isEmulatedMouse()) return;
  const {col, row} = getCell(e);
  if (selectionMode === 'range' && rangeStart) {
    if (rangeSelectMode === 'free') {
      const last = rangePath[rangePath.length - 1];
      if (last.col !== col || last.row !== row) {
        for (const p of interpolateCells(last.col, last.row, col, row)) {
          const lp = rangePath[rangePath.length - 1];
          if (!lp || lp.col !== p.col || lp.row !== p.row) rangePath.push(p);
        }
      }
      drawFreeRangePreview(rangePath, col, row);
    } else {
      drawRangePreview(rangeStart.col, rangeStart.row, col, row);
    }
    return;
  }
  if (moveDrag) {
    updateMoveDrag(col, row);
    statPos.textContent = `${col+1}, ${row+1}`;
    return;
  }
  if (currentTool === 'shape' && shapeStart) {
    if (shapeType === 'line') {
      drawLinePreview(shapeStart.col, shapeStart.row, col, row);
    } else if (shapeType === 'heart' && heartImage) {
      drawHeartImagePreview(shapeFill, shapeStart.col, shapeStart.row, col, row);
    } else {
      drawShapePreview(shapeType, shapeFill, shapeStart.col, shapeStart.row, col, row);
    }
    statPos.textContent = `${col+1}, ${row+1}`;
    return;
  }
  drawOverlayCell(col, row);
  statPos.textContent = `${col+1}, ${row+1}`;
  const c = compositeAt(row, col);
  statColor.textContent = c || '—';
  if (!isPainting) return;
  if (lastCell && lastCell.col === col && lastCell.row === row) return;
  if (!lastCell) {
    // キャンバス外に出て戻ってきた直後。出た地点と直線でつながず、
    // 再進入地点から新しい線として描き始める。
    applyToolSingle(col, row);
    drawCells();
  } else {
    applyToolLine(lastCell.col, lastCell.row, col, row);
  }
  lastCell = {col, row};
});
document.addEventListener('mouseup', e => {
  if (selectionMode === 'range' && rangeStart) {
    const {col, row} = getCell(e);
    if (rangeSelectMode === 'free') {
      applyFreeRangeSelection(rangePath, col, row);
    } else {
      applyRangeSelection(rangeStart.col, rangeStart.row, col, row);
    }
    rangeStart = null;
    rangePath = [];
    selectionMode = 'none';
    updateSelectionButtons();
    return;
  }
  if (moveDrag) {
    endMoveDrag();
    return;
  }
  if (currentTool === 'shape' && shapeStart) {
    const {col, row} = getCell(e);
    pushHistory();
    if (shapeType === 'line') {
      applyLineToCells(shapeStart.col, shapeStart.row, col, row);
    } else if (shapeType === 'heart' && heartImage) {
      applyHeartImageToCells(shapeFill, shapeStart.col, shapeStart.row, col, row);
    } else {
      applyShapeToCells(shapeType, shapeFill, shapeStart.col, shapeStart.row, col, row);
    }
    shapeStart = null;
    drawCells();
    updateLayerThumbnails();
    const ctx = cOv.getContext('2d');
    ctx.clearRect(0, 0, cOv.width, cOv.height);
    drawSelectionOverlay(ctx);
    return;
  }
  if (isPainting) updateLayerThumbnails();
  isPainting = false; lastCell = null;
});
cOv.addEventListener('mouseleave',() => {
  cOv.getContext('2d').clearRect(0,0,cOv.width,cOv.height);
  statPos.textContent = '—';
  // 描画中にキャンバス外へ出たら線をいったん打ち切る。
  // これを消さないと、反対側から再進入したときに出た地点と
  // 入った地点が直線補間でつながって描画されてしまう。
  lastCell = null;
  hidePickLoupe();
});
// iPad で Pencil を浮かせて動かしたときもガイドの枠が出るが、Pencil を画面から遠ざけたときは
// マウスの「外に出た」が来ないことがあるため、Pencil 自体の「外に出た」でも消す
cOv.addEventListener('pointerleave', e => {
  if (e.pointerType === 'mouse' || isPainting || touchPick) return;
  redrawOverlay();
  statPos.textContent = '—';
  hidePickLoupe();
});

// ── スポイトの拡大鏡 ──
// スポイト中は、カーソルの横にカーソルのまわりを拡大した円を出す。
// 真ん中の枠がクリックで取れる色。カーソル自体は隠さないので、どこを指しているか分かりやすい。
const LOUPE_CELLS = 9;     // 縦横に見せるマスの数（真ん中があるよう奇数）
const LOUPE_CELL_PX = 12;  // 拡大鏡の中の1マスの大きさ
const LOUPE_GAP = 22;      // カーソルから離す距離
const LOUPE_GAP_TOUCH = 48; // タッチのときは指で隠れないよう、もっと離す
const LOUPE_D = LOUPE_CELLS * LOUPE_CELL_PX;
const LOUPE_W = LOUPE_D + 8, LOUPE_H = LOUPE_D + 8 + 30; // 円の下に色コードの札を付ける
const pickLoupe = document.createElement('canvas');
pickLoupe.className = 'pick-loupe';
document.body.appendChild(pickLoupe);
let loupeDpr = 0;

// colorAt(dx, dy)：真ん中から dx, dy ずれた所の色。'#rrggbb'、透明ならnull、範囲外ならundefined。
function showPickLoupe(clientX, clientY, colorAt, gap = LOUPE_GAP) {
  const dpr = window.devicePixelRatio || 1;
  if (dpr !== loupeDpr) {
    loupeDpr = dpr;
    pickLoupe.width = LOUPE_W * dpr;
    pickLoupe.height = LOUPE_H * dpr;
    pickLoupe.style.width = LOUPE_W + 'px';
    pickLoupe.style.height = LOUPE_H + 'px';
  }
  const ctx = pickLoupe.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, LOUPE_W, LOUPE_H);
  const cx = LOUPE_W / 2, cy = LOUPE_D / 2 + 4, r = LOUPE_D / 2;
  const x0 = cx - r, y0 = cy - r, S = LOUPE_CELL_PX, h = (LOUPE_CELLS - 1) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  for (let i = 0; i < LOUPE_CELLS; i++) {
    for (let j = 0; j < LOUPE_CELLS; j++) {
      const x = x0 + j * S, y = y0 + i * S;
      const c = colorAt(j - h, i - h);
      if (c === undefined) {
        ctx.fillStyle = '#888888';
        ctx.fillRect(x, y, S, S);
      } else if (c === null) {
        // 透明な所は市松模様
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y, S, S);
        ctx.fillStyle = '#d8d8d8';
        ctx.fillRect(x, y, S / 2, S / 2);
        ctx.fillRect(x + S / 2, y + S / 2, S / 2, S / 2);
      } else {
        ctx.fillStyle = c;
        ctx.fillRect(x, y, S, S);
      }
    }
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= LOUPE_CELLS; i++) {
    ctx.moveTo(x0 + i * S, y0); ctx.lineTo(x0 + i * S, y0 + LOUPE_D);
    ctx.moveTo(x0, y0 + i * S); ctx.lineTo(x0 + LOUPE_D, y0 + i * S);
  }
  ctx.stroke();
  ctx.restore();

  // 真ん中のマス（取れる色）は白黒の二重枠で、どんな色の上でも見えるようにする
  const mx = x0 + h * S, my = y0 + h * S;
  ctx.lineWidth = 3; ctx.strokeStyle = '#000000'; ctx.strokeRect(mx, my, S, S);
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.strokeRect(mx, my, S, S);
  ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1; ctx.strokeStyle = '#444444';
  ctx.beginPath(); ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2); ctx.stroke();

  // 色コードの札
  const center = colorAt(0, 0);
  const tw = 84, th = 22, tx = cx - tw / 2, ty = LOUPE_D + 12;
  ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#444444'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(tx + 0.5, ty + 0.5, tw - 1, th - 1, 6); ctx.fill(); ctx.stroke();
  if (center) {
    ctx.fillStyle = center;
    ctx.fillRect(tx + 6, ty + 5, 12, 12);
    ctx.strokeRect(tx + 6.5, ty + 5.5, 11, 11);
  }
  ctx.fillStyle = '#222222';
  ctx.font = '12px monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText(center || '—', tx + 24, ty + th / 2 + 1);

  // 基本はカーソルの右上。画面からはみ出すときは反対側に回す
  let left = clientX + gap, top = clientY - gap - LOUPE_H;
  if (left + LOUPE_W > window.innerWidth) left = clientX - gap - LOUPE_W;
  if (top < 0) top = clientY + gap;
  pickLoupe.style.transform = `translate(${left}px, ${top}px)`;
  pickLoupe.style.display = 'block';
}

function hidePickLoupe() {
  pickLoupe.style.display = 'none';
}

// キャンバス上のスポイト：合成後の色を見せる
cOv.addEventListener('mousemove', e => {
  if (!started || currentTool !== 'pick' || selectionMode !== 'none') { hidePickLoupe(); return; }
  if (isEmulatedMouse()) return; // タッチの真似のマウス操作では出さない
  const { col, row } = getCell(e);
  showPickLoupe(e.clientX, e.clientY, (dx, dy) => {
    const r = row + dy, c = col + dx;
    if (r < 0 || c < 0 || r >= rows || c >= cols) return undefined;
    return compositeAt(r, c);
  });
});

// タッチ対応（1本指：描画・選択・図形／2本指：ピンチズーム＋パン）
// 2本指の操作はキャンバスの周りの余白でも効くよう、キャンバスエリア側で受け取る。
// 1本指側は、マウスのmousedown/mousemove/mouseupと同じ分岐
// （選択モード・図形ツール・通常描画）をすべて再現する。
let pinchStartDist = 0;
let pinchStartZoom = 1;
let isPinching = false;
// ピンチ開始時に指の中心にあったセル座標（zoomに依存しない値）。
// ズーム中も常にこの点が指の中心の下に留まるようスクロールを補正する。
let pinchContentX = 0, pinchContentY = 0;

// ピンチに使うタッチ。Pencil で描くモードでは指だけを数える（Pencil と手のひらでピンチにしない）
function pinchTouches(e) {
  const all = [...e.touches];
  return fingersDraw() ? all : all.filter(t => !isStylus(t));
}

function getTouchDist(touches) {
  const [t0, t1] = touches;
  const dx = t1.clientX - t0.clientX, dy = t1.clientY - t0.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function getTouchCenter(touches) {
  const [t0, t1] = touches;
  return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
}

function touchPointerDown(col, row) {
  if (selectionMode === 'range') {
    rangeStart = {col, row};
    rangePath = [{col, row}];
    return;
  }
  if (selectionMode === 'color') {
    applyColorSelection(col, row);
    selectionMode = 'none';
    updateSelectionButtons();
    return;
  }
  if (selectionMode === 'flood') {
    applyFloodSelection(col, row);
    selectionMode = 'none';
    updateSelectionButtons();
    return;
  }
  if (currentTool === 'move') {
    startMoveDrag(col, row);
    return;
  }
  if (currentTool === 'shape') {
    if (activeLayerLocked()) return;
    shapeStart = {col, row};
    return;
  }
  if (currentTool === 'pick') return; // タッチのスポイトは下の「タッチのスポイト」で扱う
  showTouchGuide(col, row);
  if (activeLayerLocked()) return;
  pushHistory();
  isPainting = true;
  lastCell = {col, row};
  applyToolSingle(col, row);
  drawCells();
}

// タッチ（Pencil・指）にはマウスのようにカーソルだけ動かす操作が無いので、
// 触れている間はガイドの枠を触れている所に合わせて動かし、離したら消す
function showTouchGuide(col, row) {
  drawOverlayCell(col, row);
  statPos.textContent = `${col+1}, ${row+1}`;
  statColor.textContent = compositeAt(row, col) || '—';
}

// ── タッチのスポイト ──
// 指・Pencil では、触れた瞬間には取らず、触れている間はガイドの枠と拡大鏡を付いてこさせ、
// 離した所の色を取る（指やペン先で隠れて狙えないため）。
// 色選択画面の 💉（サイト内のスポイト）と同じく、ポインタのイベント（pointerdown など）で受け取る。
// マウスは今まで通り、押した瞬間に取る（mousedown 側）。
let touchPick = null; // スポイトしている途中のポインタ {id}

function showTouchPick(clientX, clientY) {
  const { col, row } = getCell({ clientX, clientY });
  showTouchGuide(col, row);
  // 拡大鏡は指で隠れないよう、マウスのときより離して出す
  showPickLoupe(clientX, clientY, (dx, dy) => {
    const r = row + dy, c = col + dx;
    if (r < 0 || c < 0 || r >= rows || c >= cols) return undefined;
    return compositeAt(r, c);
  }, LOUPE_GAP_TOUCH);
}

function endTouchPick() {
  touchPick = null;
  hidePickLoupe();
  redrawOverlay();
  statPos.textContent = '—';
}

cOv.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse') return;
  if (touchPick) {
    // スポイト中にもう1本指が触れたらピンチなので、色を取らずにやめる（Pencil で描くモードの指は無視）
    if (e.pointerType === 'touch' && fingersDraw()) endTouchPick();
    return;
  }
  if (!started || currentTool !== 'pick' || selectionMode !== 'none') return;
  if (e.pointerType === 'touch' && !fingersDraw()) return; // Pencil で描くモードでは、指は移動・拡大縮小に使う
  touchPick = { id: e.pointerId };
  try { cOv.setPointerCapture(e.pointerId); } catch (err) { /* 捕捉できなくてもキャンバスの上では動く */ }
  showTouchPick(e.clientX, e.clientY);
});
cOv.addEventListener('pointermove', e => {
  if (touchPick && e.pointerId === touchPick.id) showTouchPick(e.clientX, e.clientY);
});
cOv.addEventListener('pointerup', e => {
  if (!touchPick || e.pointerId !== touchPick.id) return;
  const { col, row } = getCell(e);
  endTouchPick();
  applyToolSingle(col, row); // 離した所の色を取る（キャンバスの外で離したら取らない）
});
cOv.addEventListener('pointercancel', e => {
  if (touchPick && e.pointerId === touchPick.id) endTouchPick();
});

function touchPointerMove(col, row) {
  if (currentTool === 'pick') return;
  if (selectionMode === 'range' && rangeStart) {
    if (rangeSelectMode === 'free') {
      const last = rangePath[rangePath.length - 1];
      if (last.col !== col || last.row !== row) {
        for (const p of interpolateCells(last.col, last.row, col, row)) {
          const lp = rangePath[rangePath.length - 1];
          if (!lp || lp.col !== p.col || lp.row !== p.row) rangePath.push(p);
        }
      }
      drawFreeRangePreview(rangePath, col, row);
    } else {
      drawRangePreview(rangeStart.col, rangeStart.row, col, row);
    }
    return;
  }
  if (moveDrag) {
    updateMoveDrag(col, row);
    return;
  }
  if (currentTool === 'shape' && shapeStart) {
    if (shapeType === 'line') {
      drawLinePreview(shapeStart.col, shapeStart.row, col, row);
    } else if (shapeType === 'heart' && heartImage) {
      drawHeartImagePreview(shapeFill, shapeStart.col, shapeStart.row, col, row);
    } else {
      drawShapePreview(shapeType, shapeFill, shapeStart.col, shapeStart.row, col, row);
    }
    return;
  }
  showTouchGuide(col, row);
  if (!isPainting) return;
  if (lastCell && lastCell.col === col && lastCell.row === row) return;
  applyToolLine(lastCell.col, lastCell.row, col, row);
  lastCell = {col, row};
}

function touchPointerUp(col, row) {
  if (selectionMode === 'range' && rangeStart) {
    if (rangeSelectMode === 'free') {
      applyFreeRangeSelection(rangePath, col, row);
    } else {
      applyRangeSelection(rangeStart.col, rangeStart.row, col, row);
    }
    rangeStart = null;
    rangePath = [];
    selectionMode = 'none';
    updateSelectionButtons();
    return;
  }
  if (moveDrag) {
    endMoveDrag();
    return;
  }
  if (currentTool === 'shape' && shapeStart) {
    pushHistory();
    if (shapeType === 'line') {
      applyLineToCells(shapeStart.col, shapeStart.row, col, row);
    } else if (shapeType === 'heart' && heartImage) {
      applyHeartImageToCells(shapeFill, shapeStart.col, shapeStart.row, col, row);
    } else {
      applyShapeToCells(shapeType, shapeFill, shapeStart.col, shapeStart.row, col, row);
    }
    shapeStart = null;
    drawCells();
    updateLayerThumbnails();
    const ctx = cOv.getContext('2d');
    ctx.clearRect(0, 0, cOv.width, cOv.height);
    drawSelectionOverlay(ctx);
    return;
  }
  if (isPainting) updateLayerThumbnails();
  isPainting = false; lastCell = null;
  redrawOverlay(); // 離したらガイドの枠を消す
  statPos.textContent = '—';
}

// ピンチのつもりで2本の指を置くと、ほんの少し早く触れた1本目で描き始めてしまう。
// 1本目から少しの間に2本目が来たら「最初からピンチだった」とみなし、1本目で始めた
// 操作（点・図形・範囲選択・移動）を丸ごと取り消す。長く描いた後に2本目が来た場合は、
// それまでの線を残して終える。
const PINCH_GRACE_MS = 300;
let singleTouchStart = null; // 1本目が触れた時点の {time, historyLen, redo, unsaved}

function cancelSingleTouchGesture() {
  const t = singleTouchStart;
  singleTouchStart = null;
  const justStarted = t && performance.now() - t.time < PINCH_GRACE_MS;
  if (isPainting || moveDrag) {
    if (justStarted && history.length === t.historyLen + 1) {
      // 1本目が積んだ履歴を使って描く前の状態に戻し、やり直し用の履歴も元どおりにする
      isPainting = false;
      lastCell = null;
      moveDrag = null;
      restoreSnapshot(history.pop());
      redoStack = t.redo;
      hasUnsavedChanges = t.unsaved;
      updateHistoryButtons();
      updateLayerThumbnails();
    } else {
      if (isPainting) updateLayerThumbnails();
      isPainting = false;
      lastCell = null;
      endMoveDrag();
    }
  }
  // 図形・範囲選択・タッチのスポイトはまだ確定前なので、途中の状態を捨てるだけでよい
  if (touchPick) endTouchPick();
  shapeStart = null;
  rangeStart = null;
  rangePath = [];
  redrawOverlay();
}

// ── Apple Pencil と指の使い分け（タブレット） ──
// タブレットでは、お絵かきソフトと同じく Pencil で描き、指はキャンバスの移動（1本指）と
// 拡大縮小（2本指）に使う。描いている間に手のひらが画面に触れても描かれない。
// Pencil を持っていない人のため、道具バーの☝で「指でも描く」に切り替えられる。
// まだ選んでいないうちは指でも描け、初めて Pencil で触れた時点で「Pencilで描く」に切り替わる。
const FINGER_DRAW_KEY = 'pixelart-finger-draw';
let fingerDrawSetting = null; // true: 指でも描く / false: Pencilだけで描く / null: まだ選んでいない
try {
  const v = localStorage.getItem(FINGER_DRAW_KEY);
  if (v === '1' || v === '0') fingerDrawSetting = v === '1';
} catch (err) { /* 読めなければ未選択として扱う */ }

function fingersDraw() {
  return !tabletUI || fingerDrawSetting !== false;
}
const btnFingerDraw = document.getElementById('btn-finger-draw');
function updateFingerDrawButton() {
  const on = fingersDraw();
  btnFingerDraw.classList.toggle('active', on);
  btnFingerDraw.title = on
    ? '指でも描く：オン（押すと Pencil だけで描き、指はキャンバスの移動・拡大縮小に使います）'
    : '指でも描く：オフ（指はキャンバスの移動・拡大縮小。押すと指でも描けます）';
}
function setFingerDraw(on) {
  fingerDrawSetting = on;
  try { localStorage.setItem(FINGER_DRAW_KEY, on ? '1' : '0'); } catch (err) { /* 覚えられなくても使える */ }
  updateFingerDrawButton();
}
btnFingerDraw.addEventListener('click', () => setFingerDraw(!fingersDraw()));
updateFingerDrawButton();

// iPad の Safari では、Apple Pencil のタッチは touchType が 'stylus' になる
const isStylus = t => t.touchType === 'stylus';
let penTouchId = null; // 描いている最中の Pencil のタッチ
// タッチの直後にブラウザが真似して送ってくるマウス操作で描かないよう、最後のタッチ時刻を覚える。
// 触れた時だけでなく、動かした時・離した時も覚える。iPad の Pencil では、長めに描いて離した後に
// 最初に触れた所へのマウス操作が届くことがあり、触れた時から測ると間に合わずにガイドの枠がそこへ戻ってしまう。
let lastTouchAt = -Infinity;
['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(type => {
  cOv.addEventListener(type, () => { lastTouchAt = performance.now(); }, { passive: true });
});
// 直前のポインタの種類（'mouse' / 'touch'（指）/ 'pen'（Pencil））。ブラウザは、指や Pencil の操作の後に
// マウス操作を真似して送ってくることがあり、iPad ではその時刻も位置（最初に触れた所など）も当てにならない。
// ポインタのイベントは真似のマウス操作より必ず先に届くので、直前がマウスでなければ真似とみなして無視する。
let lastPointerType = 'mouse';
['pointerdown', 'pointermove', 'pointerup'].forEach(type => {
  window.addEventListener(type, e => { lastPointerType = e.pointerType; }, true);
});
function isEmulatedMouse() {
  return lastPointerType !== 'mouse' || performance.now() - lastTouchAt < 800;
}
const findTouch = (list, id) => [...list].find(t => t.identifier === id);

cOv.addEventListener('touchstart', e => {
  // 初めて Pencil で触れたら、指は移動・拡大縮小に使うよう切り替える（まだ選んでいない場合）
  if (tabletUI && fingerDrawSetting === null && [...e.changedTouches].some(isStylus)) {
    setFingerDraw(false);
    showToast('Apple Pencil で描き、指はキャンバスの移動・拡大縮小に使います（左の ☝ で切り替え）');
  }
  if (!fingersDraw()) {
    const pen = [...e.changedTouches].find(isStylus);
    if (!pen) return; // 指はブラウザのスクロール（移動）と、下のピンチ処理に任せる
    e.preventDefault();
    if (!started || penTouchId !== null) return;
    penTouchId = pen.identifier;
    const {col, row} = getCell(pen);
    touchPointerDown(col, row);
    return;
  }
  e.preventDefault();
  if (e.touches.length >= 2) return; // ピンチはキャンバスエリア側で扱う
  if (!started) return;
  singleTouchStart = {
    time: performance.now(),
    historyLen: history.length,
    redo: redoStack,
    unsaved: hasUnsavedChanges,
  };
  const {col, row} = getCell(e.touches[0]);
  touchPointerDown(col, row);
}, {passive: false});

cOv.addEventListener('touchmove', e => {
  if (!fingersDraw()) {
    const pen = findTouch(e.changedTouches, penTouchId);
    if (!pen) return;
    e.preventDefault();
    const {col, row} = getCell(pen);
    touchPointerMove(col, row);
    return;
  }
  e.preventDefault();
  if (isPinching || e.touches.length >= 2 || !started) return;
  const {col, row} = getCell(e.touches[0]);
  touchPointerMove(col, row);
}, {passive: false});

cOv.addEventListener('touchend', e => {
  if (!fingersDraw()) {
    const pen = findTouch(e.changedTouches, penTouchId);
    if (!pen) return;
    penTouchId = null;
    if (started) {
      const {col, row} = getCell(pen);
      touchPointerUp(col, row);
    }
    return;
  }
  if (e.touches.length > 0) return;
  singleTouchStart = null;
  const t = e.changedTouches[0];
  if (t && started && !isPinching) {
    const {col, row} = getCell(t);
    touchPointerUp(col, row);
  } else {
    isPainting = false; lastCell = null;
  }
});
cOv.addEventListener('touchcancel', e => {
  if (!fingersDraw()) {
    if (!findTouch(e.changedTouches, penTouchId)) return;
    penTouchId = null;
  }
  cancelSingleTouchGesture();
});

// ── ピンチで拡大縮小（キャンバスの上でも、周りの余白や定規の上でも） ──
// キャンバスや定規の上のタッチもここまで伝わってくるので、2本指の操作はすべてここで扱う。
const pinchArea = document.getElementById('canvas-stage');
pinchArea.addEventListener('touchstart', e => {
  const touches = pinchTouches(e);
  if (touches.length < 2) return;
  e.preventDefault(); // ブラウザによるページ全体の拡大縮小を止める
  if (penTouchId !== null) return; // Pencil で描いている最中は拡大縮小しない
  if (!isPinching) {
    if (fingersDraw()) cancelSingleTouchGesture(); // Pencilモードの指は描いていないので取り消す物がない
    cancelRulerDrag(); // 定規の上でピンチを始めたときに、1本目で選んだ強調を取り消す
  }
  isPinching = true;
  pinchStartDist = getTouchDist(touches) || 1;
  pinchStartZoom = zoom;
  const ctr = getTouchCenter(touches);
  const wrapRect = wrap.getBoundingClientRect();
  pinchContentX = (ctr.x - wrapRect.left) / pinchStartZoom;
  pinchContentY = (ctr.y - wrapRect.top) / pinchStartZoom;
}, {passive: false});

pinchArea.addEventListener('touchmove', e => {
  // Pencil で描いている間は、手のひらなどが動いてもキャンバスをスクロールさせない
  if (penTouchId !== null) { e.preventDefault(); return; }
  const touches = pinchTouches(e);
  if (!isPinching || touches.length < 2) return;
  e.preventDefault();
  const dist = getTouchDist(touches);
  const scale = dist / pinchStartDist;
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartZoom * scale));

  setZoom(newZoom); // zoomは内部でMIN_ZOOM〜MAX_ZOOMにクランプされる

  // パディング量がzoomに応じて非線形に変わる（updateScrollPadding参照）ため、
  // 比率計算ではなく、実際にレイアウトされたwrapの位置を測定して補正する
  // （マウスホイールズームと同じ方式。詳細はそちらのコメント参照）。
  const ctr = getTouchCenter(touches);
  const wrapRectNow = wrap.getBoundingClientRect();
  const desiredLeft = ctr.x - pinchContentX * zoom;
  const desiredTop = ctr.y - pinchContentY * zoom;
  canvasArea.scrollLeft += wrapRectNow.left - desiredLeft;
  canvasArea.scrollTop  += wrapRectNow.top - desiredTop;
}, {passive: false});

// 指を1本ずつ離したとき、残った指で描き始めないよう、全部離れるまでピンチ扱いを続ける
// （Pencilで描くモードでは指で描かないので、2本未満になった時点で終える）
function endPinchIfAllLifted(e) {
  if (e.touches.length === 0 || (!fingersDraw() && pinchTouches(e).length < 2)) isPinching = false;
}
pinchArea.addEventListener('touchend', endPinchIfAllLifted);
pinchArea.addEventListener('touchcancel', endPinchIfAllLifted);

// 上記以外の場所（ヘッダーやボタンの上など）で2本指を動かしても、
// ページ全体が拡大縮小されないようにする
document.addEventListener('touchmove', e => {
  if (e.touches.length > 1) e.preventDefault();
}, {passive: false});

// iPhone・iPadのSafariは独自のピンチ操作（gesture系イベント）でもページを拡大縮小するため、
// ページ全体で止めておく（参考画像ウィンドウなど、必要な所は自前で拡大縮小している）
['gesturestart', 'gesturechange'].forEach(type => {
  document.addEventListener(type, e => e.preventDefault(), {passive: false});
});

// ── ヒストリー ────────────────────────────────────────
// history: 元に戻す用、redoStack: やり直し用。
// 新しい操作をした時点でやり直し用の履歴は捨てる。
// グリッドサイズの変更も戻せるよう、cols/rowsと選択範囲も一緒に記録する。
let redoStack = [];
const HISTORY_LIMIT = 50;
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');

// 描く・レイヤーの操作など、ひとつのコマの中の変更は、そのコマのレイヤーだけを記録する（frame）。
// コマの追加・削除・並べ替えやキャンバスの大きさの変更は全部のコマに関わるので、
// 全部のコマを記録する（framesSnapshot）。コマが多いと大きくなるので、そのときだけにする
const copyLayers = list => list.map(l => ({ name: l.name, visible: l.visible, opacity: l.opacity, locked: l.locked, cells: l.cells.map(r => [...r]) }));
function layersSnapshot(frameIndex = currentFrame) {
  const isCurrent = frameIndex === currentFrame;
  return {
    cols, rows,
    frame: frameIndex,
    active: isCurrent ? activeLayerIndex : frames[frameIndex].active,
    mask: selectionMask, // 選択範囲は作り直す一方で書き換えないため参照のままでよい
    layers: copyLayers(isCurrent ? layers : frames[frameIndex].layers),
  };
}
function framesSnapshot() {
  return {
    cols, rows,
    frame: currentFrame,
    mask: selectionMask,
    frames: frames.map((f, i) => ({
      layers: copyLayers(f.layers),
      active: i === currentFrame ? activeLayerIndex : f.active,
    })),
  };
}
// 戻す・やり直すときに、反対側の履歴へ積む「今の状態」（戻す記録と同じ範囲を記録する）
const snapshotLike = snap => snap.frames ? framesSnapshot() : layersSnapshot(snap.frame);
function updateHistoryButtons() {
  btnUndo.disabled = !history.length;
  btnRedo.disabled = !redoStack.length;
}
// keepFloat: 選択範囲の移動中の操作から呼ぶときだけtrue（移動状態を維持する）
function pushSnapshot(snap, keepFloat) {
  if (!keepFloat) floating = null;
  history.push(snap);
  if (history.length > HISTORY_LIMIT) history.shift();
  redoStack = [];
  updateHistoryButtons();
  markChanged();
}
function pushHistory() {
  pushSnapshot(layersSnapshot());
}
// コマの増減・並べ替え、キャンバスの大きさの変更の前に呼ぶ
function pushFramesHistory() {
  pushSnapshot(framesSnapshot());
}
function clearHistory() {
  history = [];
  redoStack = [];
  updateHistoryButtons();
}
function restoreSnapshot(snap) {
  floating = null;
  const sizeChanged = snap.cols !== cols || snap.rows !== rows;
  cols = snap.cols;
  rows = snap.rows;
  if (snap.frames) {
    frames = snap.frames;
    currentFrame = Math.min(snap.frame, frames.length - 1);
  } else {
    // そのコマのレイヤーを戻し、どのコマが戻ったか分かるようにそのコマを表示する
    frames[currentFrame].active = activeLayerIndex;
    frames[snap.frame] = { layers: snap.layers, active: snap.active };
    currentFrame = snap.frame;
  }
  layers = frames[currentFrame].layers;
  activeLayerIndex = frames[currentFrame].active;
  selectionMask = snap.mask;
  syncActiveCells();
  if (typeof onFramesChanged === 'function') onFramesChanged();
  if (sizeChanged) {
    document.getElementById('stat-grid').textContent = `${cols}×${rows}`;
    resizeCanvases();
    syncSlidersToGrid();
  } else {
    drawCells();
  }
  updateLayerPanel();
  updateSelectionButtons();
  updateHistoryButtons();
  markChanged();
}
function undo() {
  if (!history.length || isPainting || moveDrag) return;
  const snap = history.pop();
  redoStack.push(snapshotLike(snap));
  restoreSnapshot(snap);
}
function redo() {
  if (!redoStack.length || isPainting || moveDrag) return;
  const snap = redoStack.pop();
  history.push(snapshotLike(snap));
  restoreSnapshot(snap);
}
// キーの位置（e.code）で判定するため、日本語入力がオンでも効く。
// Ctrl+Z: 元に戻す／Ctrl+Y・Ctrl+Shift+Z: やり直し
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (isTypingTarget(e.target)) return; // 入力欄では文字の取り消しを優先する
  if (e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); redo(); }
});
btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

// Macでは Ctrl ではなく ⌘ を使うので、ボタンのキー表示をMacの書き方に合わせる
// （やり直しはMacで一般的な ⌘⇧Z を表示する。⌘Y でも動く）
if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
  const MAC_SHORTCUTS = { undo: ['⌘Z', '元に戻す（⌘Z）'], redo: ['⌘⇧Z', 'やり直し（⌘⇧Z）'] };
  document.querySelectorAll('[data-shortcut]').forEach(k => {
    const [label, title] = MAC_SHORTCUTS[k.dataset.shortcut];
    k.textContent = label;
    k.closest('button').title = title;
  });
}

// ── パネルタブ（描画／レイヤー） ──────────────────────
const tabDrawBtn = document.getElementById('tab-draw');
const tabLayersBtn = document.getElementById('tab-layers');
const tabDrawPage = document.getElementById('panel-tab-draw');
const tabLayersPage = document.getElementById('panel-tab-layers');

function switchPanelTab(tab) {
  // ドック中はレイヤーページが左パネルの外（ドック）にあるため、
  // タブ切替の対象からは外して常に描画タブを表示する。
  const showLayers = tab === 'layers' && !layersDocked;
  tabDrawBtn.classList.toggle('active', !showLayers);
  tabLayersBtn.classList.toggle('active', showLayers);
  tabDrawPage.style.display = showLayers ? 'none' : '';
  if (!layersDocked) tabLayersPage.style.display = showLayers ? '' : 'none';
  if (showLayers) updateLayerThumbnails();
}

tabDrawBtn.addEventListener('click', () => switchPanelTab('draw'));
tabLayersBtn.addEventListener('click', () => switchPanelTab('layers'));

// ── レイヤードック（左パネルの右に並べて表示） ─────────
// レイヤーページのDOMノード自体をドックへ移動する。ノードを移動しても
// 登録済みのイベントリスナーは保持されるため、レイヤー操作はそのまま動く。
const layerDock = document.getElementById('layer-dock');
const btnDockLayers = document.getElementById('btn-dock-layers');
const btnUndockLayers = document.getElementById('btn-undock-layers');
let layersDocked = false;

function setLayersDocked(docked) {
  const anchor = canvasScreenPos(); // ドックの出し入れでキャンバスをずらさない
  layersDocked = docked;
  if (docked) {
    layerDock.appendChild(tabLayersPage);
    tabLayersPage.style.display = '';
    layerDock.style.display = '';
    tabLayersBtn.style.display = 'none';
    btnDockLayers.style.display = 'none';
  } else {
    panel.appendChild(tabLayersPage); // 元の位置（描画ページの後ろ）に戻す
    layerDock.style.display = 'none';
    tabLayersBtn.style.display = '';
    btnDockLayers.style.display = '';
  }
  switchPanelTab('draw');
  updateLayerPanel();
  syncTogglePosition();
  updateScrollPadding();
  restoreCanvasScreenPos(anchor);
}

btnDockLayers.addEventListener('click', () => setLayersDocked(true));
btnUndockLayers.addEventListener('click', () => setLayersDocked(false));

// ── レイヤーパネル ────────────────────────────────────
const layerListEl = document.getElementById('layer-list');
const btnLayerAdd = document.getElementById('btn-layer-add');
const btnLayerUp = document.getElementById('btn-layer-up');
const btnLayerDown = document.getElementById('btn-layer-down');
const btnLayerDelete = document.getElementById('btn-layer-delete');
const btnLayerDup = document.getElementById('btn-layer-dup');
const btnLayerMerge = document.getElementById('btn-layer-merge');
const btnLayerLock = document.getElementById('btn-layer-lock');
const layerOpacitySlider = document.getElementById('layer-opacity');
const layerOpacityVal = document.getElementById('layer-opacity-val');
let layerThumbCanvases = []; // layers と同じ並び（i=0が最下層）
let lastLayerNameTap = null; // レイヤー名のダブルクリック判定用 {layer, time}

function drawLayerThumb(canvas, layer) {
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cols, rows);
  // サムネイルは元から1マス=1ピクセルなので、そのままImageDataを流し込む
  ctx.putImageData(layerImageData(ctx, layer.cells), 0, 0);
}

function updateLayerThumbnails() {
  layers.forEach((layer, i) => {
    if (layerThumbCanvases[i]) drawLayerThumb(layerThumbCanvases[i], layer);
  });
  if (window.onFrameEdited) window.onFrameEdited(); // コマの一覧の小さな絵も描き直す
}

function updateLayerPanel() {
  if (!layerListEl) return;
  layerListEl.innerHTML = '';
  layerThumbCanvases = new Array(layers.length);
  // 上のレイヤーほどリストの上に表示する
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const item = document.createElement('div');
    item.className = 'layer-item'
      + (i === activeLayerIndex ? ' active' : '')
      + (layer.visible ? '' : ' hidden-layer');

    const eye = document.createElement('button');
    eye.className = 'layer-eye' + (layer.visible ? '' : ' hidden-layer');
    eye.textContent = layer.visible ? '👁' : '─';
    eye.title = layer.visible ? '非表示にする' : '表示する';
    eye.addEventListener('click', e => {
      e.stopPropagation();
      pushHistory();
      layer.visible = !layer.visible;
      drawCells();
      updateLayerPanel();
    });

    const thumb = document.createElement('canvas');
    thumb.className = 'layer-thumb';
    drawLayerThumb(thumb, layer);
    layerThumbCanvases[i] = thumb;

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name;
    name.title = 'ダブルクリック（ダブルタップ）で名前を変更';
    // ダブルクリックの判定は自前で行う。スマホ・iPad のブラウザはダブルタップで dblclick を送らないうえ、
    // 1回目のタップでレイヤーが切り替わるとリストが作り直され、2回目は別の要素へのタップになるため。
    name.addEventListener('click', e => {
      const now = performance.now();
      if (lastLayerNameTap && lastLayerNameTap.layer === layer && now - lastLayerNameTap.time < 500) {
        e.stopPropagation();
        lastLayerNameTap = null;
        startRenameLayer(layer, name);
        return;
      }
      lastLayerNameTap = { layer, time: now }; // 1回目はそのまま項目のクリック（レイヤーの切り替え）になる
    });

    item.appendChild(eye);
    item.appendChild(thumb);
    item.appendChild(name);
    if (layer.locked) {
      const lock = document.createElement('span');
      lock.className = 'layer-lock-icon';
      lock.textContent = '🔒';
      lock.title = 'ロック中';
      item.appendChild(lock);
    }

    const handle = document.createElement('span');
    handle.className = 'layer-drag-handle';
    handle.textContent = '⠿';
    handle.title = 'ドラッグで並び替え';
    handle.addEventListener('click', e => e.stopPropagation());
    handle.addEventListener('pointerdown', e => startLayerDrag(e, i, item));
    item.appendChild(handle);

    item.addEventListener('click', () => {
      if (i === activeLayerIndex) return;
      activeLayerIndex = i;
      syncActiveCells();
      updateLayerPanel();
    });
    layerListEl.appendChild(item);
  }
  btnLayerDelete.disabled = layers.length <= 1;
  btnLayerUp.disabled = activeLayerIndex >= layers.length - 1;
  btnLayerDown.disabled = activeLayerIndex <= 0;
  btnLayerMerge.disabled = activeLayerIndex <= 0;
  const active = layers[activeLayerIndex];
  if (active) {
    layerOpacitySlider.value = Math.round(active.opacity * 100);
    layerOpacityVal.textContent = Math.round(active.opacity * 100);
    btnLayerLock.classList.toggle('active', !!active.locked);
    btnLayerLock.textContent = active.locked ? '🔒' : '🔓';
    btnLayerLock.title = active.locked ? 'ロックを解除' : 'レイヤーをロック';
  }
  updateHeaderStatus();
  if (window.onFrameEdited) window.onFrameEdited(); // レイヤーの表示切替などでコマの見た目も変わる
}

// レイヤー項目のドラッグ並び替え（上下移動のみ）。
// ドラッグ中はリスト内のDOMを直接並び替えてプレビューし、
// 離した時点で順序が変わっていればlayers配列に反映して履歴を積む。
function startLayerDrag(e, layerIdx, item) {
  e.preventDefault();
  e.stopPropagation();
  const snap = layersSnapshot(); // ドラッグ前の状態（Undo用）
  const displayItems = () => [...layerListEl.children];
  const startDisplay = displayItems().indexOf(item);
  let curDisplay = startDisplay;
  item.classList.add('dragging');
  // つかんだ位置（項目上端からのオフセット）を覚えて、項目がカーソルに追従して浮くようにする
  const grabDelta = e.clientY - item.getBoundingClientRect().top;
  let dragY = 0; // 現在適用中のtranslateY量
  // 注意: ドラッグ中の項目(item)自体をinsertBeforeで動かしてはいけない。
  // 要素が一瞬DOMから外れるとポインタキャプチャが失われ、ドラッグが
  // 途中で切れてしまう。入れ替えは必ず相手側の項目を動かして実現する。

  const onMove = ev => {
    // 隣の項目の中点をポインタが越えたら1つ入れ替える。
    // 速いドラッグで一度に複数越えた場合に備えて安定するまで繰り返す。
    for (let guard = 0; guard < layers.length; guard++) {
      const list = displayItems();
      const idx = list.indexOf(item);
      const next = list[idx + 1];
      if (next && ev.clientY > next.getBoundingClientRect().top + next.getBoundingClientRect().height / 2) {
        layerListEl.insertBefore(next, item); // 下の項目を自分の上へ
        continue;
      }
      const prev = list[idx - 1];
      if (prev && ev.clientY < prev.getBoundingClientRect().top + prev.getBoundingClientRect().height / 2) {
        layerListEl.insertBefore(prev, item.nextSibling); // 上の項目を自分の下へ
        continue;
      }
      break;
    }
    curDisplay = displayItems().indexOf(item);
    // 入れ替え後の自然位置を基準に、カーソル位置まで浮かせる
    // （リストの範囲外にはみ出さないようにクランプする）
    const itemRect = item.getBoundingClientRect();
    const naturalTop = itemRect.top - dragY;
    const listRect = layerListEl.getBoundingClientRect();
    let desiredTop = ev.clientY - grabDelta;
    desiredTop = Math.max(listRect.top, Math.min(desiredTop, listRect.bottom - itemRect.height));
    dragY = desiredTop - naturalTop;
    item.style.transform = `translateY(${dragY}px)`;
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    item.classList.remove('dragging');
    item.style.transform = '';
    if (curDisplay !== startDisplay) {
      pushSnapshot(snap);
      // 表示位置（上が先頭）→ layers配列のインデックス（0が最下層）に変換
      const to = layers.length - 1 - curDisplay;
      const [layer] = layers.splice(layerIdx, 1);
      layers.splice(to, 0, layer);
      activeLayerIndex = to;
      syncActiveCells();
      drawCells();
    }
    updateLayerPanel();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// レイヤー名のインライン編集。Enterまたはフォーカスアウトで確定する。
function startRenameLayer(layer, nameEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'layer-name-input';
  input.value = layer.name;
  input.maxLength = 20;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (newName && newName !== layer.name) {
      pushHistory();
      layer.name = newName;
    }
    updateLayerPanel();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') { done = true; updateLayerPanel(); }
    e.stopPropagation();
  });
  input.addEventListener('click', e => e.stopPropagation());
}

// アクティブレイヤーの直上に空レイヤーを追加してアクティブにする
// （履歴は呼び出し側で積むこと）
function addLayerAboveActive() {
  const layer = makeLayer(`レイヤー${layerNameCounter++}`);
  layers.splice(activeLayerIndex + 1, 0, layer);
  activeLayerIndex += 1;
  syncActiveCells();
  updateLayerPanel();
}

btnLayerAdd.addEventListener('click', () => {
  if (!started) return;
  pushHistory();
  addLayerAboveActive();
});

btnLayerDelete.addEventListener('click', () => {
  if (!started || layers.length <= 1) return;
  pushHistory();
  layers.splice(activeLayerIndex, 1);
  activeLayerIndex = Math.min(activeLayerIndex, layers.length - 1);
  syncActiveCells();
  drawCells();
  updateLayerPanel();
});

function moveActiveLayer(dir) {
  const to = activeLayerIndex + dir;
  if (to < 0 || to >= layers.length) return;
  pushHistory();
  const [layer] = layers.splice(activeLayerIndex, 1);
  layers.splice(to, 0, layer);
  activeLayerIndex = to;
  syncActiveCells();
  drawCells();
  updateLayerPanel();
}

btnLayerUp.addEventListener('click', () => { if (started) moveActiveLayer(1); });
btnLayerDown.addEventListener('click', () => { if (started) moveActiveLayer(-1); });

// 不透明度スライダー。ドラッグ中はリアルタイムに反映し、
// 履歴はドラッグ開始時の状態を1回だけ積む。
let opacityGestureActive = false;
layerOpacitySlider.addEventListener('input', () => {
  if (!started) return;
  if (!opacityGestureActive) { pushHistory(); opacityGestureActive = true; }
  const v = parseInt(layerOpacitySlider.value) / 100;
  layers[activeLayerIndex].opacity = v;
  layerOpacityVal.textContent = layerOpacitySlider.value;
  drawCells();
});
layerOpacitySlider.addEventListener('change', () => {
  opacityGestureActive = false;
  markChanged(); // ドラッグし終えた値を自動保存に反映する
});

btnLayerDup.addEventListener('click', () => {
  if (!started) return;
  pushHistory();
  const src = layers[activeLayerIndex];
  const copy = {
    name: `${src.name} のコピー`.slice(0, 20),
    visible: src.visible,
    opacity: src.opacity,
    locked: false,
    cells: src.cells.map(r => [...r]),
  };
  layers.splice(activeLayerIndex + 1, 0, copy);
  activeLayerIndex += 1;
  syncActiveCells();
  drawCells();
  updateLayerPanel();
});

btnLayerMerge.addEventListener('click', () => {
  if (!started || activeLayerIndex <= 0) return;
  pushHistory();
  const top = layers[activeLayerIndex];
  const below = layers[activeLayerIndex - 1];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = top.cells[r][c];
      if (v && top.visible) {
        below.cells[r][c] = blendHex(below.cells[r][c], v, top.opacity);
      }
    }
  }
  invalidateLayerCache(below); // 下のレイヤーに焼き込んだのでキャッシュを捨てる
  layers.splice(activeLayerIndex, 1);
  activeLayerIndex -= 1;
  syncActiveCells();
  drawCells();
  updateLayerPanel();
});

btnLayerLock.addEventListener('click', () => {
  if (!started) return;
  pushHistory();
  const layer = layers[activeLayerIndex];
  layer.locked = !layer.locked;
  updateLayerPanel();
});

// ── レイヤーの反転 ────────────────────────────────────
function flipLayer(direction) {
  if (!started || activeLayerLocked()) return;
  pushHistory();
  const layer = layers[activeLayerIndex];
  layer.cells = direction === 'h'
    ? layer.cells.map(row => [...row].reverse())
    : [...layer.cells].reverse().map(row => [...row]);
  syncActiveCells();
  drawCells();
  updateLayerThumbnails();
}
document.getElementById('btn-layer-flip-h').addEventListener('click', () => flipLayer('h'));
document.getElementById('btn-layer-flip-v').addEventListener('click', () => flipLayer('v'));

// ── 色履歴の位置更新 ──────────────────────────────────
const colorHistoryEl = document.getElementById('color-history');
function updateColorHistoryPos(panelEdge) {
  const rect = canvasArea.getBoundingClientRect();
  const left = panelEdge != null ? panelEdge : rect.left;
  colorHistoryEl.style.left = (left + 10) + 'px';
  colorHistoryEl.style.bottom = (window.innerHeight - rect.bottom + 30) + 'px';
}
window.addEventListener('resize', updateColorHistoryPos);

// ── カラーパレット ────────────────────────────────────
function buildPalette() {
  const grid = document.getElementById('palette');
  grid.innerHTML = '';
  PALETTE_COLORS.forEach(hex => {
    const s = document.createElement('div');
    s.className = 'swatch';
    s.style.background = hex;
    s.title = hex;
    s.addEventListener('click', () => setColor(hex));
    grid.appendChild(s);
  });
}
const COLOR_HISTORY_SIZE = 5;
const colorHistoryList = Array(COLOR_HISTORY_SIZE).fill(null);
const colorDots = Array.from({length: COLOR_HISTORY_SIZE}, (_, i) => document.getElementById('dot-' + i));

function updateColorDots() {
  colorDots.forEach((dot, i) => {
    const c = colorHistoryList[i];
    dot.style.background = c || 'transparent';
    dot.style.visibility = c ? 'visible' : 'hidden';
  });
}

// 履歴にすでにある色をまた使ったときは、増やさずに今の色の位置へ移すだけにする
// （同じ色が何度も並ばないように）
function pushColorHistory(hex) {
  if (colorHistoryList[0] === hex) return;
  const found = colorHistoryList.findIndex(c => c && c.toLowerCase() === hex.toLowerCase());
  const from = found > 0 ? found : COLOR_HISTORY_SIZE - 1;
  for (let i = from; i > 0; i--) {
    colorHistoryList[i] = colorHistoryList[i - 1];
  }
  colorHistoryList[0] = hex;
  updateColorDots();
}

colorDots.forEach((dot, i) => {
  dot.addEventListener('click', () => {
    // 一番大きい丸（今の色）は、押すとカラーピッカーで色を選べる
    if (i === 0) { openColorPicker('current', -1, currentColor); return; }
    if (colorHistoryList[i]) setColor(colorHistoryList[i]);
  });
});

function setColor(hex) {
  currentColor = hex;
  pushColorHistory(hex);
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('selected', s.style.background === hexToRgb(hex) || s.style.background === hex);
  });
  if (currentTool === 'pick' || currentTool === 'erase') {
    setTool('pen');
  }
}
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgb(${r}, ${g}, ${b})`;
}

// ── カスタムカラーパレット ──────────────────────────
const CUSTOM_PALETTE_SIZE = 48;
const customPaletteGrid = document.getElementById('custom-palette');
const customColorPicker = document.getElementById('custom-color-picker');
const btnDeleteMode = document.getElementById('btn-delete-mode');
const btnDeleteAll = document.getElementById('btn-delete-all');
const confirmModal = document.getElementById('confirm-delete-all');
// カスタムカラーはこのブラウザに記憶し、次に開いたときも残るようにする。
// 変更は必ずbuildCustomPaletteで描き直されるので、そこで保存している。
const CUSTOM_COLORS_KEY = 'pixelart-custom-colors';
function loadCustomColors() {
  const colors = Array(CUSTOM_PALETTE_SIZE).fill(null);
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_COLORS_KEY));
    if (Array.isArray(saved)) {
      saved.slice(0, CUSTOM_PALETTE_SIZE).forEach((c, i) => {
        if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) colors[i] = c.toLowerCase();
      });
    }
  } catch (err) { /* 読めなければ空のパレットから始める */ }
  return colors;
}
function saveCustomColors() {
  try { localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(customColors)); } catch (err) { /* 記憶できなくても使うのに支障はない */ }
}
let customColors = loadCustomColors();
let deleteMode = false;
let pendingSlotIndex = -1;
// 色選択モーダル・全削除確認モーダルは「カスタムカラー」と
// 「画像から変換に使う色」で共用するため、対象を覚えておく。
let pendingSlotTarget = 'custom'; // 'custom' | 'convert' | 'current'（今の色を直接変える）
let deleteAllTarget = 'custom';   // 'custom' | 'convert' | 'import'（パレット読み込みの上書き確認）

function buildCustomPalette() {
  customPaletteGrid.innerHTML = '';
  customColors.forEach((color, i) => {
    if (color) {
      const s = document.createElement('div');
      s.className = 'swatch' + (deleteMode ? ' delete-target' : '');
      s.style.background = color;
      s.title = color;
      s.addEventListener('click', () => {
        if (deleteMode) {
          customColors[i] = null;
          buildCustomPalette();
        } else {
          setColor(color);
        }
      });
      customPaletteGrid.appendChild(s);
    } else {
      const s = document.createElement('div');
      s.className = 'swatch-empty';
      s.textContent = '＋';
      if (deleteMode) {
        s.style.opacity = '0.3';
        s.style.pointerEvents = 'none';
      }
      s.addEventListener('click', () => openColorPicker('custom', i, currentColor));
      customPaletteGrid.appendChild(s);
    }
  });
  btnPaletteExport.disabled = !customColors.some(Boolean);
  saveCustomColors();
}

// ── 色選択モーダル（輪っか状のカラーピッカー） ──
// 外側の輪で色相、内側の四角で鮮やかさと明るさを選ぶ（colorwheel.js）。
// カスタムカラーの「＋」、画像変換に使う色の「＋」、パレット下の「🎨 色を選ぶ」、
// 色履歴の一番大きい丸（今の色）から開く。
const colorPickModal = document.getElementById('color-pick-modal');
// パネルを閉じている間（スマホ・タブレットでは画面外へずらしている）でも開けるよう、パネルの外に出しておく
document.body.appendChild(colorPickModal);
const colorOldEl = document.getElementById('color-old');
const colorNewEl = document.getElementById('color-new');
const colorHexInput = document.getElementById('color-hex');
const btnColorEyedropper = document.getElementById('btn-color-eyedropper');

function showPickedColor(hex, fromHexInput) {
  customColorPicker.value = hex;
  colorNewEl.style.background = hex;
  if (!fromHexInput) colorHexInput.value = hex;
}
const colorWheel = new ColorWheel(document.getElementById('color-wheel'), {
  size: 220,
  onChange: hex => showPickedColor(hex, false),
});

function openColorPicker(target, index, initialHex) {
  pendingSlotTarget = target;
  pendingSlotIndex = index;
  colorWheel.setHex(initialHex);
  colorOldEl.style.background = initialHex;
  showPickedColor(colorWheel.getHex(), false);
  colorPickModal.style.display = 'flex';
}

function closeColorPicker() {
  pendingSlotIndex = -1;
  colorPickModal.style.display = 'none';
}

// コードを直接打ち込んだときは、正しい形（#なしでも可）になった時点でピッカーにも反映する
colorHexInput.addEventListener('input', () => {
  let v = colorHexInput.value.trim();
  if (!v.startsWith('#')) v = '#' + v;
  if (/^#[0-9a-f]{6}$/i.test(v)) {
    colorWheel.setHex(v.toLowerCase());
    showPickedColor(v.toLowerCase(), true);
  }
});
colorHexInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-color-ok').click();
  if (e.key === 'Escape') closeColorPicker();
});

// 💉：色を拾ってピッカーに入れる。
// パソコンのChrome・Edgeなどは、ブラウザの機能で画面のどこからでも拾える。
// それ以外（スマホ・iPad・Safari・Firefoxなど）は、このサイトの中から拾う（下の「サイト内のスポイト」）。
btnColorEyedropper.style.display = '';
if (window.EyeDropper) {
  btnColorEyedropper.addEventListener('click', async () => {
    try {
      const { sRGBHex } = await new EyeDropper().open();
      colorWheel.setHex(sRGBHex.toLowerCase());
      showPickedColor(sRGBHex.toLowerCase(), false);
    } catch (err) { /* Escキーなどで取り消した */ }
  });
} else {
  btnColorEyedropper.title = 'キャンバス・参考画像・パレットから色を拾う';
  btnColorEyedropper.addEventListener('click', startPagePick);
}

// ── サイト内のスポイト ──
// 色選択の画面をいったん隠し、タップ（クリック）した所の色をピッカーに入れて戻る。
// 拾えるのはキャンバス・参考画像・パレットの色・色の履歴の丸。
// 指で押したまま動かすと拡大鏡が付いてきて、離した所の色を取る。
const pagePickBar = document.createElement('div');
pagePickBar.className = 'page-pick-bar';
pagePickBar.innerHTML = '<span>色を取りたい所をタップしてください</span><button>やめる</button>';
pagePickBar.style.display = 'none';
document.body.appendChild(pagePickBar);
pagePickBar.querySelector('button').addEventListener('click', () => endPagePick(null));
let pagePicking = false;
let pagePickPressed = false;
let pagePickPointerId = null; // 押している指・Pencil・マウス

function cssColorToHex(css) {
  const m = css.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?/);
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return null; // 透明
  return '#' + [m[1], m[2], m[3]].map(v => (+v).toString(16).padStart(2, '0')).join('');
}

// 画面上の点にある部品。スマホでパネルを開いているときの暗い幕は無視して、その下を見る
function pageElementAt(x, y) {
  return document.elementsFromPoint(x, y).find(e => !e.closest('.panel-backdrop, .page-pick-bar, .pick-loupe'));
}

// 画面上の点の色。'#rrggbb'、透明な所ならnull、拾えない所ならundefined。
function pageColorAt(x, y) {
  const el = pageElementAt(x, y);
  if (!el) return undefined;
  if (el === cOv) {
    const { col, row } = getCell({ clientX: x, clientY: y });
    if (col < 0 || row < 0 || col >= cols || row >= rows) return undefined;
    return compositeAt(row, col);
  }
  if (refSampleCtx && refBody.contains(el)) return refColorAt(x, y) || undefined;
  const sw = el.closest('.swatch, .color-dot');
  if (sw) return cssColorToHex(getComputedStyle(sw).backgroundColor) || undefined;
  return undefined;
}

// キャンバスの上では、スポイトツールと同じくマスのガイドの枠も出す
function showPagePickLoupe(x, y, pointerType) {
  const onCanvas = pageElementAt(x, y) === cOv;
  if (onCanvas) {
    const { col, row } = getCell({ clientX: x, clientY: y });
    showTouchGuide(col, row);
  } else {
    clearPagePickGuide();
  }
  // キャンバスの上ではちょうど1マスずつ、それ以外は4pxずつずらした所を並べる
  const step = onCanvas ? cellPx() * zoom : 4;
  showPickLoupe(x, y, (dx, dy) => pageColorAt(x + dx * step, y + dy * step),
    pointerType === 'mouse' ? LOUPE_GAP : LOUPE_GAP_TOUCH); // 指のときは隠れないよう離して出す
}

function clearPagePickGuide() {
  redrawOverlay();
  statPos.textContent = '—';
}

// 押している途中をやめる（色の無い所で離した・ピンチを始めたなど）。次のタップは待つ
function cancelPagePickPress() {
  pagePickPressed = false;
  pagePickPointerId = null;
  hidePickLoupe();
  clearPagePickGuide();
}

function startPagePick() {
  pagePicking = true;
  cancelPagePickPress();
  colorPickModal.style.display = 'none';
  pagePickBar.style.display = 'flex';
  document.body.classList.add('page-picking');
}

function endPagePick(hex) {
  pagePicking = false;
  cancelPagePickPress();
  pagePickBar.style.display = 'none';
  document.body.classList.remove('page-picking');
  colorPickModal.style.display = 'flex';
  if (hex) {
    colorWheel.setHex(hex);
    showPickedColor(hex, false);
  }
}

// 拾っている間は、ほかの操作（描く・パネルを閉じるなど）に届かないよう、ページ全体で先に受け取って止める。
// ただし2本指の操作（キャンバスの拡大縮小・移動）は、スポイトツールのときと同じく通す。
const isPagePickBarEvent = e => pagePickBar.contains(e.target);
function blockForPagePick(e) {
  if (!pagePicking || isPagePickBarEvent(e)) return;
  if (e.type.startsWith('touch') && (isPinching || e.touches.length >= 2)) {
    if (pagePickPressed) cancelPagePickPress(); // 1本目で押していた分は取らずにやめる
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}
['touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu'].forEach(type => {
  window.addEventListener(type, blockForPagePick, { capture: true, passive: false });
});
window.addEventListener('pointerdown', e => {
  if (!pagePicking || isPagePickBarEvent(e)) return;
  blockForPagePick(e);
  if (pagePickPressed) { cancelPagePickPress(); return; } // 2本目の指が触れたらピンチ
  pagePickPressed = true;
  pagePickPointerId = e.pointerId;
  showPagePickLoupe(e.clientX, e.clientY, e.pointerType);
}, { capture: true });
window.addEventListener('pointermove', e => {
  if (!pagePicking) return;
  blockForPagePick(e);
  const pressing = pagePickPressed && e.pointerId === pagePickPointerId;
  if (pressing || (!pagePickPressed && e.pointerType === 'mouse')) showPagePickLoupe(e.clientX, e.clientY, e.pointerType);
}, { capture: true });
window.addEventListener('pointerup', e => {
  if (!pagePicking || !pagePickPressed || e.pointerId !== pagePickPointerId) return;
  blockForPagePick(e);
  const hex = pageColorAt(e.clientX, e.clientY);
  cancelPagePickPress();
  // この後に続くマウスのclickまで止めてから戻す（先に戻すと、clickが下のパレットなどに届いてしまう）
  if (hex) setTimeout(() => endPagePick(hex), 0);
  // 色の無い所で離したら、そのまま次のタップを待つ
}, { capture: true });
window.addEventListener('pointercancel', e => {
  if (pagePicking && e.pointerId === pagePickPointerId) cancelPagePickPress();
}, { capture: true });
window.addEventListener('keydown', e => {
  if (pagePicking && e.key === 'Escape') { e.stopPropagation(); endPagePick(null); }
}, { capture: true });

document.getElementById('btn-open-color-wheel').addEventListener('click', () => {
  openColorPicker('current', -1, currentColor);
});

document.getElementById('btn-color-ok').addEventListener('click', () => {
  const hex = customColorPicker.value;
  if (pendingSlotTarget === 'current') {
    setColor(hex);
  } else if (pendingSlotIndex >= 0) {
    if (pendingSlotTarget === 'convert') {
      convertPaletteColors[pendingSlotIndex] = hex;
      buildConvertPalette();
    } else {
      customColors[pendingSlotIndex] = hex;
      setColor(hex);
      buildCustomPalette();
    }
  }
  closeColorPicker();
});

document.getElementById('btn-color-cancel').addEventListener('click', closeColorPicker);

btnDeleteMode.addEventListener('click', () => {
  deleteMode = !deleteMode;
  btnDeleteMode.classList.toggle('active', deleteMode);
  buildCustomPalette();
});

btnDeleteAll.addEventListener('click', () => {
  deleteAllTarget = 'custom';
  confirmModal.querySelector('p').textContent = 'カスタムカラーをすべて削除しますか？';
  confirmModal.style.display = 'flex';
});

document.getElementById('btn-confirm-ok').addEventListener('click', () => {
  if (deleteAllTarget === 'convert') {
    convertPaletteColors.fill(null);
    buildConvertPalette();
  } else if (deleteAllTarget === 'import') {
    applyImportedPalette();
  } else {
    customColors.fill(null);
    buildCustomPalette();
  }
  confirmModal.style.display = 'none';
});

document.getElementById('btn-confirm-no').addEventListener('click', () => {
  pendingImport = null;
  confirmModal.style.display = 'none';
});

// ── パレットの書き出し・読み込み ──────────────────────
// カスタムカラーをファイルとして書き出し、他のソフトやLospecのパレットを読み込む。
// 書き出し: .hex（1行に1色、Lospec形式）／.gpl（GIMP形式。Asepriteなどでも使える）
// 読み込み: 上記に加えて .pal（JASC-PAL）・.txt（Paint.NET）・パレット画像（.pngなど）
const btnPaletteExport = document.getElementById('btn-palette-export');
const btnPaletteImport = document.getElementById('btn-palette-import');
const paletteFileInput = document.getElementById('palette-file-input');
const customPaletteHint = document.getElementById('custom-palette-hint');
const paletteExportModal = document.getElementById('palette-export-modal');
let pendingImport = null; // 上書き確認中の読み込み結果 {colors, total, name}

function showPaletteHint(text) {
  customPaletteHint.textContent = text;
  customPaletteHint.style.display = text ? '' : 'none';
}

function downloadText(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportPalette(format) {
  paletteExportModal.style.display = 'none';
  const colors = customColors.filter(Boolean);
  if (!colors.length) return;
  if (format === 'gpl') {
    const lines = colors.map(hex => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      return `${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\t${hex.slice(1)}`;
    });
    downloadText('palette.gpl', ['GIMP Palette', 'Name: SuperDotEditor-KAI', 'Columns: 8', '#', ...lines, ''].join('\n'));
  } else {
    downloadText('palette.hex', colors.map(hex => hex.slice(1)).join('\n') + '\n');
  }
  showPaletteHint(`${colors.length}色を書き出しました`);
}

// テキスト形式のパレットから色を取り出す。形式ごとに分けず、1行ずつ
// 「16進6桁（#は任意）」「16進8桁（Paint.NETのAARRGGBB）」「R G B の3つの数」
// のどれかに当てはまる行を色として読む。見出し行（GIMP Palette・JASC-PAL・
// Name:・色数など）やコメント行（; や # で始まる行）はどれにも当てはまらないので自然に飛ばされる。
function parsePaletteText(text) {
  const colors = [];
  const toHex = v => v.toString(16).padStart(2, '0');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^#?([0-9a-f]{6})$/i))) {
      colors.push('#' + m[1].toLowerCase());
    } else if ((m = line.match(/^([0-9a-f]{2})([0-9a-f]{6})$/i))) {
      colors.push('#' + m[2].toLowerCase());
    } else if ((m = line.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(\s|$)/))) {
      const rgb = [m[1], m[2], m[3]].map(Number);
      if (rgb.every(v => v <= 255)) colors.push('#' + rgb.map(toHex).join(''));
    }
  }
  return colors;
}

// パレット画像（Lospecの .png など）から、左上から順に現れた色を取り出す。
// 拡大版（8倍・32倍）でも同じ色が続くだけなので、重複を除けば元の並びになる。
function parsePaletteImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const colors = [];
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue; // 透明な部分は色として扱わない
        colors.push('#' + [data[i], data[i + 1], data[i + 2]].map(v => v.toString(16).padStart(2, '0')).join(''));
      }
      URL.revokeObjectURL(url);
      resolve(colors);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

async function importPaletteFile(file) {
  if (!file) return;
  let colors;
  try {
    colors = file.type.startsWith('image/')
      ? await parsePaletteImage(file)
      : parsePaletteText(await file.text());
  } catch (err) {
    showPaletteHint('ファイルを読み込めませんでした');
    return;
  }
  const unique = [...new Set(colors)];
  if (!unique.length) {
    showPaletteHint('このファイルからは色が見つかりませんでした');
    return;
  }
  pendingImport = { colors: unique.slice(0, CUSTOM_PALETTE_SIZE), total: unique.length };
  if (customColors.some(Boolean)) {
    // 今のカスタムカラーが消えてしまうので、先に確認する
    deleteAllTarget = 'import';
    confirmModal.querySelector('p').textContent =
      `今のカスタムカラーを、読み込んだ${pendingImport.colors.length}色に置き換えますか？`;
    confirmModal.style.display = 'flex';
  } else {
    applyImportedPalette();
  }
}

function applyImportedPalette() {
  if (!pendingImport) return;
  const { colors, total } = pendingImport;
  pendingImport = null;
  customColors = Array.from({ length: CUSTOM_PALETTE_SIZE }, (_, i) => colors[i] || null);
  deleteMode = false;
  btnDeleteMode.classList.remove('active');
  buildCustomPalette();
  showPaletteHint(total > CUSTOM_PALETTE_SIZE
    ? `${total}色のうち、先頭の${CUSTOM_PALETTE_SIZE}色を読み込みました（枠が${CUSTOM_PALETTE_SIZE}色までのため）`
    : `${colors.length}色を読み込みました`);
}

btnPaletteExport.addEventListener('click', () => {
  if (customColors.some(Boolean)) paletteExportModal.style.display = 'flex';
});
document.getElementById('btn-export-hex').addEventListener('click', () => exportPalette('hex'));
document.getElementById('btn-export-gpl').addEventListener('click', () => exportPalette('gpl'));
document.getElementById('btn-export-cancel').addEventListener('click', () => {
  paletteExportModal.style.display = 'none';
});
btnPaletteImport.addEventListener('click', () => paletteFileInput.click());
paletteFileInput.addEventListener('change', e => {
  importPaletteFile(e.target.files[0]);
  paletteFileInput.value = ''; // 同じファイルをもう一度選んでも読み込めるようにする
});

// ── 画像から変換に使う色（専用パレット） ──────────────
// チェックを入れると、変換結果の各ピクセルをこのパレット内の
// もっとも近い色（RGB空間のユークリッド距離）に置き換える。
const CONVERT_PALETTE_SIZE = 24;
const convertPaletteGrid = document.getElementById('convert-palette');
const convertUsePaletteCheckbox = document.getElementById('convert-use-palette');
const convertCountGroup = document.getElementById('convert-count-group');
const convertPaletteGroup = document.getElementById('convert-palette-group');
const convertPaletteHint = document.getElementById('convert-palette-hint');
const btnCpDeleteMode = document.getElementById('btn-cp-delete-mode');
const btnCpDeleteAll = document.getElementById('btn-cp-delete-all');
let convertPaletteColors = Array(CONVERT_PALETTE_SIZE).fill(null);
let convertDeleteMode = false;

function buildConvertPalette() {
  convertPaletteGrid.innerHTML = '';
  convertPaletteColors.forEach((color, i) => {
    const s = document.createElement('div');
    if (color) {
      s.className = 'swatch' + (convertDeleteMode ? ' delete-target' : '');
      s.style.background = color;
      s.title = color;
      s.addEventListener('click', () => {
        if (convertDeleteMode) {
          convertPaletteColors[i] = null;
          buildConvertPalette();
        } else {
          setColor(color); // 描画色としても使えるようにしておく
        }
      });
    } else {
      s.className = 'swatch-empty';
      s.textContent = '＋';
      if (convertDeleteMode) {
        s.style.opacity = '0.3';
        s.style.pointerEvents = 'none';
      }
      s.addEventListener('click', () => openColorPicker('convert', i, currentColor));
    }
    convertPaletteGrid.appendChild(s);
  });
  const count = convertPaletteColors.filter(Boolean).length;
  convertPaletteHint.textContent = count
    ? `${count}色で変換します`
    : '＋から色を追加してください';
  updateConvertButtonState();
}

// 画像が未選択、またはパレット指定なのに色が空のときは変換できない
function updateConvertButtonState() {
  const paletteReady = !convertUsePaletteCheckbox.checked
    || convertPaletteColors.some(Boolean);
  document.getElementById('btn-convert').disabled = !(uploadedImage && paletteReady);
}

convertUsePaletteCheckbox.addEventListener('change', () => {
  const use = convertUsePaletteCheckbox.checked;
  convertCountGroup.style.display = use ? 'none' : '';
  convertPaletteGroup.style.display = use ? '' : 'none';
  updateConvertButtonState();
});

btnCpDeleteMode.addEventListener('click', () => {
  convertDeleteMode = !convertDeleteMode;
  btnCpDeleteMode.classList.toggle('active', convertDeleteMode);
  buildConvertPalette();
});

btnCpDeleteAll.addEventListener('click', () => {
  deleteAllTarget = 'convert';
  confirmModal.querySelector('p').textContent = '変換に使う色をすべて削除しますか？';
  confirmModal.style.display = 'flex';
});

// 各セルの色を、指定パレット内でもっとも近い色に置き換える
function applyFixedPalette(paletteHexes) {
  const palette = paletteHexes.map(hex => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    hex,
  ]);
  const lookup = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hex = cells[r][c];
      if (!hex) continue;
      if (lookup[hex]) { cells[r][c] = lookup[hex]; continue; }
      const cr = parseInt(hex.slice(1, 3), 16);
      const cg = parseInt(hex.slice(3, 5), 16);
      const cb = parseInt(hex.slice(5, 7), 16);
      let bestDist = Infinity, bestHex = hex;
      for (const p of palette) {
        const dr = cr - p[0], dg = cg - p[1], db = cb - p[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) { bestDist = d; bestHex = p[3]; }
      }
      lookup[hex] = bestHex;
      cells[r][c] = bestHex;
    }
  }
}

// ── 選択機能 ──────────────────────────────────────────
const btnSelRange = document.getElementById('btn-sel-range');
const btnSelColor = document.getElementById('btn-sel-color');
const btnSelFlood = document.getElementById('btn-sel-flood');
const btnSelClear = document.getElementById('btn-sel-clear');
const rangeModeRow = document.getElementById('range-mode-row');
const btnRangeRect = document.getElementById('btn-range-rect');
const btnRangeFree = document.getElementById('btn-range-free');
const rangeAutoCloseLabel = document.getElementById('range-autoclose-label');
const rangeAutoCloseCheckbox = document.getElementById('range-autoclose');

function updateSelectionButtons() {
  // 選択範囲が作り直されたら、移動中の中身はその位置で確定する
  if (floating && selectionMask !== floating.mask) floating = null;
  updateClipboardButtons();
  btnSelRange.classList.toggle('active', selectionMode === 'range');
  btnSelColor.classList.toggle('active', selectionMode === 'color');
  btnSelFlood.classList.toggle('active', selectionMode === 'flood');
  btnSelClear.style.display = selectionMask ? '' : 'none';
  rangeModeRow.style.display = selectionMode === 'range' ? '' : 'none';
  rangeAutoCloseLabel.style.display = (selectionMode === 'range' && rangeSelectMode === 'free') ? 'flex' : 'none';
  btnRangeRect.classList.toggle('active', rangeSelectMode === 'rect');
  btnRangeFree.classList.toggle('active', rangeSelectMode === 'free');
  const ctx = cOv.getContext('2d');
  ctx.clearRect(0, 0, cOv.width, cOv.height);
  drawSelectionOverlay(ctx);
  updateHeaderStatus();
}

btnRangeRect.addEventListener('click', () => {
  rangeSelectMode = 'rect';
  updateSelectionButtons();
});
btnRangeFree.addEventListener('click', () => {
  rangeSelectMode = 'free';
  updateSelectionButtons();
});

function applyRangeSelection(c1, r1, c2, r2) {
  const minC = Math.max(0, Math.min(c1, c2));
  const maxC = Math.min(cols - 1, Math.max(c1, c2));
  const minR = Math.max(0, Math.min(r1, r2));
  const maxR = Math.min(rows - 1, Math.max(r1, r2));
  selectionMask = Array.from({length: rows}, (_, r) =>
    Array.from({length: cols}, (_, c) => r >= minR && r <= maxR && c >= minC && c <= maxC)
  );
  updateSelectionButtons();
}

function applyColorSelection(col, row) {
  if (col < 0 || col >= cols || row < 0 || row >= rows) return;
  const targetColor = cells[row][col];
  selectionMask = Array.from({length: rows}, (_, r) =>
    Array.from({length: cols}, (_, c) => cells[r][c] === targetColor)
  );
  updateSelectionButtons();
}

function applyFloodSelection(col, row) {
  if (col < 0 || col >= cols || row < 0 || row >= rows) return;
  const targetColor = cells[row][col];
  selectionMask = Array.from({length: rows}, () => Array(cols).fill(false));
  const stack = [[col, row]];
  while (stack.length) {
    const [c, r] = stack.pop();
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    if (selectionMask[r][c]) continue;
    if (cells[r][c] !== targetColor) continue;
    selectionMask[r][c] = true;
    stack.push([c+1,r],[c-1,r],[c,r+1],[c,r-1]);
  }
  updateSelectionButtons();
}

function applyFreeRangeSelection(path, endCol, endRow) {
  if (!path.length) return;
  const start = path[0];
  const releasedAtStart = endCol === start.col && endRow === start.row;
  const traced = Array.from({length: rows}, () => Array(cols).fill(false));
  const markCell = (c, r) => { if (c >= 0 && c < cols && r >= 0 && r < rows) traced[r][c] = true; };
  for (const p of path) markCell(p.col, p.row);
  if (!releasedAtStart && !rangeAutoCloseCheckbox.checked) {
    // 始点に戻らず終了したので、なぞった軌跡のみを選択する
    selectionMask = traced;
    updateSelectionButtons();
    return;
  }
  if (!releasedAtStart) {
    for (const p of interpolateCells(endCol, endRow, start.col, start.row)) markCell(p.col, p.row);
  }
  // 外周からたどれるセルを「外部」とし、なぞった線とそれ以外(内部)を選択対象にする
  const outside = Array.from({length: rows}, () => Array(cols).fill(false));
  const stack = [];
  for (let c = 0; c < cols; c++) { stack.push([c, 0]); stack.push([c, rows - 1]); }
  for (let r = 0; r < rows; r++) { stack.push([0, r]); stack.push([cols - 1, r]); }
  while (stack.length) {
    const [c, r] = stack.pop();
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    if (outside[r][c] || traced[r][c]) continue;
    outside[r][c] = true;
    stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
  }
  selectionMask = Array.from({length: rows}, (_, r) =>
    Array.from({length: cols}, (_, c) => traced[r][c] || !outside[r][c])
  );
  updateSelectionButtons();
}

function drawFreeRangePreview(path, curCol, curRow) {
  const px = cellPx();
  const ctx = cOv.getContext('2d');
  ctx.clearRect(0, 0, cOv.width, cOv.height);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, cOv.width, cOv.height);
  const cx = c => c * px + px / 2, cy = r => r * px + px / 2;
  ctx.strokeStyle = 'rgba(59,130,246,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  path.forEach((p, i) => {
    if (i === 0) ctx.moveTo(cx(p.col), cy(p.row));
    else ctx.lineTo(cx(p.col), cy(p.row));
  });
  ctx.stroke();
  const start = path[0];
  if (rangeAutoCloseCheckbox.checked) {
    ctx.strokeStyle = 'rgba(59,130,246,0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx(curCol), cy(curRow));
    ctx.lineTo(cx(start.col), cy(start.row));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = 'rgba(59,130,246,0.9)';
  ctx.beginPath();
  ctx.arc(cx(start.col), cy(start.row), Math.max(3, px * 0.25), 0, Math.PI * 2);
  ctx.fill();
}

function drawRangePreview(c1, r1, c2, r2) {
  const px = cellPx();
  const ctx = cOv.getContext('2d');
  ctx.clearRect(0, 0, cOv.width, cOv.height);
  const minC = Math.max(0, Math.min(c1, c2));
  const maxC = Math.min(cols - 1, Math.max(c1, c2));
  const minR = Math.max(0, Math.min(r1, r2));
  const maxR = Math.min(rows - 1, Math.max(r1, r2));
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, cOv.width, cOv.height);
  ctx.clearRect(minC * px, minR * px, (maxC - minC + 1) * px, (maxR - minR + 1) * px);
  ctx.strokeStyle = 'rgba(59,130,246,0.8)';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(minC * px, minR * px, (maxC - minC + 1) * px, (maxR - minR + 1) * px);
  ctx.setLineDash([]);
}

function clearSelection() {
  selectionMask = null;
  selectionMode = 'none';
  rangeStart = null;
  rangePath = [];
  updateSelectionButtons();
}

btnSelRange.addEventListener('click', () => {
  if (selectionMode === 'range') { clearSelection(); return; }
  selectionMode = 'range';
  selectionMask = null;
  updateSelectionButtons();
});

btnSelColor.addEventListener('click', () => {
  if (selectionMode === 'color') { clearSelection(); return; }
  selectionMode = 'color';
  selectionMask = null;
  updateSelectionButtons();
});

btnSelFlood.addEventListener('click', () => {
  if (selectionMode === 'flood') { clearSelection(); return; }
  selectionMode = 'flood';
  selectionMask = null;
  updateSelectionButtons();
});

btnSelClear.addEventListener('click', clearSelection);

// ── 選択範囲の移動 ────────────────────────────────────
// 移動ツールでドラッグすると、選択範囲（選択が無ければレイヤー全体）の
// 中身を持ち上げて動かす。「全レイヤー」を選んでいれば、ロックされていない
// すべてのレイヤーの同じ範囲をまとめて動かす。動かしている間は floating に
//   entries: 動かすレイヤーごとの {layer, base, pixels}
//            base:   持ち上げた後に残る下地（レイヤーのコピー）
//            pixels: 持ち上げた中身（w×h、nullは透明）
//   pmask:  選択範囲の形（w×h。レイヤー全体を動かす場合はnull）
// を保持し、各レイヤーには常に「下地＋現在位置の中身」を書き込んでおく。
// そのため保存・サムネイル・Undoはレイヤーをそのまま扱えばよく、
// 何度動かしても中身の下にあった絵は失われない。
// 他の操作（描画・選択し直し・レイヤー切替・Undoなど）をした時点で
// floating を捨てると、その位置で確定したことになる。
function selectionBounds(mask) {
  if (!mask) return { x: 0, y: 0, w: cols, h: rows };
  let minR = rows, maxR = -1, minC = cols, maxC = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r][c]) continue;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
  }
  if (maxR < 0) return null;
  return { x: minC, y: minR, w: maxC - minC + 1, h: maxR - minR + 1 };
}

// 選択範囲の中身を切り出す（maskがnullなら範囲内すべて）
function extractPixels(src, mask, b) {
  const pixels = [], pmask = [];
  for (let r = 0; r < b.h; r++) {
    const prow = [], mrow = [];
    for (let c = 0; c < b.w; c++) {
      const inSel = !mask || mask[b.y + r][b.x + c];
      prow.push(inSel ? src[b.y + r][b.x + c] : null);
      mrow.push(inSel);
    }
    pixels.push(prow);
    pmask.push(mrow);
  }
  return { pixels, pmask };
}

let moveAllLayers = false; // 移動ツールの対象が全レイヤーか

function liftSelection() {
  const b = selectionBounds(selectionMask);
  if (!b) return false;
  const targets = moveAllLayers
    ? layers.filter(l => !l.locked) // ロック中のレイヤーは動かさない
    : [layers[activeLayerIndex]];
  if (!targets.length) return false;
  let pmask = null;
  const entries = targets.map(layer => {
    const extracted = extractPixels(layer.cells, selectionMask, b);
    pmask = extracted.pmask; // 形はどのレイヤーでも同じ
    const base = layer.cells.map(r => [...r]);
    for (let r = 0; r < b.h; r++) {
      for (let c = 0; c < b.w; c++) {
        if (pmask[r][c]) base[b.y + r][b.x + c] = null;
      }
    }
    return { layer, base, pixels: extracted.pixels };
  });
  floating = {
    entries,
    all: moveAllLayers,
    activeLayer: layers[activeLayerIndex],
    pmask: selectionMask ? pmask : null,
    x: b.x, y: b.y, w: b.w, h: b.h,
    mask: selectionMask,
  };
  return true;
}

// 現在位置に置いていた中身を取り除き、下地に戻す
function restoreFloatBase() {
  const { entries, x, y, w, h } = floating;
  for (const { layer, base } of entries) {
    for (let r = Math.max(0, y); r < Math.min(rows, y + h); r++) {
      for (let c = Math.max(0, x); c < Math.min(cols, x + w); c++) {
        layer.cells[r][c] = base[r][c];
      }
    }
  }
}

// 現在位置に中身を書き込み、選択範囲も同じ位置へ動かす。
// キャンバス外にはみ出した部分はpixelsに残っているので、戻せば元どおり。
function stampFloat() {
  const { entries, pmask, x, y, w, h } = floating;
  for (const { layer, pixels } of entries) {
    for (let r = 0; r < h; r++) {
      const tr = y + r;
      if (tr < 0 || tr >= rows) continue;
      for (let c = 0; c < w; c++) {
        const tc = x + c;
        if (tc < 0 || tc >= cols) continue;
        const v = pixels[r][c];
        if (v) layer.cells[tr][tc] = v; // 透明部分は下の絵を隠さない
      }
    }
    // 表示用のキャッシュは描画中のレイヤーしか作り直されないので、他のレイヤーは捨てておく
    if (layer !== layers[activeLayerIndex]) invalidateLayerCache(layer);
  }
  if (pmask) {
    const m = Array.from({length: rows}, () => Array(cols).fill(false));
    for (let r = 0; r < h; r++) {
      const tr = y + r;
      if (tr < 0 || tr >= rows) continue;
      for (let c = 0; c < w; c++) {
        const tc = x + c;
        if (tc >= 0 && tc < cols && pmask[r][c]) m[tr][tc] = true;
      }
    }
    selectionMask = m;
  }
  floating.mask = selectionMask;
}

function moveFloatTo(x, y) {
  if (x === floating.x && y === floating.y) return;
  restoreFloatBase();
  floating.x = x;
  floating.y = y;
  stampFloat();
  drawCells();
  redrawOverlay();
}

// 動かしている中身のうち、描画中のレイヤーの分（コピーに使う）
function activeFloatPixels() {
  const entry = floating && floating.entries.find(en => en.layer === layers[activeLayerIndex]);
  return entry ? entry.pixels : null;
}

// 移動を1回ぶん始める（ドラッグ開始・矢印キー）。動かせない場合はfalse。
function beginMove() {
  if (!moveAllLayers && activeLayerLocked()) return false;
  // 対象（このレイヤー／全レイヤー）を切り替えた後は、今の位置で確定して持ち上げ直す
  if (floating && floating.all !== moveAllLayers) floating = null;
  if (!floating && !liftSelection()) return false;
  pushSnapshot(layersSnapshot(), true); // 1回の移動ごとにUndoできるようにする
  return true;
}

function startMoveDrag(col, row) {
  if (!beginMove()) return;
  moveDrag = { col, row, x: floating.x, y: floating.y };
}
function updateMoveDrag(col, row) {
  if (!moveDrag || !floating) return;
  moveFloatTo(moveDrag.x + col - moveDrag.col, moveDrag.y + row - moveDrag.row);
}
function endMoveDrag() {
  if (!moveDrag) return;
  moveDrag = null;
  updateLayerThumbnails();
}

function nudgeSelection(dx, dy) {
  if (!beginMove()) return;
  moveFloatTo(floating.x + dx, floating.y + dy);
  updateLayerThumbnails();
}

function redrawOverlay() {
  const ctx = cOv.getContext('2d');
  ctx.clearRect(0, 0, cOv.width, cOv.height);
  drawSelectionOverlay(ctx);
}

// ── コピー・切り取り・貼り付け ────────────────────────
// アクティブレイヤーの選択範囲が対象。貼り付けた内容は移動中の状態になるので、
// そのまま移動ツールでドラッグして好きな位置に置ける。
const btnCut = document.getElementById('btn-cut');
const btnCopy = document.getElementById('btn-copy');
const btnPaste = document.getElementById('btn-paste');

function updateClipboardButtons() {
  btnCut.disabled = btnCopy.disabled = !selectionMask;
  btnPaste.disabled = !clipboard;
}

function copySelection() {
  if (!started || !selectionMask) return false;
  const floatPixels = floating && floating.pmask && activeFloatPixels();
  if (floatPixels) {
    // 動かしている最中なら、下地と混ざる前の中身そのものをコピーする
    const { pmask, x, y, w, h } = floating;
    clipboard = { pixels: floatPixels, pmask, x, y, w, h };
  } else {
    const b = selectionBounds(selectionMask);
    if (!b) return false;
    clipboard = { ...extractPixels(cells, selectionMask, b), ...b };
  }
  updateClipboardButtons();
  return true;
}

function deleteSelection() {
  if (!started || !selectionMask || activeLayerLocked()) return false;
  // 全レイヤーをまとめて動かした後の削除は、描画中のレイヤーだけを対象にする
  if (floating && floating.entries.length > 1) floating = null;
  if (floating) {
    // 動かしている中身だけを取り除けば、その下の絵が見えるようになる
    pushSnapshot(layersSnapshot(), true);
    restoreFloatBase();
    floating = null;
  } else {
    pushHistory();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (selectionMask[r][c]) cells[r][c] = null;
      }
    }
  }
  drawCells();
  updateLayerThumbnails();
  return true;
}

function cutSelection() {
  if (activeLayerLocked()) return false;
  return copySelection() && deleteSelection();
}

function pasteClipboard() {
  if (!started || !clipboard || activeLayerLocked()) return false;
  pushHistory(); // 移動中のものがあればここで確定される
  const { pixels, pmask, w, h } = clipboard;
  // キャンバスサイズが変わっていても見える位置に収める
  const x = Math.max(0, Math.min(clipboard.x, cols - w));
  const y = Math.max(0, Math.min(clipboard.y, rows - h));
  const layer = layers[activeLayerIndex];
  floating = {
    entries: [{ layer, base: layer.cells.map(r => [...r]), pixels }],
    all: false, activeLayer: layer,
    pmask, x, y, w, h, mask: null,
  };
  setMoveTarget(false); // 貼り付けたものは描画中のレイヤーだけで動かす
  stampFloat();
  selectionMode = 'none';
  setTool('move');
  drawCells();
  updateLayerThumbnails();
  updateSelectionButtons();
  return true;
}

function selectAll() {
  if (!started) return;
  selectionMode = 'none';
  selectionMask = Array.from({length: rows}, () => Array(cols).fill(true));
  updateSelectionButtons();
}

btnCut.addEventListener('click', cutSelection);
btnCopy.addEventListener('click', copySelection);
btnPaste.addEventListener('click', pasteClipboard);

const ARROW_KEYS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

document.addEventListener('keydown', e => {
  if (!started || e.isComposing || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  let handled = false;
  if (e.ctrlKey || e.metaKey) {
    if (e.shiftKey) return;
    if (e.code === 'KeyC') handled = copySelection();
    else if (e.code === 'KeyX') handled = cutSelection();
    else if (e.code === 'KeyV') handled = pasteClipboard();
    else if (e.code === 'KeyA') { selectAll(); handled = true; }
  } else if (e.code === 'Delete' || e.code === 'Backspace') {
    handled = deleteSelection();
  } else if (currentTool === 'move' && ARROW_KEYS[e.code] && !isPainting && !moveDrag) {
    const [dx, dy] = ARROW_KEYS[e.code];
    const step = e.shiftKey ? 10 : 1;
    nudgeSelection(dx * step, dy * step);
    handled = true;
  }
  if (handled) e.preventDefault();
});

// ── 描画スタイル ──────────────────────────────────────
const drawStyleSection = document.getElementById('draw-style-section');
const detectLineLabel = document.getElementById('detect-line-label');
const detectLineCheck = document.getElementById('detect-line');

function updateDetectLineVisibility() {
  detectLineLabel.style.display = (drawStyle === 'col' || drawStyle === 'row') ? 'flex' : 'none';
}

document.querySelectorAll('.style-btn').forEach(b => {
  b.addEventListener('click', () => {
    drawStyle = b.dataset.style;
    document.querySelectorAll('.style-btn').forEach(x => x.classList.toggle('active', x.dataset.style === drawStyle));
    updateHeaderStatus();
    updateDetectLineVisibility();
  });
});

detectLineCheck.addEventListener('change', () => {
  detectLine = detectLineCheck.checked;
});

function updateDrawStyleVisibility() {
  drawStyleSection.style.display = currentTool === 'pen' || currentTool === 'erase' ? '' : 'none';
  document.getElementById('move-target-section').style.display = currentTool === 'move' ? '' : 'none';
}

// ── 移動の対象（このレイヤー／全レイヤー） ──
function setMoveTarget(all) {
  moveAllLayers = all;
  document.querySelectorAll('.move-target-btn').forEach(b => {
    b.classList.toggle('active', (b.dataset.all === '1') === all);
  });
  updateHeaderStatus();
}
document.querySelectorAll('.move-target-btn').forEach(b => {
  b.addEventListener('click', () => setMoveTarget(b.dataset.all === '1'));
});

// ── 描画サイズ ────────────────────────────────────────
const brushSlider = document.getElementById('brush-slider');
const brushVal = document.getElementById('brush-val');
brushSlider.addEventListener('input', () => {
  brushSize = parseInt(brushSlider.value);
  brushVal.textContent = brushSize;
  updateHeaderStatus();
});

// ── ツール選択 ────────────────────────────────────────
function setTool(t) {
  currentTool = t;
  document.querySelectorAll('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === t);
  });
  updateDrawStyleVisibility();
  updateShapeMenuUI();
  updateCanvasCursor();
  updateHeaderStatus();
  if (t !== 'pick') hidePickLoupe();
}

// ── ヘッダーの状態表示（描画中のレイヤーと今のツール） ──
// ツール・選択モード・図形・ブラシサイズ・レイヤーが変わるたびに呼ぶ。
const statusChip = document.getElementById('status-chip');
const statusLayer = document.getElementById('status-layer');
const statusTool = document.getElementById('status-tool');
const TOOL_LABELS = {
  pen: '✏️ ペン', fill: '🪣 塗り潰し', erase: '🧹 消しゴム', pick: '💉 スポイト', move: '✥ 移動',
};
const DRAW_STYLE_LABELS = { col: '縦', row: '横' };

// 今キャンバスをクリックしたときに起きることを文字にする
function currentToolLabel() {
  // 選択ボタンを押した直後は、ツールより選択が優先される
  if (selectionMode === 'range') return `📐 範囲選択（${rangeSelectMode === 'free' ? '自分で指定' : '四角で囲う'}）`;
  if (selectionMode === 'color') return '🎨 色で選択';
  if (selectionMode === 'flood') return '💧 隣接色で選択';
  if (currentTool === 'shape') {
    const opt = document.querySelector(`.shape-opt[data-shape="${shapeType}"][data-fill="${shapeFill ? 1 : 0}"]`);
    return opt ? opt.textContent.trim() : '図形';
  }
  let label = TOOL_LABELS[currentTool] || currentTool;
  const details = [];
  if (currentTool === 'move' && moveAllLayers) details.push('全レイヤー');
  if ((currentTool === 'pen' || currentTool === 'erase') && DRAW_STYLE_LABELS[drawStyle]) details.push(DRAW_STYLE_LABELS[drawStyle]);
  if ((currentTool === 'pen' || currentTool === 'erase') && brushSize > 1) details.push(`サイズ${brushSize}`);
  if (details.length) label += `（${details.join('・')}）`;
  return label;
}

function updateHeaderStatus() {
  statusChip.style.display = started ? '' : 'none';
  const layer = layers[activeLayerIndex];
  if (!layer) return;
  const marks = (layer.locked ? '🔒' : '') + (layer.visible ? '' : '（非表示）');
  statusLayer.textContent = `🗂 ${layer.name}${marks}`;
  statusLayer.title = `描画中のレイヤー: ${layer.name}${layer.locked ? '（ロック中）' : ''}${layer.visible ? '' : '（非表示）'}`;
  const tool = currentToolLabel();
  statusTool.textContent = tool;
  statusTool.title = `今のツール: ${tool}`;
}

// ヘッダーのサイト名は、場所が足りなくなると
// 正式名「スーパードットエディター・改」→ 略称「超.田・改」→ アイコン の順に切り替える。
// 空き具合は隣の状態表示（レイヤー名の長さなど）でも変わるため、画面幅で決め打ちせず、
// ヘッダーの中身を縮めずに並べたときに収まるかを実際に測って決める。
// （状態表示は今のレイヤーやツールが分かる大事な表示なので、サイト名の方を先に譲る）
const headerEl = document.querySelector('header');
const siteTitle = headerEl.querySelector('h1');
function headerOverflows() {
  headerEl.classList.add('measuring'); // 一時的に何も縮めない状態にして測る
  const over = headerEl.scrollWidth > headerEl.clientWidth;
  headerEl.classList.remove('measuring');
  return over;
}
function fitSiteTitle() {
  siteTitle.classList.remove('name-short', 'name-icon');
  if (!headerOverflows()) return;
  siteTitle.classList.add('name-short');
  if (!headerOverflows()) return;
  siteTitle.classList.replace('name-short', 'name-icon');
}
// ヘッダーの幅（画面幅）と状態表示の幅のどちらが変わっても測り直す
const siteTitleObserver = new ResizeObserver(fitSiteTitle);
siteTitleObserver.observe(headerEl);
siteTitleObserver.observe(statusChip);

function updateCanvasCursor() {
  cOv.style.cursor = currentTool === 'move' ? 'move' : '';
  // スポイト中は参考画像の上でも色を取れることが分かるようにする
  document.getElementById('ref-body').classList.toggle('picking', currentTool === 'pick');
}
document.querySelectorAll('.tool-btn').forEach(b => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});

// ── ショートカットキー ────────────────────────────────
// キーの位置で判定する（e.code）ため、日本語入力がオンでも効く。
const TOOL_SHORTCUTS = {
  KeyQ: 'pen',
  KeyW: 'fill',
  KeyA: 'erase',
  KeyS: 'pick',
  KeyV: 'move',
};

// レイヤー名やファイル名の入力中はショートカットを無効にする
function isTypingTarget(el) {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+Z などと衝突させない
  if (e.isComposing) return;                      // 日本語入力の変換中は無視
  if (isTypingTarget(e.target)) return;
  const tool = TOOL_SHORTCUTS[e.code];
  if (!tool) return;
  e.preventDefault();
  setTool(tool);
});

// ── 絵の確認モード ────────────────────────────────────
// Dキー（または右下の👁ボタン）を押している間だけ、描いた絵以外
// （市松模様の背景・グリッド・定規・選択表示・トレース・パネルやボタン類）を隠す。
// 背景はヘッダーで選んだ色のままなので、白・灰・黒それぞれの上での見え方を確かめられる。
const btnArtPreview = document.getElementById('btn-art-preview');

function setArtPreview(on) {
  if (on && !started) return;
  document.body.classList.toggle('art-preview', on);
  btnArtPreview.classList.toggle('active', on);
  // ヘッダーやステータスバーを隠した跡も、キャンバスの背景色で埋める
  document.body.style.background = on ? getComputedStyle(canvasArea).backgroundColor : '';
}

document.addEventListener('keydown', e => {
  if (e.code !== 'KeyD' || e.repeat) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  if (isTypingTarget(e.target)) return;
  e.preventDefault();
  setArtPreview(true);
});
document.addEventListener('keyup', e => {
  if (e.code === 'KeyD') setArtPreview(false);
});
// キーを押したまま別のウィンドウに移ると離した通知が来ないため、その時点で戻す
window.addEventListener('blur', () => setArtPreview(false));

btnArtPreview.addEventListener('pointerdown', e => {
  e.preventDefault();
  try { btnArtPreview.setPointerCapture(e.pointerId); } catch (err) { /* 捕捉できなくても押している間は効く */ }
  setArtPreview(true);
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => {
  btnArtPreview.addEventListener(type, () => setArtPreview(false));
});
btnArtPreview.addEventListener('contextmenu', e => e.preventDefault()); // スマホの長押しメニューを出さない

// ── テンプレート図形メニュー ──────────────────────────
const shapeMenu = document.getElementById('shape-menu');
const shapeMenuBtn = document.getElementById('btn-shape-menu');
const shapeMenuDropdown = document.getElementById('shape-menu-dropdown');

function updateShapeMenuUI() {
  shapeMenuBtn.classList.toggle('active', currentTool === 'shape');
  document.querySelectorAll('.shape-opt[data-shape]').forEach(b => {
    const matches = currentTool === 'shape' && b.dataset.shape === shapeType && (b.dataset.fill === '1') === shapeFill;
    b.classList.toggle('active', matches);
  });
}

function closeShapeMenu() {
  shapeMenuDropdown.style.display = 'none';
}

shapeMenuBtn.addEventListener('click', e => {
  e.stopPropagation();
  shapeMenuDropdown.style.display = shapeMenuDropdown.style.display === 'none' ? 'flex' : 'none';
});

document.querySelectorAll('.shape-opt[data-shape]').forEach(b => {
  b.addEventListener('click', () => {
    shapeType = b.dataset.shape;
    shapeFill = b.dataset.fill === '1';
    currentTool = 'shape';
    document.querySelectorAll('.tool-btn').forEach(x => x.classList.remove('active'));
    updateDrawStyleVisibility();
    updateCanvasCursor();
    updateHeaderStatus();
    updateShapeMenuUI();
    closeShapeMenu();
  });
});

document.addEventListener('click', e => {
  if (!shapeMenu.contains(e.target)) closeShapeMenu();
});

// ── グリッドサイズ ────────────────────────────────────
const bothSlider = document.getElementById('both-slider');
const colsSlider = document.getElementById('cols-slider');
const rowsSlider = document.getElementById('rows-slider');
const bothVal = document.getElementById('both-val');
const colsVal = document.getElementById('cols-val');
const rowsVal = document.getElementById('rows-val');

const MAX_GRID = 1024;
function clampSize(v) { return Math.max(4, Math.min(MAX_GRID, Math.round(v) || 4)); }

function setSizeAll(v) {
  bothSlider.value = v; bothVal.value = v;
  colsSlider.value = v; colsVal.value = v;
  rowsSlider.value = v; rowsVal.value = v;
}

function syncBothDisplay() {
  const c = parseInt(colsSlider.value), r = parseInt(rowsSlider.value);
  if (c === r) {
    bothSlider.value = c;
    bothVal.value = c;
  } else {
    bothSlider.value = Math.max(c, r);
    bothVal.value = '';
    bothVal.placeholder = '-';
  }
}

function updatePresetHighlight() {
  const c = parseInt(colsSlider.value), r = parseInt(rowsSlider.value);
  document.querySelectorAll('.preset-btn').forEach(b => {
    const s = parseInt(b.dataset.size);
    b.classList.toggle('active', s === c && s === r);
  });
}

document.querySelectorAll('.preset-btn').forEach(b => {
  b.addEventListener('click', () => {
    const v = parseInt(b.dataset.size);
    setSizeAll(v);
    pushFramesHistory(); // 大きさは全部のコマに関わる
    initCells(v, v, true);
    resizeCanvases();
    updatePresetHighlight();
  });
});

bothSlider.addEventListener('input', () => {
  const v = bothSlider.value;
  bothVal.value = v;
  colsSlider.value = v; colsVal.value = v;
  rowsSlider.value = v; rowsVal.value = v;
});
bothVal.addEventListener('change', () => {
  const v = clampSize(bothVal.value);
  bothVal.value = v; bothSlider.value = v;
  colsSlider.value = v; colsVal.value = v;
  rowsSlider.value = v; rowsVal.value = v;
});

colsSlider.addEventListener('input', () => { colsVal.value = colsSlider.value; syncBothDisplay(); });
colsVal.addEventListener('change', () => {
  const v = clampSize(colsVal.value);
  colsVal.value = v; colsSlider.value = v; syncBothDisplay();
});

rowsSlider.addEventListener('input', () => { rowsVal.value = rowsSlider.value; syncBothDisplay(); });
rowsVal.addEventListener('change', () => {
  const v = clampSize(rowsVal.value);
  rowsVal.value = v; rowsSlider.value = v; syncBothDisplay();
});

document.getElementById('btn-resize').addEventListener('click', () => {
  pushFramesHistory(); // 大きさは全部のコマに関わる
  initCells(parseInt(colsSlider.value), parseInt(rowsSlider.value), true);
  resizeCanvases();
  updatePresetHighlight();
});

// ── グリッド表示切替 ──────────────────────────────────
document.getElementById('show-grid').addEventListener('change', e => {
  showGrid = e.target.checked;
  drawGrid();
});

// 中心線の表示・非表示は、このブラウザに記憶して次に開いたときも同じにする
const SHOW_CENTER_LINES_KEY = 'pixelart-show-center-lines';
const showCenterLinesCheckbox = document.getElementById('show-center-lines');
try {
  if (localStorage.getItem(SHOW_CENTER_LINES_KEY) === '0') showCenterLinesCheckbox.checked = false;
} catch (err) { /* 読めなければ表示する */ }
updateCenterLines();
showCenterLinesCheckbox.addEventListener('change', () => {
  try { localStorage.setItem(SHOW_CENTER_LINES_KEY, showCenterLinesCheckbox.checked ? '1' : '0'); } catch (err) { /* 覚えられなくても切り替えはできる */ }
  updateCenterLines();
});

// ── 定規と列・行の強調 ────────────────────────────────
// キャンバスエリアの上（列）と左（行）に、左上を(1,1)とするマス番号の定規を出す。
// 定規はスクロールや拡大縮小に合わせて描き直し、数字の間隔は倍率に応じて間引く。
// 列・行は別々に、1本または範囲で強調でき、パネルの入力欄か定規のクリック・ドラッグで選ぶ。
const canvasStage = document.getElementById('canvas-stage');
const rulerTop = document.getElementById('ruler-top');
const rulerLeft = document.getElementById('ruler-left');
const rulerCorner = document.getElementById('ruler-corner');
const colHighlight = document.getElementById('col-highlight');
const rowHighlight = document.getElementById('row-highlight');
const colRangeInput = document.getElementById('col-range-input');
const rowRangeInput = document.getElementById('row-range-input');
const SHOW_RULERS_KEY = 'pixelart-show-rulers';
// 数字の間隔の候補（マス数）。数字どうしが重ならない一番細かいものを使う
const RULER_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500];
const RULER_W = 28; // 左の定規の幅（4桁の数字が入る）
const RULER_H = 18; // 上の定規の高さ

// 強調中の範囲（1始まり、両端を含む）。nullなら強調なし
const lineHighlight = { col: null, row: null };
let rulerHover = null; // カーソルのあるマス {col, row}（0始まり）
let rulerDrawPending = false;

// 「60」「60-80」「８０〜６０」などを {start, end} にする。空ならnull、読めなければfalse。
function parseLineRange(text) {
  const t = text.normalize('NFKC').replace(/\s/g, ''); // 全角数字・記号を半角にそろえる
  if (!t) return null;
  const m = t.match(/^(\d+)(?:[-~〜ー:]+(\d+))?$/);
  if (!m) return false;
  let a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
  if (a > b) [a, b] = [b, a];
  if (a < 1) return false;
  return { start: a, end: b };
}

function formatLineRange(r) {
  return r ? (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`) : '';
}

// 強調をキャンバス上の帯として表示する。キャンバスに対する割合で置くので、
// 拡大縮小してもそのまま追従する。範囲がキャンバスをはみ出す分は切り詰める。
function updateLineHighlights() {
  const place = (el, range, total, vertical) => {
    const visible = range && range.start <= total;
    el.style.display = visible ? '' : 'none';
    if (!visible) return;
    const start = (range.start - 1) / total * 100;
    const size = (Math.min(range.end, total) - range.start + 1) / total * 100;
    if (vertical) {
      Object.assign(el.style, { left: start + '%', width: size + '%', top: '0', height: '100%' });
    } else {
      Object.assign(el.style, { top: start + '%', height: size + '%', left: '0', width: '100%' });
    }
  };
  place(colHighlight, lineHighlight.col, cols, true);
  place(rowHighlight, lineHighlight.row, rows, false);
  rulerCorner.classList.toggle('has-highlight', !!(lineHighlight.col || lineHighlight.row));
  scheduleRulerDraw();
}

function setLineHighlight(axis, range) {
  lineHighlight[axis] = range;
  const input = axis === 'col' ? colRangeInput : rowRangeInput;
  if (document.activeElement !== input) input.value = formatLineRange(range);
  input.classList.remove('invalid');
  updateLineHighlights();
}

[['col', colRangeInput], ['row', rowRangeInput]].forEach(([axis, input]) => {
  input.addEventListener('input', () => {
    const range = parseLineRange(input.value);
    input.classList.toggle('invalid', range === false);
    if (range === false) return; // 入力途中の読めない値では今の強調を保つ
    lineHighlight[axis] = range;
    updateLineHighlights();
  });
  // 入力欄から離れたら、読める値なら「60-80」の形に整える
  input.addEventListener('blur', () => {
    if (parseLineRange(input.value) !== false) input.value = formatLineRange(lineHighlight[axis]);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    e.stopPropagation(); // 入力中の文字でツールが切り替わらないようにする
  });
});

function clearLineHighlights() {
  setLineHighlight('col', null);
  setLineHighlight('row', null);
}
document.getElementById('btn-line-clear').addEventListener('click', clearLineHighlights);
rulerCorner.addEventListener('click', clearLineHighlights);

// ── 定規の描画 ──
function scheduleRulerDraw() {
  if (rulerDrawPending) return;
  rulerDrawPending = true;
  requestAnimationFrame(() => {
    rulerDrawPending = false;
    drawRulers();
  });
}

// 定規のキャンバスを表示サイズ×画面の解像度に合わせ、CSSピクセルで描けるようにする
function prepareRulerCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawRulers() {
  if (canvasStage.classList.contains('no-rulers')) return;
  const css = getComputedStyle(document.documentElement);
  const colors = {
    text: css.getPropertyValue('--text-muted').trim() || '#888',
    tick: css.getPropertyValue('--border-strong').trim() || '#ccc',
    accent: css.getPropertyValue('--accent').trim() || '#333',
  };
  const cell = cellPx() * zoom; // 画面上での1マスの大きさ
  const layout = layoutRulers();
  if (layout.top) {
    drawRuler(rulerTop, cols, cell, layout.top.offset,
      lineHighlight.col, rulerHover && rulerHover.col, true, colors);
  }
  if (layout.left) {
    drawRuler(rulerLeft, rows, cell, layout.left.offset,
      lineHighlight.row, rulerHover && rulerHover.row, false, colors);
  }
}

// 定規をキャンバスの上辺・左辺に付けて置く。キャンバスの端が見えている範囲の外に
// 出たときは、見えている範囲の端で止めて見え続けるようにする。
// 戻り値のoffsetは、定規の端から見たキャンバスの端の位置（描画に使う）。
function layoutRulers() {
  const stage = canvasStage.getBoundingClientRect();
  const areaRect = canvasArea.getBoundingClientRect();
  // スクロールバーを除いた、実際に見えている範囲
  const aL = areaRect.left + canvasArea.clientLeft, aT = areaRect.top + canvasArea.clientTop;
  const aR = aL + canvasArea.clientWidth, aB = aT + canvasArea.clientHeight;
  const w = wrap.getBoundingClientRect();
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const place = (el, x, y, width, height) => {
    Object.assign(el.style, {
      display: 'block',
      left: (x - stage.left) + 'px', top: (y - stage.top) + 'px',
      width: width + 'px', height: height + 'px',
    });
  };
  const hide = el => { el.style.display = 'none'; };

  const topY = clamp(w.top - RULER_H, aT, aB - RULER_H);
  const leftX = clamp(w.left - RULER_W, aL, aR - RULER_W);
  // キャンバスが見えている範囲（縦横どちらかでも見えていなければ定規も出さない）
  const visX1 = Math.max(w.left, aL), visX2 = Math.min(w.right, aR);
  const visY1 = Math.max(w.top, aT), visY2 = Math.min(w.bottom, aB);
  const visible = visX2 > visX1 && visY2 > visY1;

  const result = { top: null, left: null };
  if (visible) {
    place(rulerTop, visX1, topY, visX2 - visX1, RULER_H);
    place(rulerLeft, leftX, visY1, RULER_W, visY2 - visY1);
    place(rulerCorner, leftX, topY, RULER_W, RULER_H);
    result.top = { offset: w.left - visX1 };
    result.left = { offset: w.top - visY1 };
  } else {
    hide(rulerTop);
    hide(rulerLeft);
    hide(rulerCorner);
  }
  return result;
}

// horizontal: 上の定規（列）ならtrue。offset: 定規の端から見たキャンバスの端の位置
function drawRuler(cv, count, cell, offset, range, hover, horizontal, colors) {
  const { ctx, w, h } = prepareRulerCanvas(cv);
  const length = horizontal ? w : h;
  const thick = horizontal ? h : w;
  // 定規の向きに関係なく「長さ方向の位置 pos・幅方向の位置 across」で矩形を塗る
  const fill = (pos, size, across, depth) => {
    if (horizontal) ctx.fillRect(pos, across, size, depth);
    else ctx.fillRect(across, pos, depth, size);
  };

  // 強調中の範囲とカーソル位置
  if (range && range.start <= count) {
    ctx.fillStyle = 'rgba(255, 190, 0, 0.45)';
    fill(offset + (range.start - 1) * cell, (Math.min(range.end, count) - range.start + 1) * cell, 0, thick);
  }
  if (hover != null && hover >= 0 && hover < count) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.10)';
    fill(offset + hover * cell, Math.max(1, cell), 0, thick);
  }

  // 数字が重ならない間隔を選ぶ（上は4桁の数字の幅、左は文字の高さが目安）
  const minGap = horizontal ? 28 : 16;
  const step = RULER_STEPS.find(s => s * cell >= minGap) || RULER_STEPS[RULER_STEPS.length - 1];
  // 画面に見えている範囲のマスだけを描く
  const first = Math.max(0, Math.floor(-offset / cell));
  const last = Math.min(count - 1, Math.ceil((length - offset) / cell));

  ctx.fillStyle = colors.tick;
  for (let i = first; i <= last + 1 && i <= count; i++) {
    const pos = Math.round(offset + i * cell);
    const labeled = (i + 1) % step === 0 || i === 0; // マスi（0始まり）の左端・上端
    if (cell >= 4 || labeled) {
      const depth = labeled ? thick * 0.45 : thick * 0.2;
      fill(pos, 1, thick - depth, depth);
    }
  }

  ctx.fillStyle = colors.text;
  ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 1番は常に出したいが、次の数字（stepの倍数）と近すぎて重なるときは省く
  const showOne = step === 1 || (step - 1) * cell >= minGap;
  for (let i = first; i <= last; i++) {
    const n = i + 1;
    if (n === 1 ? !showOne : n % step !== 0) continue;
    const center = offset + (i + 0.5) * cell;
    if (horizontal) ctx.fillText(String(n), center, h * 0.36);
    else ctx.fillText(String(n), w * 0.42, center);
  }
}

// ── 定規のクリック・ドラッグで強調する ──
function rulerIndexAt(e, horizontal) {
  const cell = cellPx() * zoom;
  const wrapRect = wrap.getBoundingClientRect();
  const pos = horizontal ? e.clientX - wrapRect.left : e.clientY - wrapRect.top;
  const count = horizontal ? cols : rows;
  return Math.max(1, Math.min(count, Math.floor(pos / cell) + 1));
}

// 定規をドラッグ中の状態。ピンチのつもりで触れた1本目が強調を変えてしまった場合に、
// 少しの間なら元に戻せるよう、触れる前の強調を覚えておく。
let rulerDrag = null; // {axis, before, time, end}

function cancelRulerDrag() {
  if (!rulerDrag) return;
  const { axis, before, time, end } = rulerDrag;
  end();
  if (performance.now() - time < PINCH_GRACE_MS) setLineHighlight(axis, before);
}

[[rulerTop, 'col', true], [rulerLeft, 'row', false]].forEach(([cv, axis, horizontal]) => {
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !started || rulerDrag) return;
    e.preventDefault();
    const current = lineHighlight[axis];
    const at = rulerIndexAt(e, horizontal);
    // Shift＋クリックは今の強調の端からその位置までを範囲にする
    const anchor = e.shiftKey && current ? current.start : at;
    const apply = end => setLineHighlight(axis, { start: Math.min(anchor, end), end: Math.max(anchor, end) });
    const before = current;
    apply(at);
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 捕捉できなくてもクリックは効く */ }
    const onMove = ev => { if (ev.pointerId === e.pointerId) apply(rulerIndexAt(ev, horizontal)); };
    const onUp = () => {
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
      rulerDrag = null;
    };
    rulerDrag = { axis, before, time: performance.now(), end: onUp };
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
  });
});

// カーソルのあるマスを定規に示す
cOv.addEventListener('mousemove', e => {
  const { col, row } = getCell(e);
  if (!rulerHover || rulerHover.col !== col || rulerHover.row !== row) {
    rulerHover = { col, row };
    scheduleRulerDraw();
  }
});
cOv.addEventListener('mouseleave', () => {
  rulerHover = null;
  scheduleRulerDraw();
});

// ── 定規の表示切替 ──
const showRulersCheckbox = document.getElementById('show-rulers');
function setRulersVisible(visible) {
  canvasStage.classList.toggle('no-rulers', !visible);
  showRulersCheckbox.checked = visible;
  scheduleRulerDraw();
}
showRulersCheckbox.addEventListener('change', () => {
  setRulersVisible(showRulersCheckbox.checked);
  try { localStorage.setItem(SHOW_RULERS_KEY, showRulersCheckbox.checked ? '1' : '0'); } catch (err) { /* 記憶できなくても切り替えはできる */ }
});
try {
  if (localStorage.getItem(SHOW_RULERS_KEY) === '0') {
    canvasStage.classList.add('no-rulers');
    showRulersCheckbox.checked = false;
  }
} catch (err) { /* 読めなければ表示する */ }

// スクロールや表示領域の大きさが変わったら描き直す
// （拡大縮小・グリッドサイズの変更はupdateGridOverlayから呼ばれる）
// スクロール中はキャンバスに遅れず付いていくよう、待たずにその場で描き直す
canvasArea.addEventListener('scroll', () => drawRulers(), { passive: true });
new ResizeObserver(scheduleRulerDraw).observe(canvasArea);

// ── ズーム ────────────────────────────────────────────
// 大きなグリッドを全体表示できるよう、縮小は10%まで許可する
const MIN_ZOOM = 0.1, MAX_ZOOM = 8;
function setZoom(z) {
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  const {w, h} = canvasSize();
  wrap.style.width  = (w * zoom) + 'px';
  wrap.style.height = (h * zoom) + 'px';
  [cBg, cTrace, cMain, cOv].forEach(c => {
    c.style.width  = (w * zoom) + 'px';
    c.style.height = (h * zoom) + 'px';
  });
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  updateGridOverlay(); // 1マスの表示サイズが変わるのでグリッド線も追従させる
  updateScrollPadding();
}
document.getElementById('btn-zoom-in').addEventListener('click',  () => setZoom(zoom * 1.5));
document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(zoom / 1.5));

// マウスホイールズーム（カーソル位置を中心に拡縮する）
// パディング量がzoomに応じて非線形に変わる（updateScrollPadding参照）ため、
// スクロール量を比率計算で求めることはできない。ズーム前後で実際に
// レイアウトされたwrapの画面上の位置を測定し、カーソル直下にあった
// セル座標がズーム後も同じ画面位置に留まるようスクロール位置を補正する。
// パソコンのタッチパッドのピンチもCtrl付きのホイールとして届くので、ここで扱う。
// 定規の上でも効くよう、定規を含むキャンバス全体（canvas-stage）で受け取る。
document.getElementById('canvas-stage').addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) {
    // 定規はスクロールしない要素なので、上での2本指スクロールやホイールをキャンバスに回す
    if (e.target.closest('.ruler, .ruler-corner')) {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 20 : 1;
      canvasArea.scrollLeft += (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
      canvasArea.scrollTop += (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
    }
    return;
  }
  e.preventDefault();
  const delta = -e.deltaY * (e.deltaMode === 1 ? 20 : 1);
  const factor = 1 + Math.min(Math.abs(delta) * 0.002, 0.15);
  const newZoom = delta > 0 ? zoom * factor : zoom / factor;

  const oldZoom = zoom;
  const wrapRectBefore = wrap.getBoundingClientRect();
  // カーソル直下のセル座標（zoomに依存しない値）を記録
  const contentX = (e.clientX - wrapRectBefore.left) / oldZoom;
  const contentY = (e.clientY - wrapRectBefore.top) / oldZoom;

  setZoom(newZoom); // zoomは内部でMIN_ZOOM〜MAX_ZOOMにクランプされる

  const wrapRectAfter = wrap.getBoundingClientRect();
  const desiredLeft = e.clientX - contentX * zoom;
  const desiredTop = e.clientY - contentY * zoom;
  canvasArea.scrollLeft += wrapRectAfter.left - desiredLeft;
  canvasArea.scrollTop  += wrapRectAfter.top - desiredTop;
}, {passive: false});

// ── 右クリックドラッグでパン ──────────────────────────
let isPanning = false;
let panStartX = 0, panStartY = 0;
let scrollStartX = 0, scrollStartY = 0;

canvasArea.addEventListener('mousedown', e => {
  if (e.button !== 2) return;
  e.preventDefault();
  isPanning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  scrollStartX = canvasArea.scrollLeft;
  scrollStartY = canvasArea.scrollTop;
  canvasArea.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', e => {
  if (!isPanning) return;
  canvasArea.scrollLeft = scrollStartX - (e.clientX - panStartX);
  canvasArea.scrollTop  = scrollStartY - (e.clientY - panStartY);
});

document.addEventListener('mouseup', e => {
  if (e.button !== 2 || !isPanning) return;
  isPanning = false;
  canvasArea.style.cursor = '';
});

canvasArea.addEventListener('contextmenu', e => e.preventDefault());

// ── クリア ────────────────────────────────────────────
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!started || activeLayerLocked()) return;
  pushHistory();
  const layer = layers[activeLayerIndex];
  layer.cells = makeCells(cols, rows);
  syncActiveCells();
  drawCells();
  updateLayerPanel();
});

// ── ファイルメニュー ──────────────────────────────────
// 「保存」「クラウド保存」のように入れ子のサブメニューを持つドロップダウン。
// cloud.js（クラウド保存・ギャラリー・ログイン）からも window.closeFileMenu()
// として呼び出され、操作後にメニュー全体を閉じるのに使われる。
const fileMenu = document.getElementById('file-menu');
const btnFileMenu = document.getElementById('btn-file-menu');
const fileDropdown = document.getElementById('file-dropdown');
const btnMenuSave = document.getElementById('btn-menu-save');
const saveSubdropdown = document.getElementById('save-subdropdown');

function closeFileMenu() {
  fileDropdown.style.display = 'none';
  saveSubdropdown.style.display = 'none';
  const cloudDD = document.getElementById('cloud-save-dropdown');
  if (cloudDD) cloudDD.style.display = 'none';
}
window.closeFileMenu = closeFileMenu;

btnFileMenu.addEventListener('click', e => {
  e.stopPropagation();
  if (fileDropdown.style.display === 'none') {
    fileDropdown.style.display = 'flex';
  } else {
    closeFileMenu();
  }
});

btnMenuSave.addEventListener('click', e => {
  e.stopPropagation();
  const opening = saveSubdropdown.style.display === 'none';
  saveSubdropdown.style.display = opening ? 'flex' : 'none';
  if (!opening) {
    const cloudDD = document.getElementById('cloud-save-dropdown');
    if (cloudDD) cloudDD.style.display = 'none';
  }
});

document.addEventListener('click', e => {
  if (!fileMenu.contains(e.target)) closeFileMenu();
});

// ── ダウンロード（PNG保存） ───────────────────────────
// 保存時に倍率を選ぶ。×1は1ドット＝1ピクセルで、ゲーム素材などにそのまま使える。
// ドット絵を半端な倍率で拡大するとドットの大きさが不ぞろいになったりぼやけたりするため、
// 倍率は整数に限る。選んだ倍率はこのブラウザに記憶する。
const PNG_SCALES = [1, 2, 4, 8, 16, 32];
const PNG_SCALE_KEY = 'pixelart-png-scale';
// 端末によっては大きすぎる画像を作れない（iPhoneのSafariは面積の上限が特に小さい）ため、
// どの端末でも作れる大きさまでに制限する
const PNG_MAX_SIDE = 8192;
const PNG_MAX_AREA = 4096 * 4096;
const pngExportModal = document.getElementById('png-export-modal');
const pngScaleGrid = document.getElementById('png-scale-grid');
let pngExportTransparent = false;
let pngExportScale = 1;

// 合成後の絵を1ドット＝1ピクセルで描いたキャンバスを作る
function compositeCanvas() {
  const cv = document.createElement('canvas');
  cv.width = cols;
  cv.height = rows;
  const ctx = cv.getContext('2d');
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = compositeAt(r, c);
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(c, r, 1, 1);
      }
    }
  }
  return cv;
}

function pngScaleAllowed(scale) {
  const w = cols * scale, h = rows * scale;
  return w <= PNG_MAX_SIDE && h <= PNG_MAX_SIDE && w * h <= PNG_MAX_AREA;
}

// 前回選んだ倍率。初めてのときは、これまでの保存サイズ（約512px）に近い倍率にする
function initialPngScale() {
  let saved = NaN;
  try { saved = parseInt(localStorage.getItem(PNG_SCALE_KEY), 10); } catch (err) { /* 読めなければ既定値 */ }
  const wanted = PNG_SCALES.includes(saved)
    ? saved
    : PNG_SCALES.reduce((best, s) =>
        Math.abs(Math.max(cols, rows) * s - 512) < Math.abs(Math.max(cols, rows) * best - 512) ? s : best);
  // 今のキャンバスでは大きすぎる場合は、作れる中で一番近い倍率にする
  return [...PNG_SCALES].reverse().find(s => s <= wanted && pngScaleAllowed(s)) || 1;
}

function buildPngScaleButtons() {
  pngScaleGrid.innerHTML = '';
  PNG_SCALES.forEach(scale => {
    const b = document.createElement('button');
    const allowed = pngScaleAllowed(scale);
    b.className = scale === pngExportScale ? 'active' : '';
    b.disabled = !allowed;
    b.title = allowed ? '' : 'この端末では作れない大きさのため選べません';
    b.textContent = `×${scale}`;
    const size = document.createElement('span');
    size.textContent = `${cols * scale}×${rows * scale}px`;
    b.appendChild(size);
    b.addEventListener('click', () => {
      pngExportScale = scale;
      buildPngScaleButtons();
    });
    pngScaleGrid.appendChild(b);
  });
}

function openPngExport(transparent) {
  closeFileMenu();
  if (!started) return;
  pngExportTransparent = transparent;
  pngExportScale = initialPngScale();
  document.getElementById('png-export-title').textContent = transparent ? 'PNG保存（背景を透明にする）' : 'PNG保存（背景は白）';
  buildPngScaleButtons();
  pngExportModal.style.display = 'flex';
}

function exportPng() {
  pngExportModal.style.display = 'none';
  const scale = pngExportScale;
  try { localStorage.setItem(PNG_SCALE_KEY, String(scale)); } catch (err) { /* 記憶できなくても保存はできる */ }
  const out = document.createElement('canvas');
  out.width = cols * scale;
  out.height = rows * scale;
  const ctx = out.getContext('2d');
  if (!pngExportTransparent) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
  }
  // 等倍の絵を、ぼかさずに（ドットのまま）拡大して描き写す
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(compositeCanvas(), 0, 0, out.width, out.height);
  const name = `pixel-art${pngExportTransparent ? '-transparent' : ''}_${out.width}x${out.height}.png`;
  out.toBlob(blob => {
    if (!blob) return; // 作れなかった（メモリ不足など）
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = name;
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    markProjectSaved();
  }, 'image/png');
}

document.getElementById('btn-download').addEventListener('click', () => openPngExport(false));
document.getElementById('btn-download-transparent').addEventListener('click', () => openPngExport(true));
document.getElementById('btn-png-export-ok').addEventListener('click', exportPng);
document.getElementById('btn-png-export-cancel').addEventListener('click', () => {
  pngExportModal.style.display = 'none';
});

// ── 画像変換 ──────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const convertResizeCanvasCheckbox = document.getElementById('convert-resize-canvas');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.background = '#f0f0ee'; });
dropZone.addEventListener('dragleave', () => { dropZone.style.background = ''; });
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.style.background = '';
  loadImageFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => loadImageFile(e.target.files[0]));

function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      uploadedImage = img;
      updateConvertButtonState();
      // SVGアイコンは定数なのでinnerHTMLで挿入するが、file.nameは
      // ユーザー由来なのでテキストノードとして追加する（HTMLとして解釈させない）。
      // 直接innerHTMLに埋め込むと、細工したファイル名によるDOM XSSになる。
      dropZone.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="display:block;margin:0 auto 4px"><path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2M12 4v12m-4-4l4-4 4 4"/></svg>';
      dropZone.appendChild(document.createTextNode(file.name));
      if (!started) startEditor();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

document.querySelectorAll('.method-btn').forEach(b => {
  b.addEventListener('click', () => {
    convertMethod = b.dataset.method;
    document.querySelectorAll('.method-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
  });
});

document.querySelectorAll('.cc-btn').forEach(b => {
  b.addEventListener('click', () => {
    convertColorCount = parseInt(b.dataset.colors);
    document.querySelectorAll('.cc-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
  });
});

document.getElementById('btn-convert').addEventListener('click', () => {
  if (!uploadedImage) return;
  pushHistory();
  convertImage(uploadedImage);
});

function syncSlidersToGrid() {
  colsSlider.value = cols; colsVal.value = cols;
  rowsSlider.value = rows; rowsVal.value = rows;
  syncBothDisplay();
  updatePresetHighlight();
}

// ── トレース（下描き用の参考画像） ────────────────────
// ドット絵に変換せず、選んだ画像をそのままキャンバスの裏に薄く表示するだけの機能。
// レイヤー・履歴（Undo）・保存（PNG/クラウド）のいずれにも含まれない、
// あくまで画面上の下描きガイド。
let traceImage = null;
let traceOpacity = 0.5;

const traceDropZone = document.getElementById('trace-drop-zone');
const traceFileInput = document.getElementById('trace-file-input');
const traceResizeCheckbox = document.getElementById('trace-resize-canvas');
const traceOpacitySlider = document.getElementById('trace-opacity');
const traceOpacityVal = document.getElementById('trace-opacity-val');
const btnTraceRemove = document.getElementById('btn-trace-remove');

// レターボックス（縦横比を保ってキャンバス内に収める）で描画する。
// resizeCanvasesでキャンバスの実ピクセルサイズが変わると内容が消えるため、
// リサイズ後は必ず呼び直す想定。
function drawTraceImage() {
  const ctx = cTrace.getContext('2d');
  ctx.clearRect(0, 0, cTrace.width, cTrace.height);
  if (!traceImage) return;
  const scale = Math.min(cTrace.width / traceImage.width, cTrace.height / traceImage.height);
  const w = traceImage.width * scale;
  const h = traceImage.height * scale;
  ctx.globalAlpha = traceOpacity;
  ctx.drawImage(traceImage, (cTrace.width - w) / 2, (cTrace.height - h) / 2, w, h);
  ctx.globalAlpha = 1;
}

function updateTraceUI() {
  btnTraceRemove.style.display = traceImage ? '' : 'none';
}

function clearTraceImage() {
  traceImage = null;
  drawTraceImage();
  updateTraceUI();
}

// チェックが入っている場合、画像のアスペクト比に合わせてキャンバスサイズを
// 変更する（既存の描画内容は保持したまま。画像から変換の同名チェックボックスとは異なり、
// トレースは絵を消す機能ではないためkeepOld=trueにする）。
function applyTraceCanvasResize() {
  if (!traceImage) return;
  const maxDim = Math.max(cols, rows);
  const aspect = traceImage.width / traceImage.height;
  let newCols, newRows;
  if (aspect >= 1) {
    newCols = maxDim;
    newRows = Math.max(1, Math.round(maxDim / aspect));
  } else {
    newRows = maxDim;
    newCols = Math.max(1, Math.round(maxDim * aspect));
  }
  newCols = Math.min(MAX_GRID, newCols);
  newRows = Math.min(MAX_GRID, newRows);
  pushFramesHistory(); // 大きさは全部のコマに関わる
  initCells(newCols, newRows, true);
  resizeCanvases();
  syncSlidersToGrid();
}

function loadTraceImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      traceImage = img;
      if (!started) startEditor();
      if (traceResizeCheckbox.checked) applyTraceCanvasResize();
      // アイコン(定数)とファイル名(ユーザー由来)を分ける。file.nameをinnerHTMLに
      // 直接埋め込むとDOM XSSになるため、テキストノードとして追加する。
      traceDropZone.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="display:block;margin:0 auto 4px"><path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2M12 4v12m-4-4l4-4 4 4"/></svg>';
      traceDropZone.appendChild(document.createTextNode(file.name));
      drawTraceImage();
      updateTraceUI();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

traceDropZone.addEventListener('click', () => traceFileInput.click());
traceDropZone.addEventListener('dragover', e => { e.preventDefault(); traceDropZone.style.background = '#f0f0ee'; });
traceDropZone.addEventListener('dragleave', () => { traceDropZone.style.background = ''; });
traceDropZone.addEventListener('drop', e => {
  e.preventDefault();
  traceDropZone.style.background = '';
  loadTraceImageFile(e.dataTransfer.files[0]);
});
traceFileInput.addEventListener('change', e => loadTraceImageFile(e.target.files[0]));

traceResizeCheckbox.addEventListener('change', () => {
  if (traceResizeCheckbox.checked && traceImage) applyTraceCanvasResize();
});

traceOpacitySlider.addEventListener('input', () => {
  traceOpacity = parseInt(traceOpacitySlider.value) / 100;
  traceOpacityVal.textContent = traceOpacitySlider.value;
  drawTraceImage();
});

// 重ね順の切替。実際の前後関係はCSSのz-index（.above-layers）で決まる。
document.querySelectorAll('.trace-pos-btn').forEach(b => {
  b.addEventListener('click', () => {
    const above = b.dataset.tracePos === 'above';
    cTrace.classList.toggle('above-layers', above);
    document.querySelectorAll('.trace-pos-btn').forEach(x => {
      x.classList.toggle('active', x === b);
    });
  });
});

btnTraceRemove.addEventListener('click', clearTraceImage);

function convertImage(img) {
  if (!started) startEditor();
  // destC0,destR0,destW,destH: 画像を実際に描画する先の範囲（キャンバス座標）。
  // キャンバスサイズを変える場合は全面、変えない場合はアスペクト比を保った
  // まま中央に配置する範囲になる。
  let destC0 = 0, destR0 = 0, destW = cols, destH = rows;
  if (convertResizeCanvasCheckbox.checked) {
    const maxDim = Math.max(cols, rows);
    const aspect = img.width / img.height;
    let newCols, newRows;
    if (aspect >= 1) {
      newCols = maxDim;
      newRows = Math.max(1, Math.round(maxDim / aspect));
    } else {
      newRows = maxDim;
      newCols = Math.max(1, Math.round(maxDim * aspect));
    }
    newCols = Math.min(MAX_GRID, newCols);
    newRows = Math.min(MAX_GRID, newRows);
    initCells(newCols, newRows, true); // 既存レイヤーは残したままサイズだけ変更
    resizeCanvases();
    syncSlidersToGrid();
    destW = cols; destH = rows;
  } else {
    const scale = Math.min(cols / img.width, rows / img.height);
    destW = Math.max(1, Math.round(img.width * scale));
    destH = Math.max(1, Math.round(img.height * scale));
    destC0 = Math.floor((cols - destW) / 2);
    destR0 = Math.floor((rows - destH) / 2);
  }
  // 変換結果は既存の絵を消さず、新しいレイヤーとして重ねる
  addLayerAboveActive();
  const off = document.createElement('canvas');
  off.width = destW; off.height = destH;
  const ctx = off.getContext('2d');
  ctx.drawImage(img, 0, 0, destW, destH);
  const data = ctx.getImageData(0, 0, destW, destH).data;
  for (let r = 0; r < destH; r++) {
    for (let c = 0; c < destW; c++) {
      const i = (r * destW + c) * 4;
      if (data[i+3] < 128) { cells[destR0 + r][destC0 + c] = null; continue; }
      cells[destR0 + r][destC0 + c] = `#${[data[i],data[i+1],data[i+2]].map(v=>v.toString(16).padStart(2,'0')).join('')}`;
    }
  }
  if (convertMethod === 'avg') {
    // 平均色はすでに縮小時に自動でブレンドされている
  } else {
    // 最頻色：より高解像度から集計
    const hi = document.createElement('canvas');
    const sx = Math.min(1024, img.width);
    const sy = Math.round(img.height * (sx / img.width));
    hi.width = sx; hi.height = sy;
    const hctx = hi.getContext('2d');
    hctx.drawImage(img, 0, 0, sx, sy);
    const hdata = hctx.getImageData(0, 0, sx, sy).data;
    const cw = sx / destW, ch = sy / destH;
    for (let r = 0; r < destH; r++) {
      for (let c = 0; c < destW; c++) {
        const x = Math.round(c * cw), y = Math.round(r * ch);
        const w = Math.round(cw), h = Math.round(ch);
        const map = {};
        let best = 0, bestColor = null;
        let alphaSum = 0, alphaCount = 0;
        for (let py = y; py < y+h && py < sy; py++) {
          for (let px = x; px < x+w && px < sx; px++) {
            const i = (py * sx + px) * 4;
            alphaSum += hdata[i+3]; alphaCount++;
            if (hdata[i+3] < 128) continue;
            const key = ((hdata[i]>>4)<<8)|((hdata[i+1]>>4)<<4)|(hdata[i+2]>>4);
            map[key] = (map[key]||0) + 1;
            if (map[key] > best) { best = map[key]; bestColor = [hdata[i],hdata[i+1],hdata[i+2]]; }
          }
        }
        if (alphaCount > 0 && alphaSum / alphaCount < 128) { cells[destR0 + r][destC0 + c] = null; }
        else if (bestColor) cells[destR0 + r][destC0 + c] = `#${bestColor.map(v=>v.toString(16).padStart(2,'0')).join('')}`;
      }
    }
  }
  // 「指定した色だけで変換する」がオンなら減色ではなく指定パレットへ寄せる
  const fixedPalette = convertUsePaletteCheckbox.checked
    ? convertPaletteColors.filter(Boolean)
    : null;
  if (fixedPalette && fixedPalette.length) {
    applyFixedPalette(fixedPalette);
  } else {
    quantizeColors(convertColorCount);
  }
  drawCells();
  updateLayerThumbnails();
}

function quantizeColors(maxColors) {
  const colorMap = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r][c]) colorMap[cells[r][c]] = true;
    }
  }
  const uniqueColors = Object.keys(colorMap).map(hex => {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return [r, g, b, hex];
  });
  if (uniqueColors.length <= maxColors) return;

  const palette = medianCut(uniqueColors.map(c => [c[0],c[1],c[2]]), maxColors);
  const lookup = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hex = cells[r][c];
      if (!hex) continue;
      if (lookup[hex]) { cells[r][c] = lookup[hex]; continue; }
      const cr = parseInt(hex.slice(1,3),16);
      const cg = parseInt(hex.slice(3,5),16);
      const cb = parseInt(hex.slice(5,7),16);
      let bestDist = Infinity, bestHex = hex;
      for (const p of palette) {
        const dr = cr-p[0], dg = cg-p[1], db = cb-p[2];
        const d = dr*dr + dg*dg + db*db;
        if (d < bestDist) { bestDist = d; bestHex = `#${p.map(v=>v.toString(16).padStart(2,'0')).join('')}`; }
      }
      lookup[hex] = bestHex;
      cells[r][c] = bestHex;
    }
  }
}

function medianCut(colors, maxColors) {
  if (colors.length === 0) return [];
  let buckets = [colors];
  while (buckets.length < maxColors) {
    let longest = -1, longestIdx = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].length <= 1) continue;
      const ranges = [0,1,2].map(ch => {
        let mn = 255, mx = 0;
        for (const c of buckets[i]) { mn = Math.min(mn, c[ch]); mx = Math.max(mx, c[ch]); }
        return mx - mn;
      });
      const maxRange = Math.max(...ranges);
      if (maxRange > longest) { longest = maxRange; longestIdx = i; }
    }
    if (longest <= 0) break;
    const bucket = buckets[longestIdx];
    const ranges = [0,1,2].map(ch => {
      let mn = 255, mx = 0;
      for (const c of bucket) { mn = Math.min(mn, c[ch]); mx = Math.max(mx, c[ch]); }
      return mx - mn;
    });
    const splitCh = ranges.indexOf(Math.max(...ranges));
    bucket.sort((a, b) => a[splitCh] - b[splitCh]);
    const mid = Math.floor(bucket.length / 2);
    buckets.splice(longestIdx, 1, bucket.slice(0, mid), bucket.slice(mid));
  }
  return buckets.map(b => {
    const avg = [0,1,2].map(ch => Math.round(b.reduce((s,c) => s+c[ch], 0) / b.length));
    return avg;
  });
}

// ── スタート ──────────────────────────────────────────
function centerCanvas() {
  const padEl = document.querySelector('.canvas-scroll-pad');
  const {w, h} = canvasSize();
  const cw = w * zoom, ch = h * zoom;
  const padX = parseFloat(padEl.style.paddingLeft) || 0;
  const padY = parseFloat(padEl.style.paddingTop) || 0;
  canvasArea.scrollLeft = padX + cw / 2 - canvasArea.clientWidth / 2;
  canvasArea.scrollTop  = padY + ch / 2 - canvasArea.clientHeight / 2;
}

// タブレットでは、キャンバスが小さいと描きにくいので、画面いっぱい近くまで拡大して表示する
function fitCanvasToView() {
  const {w, h} = canvasSize();
  setZoom(Math.min(canvasArea.clientWidth * 0.9 / w, canvasArea.clientHeight * 0.9 / h));
}

function startEditor() {
  started = true;
  overlay.style.display = 'none';
  initCells(cols, rows, false);
  resizeCanvases();
  if (tabletUI) fitCanvasToView();
  centerCanvas();
}

document.getElementById('btn-new').addEventListener('click', () => {
  startEditor();
});
document.getElementById('btn-load-img').addEventListener('click', () => {
  fileInput.click();
});

// ── 新規キャンバス（ファイルメニュー） ─────────────────
// サイトを開いた直後・「白紙で始める」を押した直後と同じ状態
// （32×32・単一の空レイヤー・ズーム100%・履歴なし）に戻す。
function resetToNewCanvas() {
  initCells(32, 32, false);
  setZoom(1);
  clearHistory();
  resetChangeTracking();
  clearSelection();
  clearTraceImage();
  resizeCanvases();
  syncSlidersToGrid();
  updatePresetHighlight();
  if (tabletUI) fitCanvasToView();
  centerCanvas();
  if (window.clearCurrentArtwork) window.clearCurrentArtwork();
}

const newCanvasConfirmModal = document.getElementById('new-canvas-confirm-modal');
document.getElementById('btn-new-canvas').addEventListener('click', () => {
  if (!started) return;
  closeFileMenu();
  newCanvasConfirmModal.style.display = 'flex';
});
document.getElementById('btn-new-canvas-ok').addEventListener('click', () => {
  newCanvasConfirmModal.style.display = 'none';
  resetToNewCanvas();
});
document.getElementById('btn-new-canvas-cancel').addEventListener('click', () => {
  newCanvasConfirmModal.style.display = 'none';
});

// ── パネルリサイズ・開閉 ──────────────────────────────
const panel = document.getElementById('panel');
const panelResize = document.getElementById('panel-resize');
const panelToggle = document.getElementById('panel-toggle');
const panelBackdrop = document.getElementById('panel-backdrop');
const MIN_PANEL_W = 260;
let panelCollapsed = false;
let savedPanelWidth = panel.offsetWidth || 260;

function isMobile() { return window.innerWidth <= 640; }
// パネルを画面の左から引き出す形で使うか（スマホとタブレット）
function isDrawerLayout() { return isMobile() || tabletUI; }

function syncTogglePosition() {
  panelToggle.textContent = panelCollapsed ? '▶' : '◀';
  if (isDrawerLayout()) {
    panelToggle.style.left = '0px';
    panelBackdrop.classList.toggle('visible', !panelCollapsed);
    updateColorHistoryPos();
  } else {
    // パネルはトランジション中のため、実測値ではなく指定済みの目標幅を使う
    const w = panelCollapsed ? 0 : (parseFloat(panel.style.width) || panel.getBoundingClientRect().width);
    const handleW = panelCollapsed ? 0 : 4;
    // レイヤードックを開いている場合は、パネル・リサイズハンドル・ドックの右端に付ける。
    // 開いていない場合はパネルの枠線にぴったり付ける（リサイズハンドルは透明なので、
    // その幅を足すとボタンがパネルから離れて見える。ハンドルの上に重なってもボタンが上に来る）
    const dockW = layersDocked ? layerDock.getBoundingClientRect().width : 0;
    const edge = layersDocked ? w + handleW + dockW : w;
    panelToggle.style.left = edge + 'px';
    panelBackdrop.classList.remove('visible');
    updateColorHistoryPos(edge);
  }
}

// パネルの開閉や幅変更でキャンバスエリアの左端が動くと、スクロール位置は
// そのままなのでキャンバスが画面上で左右にずれて見える。変更前のキャンバスの
// 画面座標を覚えておき、スクロール位置を補正して同じ場所に留める。
function canvasScreenPos() {
  const r = wrap.getBoundingClientRect();
  return { x: r.left, y: r.top };
}

function restoreCanvasScreenPos(target) {
  const now = canvasScreenPos();
  canvasArea.scrollLeft += now.x - target.x;
  canvasArea.scrollTop  += now.y - target.y;
}

// パネル幅はCSSトランジション（0.22秒）で徐々に変わるため、
// アニメーションが終わるまで毎フレーム補正し続ける。
function keepCanvasAnchored(duration = 300) {
  const target = canvasScreenPos();
  const settle = () => {
    updateScrollPadding(); // エリア幅が変わったので余白を取り直す
    restoreCanvasScreenPos(target);
  };
  const start = performance.now();
  const step = () => {
    restoreCanvasScreenPos(target);
    if (performance.now() - start < duration) requestAnimationFrame(step);
    else settle();
  };
  requestAnimationFrame(step);
  // 非表示タブなどでrequestAnimationFrameが動かない場合の保険
  setTimeout(settle, duration);
}

function togglePanel() {
  const anchor = canvasScreenPos();
  if (panelCollapsed) {
    panel.classList.remove('collapsed');
    if (!isDrawerLayout()) panel.style.width = savedPanelWidth + 'px';
    panelCollapsed = false;
  } else {
    if (!isDrawerLayout()) savedPanelWidth = panel.offsetWidth;
    panel.classList.add('collapsed');
    panelCollapsed = true;
  }
  syncTogglePosition();
  restoreCanvasScreenPos(anchor); // 1フレーム目のずれを先に打ち消す
  keepCanvasAnchored();
}

panelToggle.addEventListener('click', togglePanel);
panelBackdrop.addEventListener('click', () => {
  if (!panelCollapsed) togglePanel();
});

// スマホ・タブレットでは初期状態で閉じる（開いた状態から閉じていく動きを見せないよう、一瞬で閉じる）
if (isDrawerLayout()) {
  panel.classList.add('no-transition', 'collapsed');
  panelCollapsed = true;
  requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove('no-transition')));
}

// 画面リサイズ時にモード切替
window.addEventListener('resize', () => {
  // 並べて表示する幅がなくなったらタブ表示に戻す（CSSの900px境界と揃える）
  if (layersDocked && window.innerWidth <= 900) setLayersDocked(false);
  syncTogglePosition();
});

// ドラッグリサイズ（デスクトップのみ）
let isResizing = false;
let resizeAnchor = null; // ドラッグ中にキャンバスを固定しておく画面座標
panelResize.addEventListener('mousedown', e => {
  if (isDrawerLayout()) return;
  e.preventDefault();
  isResizing = true;
  resizeAnchor = canvasScreenPos();
  panel.classList.add('no-transition');
  panelResize.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', e => {
  if (!isResizing) return;
  const appRect = document.querySelector('.app').getBoundingClientRect();
  let newWidth = e.clientX - appRect.left;
  newWidth = Math.max(MIN_PANEL_W, Math.min(newWidth, window.innerWidth * 0.5));
  panel.style.width = newWidth + 'px';
  syncTogglePosition();
  restoreCanvasScreenPos(resizeAnchor); // 幅を変えてもキャンバスは動かさない
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  panel.classList.remove('no-transition');
  panelResize.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  savedPanelWidth = panel.offsetWidth;
  updateScrollPadding();
  restoreCanvasScreenPos(resizeAnchor);
  resizeAnchor = null;
});

// ── キャンバス表示切替 ────────────────────────────────
let canvasVisible = true;
document.getElementById('btn-toggle-canvas').addEventListener('click', () => {
  canvasVisible = !canvasVisible;
  cBg.style.visibility = canvasVisible ? 'visible' : 'hidden';
  const btn = document.getElementById('btn-toggle-canvas');
  btn.classList.toggle('primary', !canvasVisible);
});

// ── 背景色切替 ────────────────────────────────────────
document.querySelectorAll('.bg-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.bg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    canvasArea.style.background = b.dataset.bg;
  });
});

// ── クラウド保存用のシリアライズ（cloud.jsから利用） ──
// 保存容量・転送量を抑えるため、各レイヤーのセルは
// 「パレット＋ランレングス圧縮した文字列」に変換する。
// 値0は透明、1以降はpalette[値-1]の色を表す。ランは「値*連続数」で表記。
// コマが1つなら今までと同じ形（version 1）で保存し、2つ以上なら全部のコマを入れる（version 2）
function serializeProject() {
  frames[currentFrame].active = activeLayerIndex;
  if (frames.length <= 1) return { version: 1, cols, rows, layers: serializeLayers(layers) };
  return {
    version: 2,
    cols, rows,
    fps: animFps,
    current: currentFrame,
    frames: frames.map(f => ({ active: f.active, layers: serializeLayers(f.layers) })),
  };
}

function serializeLayers(list) {
  return list.map(l => {
    const palette = [];
    const paletteMap = new Map();
    const flat = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = l.cells[r][c];
        if (!v) { flat.push(0); continue; }
        let idx = paletteMap.get(v);
        if (idx === undefined) {
          palette.push(v);
          idx = palette.length;
          paletteMap.set(v, idx);
        }
        flat.push(idx);
      }
    }
    const runs = [];
    let run = 1;
    for (let i = 1; i <= flat.length; i++) {
      if (i < flat.length && flat[i] === flat[i - 1]) { run++; continue; }
      runs.push(run > 1 ? `${flat[i - 1]}*${run}` : `${flat[i - 1]}`);
      run = 1;
    }
    return {
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      locked: l.locked,
      palette,
      data: runs.join(','),
    };
  });
}

function decodeLayerCells(sl, c, r) {
  const cells = makeCells(c, r);
  if (!sl.data) return cells;
  let p = 0;
  const put = idx => {
    if (p >= c * r) return;
    if (idx > 0) cells[Math.floor(p / c)][p % c] = sl.palette[idx - 1] || null;
    p++;
  };
  for (const token of sl.data.split(',')) {
    if (p >= c * r) break;
    const [v, n] = token.split('*');
    const idx = parseInt(v, 10) || 0;
    const count = n ? parseInt(n, 10) : 1;
    // 壊れたファイルで連続数が極端に大きくても固まらないよう、キャンバスの残りマス数までにする
    for (let i = 0; i < count && p < c * r; i++) put(idx);
  }
  return cells;
}

// 保存データからエディタの状態を丸ごと復元する
function loadProjectData(p) {
  cols = Math.max(4, Math.min(MAX_GRID, p.cols));
  rows = Math.max(4, Math.min(MAX_GRID, p.rows));
  const decodeLayers = list => {
    const out = (list || []).map(sl => ({
      name: sl.name || 'レイヤー',
      visible: sl.visible !== false,
      opacity: typeof sl.opacity === 'number' ? sl.opacity : 1,
      locked: !!sl.locked,
      cells: decodeLayerCells(sl, cols, rows),
    }));
    return out.length ? out : [makeLayer('レイヤー1')];
  };
  // コマのある保存データ（version 2）と、コマの無い今までの保存データ（version 1）の両方を読める
  const savedFrames = Array.isArray(p.frames) && p.frames.length ? p.frames : [{ layers: p.layers }];
  frames = savedFrames.map(sf => {
    const fl = decodeLayers(sf.layers);
    const active = Number.isInteger(sf.active) ? Math.max(0, Math.min(fl.length - 1, sf.active)) : fl.length - 1;
    return { layers: fl, active };
  });
  currentFrame = Number.isInteger(p.current) ? Math.max(0, Math.min(frames.length - 1, p.current)) : 0;
  animFps = Number.isFinite(p.fps) ? Math.max(1, Math.min(MAX_FPS, Math.round(p.fps))) : 8;
  layers = frames[currentFrame].layers;
  activeLayerIndex = frames[currentFrame].active;
  layerNameCounter = Math.max(...frames.map(f => f.layers.length)) + 1;
  syncActiveCells();
  if (typeof onFramesLoaded === 'function') onFramesLoaded();
  clearHistory();
  resetChangeTracking();
  floating = null;
  selectionMask = null;
  updateSelectionButtons();
  started = true;
  overlay.style.display = 'none';
  document.getElementById('stat-grid').textContent = `${cols}×${rows}`;
  clearTraceImage();
  resizeCanvases();
  syncSlidersToGrid();
  updateLayerPanel();
  if (tabletUI) fitCanvasToView();
  centerCanvas();
}

// ギャラリー一覧用のサムネイル（合成後の絵の等倍PNG）
function projectThumbnailDataURL() {
  return compositeCanvas().toDataURL('image/png');
}

function isEditorStarted() {
  return started;
}

// ── 自動保存と未保存の警告 ────────────────────────────
// 変更があるたびに少し待ってからブラウザ（localStorage）へ保存し、
// 次に開いたときスタート画面の「前回の続きから」で復元できるようにする。
// また、PNG保存・クラウド保存をしていない変更がある状態でタブを
// 閉じようとしたら、ブラウザの確認ダイアログを出す。
const AUTOSAVE_KEY = 'pixelart-autosave-v1';
const AUTOSAVE_DELAY = 1000;
let hasUnsavedChanges = false; // PNG保存・クラウド保存以降に変更があるか
let autosavePending = false;   // まだ自動保存していない変更があるか
let autosaveTimer = null;

// 履歴を積む操作（＝絵が変わる操作）のたびに呼ばれる
function markChanged() {
  if (!started) return;
  hasUnsavedChanges = true;
  autosavePending = true;
  scheduleAutosave();
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => flushAutosave(false), AUTOSAVE_DELAY);
}

// force: タブを閉じる直前など、描いている途中でも今すぐ保存したいとき
function flushAutosave(force) {
  clearTimeout(autosaveTimer);
  if (!autosavePending || !started) return;
  if (!force && (isPainting || moveDrag)) { scheduleAutosave(); return; } // 描き終わるまで待つ
  autosavePending = false;
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
      savedAt: Date.now(),
      unsaved: hasUnsavedChanges,
      artwork: window.getCurrentArtwork ? window.getCurrentArtwork() : null,
      project: serializeProject(),
    }));
  } catch (err) {
    // 容量オーバーやプライベートブラウズでは保存できないことがある
    console.warn('自動保存に失敗しました', err);
  }
}

// 作品を開き直した・新規にしたときは「変更なし」の状態から数え直す
function resetChangeTracking() {
  clearTimeout(autosaveTimer);
  hasUnsavedChanges = false;
  autosavePending = false;
}

// PNG保存・クラウド保存に成功したら呼ぶ（cloud.jsからも利用）
function markProjectSaved() {
  hasUnsavedChanges = false;
  if (!started) return;
  autosavePending = true; // 「保存済み」になったことも自動保存に反映する
  scheduleAutosave();
}
window.markProjectSaved = markProjectSaved;

// ── 作品ファイル（自分のフォルダに保存・開く） ─────────
// レイヤーなども含めた作品を1つのファイルとして保存し、あとで開いて続きを編集できるようにする。
// 中身はクラウド保存と同じ形式（serializeProject）を包んだJSON。
// 保存先を選べるブラウザ（パソコンのChrome・Edgeなど）では保存場所を選ぶ画面を出し、
// それ以外では通常のダウンロードとして保存する。
const PROJECT_FILE_APP = 'SuperDotEditor-KAI';
const PROJECT_FILE_EXT = '.dotkai.json';
const toastEl = document.getElementById('cloud-toast');
let toastTimer = null;
function showToast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', !!isError);
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 3000);
}

function projectFileName() {
  const art = window.getCurrentArtwork && window.getCurrentArtwork();
  const base = (art && art.name) || `dot-art_${cols}x${rows}`;
  return base.replace(/[\\/:*?"<>|]/g, '_') + PROJECT_FILE_EXT; // ファイル名に使えない文字は置き換える
}

async function saveProjectFile() {
  closeFileMenu();
  if (!started) return;
  const text = JSON.stringify({ app: PROJECT_FILE_APP, format: 1, project: serializeProject() });
  const name = projectFileName();
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'スーパードットエディター・改の作品', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      markProjectSaved();
      showToast(`「${handle.name}」に保存しました`);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // 保存先の選択をキャンセルした
      // それ以外で使えなかったときは、通常のダウンロードで保存する
    }
  }
  downloadText(name, text, 'application/json');
  markProjectSaved();
}

// 作品ファイルの中身を確かめて、読み込める形に整える（壊れたファイルや別のJSONならnull）
function sanitizeProjectFile(data) {
  const p = data && data.app === PROJECT_FILE_APP ? data.project : null;
  if (!p || !Array.isArray(p.layers) || !Number.isFinite(p.cols) || !Number.isFinite(p.rows)) return null;
  return {
    cols: Math.round(p.cols),
    rows: Math.round(p.rows),
    layers: p.layers.slice(0, 100).map(l => ({
      name: typeof l.name === 'string' ? l.name.slice(0, 50) : 'レイヤー',
      visible: l.visible !== false,
      opacity: typeof l.opacity === 'number' && l.opacity >= 0 && l.opacity <= 1 ? l.opacity : 1,
      locked: !!l.locked,
      // 色として使えない値は透明として扱う
      palette: Array.isArray(l.palette)
        ? l.palette.map(h => (typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : null))
        : [],
      data: typeof l.data === 'string' ? l.data : '',
    })),
  };
}

const projectFileInput = document.getElementById('project-file-input');
function openProjectFile() {
  closeFileMenu();
  projectFileInput.value = ''; // 同じファイルを続けて選んでも読み込まれるように
  projectFileInput.click();
}
projectFileInput.addEventListener('change', async () => {
  const file = projectFileInput.files[0];
  if (!file) return;
  let project = null;
  try {
    project = sanitizeProjectFile(JSON.parse(await file.text()));
  } catch (err) { /* JSONとして読めない */ }
  if (!project) {
    showToast('作品ファイルとして読み込めませんでした', true);
    return;
  }
  loadProjectData(project);
  if (window.clearCurrentArtwork) window.clearCurrentArtwork(); // クラウド作品との紐付けは外す
  markProjectSaved(); // 開いた直後は保存済みの状態。自動保存にも反映する
  showToast(`「${file.name}」を開きました`);
});

document.getElementById('btn-save-file').addEventListener('click', saveProjectFile);
document.getElementById('btn-open-file').addEventListener('click', openProjectFile);
document.getElementById('btn-start-open-file').addEventListener('click', openProjectFile);

function readAutosave() {
  try {
    const rec = JSON.parse(localStorage.getItem(AUTOSAVE_KEY));
    return rec && rec.project && Array.isArray(rec.project.layers) ? rec : null;
  } catch (err) {
    return null;
  }
}

const btnRestore = document.getElementById('btn-restore');

function setupRestoreButton() {
  const rec = readAutosave();
  if (!rec) return;
  document.getElementById('restore-time').textContent = new Date(rec.savedAt).toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  btnRestore.style.display = '';
  document.getElementById('btn-new').classList.remove('primary'); // 続きからを一番目立たせる
}

btnRestore.addEventListener('click', () => {
  const rec = readAutosave();
  if (!rec) return;
  try {
    loadProjectData(rec.project);
  } catch (err) {
    console.warn('自動保存データの復元に失敗しました', err);
    return;
  }
  // 開いていたクラウド作品の紐付け（上書き保存先）も戻す
  if (rec.artwork && window.setCurrentArtwork) window.setCurrentArtwork(rec.artwork.id, rec.artwork.name);
  hasUnsavedChanges = !!rec.unsaved;
});

window.addEventListener('beforeunload', e => {
  flushAutosave(true);
  if (started && hasUnsavedChanges) {
    e.preventDefault();
    e.returnValue = ''; // 古いブラウザ向け
  }
});
// スマホではbeforeunloadが来ないまま閉じられることがあるため、
// 画面が隠れた時点でも保存しておく
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAutosave(true);
});

// ── 参考画像ウィンドウ ────────────────────────────────
// キャンバスとは別に、画面上に参考画像を小さく浮かべて表示する。
// トレースと違って絵を描いても隠れない。
// ・ウィンドウ：ドラッグで移動、右下の角で幅と高さを別々に変更できる。
//   位置と大きさはこのブラウザに記憶する（画像そのものは容量が大きくなりうるため記憶しない）。
// ・画像：ピンチ（トラックパッド・2本指）やホイールで拡大縮小し、拡大中はドラッグで見る場所を動かせる。
//   ダブルクリックか、ヘッダーの倍率表示を押すと全体表示に戻る。
const refWindow = document.getElementById('ref-window');
const refBody = document.getElementById('ref-body');
const refImg = document.getElementById('ref-img');
const refEmpty = document.getElementById('ref-empty');
const refResize = document.getElementById('ref-resize');
const refFileInput = document.getElementById('ref-file-input');
const btnRefToggle = document.getElementById('btn-ref-toggle');
const btnRefFit = document.getElementById('btn-ref-fit');
const REF_GEOMETRY_KEY = 'pixelart-ref-window';
const REF_HEADER_H = 28;
const REF_MIN_W = 120;
const REF_MIN_BODY_H = 60;
const REF_DEFAULT_ASPECT = 4 / 3; // 画像を選ぶ前の枠の縦横比
const REF_MAX_ZOOM = 32;          // 全体表示に対する最大倍率

// x, y: ウィンドウ左上の画面座標、w, h: ウィンドウ全体の幅と高さ（ヘッダー込み）
let refGeom = null;
// 画像の表示状態。scale: 画像1pxあたりの画面上の大きさ、
// ox, oy: 表示領域の左上から見た画像の左上の位置、fitted: 全体表示中か
let refView = { scale: 1, ox: 0, oy: 0, fitted: true };

function loadRefGeometry() {
  try {
    const g = JSON.parse(localStorage.getItem(REF_GEOMETRY_KEY));
    if (g && [g.x, g.y, g.w].every(Number.isFinite)) {
      // 高さを記憶していない古い形式なら、幅から決める
      if (!Number.isFinite(g.h)) g.h = Math.round(g.w / REF_DEFAULT_ASPECT) + REF_HEADER_H;
      return g;
    }
  } catch (err) { /* 読めなければ既定の位置にする */ }
  const w = Math.min(240, Math.round(window.innerWidth * 0.6));
  return { x: window.innerWidth - w - 28, y: 100, w, h: Math.round(w / REF_DEFAULT_ASPECT) + REF_HEADER_H };
}

function saveRefGeometry() {
  try { localStorage.setItem(REF_GEOMETRY_KEY, JSON.stringify(refGeom)); } catch (err) { /* 記憶できなくても動作に支障はない */ }
}

// 画面からはみ出さないように大きさと位置を収めて反映する
function layoutRefWindow() {
  refGeom.w = Math.round(Math.max(REF_MIN_W, Math.min(window.innerWidth - 16, refGeom.w)));
  refGeom.h = Math.round(Math.max(REF_HEADER_H + REF_MIN_BODY_H, Math.min(window.innerHeight - 16, refGeom.h)));
  refGeom.x = Math.round(Math.max(0, Math.min(window.innerWidth - refGeom.w, refGeom.x)));
  refGeom.y = Math.round(Math.max(0, Math.min(window.innerHeight - refGeom.h, refGeom.y)));
  refWindow.style.left = refGeom.x + 'px';
  refWindow.style.top = refGeom.y + 'px';
  refWindow.style.width = refGeom.w + 'px';
  refWindow.style.height = refGeom.h + 'px';
  // 全体表示中はウィンドウに合わせて画像も伸び縮みさせ、拡大中は倍率を保つ
  if (refView.fitted || refView.scale < refFitScale()) fitRefView();
  else clampRefView();
  applyRefView();
}

// ── 画像の拡大縮小・移動 ──
function refFitScale() {
  if (!refSampleCtx) return 1;
  const { width: nw, height: nh } = refSampleCtx.canvas;
  return Math.min(refBody.clientWidth / nw, refBody.clientHeight / nh);
}

function fitRefView() {
  if (!refSampleCtx) return;
  const { width: nw, height: nh } = refSampleCtx.canvas;
  const s = refFitScale();
  refView = {
    scale: s,
    ox: (refBody.clientWidth - nw * s) / 2,
    oy: (refBody.clientHeight - nh * s) / 2,
    fitted: true,
  };
}

// 画像を表示領域から外へ逃がさない。表示領域より大きい向きはすき間ができない範囲、
// 小さい向きは領域内に収まる範囲に制限する（中央に固定すると、拡大の途中で
// カーソルの下の点がずれてしまうため、範囲内なら位置はそのまま保つ）。
function clampRefView() {
  if (!refSampleCtx) return;
  const clampAxis = (o, box, size) => {
    const a = box - size; // 大きい向きなら負、小さい向きなら正
    return Math.max(Math.min(0, a), Math.min(Math.max(0, a), o));
  };
  refView.ox = clampAxis(refView.ox, refBody.clientWidth, refSampleCtx.canvas.width * refView.scale);
  refView.oy = clampAxis(refView.oy, refBody.clientHeight, refSampleCtx.canvas.height * refView.scale);
}

function applyRefView() {
  if (!refSampleCtx) return;
  const { width: nw, height: nh } = refSampleCtx.canvas;
  refImg.style.width = nw * refView.scale + 'px';
  refImg.style.height = nh * refView.scale + 'px';
  refImg.style.transform = `translate(${refView.ox}px, ${refView.oy}px)`;
  // 拡大表示のときはぼかさずにドットをくっきり見せる
  refImg.style.imageRendering = refView.scale > 1 ? 'pixelated' : 'auto';
  refBody.classList.toggle('zoomed', !refView.fitted);
  btnRefFit.style.display = refView.fitted ? 'none' : '';
  btnRefFit.textContent = Math.round(refView.scale / refFitScale() * 100) + '%';
}

// 倍率を変える。(cx, cy)は表示領域内の基準点で、その下にある画像上の点が動かないようにする。
// 基準点を別の位置(tx, ty)へ移したいとき（2本指で拡大しながら動かす）はそれも指定する。
function setRefScale(newScale, cx, cy, base = refView, tx = cx, ty = cy) {
  const fit = refFitScale();
  const s = Math.max(fit, Math.min(fit * REF_MAX_ZOOM, newScale));
  refView = {
    scale: s,
    ox: tx - (cx - base.ox) * (s / base.scale),
    oy: ty - (cy - base.oy) * (s / base.scale),
    fitted: s <= fit * 1.001,
  };
  if (refView.fitted) fitRefView();
  else clampRefView();
  applyRefView();
}

function refBodyPoint(clientX, clientY) {
  const r = refBody.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

function setRefWindowOpen(open) {
  if (open) {
    if (!refGeom) refGeom = loadRefGeometry();
    refWindow.style.display = 'flex';
    layoutRefWindow();
  } else {
    refWindow.style.display = 'none';
  }
  btnRefToggle.classList.toggle('active', open);
  btnRefToggle.title = open ? '参考画像を閉じる' : '参考画像を表示';
}

function loadRefImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      refImg.src = img.src;
      refImg.style.display = '';
      refEmpty.style.display = 'none';
      refBody.classList.add('has-image');
      prepareRefSampling(img);
      // 新しい画像を開いたら、今の幅のまま画像の縦横比に合う高さにして全体表示する
      if (!refGeom) refGeom = loadRefGeometry();
      refGeom.h = Math.round(refGeom.w * img.naturalHeight / img.naturalWidth) + REF_HEADER_H;
      refView.fitted = true;
      // タイトルにファイル名を出す（textContentなのでHTMLとして解釈されない）
      refWindow.querySelector('.ref-title').textContent = file.name;
      refWindow.title = file.name;
      setRefWindowOpen(true);
      saveRefGeometry();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ── 参考画像からのスポイト ──
// スポイトツールを選んでいるときに参考画像をクリックすると、その位置の色を取る。
// 色を読むために、画像を原寸で作業用キャンバスに描いておく。
let refSampleCtx = null;

function prepareRefSampling(img) {
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  refSampleCtx = cv.getContext('2d', { willReadFrequently: true });
  refSampleCtx.drawImage(img, 0, 0);
}

// 画面座標 → 画像上の色（'#rrggbb'）。画像の外や透明な部分ならnull。
function refColorAt(clientX, clientY) {
  if (!refSampleCtx) return null;
  const { width: nw, height: nh } = refSampleCtx.canvas;
  const p = refBodyPoint(clientX, clientY);
  const x = Math.floor((p.x - refView.ox) / refView.scale);
  const y = Math.floor((p.y - refView.oy) / refView.scale);
  if (x < 0 || y < 0 || x >= nw || y >= nh) return null;
  const [r, g, b, a] = refSampleCtx.getImageData(x, y, 1, 1).data;
  if (a < 128) return null; // キャンバスのスポイトと同じく、透明な所では色を変えない
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function isRefPicking(e) {
  return currentTool === 'pick' && refSampleCtx && refBody.contains(e.target);
}

// スポイト中は、カーソルの下の色をステータスバーに表示する
refBody.addEventListener('pointermove', e => {
  if (currentTool !== 'pick') return;
  statColor.textContent = refColorAt(e.clientX, e.clientY) || '—';
  if (!refSampleCtx || e.pointerType !== 'mouse') return;
  // 拡大鏡には画像の原寸のピクセルを並べる
  const { width: nw, height: nh } = refSampleCtx.canvas;
  const p = refBodyPoint(e.clientX, e.clientY);
  const x = Math.floor((p.x - refView.ox) / refView.scale);
  const y = Math.floor((p.y - refView.oy) / refView.scale);
  if (x < 0 || y < 0 || x >= nw || y >= nh) { hidePickLoupe(); return; }
  const h = (LOUPE_CELLS - 1) / 2;
  const sx = Math.max(0, x - h), sy = Math.max(0, y - h);
  const sw = Math.min(nw, x + h + 1) - sx, sh = Math.min(nh, y + h + 1) - sy;
  const data = refSampleCtx.getImageData(sx, sy, sw, sh).data;
  showPickLoupe(e.clientX, e.clientY, (dx, dy) => {
    const ix = x + dx - sx, iy = y + dy - sy;
    if (ix < 0 || iy < 0 || ix >= sw || iy >= sh) return undefined;
    const k = (iy * sw + ix) * 4;
    if (data[k + 3] < 128) return null;
    return '#' + [data[k], data[k + 1], data[k + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
  });
});
refBody.addEventListener('pointerleave', () => {
  if (currentTool === 'pick') statColor.textContent = '—';
  hidePickLoupe();
});

btnRefToggle.addEventListener('click', () => {
  setRefWindowOpen(refWindow.style.display === 'none');
});
document.getElementById('btn-ref-close').addEventListener('click', () => setRefWindowOpen(false));
document.getElementById('btn-ref-change').addEventListener('click', () => refFileInput.click());
refFileInput.addEventListener('change', e => {
  loadRefImageFile(e.target.files[0]);
  refFileInput.value = ''; // 同じ画像をもう一度選んでも読み込めるようにする
});

function resetRefView() {
  fitRefView();
  applyRefView();
}
btnRefFit.addEventListener('click', resetRefView);
refBody.addEventListener('dblclick', () => { if (refSampleCtx) resetRefView(); });

refBody.addEventListener('dragover', e => { e.preventDefault(); refBody.classList.add('drag-over'); });
refBody.addEventListener('dragleave', () => refBody.classList.remove('drag-over'));
refBody.addEventListener('drop', e => {
  e.preventDefault();
  refBody.classList.remove('drag-over');
  loadRefImageFile(e.dataTransfer.files[0]);
});

// ホイール・トラックパッドのピンチで拡大縮小（カーソル位置を中心にする）。
// トラックパッドのピンチはCtrl付きの細かいホイールとして届くので感度を上げる。
refWindow.addEventListener('wheel', e => {
  e.preventDefault(); // ブラウザ自体の拡大（Ctrl+ホイール）を防ぐ
  if (!refSampleCtx) return;
  const unit = e.deltaMode === 1 ? 20 : 1;
  const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.002));
  const p = refBodyPoint(e.clientX, e.clientY);
  setRefScale(refView.scale * factor, p.x, p.y);
}, { passive: false });

// ── ウィンドウ上のドラッグ操作 ──
// 1本指（マウス）：拡大中の画像の上なら見る場所の移動、それ以外はウィンドウの移動。
// 2本指：画像の拡大縮小（ピンチ）と移動。
// 画像が未選択のときは、動かさずに離したら画像選択を開く。
const refPointers = new Map(); // pointerId → {x, y}
let refGesture = null;

function beginRefSingle(clientX, clientY, target) {
  const pan = refBody.contains(target) && refSampleCtx && !refView.fitted;
  refGesture = {
    mode: pan ? 'pan' : 'move',
    px: clientX, py: clientY,
    x: refGeom.x, y: refGeom.y, ox: refView.ox, oy: refView.oy,
    moved: false, target,
  };
}

function beginRefPinch() {
  const [a, b] = [...refPointers.values()];
  const c = refBodyPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
  refGesture = {
    mode: 'pinch',
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    cx: c.x, cy: c.y,
    base: { ...refView },
    moved: true,
  };
}

refWindow.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('button') || e.target === refResize) return;
  e.preventDefault();
  if (isRefPicking(e) && !refPointers.size) {
    // スポイト中は画像部分では移動せず色を取る（ヘッダーをつかめば移動できる）
    const color = refColorAt(e.clientX, e.clientY);
    if (color) setColor(color);
    return;
  }
  try { refWindow.setPointerCapture(e.pointerId); } catch (err) { /* 捕捉できなくても操作は続けられる */ }
  refPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (refPointers.size === 1) beginRefSingle(e.clientX, e.clientY, e.target);
  else if (refPointers.size === 2 && refSampleCtx) beginRefPinch();
});

refWindow.addEventListener('pointermove', e => {
  if (!refPointers.has(e.pointerId)) return;
  refPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = refGesture;
  if (!g) return;
  if (g.mode === 'pinch') {
    if (refPointers.size < 2) return;
    const [a, b] = [...refPointers.values()];
    const c = refBodyPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    // 開始時に指の中心にあった画像上の点を、今の指の中心へ合わせる
    setRefScale(g.base.scale * dist / g.dist, g.cx, g.cy, g.base, c.x, c.y);
    return;
  }
  const dx = e.clientX - g.px, dy = e.clientY - g.py;
  if (!g.moved && Math.abs(dx) + Math.abs(dy) < 4) return; // 小さな手ぶれはクリック扱い
  g.moved = true;
  if (g.mode === 'pan') {
    refView.ox = g.ox + dx;
    refView.oy = g.oy + dy;
    clampRefView();
    applyRefView();
  } else if (g.mode === 'move') {
    refGeom.x = g.x + dx;
    refGeom.y = g.y + dy;
    layoutRefWindow();
  }
});

function endRefPointer(e) {
  if (!refPointers.has(e.pointerId)) return;
  refPointers.delete(e.pointerId);
  const g = refGesture;
  if (refPointers.size === 1 && g && g.mode === 'pinch') {
    // ピンチの途中で1本離したら、残った指では拡大中の画像の移動だけを続ける
    // （いきなりウィンドウが動き出さないようにする）
    const [p] = [...refPointers.values()];
    beginRefSingle(p.x, p.y, refBody);
    if (refGesture.mode !== 'pan') refGesture.mode = 'none';
    refGesture.moved = true;
    return;
  }
  if (refPointers.size) return;
  refGesture = null;
  if (!g) return;
  if (g.mode === 'move' && g.moved) saveRefGeometry();
  else if (!g.moved && refEmpty.style.display !== 'none' && refBody.contains(g.target)) refFileInput.click();
}
refWindow.addEventListener('pointerup', endRefPointer);
refWindow.addEventListener('pointercancel', endRefPointer);

// 右下のつまみで大きさを変える（左上の位置は固定し、幅と高さは別々に動かせる）
refResize.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const start = { px: e.clientX, py: e.clientY, w: refGeom.w, h: refGeom.h };
  refResize.setPointerCapture(e.pointerId);
  const onMove = ev => {
    // 画面の右端・下端を越えて広げた分は、ウィンドウを動かさずに切り捨てる
    refGeom.w = Math.min(start.w + ev.clientX - start.px, window.innerWidth - refGeom.x);
    refGeom.h = Math.min(start.h + ev.clientY - start.py, window.innerHeight - refGeom.y);
    layoutRefWindow();
  };
  const onUp = () => {
    refResize.removeEventListener('pointermove', onMove);
    refResize.removeEventListener('pointerup', onUp);
    refResize.removeEventListener('pointercancel', onUp);
    saveRefGeometry();
  };
  refResize.addEventListener('pointermove', onMove);
  refResize.addEventListener('pointerup', onUp);
  refResize.addEventListener('pointercancel', onUp);
});

window.addEventListener('resize', () => {
  if (refWindow.style.display !== 'none') layoutRefWindow();
});

// ── パレットの切り出し ──
// 「カラー」「カスタムカラー」の見出しの右のボタンを押すと、中身（.popout-body）を画面上の小窓に移す。
// 小窓は見出しをつかんで動かし、右下のつまみで幅を変えられる。もう一度ボタンを押すか、小窓の ✕ でパネルに戻る。
// 位置・幅・切り出しているかどうかは、次に開いたときのために覚えておく。
const FLOAT_PALETTE_KEY = 'pixelart-float-palettes';
const FLOAT_PALETTE_MIN_W = 160;
let floatPaletteState = {}; // key → {open, x, y, w}
try {
  floatPaletteState = JSON.parse(localStorage.getItem(FLOAT_PALETTE_KEY)) || {};
} catch (err) { /* 読めなければ何も覚えていない状態から始める */ }
function saveFloatPalettes() {
  try { localStorage.setItem(FLOAT_PALETTE_KEY, JSON.stringify(floatPaletteState)); } catch (err) { /* 記憶できなくても動作に支障はない */ }
}

const floatPalettes = {}; // key → {section, body, btn, win, winBody}

// パレットから開くモーダルは、左パネルの中にあると切り出した小窓より奥に出てしまうため、パネルの外へ出しておく
['palette-export-modal', 'color-pick-modal', 'confirm-delete-all'].forEach(id => {
  document.body.appendChild(document.getElementById(id));
});

function layoutFloatPalette(fp) {
  const g = floatPaletteState[fp.key];
  g.w = Math.round(Math.max(FLOAT_PALETTE_MIN_W, Math.min(window.innerWidth - 16, g.w)));
  fp.win.style.width = g.w + 'px';
  const h = fp.win.offsetHeight;
  g.x = Math.round(Math.max(0, Math.min(window.innerWidth - g.w, g.x)));
  g.y = Math.round(Math.max(0, Math.min(window.innerHeight - h, g.y)));
  fp.win.style.left = g.x + 'px';
  fp.win.style.top = g.y + 'px';
}

// 最後に触った小窓をもう一方より手前に出す
function bringFloatPaletteToFront(fp) {
  Object.values(floatPalettes).forEach(o => o.win.classList.toggle('front', o === fp));
}

function setPalettePoppedOut(key, out) {
  const fp = floatPalettes[key];
  if (out) {
    if (!floatPaletteState[key] || floatPaletteState[key].w == null) {
      // 初めて切り出すときは、パネルのすぐ右、パネルにあったのと同じ高さに置く
      const r = fp.section.getBoundingClientRect();
      const panelRight = document.getElementById('panel').getBoundingClientRect().right;
      floatPaletteState[key] = { x: Math.max(panelRight, 0) + 12, y: r.top, w: Math.max(r.width - 8, FLOAT_PALETTE_MIN_W) };
    }
    fp.winBody.appendChild(fp.body);
    fp.win.style.display = 'flex';
    layoutFloatPalette(fp);
    bringFloatPaletteToFront(fp);
  } else {
    fp.section.appendChild(fp.body);
    fp.win.style.display = 'none';
  }
  floatPaletteState[key].open = out;
  fp.section.classList.toggle('popped-out', out);
  fp.btn.classList.toggle('active', out);
  fp.btn.title = out ? 'パネルに戻す' : 'パネルから切り出して、画面の好きな場所に置く';
  saveFloatPalettes();
}

document.querySelectorAll('.panel-section[data-popout]').forEach(section => {
  const key = section.dataset.popout;
  const win = document.createElement('div');
  win.className = 'float-palette';
  win.style.display = 'none';
  win.innerHTML = `
    <div class="ref-header">
      <span class="ref-title"></span>
      <button class="ref-header-btn" title="パネルに戻す">✕</button>
    </div>
    <div class="float-palette-body"></div>
    <div class="float-palette-resize" title="ドラッグで幅を変更"></div>`;
  win.querySelector('.ref-title').textContent = section.dataset.popoutTitle;
  document.body.appendChild(win);
  const fp = {
    key, section, win,
    body: section.querySelector('.popout-body'),
    btn: section.querySelector('.popout-btn'),
    winBody: win.querySelector('.float-palette-body'),
  };
  floatPalettes[key] = fp;

  fp.btn.addEventListener('click', () => setPalettePoppedOut(key, !section.classList.contains('popped-out')));
  win.querySelector('.ref-header-btn').addEventListener('click', () => setPalettePoppedOut(key, false));
  win.addEventListener('pointerdown', () => bringFloatPaletteToFront(fp));

  // 見出しをつかんで動かす
  const header = win.querySelector('.ref-header');
  header.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const g = floatPaletteState[key];
    const start = { px: e.clientX, py: e.clientY, x: g.x, y: g.y };
    header.setPointerCapture(e.pointerId);
    const onMove = ev => {
      g.x = start.x + ev.clientX - start.px;
      g.y = start.y + ev.clientY - start.py;
      layoutFloatPalette(fp);
    };
    const onUp = () => {
      header.removeEventListener('pointermove', onMove);
      header.removeEventListener('pointerup', onUp);
      header.removeEventListener('pointercancel', onUp);
      saveFloatPalettes();
    };
    header.addEventListener('pointermove', onMove);
    header.addEventListener('pointerup', onUp);
    header.addEventListener('pointercancel', onUp);
  });

  // 右下のつまみで幅を変える（色の四角は幅に合わせて大きくなる）
  const grip = win.querySelector('.float-palette-resize');
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = floatPaletteState[key];
    const start = { px: e.clientX, w: g.w };
    grip.setPointerCapture(e.pointerId);
    const onMove = ev => {
      g.w = Math.min(start.w + ev.clientX - start.px, window.innerWidth - g.x);
      layoutFloatPalette(fp);
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      saveFloatPalettes();
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
});

// 前回切り出していたパレットは、また切り出した状態で始める（タブレットは色パネルがあるので切り出さない）
function restoreFloatPalettes() {
  if (tabletUI) return;
  for (const key in floatPalettes) {
    if (floatPaletteState[key] && floatPaletteState[key].open) setPalettePoppedOut(key, true);
  }
}

window.addEventListener('resize', () => {
  Object.values(floatPalettes).forEach(fp => {
    if (fp.win.style.display !== 'none') layoutFloatPalette(fp);
  });
});

// ── 長押しでボタンの説明を出す（スマホ・タブレット） ──
// パソコンではマウスを乗せると title の説明が出るが、タッチでは出ないため、
// ボタンを長押ししたら title の内容を吹き出しで出す。長押しした後に離しても、押したことにはしない。
// 押している間だけ働くボタン（👁 など）は data-no-tip で外す。
const TIP_PRESS_MS = 500;
const touchTip = document.createElement('div');
touchTip.className = 'touch-tip';
touchTip.style.display = 'none';
document.body.appendChild(touchTip);
let tipPress = null;      // 押している途中 {target, x, y, timer, shown}
let tipHideTimer = null;
let tipSuppressClick = null; // 長押しの後に来るクリックを止める {target, until}

function hideTouchTip() {
  clearTimeout(tipHideTimer);
  touchTip.style.display = 'none';
}

function showTouchTip(target) {
  const text = target.getAttribute('title');
  if (!text) return false;
  touchTip.textContent = text;
  touchTip.style.display = 'block';
  // ボタンの上に出す。上に場所が無ければ下に出し、左右は画面からはみ出さないようにする
  const r = target.getBoundingClientRect();
  const w = touchTip.offsetWidth, h = touchTip.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  touchTip.style.left = left + 'px';
  touchTip.style.top = top + 'px';
  return true;
}

document.addEventListener('pointerdown', e => {
  hideTouchTip();
  tipSuppressClick = null;
  if (e.pointerType === 'mouse') return;
  const target = e.target.closest('button[title], .color-dot[title]');
  if (!target || target.closest('[data-no-tip]')) return;
  const press = { target, x: e.clientX, y: e.clientY, shown: false };
  press.timer = setTimeout(() => { press.shown = showTouchTip(target); }, TIP_PRESS_MS);
  tipPress = press;
}, true);

document.addEventListener('pointermove', e => {
  // 指がずれたら（スクロールなど）長押しではない
  if (tipPress && !tipPress.shown && Math.hypot(e.clientX - tipPress.x, e.clientY - tipPress.y) > 10) {
    clearTimeout(tipPress.timer);
    tipPress = null;
  }
}, true);

['pointerup', 'pointercancel'].forEach(type => {
  document.addEventListener(type, () => {
    if (!tipPress) return;
    clearTimeout(tipPress.timer);
    if (tipPress.shown) {
      tipSuppressClick = { target: tipPress.target, until: performance.now() + 800 };
      tipHideTimer = setTimeout(hideTouchTip, 2500); // 読めるよう、離した後もしばらく出しておく
    }
    tipPress = null;
  }, true);
});

document.addEventListener('click', e => {
  const s = tipSuppressClick;
  if (!s || performance.now() > s.until || !s.target.contains(e.target)) return;
  tipSuppressClick = null;
  e.preventDefault();
  e.stopPropagation();
}, true);

// スマホの長押しメニューを出さない（説明を出している所だけ）
document.addEventListener('contextmenu', e => {
  if (tipPress || touchTip.style.display !== 'none') e.preventDefault();
}, true);

// ── 起動 ─────────────────────────────────────────────
buildPalette();
buildCustomPalette();
buildConvertPalette();
restoreFloatPalettes();
setColor('#3a3a38');
setupRestoreButton();
initCells(cols, rows, false);
resizeCanvases();
syncTogglePosition();
updateColorHistoryPos();
// 初期表示でもキャンバスを中央に配置する。読み込み直後はレイアウトが
// 確定しきっていないことがあるため、タスクを分けて余白を再計算してから
// 中央へスクロールする。requestAnimationFrameは非表示タブで発火しないため
// 使わない（バックグラウンドで開かれた場合に中央にならなくなる）。
function centerCanvasOnBoot() {
  updateScrollPadding();
  centerCanvas();
}
setTimeout(centerCanvasOnBoot, 0);
window.addEventListener('load', centerCanvasOnBoot);
