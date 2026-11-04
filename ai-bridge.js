// ── AI との接続（MCP の橋渡し mcp/server.js とつなぐ） ─────────
// AI のアプリ（Claude のデスクトップアプリなど）が起動した橋渡しのプログラムと、
// パソコンの中だけの WebSocket（127.0.0.1）でつながり、AI からの命令（ドットを置く・今の絵を見る…）を
// エディタの機能で実行して答えを返す。AI の操作は1回ごとに「元に戻す」で取り消せる。
// 「ファイル ▸ AI に描いてもらう」の画面で「つなぐ」を押すまでは何もしない。
// つないでいる間だけ、ヘッダーに状態のボタンを出す（URL に ?ai を付けて開くと、最初からつなぐ）。
// script.js・anim.js のグローバルを使うため、それらの後に読み込むこと。
(() => {
  const params = new URLSearchParams(location.search);

  // mcp/server.js と合わせる。?ai=17322 のように番号を付けると、そのポートにつなぐ（試すとき用）
  const PORT = /^\d{4,5}$/.test(params.get('ai') || '') ? Number(params.get('ai')) : 17321;
  // つなぎ直す間隔。つながらない間は少しずつ延ばす（失敗のたびにブラウザが記録を出すため）
  const RETRY_MS = 3000, RETRY_MAX_MS = 10000;
  let retryMs = RETRY_MS;
  const ENABLED_KEY = 'pixelart-ai-bridge-on';
  const MAX_PIXEL_READ = 64;        // get_pixels で一度に読める大きさ
  const LEGEND_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&*+=?@';

  // ── ヘッダーのボタン ──
  const btn = document.createElement('button');
  btn.id = 'btn-ai-bridge';
  btn.className = 'ai-bridge-btn';
  document.getElementById('file-menu').before(btn);

  let enabled = false;
  let ws = null;
  let retryTimer = null;
  let state = 'off'; // 'off' | 'waiting' | 'connected'

  // 「ファイル ▸ AI に描いてもらう」の画面
  const modal = document.getElementById('ai-connect-modal');
  const modalStatus = document.getElementById('ai-connect-status');
  const modalBtn = document.getElementById('btn-ai-connect');
  const STATUS_TEXT = {
    off: 'つないでいません',
    waiting: '待機中：AI のアプリで橋渡しのプログラムが起動するのを待っています',
    connected: 'つながっています。AI のチャットで描いてほしいものを頼んでください',
  };

  function setState(s) {
    state = s;
    btn.dataset.state = s;
    btn.style.display = s === 'off' ? 'none' : ''; // つないでいない間はヘッダーに出さない
    btn.textContent = s === 'connected' ? '🤖 AI 接続中' : '🤖 AI 待機中…';
    btn.title = s === 'connected'
      ? 'AI とつながっています（押すと切ります）'
      : 'AI のアプリで、このエディタの道具（MCP）が起動するのを待っています（押すとやめます）';
    modalStatus.textContent = STATUS_TEXT[s];
    modalStatus.dataset.state = s;
    modalBtn.textContent = s === 'off' ? 'つなぐ' : '切る';
  }

  function connect() {
    clearTimeout(retryTimer);
    if (!enabled) return;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    } catch (err) {
      retryTimer = setTimeout(connect, retryMs);
      return;
    }
    ws.onopen = () => {
      retryMs = RETRY_MS;
      setState('connected');
      ws.send(JSON.stringify({ type: 'hello', cols, rows }));
    };
    ws.onmessage = e => handleMessage(e.data);
    ws.onclose = () => {
      ws = null;
      if (!enabled) return;
      // 橋渡しのプログラムがまだ動いていない・AI のアプリを閉じた → 少し待ってからつなぎ直す
      setState('waiting');
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(RETRY_MAX_MS, retryMs + 1000);
    };
    ws.onerror = () => {}; // つなげないときは onclose でつなぎ直す
  }

  function setEnabled(on) {
    enabled = on;
    try { sessionStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch (err) { /* 覚えられなくても使える */ }
    clearTimeout(retryTimer);
    if (on) {
      setState('waiting');
      retryMs = RETRY_MS;
      connect();
    } else {
      if (ws) ws.close();
      ws = null;
      setState('off');
    }
  }
  btn.addEventListener('click', () => setEnabled(!enabled));
  modalBtn.addEventListener('click', () => setEnabled(!enabled));
  document.getElementById('btn-menu-ai').addEventListener('click', () => {
    closeFileMenu();
    modal.style.display = 'flex';
  });
  document.getElementById('btn-ai-connect-close').addEventListener('click', () => { modal.style.display = 'none'; });
  setState('off');
  let resume = params.has('ai');
  try { if (sessionStorage.getItem(ENABLED_KEY) === '1') resume = true; } catch (err) { /* 読めなければ ?ai だけを見る */ }
  if (resume) setEnabled(true);

  // ── 命令の実行 ──
  async function handleMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (err) { return; }
    if (msg.id === undefined) return;
    let reply;
    try {
      const fn = HANDLERS[msg.method];
      if (!fn) throw new Error(`Unknown command: ${msg.method}`);
      if (!started) startEditor(); // スタート画面のままなら白紙で始める
      reply = { id: msg.id, result: await fn(msg.params || {}) };
      flash();
    } catch (err) {
      reply = { id: msg.id, error: String(err.message || err) };
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  }

  // AI が何かしたことが分かるよう、ボタンを一瞬光らせる
  let flashTimer = null;
  function flash() {
    btn.classList.add('busy');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => btn.classList.remove('busy'), 500);
  }

  // ── 共通の小道具 ──
  function parseColor(v) {
    if (v === 'transparent' || v === null) return null;
    if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())) return v.trim().toLowerCase();
    throw new Error(`Bad color "${v}". Use "#rrggbb" or "transparent".`);
  }
  const inBounds = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < cols && y < rows;

  // 今のレイヤーに描く。1回の命令＝1回の「元に戻す」
  function editActiveLayer(fn) {
    if (activeLayerLocked()) throw new Error('The active layer is locked. Unlock it or select another layer.');
    pushHistory();
    let changed = 0, outside = 0;
    const put = (x, y, color) => {
      if (!inBounds(x, y)) { outside++; return; }
      if (cells[y][x] !== color) { cells[y][x] = color; changed++; }
    };
    fn(put);
    drawCells();
    updateLayerThumbnails();
    return { text: `Changed ${changed} pixel(s) on layer "${layers[activeLayerIndex].name}".`
      + (outside ? ` ${outside} pixel(s) were outside the ${cols}x${rows} canvas and were skipped.` : '') };
  }

  function canvasInfo() {
    frames[currentFrame].active = activeLayerIndex;
    return {
      cols, rows,
      layers: layers.map((l, i) => ({ index: i, name: l.name, visible: l.visible, opacity: l.opacity, locked: !!l.locked })),
      activeLayer: activeLayerIndex,
      frames: frames.length,
      currentFrame,
      fps: animFps,
      currentColor,
      customPalette: customColors.filter(Boolean),
      note: 'x = column, y = row, 0-based from the top-left. Layer index 0 is the bottom layer.',
    };
  }

  // ── 命令ごとの処理（名前は mcp/server.js の道具の名前と同じ） ──
  const HANDLERS = {
    get_canvas_info: () => ({ text: JSON.stringify(canvasInfo(), null, 1) }),

    get_canvas_image: ({ grid = false, layer = 'all' }) => {
      // 長い辺が512px前後になるよう、ドットのまま拡大する
      const scale = Math.max(1, Math.min(32, Math.floor(512 / Math.max(cols, rows))));
      const cv = document.createElement('canvas');
      cv.width = cols * scale;
      cv.height = rows * scale;
      const ctx = cv.getContext('2d');
      // 透明な所が分かるよう、1ドットごとの市松模様を敷く
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          ctx.fillStyle = (x + y) % 2 ? '#e4e4e4' : '#f7f7f7';
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
      ctx.imageSmoothingEnabled = false;
      if (layer === 'active') {
        ctx.drawImage(getLayerCanvas(layers[activeLayerIndex], true), 0, 0, cv.width, cv.height);
      } else {
        ctx.drawImage(compositeCanvas(), 0, 0, cv.width, cv.height);
      }
      if (grid && scale >= 4) {
        // 1ドットごとに薄い線、8ドットごとに少し濃い線（数えやすいように）
        for (let i = 0; i <= Math.max(cols, rows); i++) {
          ctx.fillStyle = i % 8 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.12)';
          if (i <= cols) ctx.fillRect(i * scale, 0, 1, cv.height);
          if (i <= rows) ctx.fillRect(0, i * scale, cv.width, 1);
        }
      }
      return {
        image: cv.toDataURL('image/png').split(',')[1],
        text: `${cols}x${rows} pixels shown at ${scale}x (${layer === 'active' ? 'active layer only' : 'all visible layers'}). `
          + 'Transparent pixels are shown as a light checkerboard.' + (grid && scale >= 4 ? ' Darker grid lines every 8 pixels.' : ''),
      };
    },

    get_pixels: ({ x, y, width, height }) => {
      const w = Math.min(MAX_PIXEL_READ, width), h = Math.min(MAX_PIXEL_READ, height);
      if (!(w > 0 && h > 0)) throw new Error('width and height must be at least 1');
      const legend = {};
      const charOf = new Map();
      const out = [];
      for (let yy = y; yy < y + h; yy++) {
        let row = '';
        for (let xx = x; xx < x + w; xx++) {
          if (!inBounds(xx, yy)) { row += ' '; continue; }
          const v = cells[yy][xx];
          if (!v) { row += '.'; continue; }
          let ch = charOf.get(v);
          if (!ch) {
            if (charOf.size >= LEGEND_CHARS.length) throw new Error('Too many colors in this area. Read a smaller rectangle.');
            ch = LEGEND_CHARS[charOf.size];
            charOf.set(v, ch);
            legend[ch] = v;
          }
          row += ch;
        }
        out.push(row);
      }
      return { text: JSON.stringify({ x, y, width: w, height: h, legend, rows: out, note: '"." = transparent, space = outside the canvas' }, null, 1) };
    },

    set_canvas_size: ({ cols: c, rows: r }) => {
      if (!(Number.isInteger(c) && Number.isInteger(r) && c >= 4 && r >= 4 && c <= MAX_GRID && r <= MAX_GRID)) {
        throw new Error(`cols and rows must be integers from 4 to ${MAX_GRID}`);
      }
      pushFramesHistory();
      initCells(c, r, true);
      resizeCanvases();
      syncSlidersToGrid();
      fitCanvasToView();
      centerCanvas();
      return { text: `Canvas is now ${cols}x${rows}.` };
    },

    draw_pixel_map: ({ x, y, rows: mapRows, legend }) => {
      if (!Array.isArray(mapRows)) throw new Error('rows must be an array of strings');
      const colors = {};
      for (const [ch, v] of Object.entries(legend || {})) {
        if ([...ch].length !== 1) throw new Error(`Legend keys must be single characters (got "${ch}")`);
        colors[ch] = parseColor(v);
      }
      return editActiveLayer(put => {
        mapRows.forEach((line, dy) => {
          [...String(line)].forEach((ch, dx) => {
            if (ch === '.' || ch === ' ' || !(ch in colors)) return;
            put(x + dx, y + dy, colors[ch]);
          });
        });
      });
    },

    draw_pixels: ({ pixels }) => {
      if (!Array.isArray(pixels)) throw new Error('pixels must be an array');
      const list = pixels.map(p => [p.x, p.y, parseColor(p.color)]);
      return editActiveLayer(put => list.forEach(([px, py, c]) => put(px, py, c)));
    },

    draw_rect: ({ x, y, width, height, color, filled = true }) => {
      const c = parseColor(color);
      return editActiveLayer(put => {
        for (let yy = y; yy < y + height; yy++) {
          for (let xx = x; xx < x + width; xx++) {
            const edge = yy === y || yy === y + height - 1 || xx === x || xx === x + width - 1;
            if (filled || edge) put(xx, yy, c);
          }
        }
      });
    },

    draw_line: ({ x1, y1, x2, y2, color }) => {
      const c = parseColor(color);
      return editActiveLayer(put => {
        put(x1, y1, c);
        for (const p of interpolateCells(x1, y1, x2, y2)) put(p.col, p.row, c);
      });
    },

    flood_fill: ({ x, y, color }) => {
      const c = parseColor(color);
      if (!inBounds(x, y)) throw new Error(`(${x}, ${y}) is outside the ${cols}x${rows} canvas`);
      return editActiveLayer(put => {
        const target = cells[y][x];
        if (target === c) return;
        const seen = new Uint8Array(cols * rows);
        const stack = [[x, y]];
        while (stack.length) {
          const [cx, cy] = stack.pop();
          if (!inBounds(cx, cy) || seen[cy * cols + cx] || cells[cy][cx] !== target) continue;
          seen[cy * cols + cx] = 1;
          put(cx, cy, c);
          stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
      });
    },

    clear_layer: () => editActiveLayer(put => {
      for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < cols; xx++) put(xx, yy, null);
    }),

    add_layer: ({ name }) => {
      pushHistory();
      addLayerAboveActive();
      if (name) layers[activeLayerIndex].name = String(name).slice(0, 20);
      drawCells();
      updateLayerPanel();
      return { text: `Added layer "${layers[activeLayerIndex].name}" (index ${activeLayerIndex}) and made it active.` };
    },

    select_layer: ({ index }) => {
      if (!(Number.isInteger(index) && index >= 0 && index < layers.length)) throw new Error(`Layer index must be 0..${layers.length - 1}`);
      activeLayerIndex = index;
      syncActiveCells();
      updateLayerPanel();
      return { text: `Layer "${layers[index].name}" (index ${index}) is now active.` };
    },

    set_layer: ({ index, name, visible, opacity }) => {
      const l = layers[index];
      if (!l) throw new Error(`Layer index must be 0..${layers.length - 1}`);
      pushHistory();
      if (typeof name === 'string' && name.trim()) l.name = name.trim().slice(0, 20);
      if (typeof visible === 'boolean') l.visible = visible;
      if (typeof opacity === 'number') l.opacity = Math.max(0, Math.min(1, opacity));
      drawCells();
      updateLayerPanel();
      return { text: `Layer ${index}: name "${l.name}", visible ${l.visible}, opacity ${l.opacity}.` };
    },

    add_frame: ({ copy = true }) => {
      if (copy) window.animApi.duplicateFrame(); else window.animApi.addEmptyFrame();
      window.animApi.openTimeline();
      return { text: `Added frame ${currentFrame} (${copy ? 'copy of the previous frame' : 'empty'}). Now ${frames.length} frames; the new frame is current.` };
    },

    select_frame: ({ index }) => {
      if (!(Number.isInteger(index) && index >= 0 && index < frames.length)) throw new Error(`Frame index must be 0..${frames.length - 1}`);
      window.animApi.selectFrame(index);
      return { text: `Frame ${index} is now current.` };
    },

    set_animation_speed: ({ fps, frame_ms }) => {
      const notes = [];
      if (fps !== undefined) {
        animFps = Math.max(1, Math.min(MAX_FPS, Math.round(fps)));
        document.getElementById('anim-fps').value = animFps;
        markChanged();
        notes.push(`fps = ${animFps}`);
      }
      if (frame_ms !== undefined) {
        pushFramesHistory();
        if (frame_ms > 0) frames[currentFrame].delay = Math.max(MIN_FRAME_DELAY, Math.min(MAX_FRAME_DELAY, Math.round(frame_ms / 10) * 10));
        else delete frames[currentFrame].delay;
        window.onFramesChanged();
        notes.push(`frame ${currentFrame} display time = ${frames[currentFrame].delay ? frames[currentFrame].delay + ' ms' : 'follows fps'}`);
      }
      return { text: notes.join(', ') || 'Nothing changed.' };
    },

    undo: () => {
      if (!history.length) return { text: 'Nothing to undo.' };
      undo();
      return { text: 'Undid the last change.' };
    },

    // 書き出し用の PNG を作る（ファイルへの保存は mcp/server.js が行う）
    export_png: ({ frames: which = 'current', layout = 'sheet', columns, scale = 1, background = 'transparent' }) => {
      const s = Math.max(1, Math.min(16, Math.round(scale) || 1));
      const fw = cols * s, fh = rows * s;
      frames[currentFrame].active = activeLayerIndex;
      const list = which === 'all' ? frames.map((_, i) => i) : [currentFrame];
      const draw = (ctx, i, ox, oy) => {
        if (background === 'white') { ctx.fillStyle = '#ffffff'; ctx.fillRect(ox, oy, fw, fh); }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(frameCanvas(frames[i]), 0, 0, cols, rows, ox, oy, fw, fh);
      };
      const toB64 = cv => cv.toDataURL('image/png').split(',')[1];
      const durationsMs = list.map(i => Math.round(frames[i].delay || 1000 / animFps));
      const info = { frameWidth: fw, frameHeight: fh, frameCount: list.length, scale: s, fps: animFps, durationsMs };
      if (layout === 'sequence') {
        const images = list.map(i => {
          const cv = document.createElement('canvas');
          cv.width = fw; cv.height = fh;
          draw(cv.getContext('2d'), i, 0, 0);
          return toB64(cv);
        });
        return { ...info, images, columns: 1, rows: 1 };
      }
      // スプライトシート：左から右へ、columns ごとに折り返す
      const ncol = Math.max(1, Math.min(list.length, Math.round(columns) || list.length));
      const nrow = Math.ceil(list.length / ncol);
      if (fw * ncol > 8192 || fh * nrow > 8192) throw new Error('The sheet would be larger than 8192px. Use a smaller scale, more rows (columns), or layout "sequence".');
      const cv = document.createElement('canvas');
      cv.width = fw * ncol; cv.height = fh * nrow;
      const ctx = cv.getContext('2d');
      list.forEach((fi, k) => draw(ctx, fi, (k % ncol) * fw, Math.floor(k / ncol) * fh));
      return { ...info, images: [toB64(cv)], columns: ncol, rows: nrow };
    },
  };

  // あるコマの絵（見えているレイヤーを不透明度込みで重ねた色）を、1ドット＝1ピクセルで描いたキャンバス。
  // PNG保存（compositeAt）と同じ重ね方にする
  function frameCanvas(frame) {
    const cv = document.createElement('canvas');
    cv.width = cols; cv.height = rows;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cols, rows);
    const px = new Uint32Array(img.data.buffer);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let out = null;
        for (const l of frame.layers) {
          if (!l.visible || l.opacity <= 0) continue;
          const v = l.cells[y] && l.cells[y][x];
          if (v) out = blendHex(out, v, l.opacity);
        }
        if (out) px[y * cols + x] = hexToU32(out);
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }
})();
