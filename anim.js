// ── アニメーション（コマ）とGIF保存 ─────────────────────
// 画面の下のコマの一覧（タイムライン）で、コマの追加・複製・削除・並べ替え・再生をし、
// 全部のコマを1つのGIFとして保存する。各コマはそれぞれのレイヤー一式を持つ。
// コマのデータ（frames・currentFrame・animFps）と、元に戻す・作品ファイルへの保存は script.js が持ち、
// ここは画面と操作、GIFの作成を受け持つ。script.js のグローバルを使うため、script.js の後に読み込むこと。
(() => {
  const timeline = document.getElementById('timeline');
  const framesEl = document.getElementById('timeline-frames');
  const frameLabel = document.getElementById('timeline-frame-label');
  const btnToggle = document.getElementById('btn-toggle-timeline');
  const btnPlay = document.getElementById('btn-anim-play');
  const fpsInput = document.getElementById('anim-fps');
  const btnDup = document.getElementById('btn-frame-dup');
  const btnNew = document.getElementById('btn-frame-new');
  const btnLeft = document.getElementById('btn-frame-left');
  const btnRight = document.getElementById('btn-frame-right');
  const btnDelete = document.getElementById('btn-frame-delete');
  const delayInput = document.getElementById('frame-delay');
  const btnOnion = document.getElementById('btn-onion');
  const THUMB_MAX = 56; // コマの一覧の小さな絵の、長い辺の大きさ
  let thumbs = [];      // コマの一覧の小さな絵（frames と同じ並び）

  // ── コマの切り替え ──
  // playing: 再生中の切り替え（レイヤーの一覧は止めたときにまとめて描き直す）
  function switchFrame(i, playing = false) {
    if (i === currentFrame || i < 0 || i >= frames.length) return;
    if (isPainting || moveDrag) return;
    frames[currentFrame].active = activeLayerIndex;
    currentFrame = i;
    layers = frames[i].layers;
    activeLayerIndex = frames[i].active;
    syncActiveCells();
    drawCells();
    if (!playing) {
      updateLayerPanel();
      drawOnionSkin();
    }
    markCurrent();
  }

  // ── コマの操作（どれも元に戻せる） ──
  function insertFrame(frame) {
    stopPlayback();
    pushFramesHistory();
    frames[currentFrame].active = activeLayerIndex;
    frames.splice(currentFrame + 1, 0, frame);
    currentFrame++;
    layers = frame.layers;
    activeLayerIndex = frame.active;
    syncActiveCells();
    drawCells();
    updateLayerPanel();
    renderTimeline();
  }

  // 今のコマを複製して、すぐ後ろに入れる（少しずつ動かして描くときの基本）
  function duplicateFrame() {
    insertFrame({
      layers: layers.map(l => ({ ...l, cells: l.cells.map(r => [...r]) })),
      active: activeLayerIndex,
      ...(frames[currentFrame].delay ? { delay: frames[currentFrame].delay } : {}),
    });
  }

  // 今のコマと同じレイヤーの並び（名前・表示・不透明度）で、中身が空のコマを入れる
  function addEmptyFrame() {
    insertFrame({
      layers: layers.map(l => ({ ...makeLayer(l.name), visible: l.visible, opacity: l.opacity })),
      active: activeLayerIndex,
    });
  }

  function deleteFrame() {
    if (frames.length <= 1) return;
    stopPlayback();
    pushFramesHistory();
    frames.splice(currentFrame, 1);
    currentFrame = Math.min(currentFrame, frames.length - 1);
    layers = frames[currentFrame].layers;
    activeLayerIndex = frames[currentFrame].active;
    syncActiveCells();
    drawCells();
    updateLayerPanel();
    renderTimeline();
  }

  function moveFrame(dir) {
    const to = currentFrame + dir;
    if (to < 0 || to >= frames.length) return;
    stopPlayback();
    pushFramesHistory();
    frames[currentFrame].active = activeLayerIndex;
    [frames[currentFrame], frames[to]] = [frames[to], frames[currentFrame]];
    currentFrame = to;
    renderTimeline();
  }

  // ── コマの一覧 ──
  function drawFrameThumb(i) {
    const cv = thumbs[i];
    if (!cv) return;
    const scale = Math.min(1, THUMB_MAX / Math.max(cols, rows));
    const w = Math.max(1, Math.round(cols * scale)), h = Math.max(1, Math.round(rows * scale));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    for (const layer of frames[i].layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(getLayerCanvas(layer, false), 0, 0, cols, rows, 0, 0, w, h);
    }
    ctx.globalAlpha = 1;
  }

  function renderTimeline() {
    framesEl.innerHTML = '';
    thumbs = frames.map((f, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'timeline-frame';
      item.title = `コマ ${i + 1}`;
      const cv = document.createElement('canvas');
      const num = document.createElement('span');
      num.textContent = i + 1;
      item.append(cv, num);
      if (f.delay) {
        // 表示時間を個別に決めたコマには、その時間を出しておく
        const badge = document.createElement('span');
        badge.className = 'timeline-delay';
        badge.textContent = `${f.delay}ms`;
        item.appendChild(badge);
        item.title += `（${f.delay}ミリ秒）`;
      }
      item.addEventListener('click', () => { stopPlayback(); switchFrame(i); });
      framesEl.appendChild(item);
      return cv;
    });
    thumbs.forEach((_, i) => drawFrameThumb(i));
    markCurrent();
    drawOnionSkin();
  }

  function markCurrent() {
    [...framesEl.children].forEach((el, i) => el.classList.toggle('active', i === currentFrame));
    const cur = framesEl.children[currentFrame];
    if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    frameLabel.textContent = `コマ ${currentFrame + 1} / ${frames.length}`;
    btnDelete.disabled = frames.length <= 1;
    btnLeft.disabled = currentFrame <= 0;
    btnRight.disabled = currentFrame >= frames.length - 1;
    btnPlay.disabled = frames.length <= 1 && !playTimer;
    if (document.activeElement !== delayInput) delayInput.value = frames[currentFrame].delay || '';
  }

  // ── 再生 ──
  // コマごとに表示時間が違うことがあるので、1コマ表示するたびに次の切り替えを予約する
  let playTimer = null;
  const frameDuration = i => frames[i].delay || 1000 / animFps;
  function scheduleNextFrame() {
    playTimer = setTimeout(() => {
      switchFrame((currentFrame + 1) % frames.length, true);
      scheduleNextFrame();
    }, frameDuration(currentFrame));
  }
  function startPlayback() {
    if (frames.length <= 1 || playTimer) return;
    if (isPainting || moveDrag) return;
    scheduleNextFrame();
    btnPlay.textContent = '■';
    btnPlay.title = '止める';
    btnPlay.classList.add('active');
    drawOnionSkin(); // 再生中は前後のコマを重ねない
  }
  function stopPlayback() {
    if (!playTimer) return;
    clearTimeout(playTimer);
    playTimer = null;
    drawOnionSkin();
    btnPlay.textContent = '▶';
    btnPlay.title = '再生（コマを順に表示）';
    btnPlay.classList.remove('active');
    updateLayerPanel(); // 再生中は省いていたレイヤーの一覧を、止めたコマに合わせる
    markCurrent();
  }
  btnPlay.addEventListener('click', () => (playTimer ? stopPlayback() : startPlayback()));
  // 再生中にキャンバスに触れたら止める（描けるように）
  document.getElementById('canvas-stage').addEventListener('pointerdown', stopPlayback, true);

  fpsInput.addEventListener('change', () => {
    const v = Math.max(1, Math.min(MAX_FPS, Math.round(Number(fpsInput.value)) || 8));
    fpsInput.value = v;
    if (v === animFps) return;
    animFps = v;
    markChanged(); // 速さも作品ファイルに保存する
  });

  // 今のコマの表示時間（ミリ秒）。空にすると全体の速さに合わせる。元に戻せる
  delayInput.addEventListener('change', () => {
    if (!started) return;
    const raw = delayInput.value.trim();
    const v = raw === '' ? null
      : Math.max(MIN_FRAME_DELAY, Math.min(MAX_FRAME_DELAY, Math.round(Number(raw) / 10) * 10 || MIN_FRAME_DELAY));
    const f = frames[currentFrame];
    if ((f.delay || null) === v) { delayInput.value = v || ''; return; }
    pushFramesHistory();
    if (v) f.delay = v; else delete f.delay;
    delayInput.value = v || '';
    renderTimeline();
  });
  delayInput.addEventListener('keydown', e => { if (e.key === 'Enter') delayInput.blur(); });

  // ── 前後のコマを薄く表示（オニオンスキン） ──
  // 前のコマを赤く、次のコマを青く染めて、今のコマの下に薄く重ねる。動きをつなげて描きやすくする
  const ONION_KEY = 'pixelart-onion-skin';
  let onionOn = false;
  try { onionOn = localStorage.getItem(ONION_KEY) === '1'; } catch (err) { /* 読めなければ出さない */ }
  const onionScratch = document.createElement('canvas');

  function drawOnionSkin() {
    const ctx = cOnion.getContext('2d');
    ctx.clearRect(0, 0, cOnion.width, cOnion.height);
    if (!onionOn || playTimer || frames.length <= 1 || timeline.style.display === 'none') return;
    const px = cellPx();
    onionScratch.width = cols;
    onionScratch.height = rows;
    const sctx = onionScratch.getContext('2d');
    [[currentFrame - 1, '#ff3b30'], [currentFrame + 1, '#1e6bff']].forEach(([i, tint]) => {
      if (i < 0 || i >= frames.length) return;
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, cols, rows);
      for (const layer of frames[i].layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        sctx.globalAlpha = layer.opacity;
        sctx.drawImage(getLayerCanvas(layer, false), 0, 0);
      }
      // 絵のある所だけを色で染める
      sctx.globalAlpha = 0.6;
      sctx.globalCompositeOperation = 'source-atop';
      sctx.fillStyle = tint;
      sctx.fillRect(0, 0, cols, rows);
      sctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(onionScratch, 0, 0, cols, rows, 0, 0, cols * px, rows * px);
    });
    sctx.globalCompositeOperation = 'source-over';
  }
  window.drawOnionSkin = drawOnionSkin;

  function setOnion(on) {
    onionOn = on;
    btnOnion.classList.toggle('active', on);
    try { localStorage.setItem(ONION_KEY, on ? '1' : '0'); } catch (err) { /* 覚えられなくても使える */ }
    drawOnionSkin();
  }
  btnOnion.addEventListener('click', () => setOnion(!onionOn));
  btnOnion.classList.toggle('active', onionOn);

  // ── 一覧の表示・非表示 ──
  const TIMELINE_KEY = 'pixelart-timeline-open';
  function setTimelineOpen(open) {
    timeline.style.display = open ? '' : 'none';
    btnToggle.classList.toggle('active', open);
    document.body.classList.toggle('timeline-open', open);
    document.body.style.setProperty('--timeline-h', open ? `${timeline.offsetHeight}px` : '0px');
    if (!open) { stopPlayback(); drawOnionSkin(); } // 一覧をしまったら前後のコマも重ねない
    try { localStorage.setItem(TIMELINE_KEY, open ? '1' : '0'); } catch (err) { /* 覚えられなくても使える */ }
    // キャンバスの見える範囲が変わったので、スクロールの余白と左下の色の位置を合わせ直す
    updateScrollPadding();
    updateColorHistoryPos();
    if (open) renderTimeline();
  }
  btnToggle.addEventListener('click', () => setTimelineOpen(timeline.style.display === 'none'));
  // スマホではヘッダーに場所が無いので、ファイルメニューからも出す・しまうができる
  document.getElementById('btn-menu-timeline').addEventListener('click', () => {
    closeFileMenu();
    setTimelineOpen(timeline.style.display === 'none');
  });
  window.addEventListener('resize', () => {
    if (timeline.style.display !== 'none') document.body.style.setProperty('--timeline-h', `${timeline.offsetHeight}px`);
  });

  btnDup.addEventListener('click', () => { if (started) duplicateFrame(); });
  btnNew.addEventListener('click', () => { if (started) addEmptyFrame(); });
  btnDelete.addEventListener('click', () => { if (started) deleteFrame(); });
  btnLeft.addEventListener('click', () => { if (started) moveFrame(-1); });
  btnRight.addEventListener('click', () => { if (started) moveFrame(1); });

  // ── script.js からの知らせ ──
  window.onFramesReset = () => { stopPlayback(); fpsInput.value = animFps; renderTimeline(); };
  window.onFramesChanged = () => { stopPlayback(); renderTimeline(); };
  window.onFramesLoaded = () => {
    stopPlayback();
    fpsInput.value = animFps;
    if (frames.length > 1) setTimelineOpen(true); // コマのある作品を開いたら一覧を出す
    else renderTimeline();
  };
  window.onFrameEdited = () => { if (!playTimer && timeline.style.display !== 'none') drawFrameThumb(currentFrame); };

  // 前回開いていたら、最初から一覧を出しておく
  try { if (localStorage.getItem(TIMELINE_KEY) === '1') setTimelineOpen(true); } catch (err) { /* 読めなければ閉じたまま */ }

  // ── GIF保存 ──
  // 背景は白か透過を選べる（GIFの透過は「透明か不透明か」の2段階だけ）。倍率はPNG保存と同じく整数倍。
  const GIF_MAX_SIDE = 4096;
  const GIF_MAX_PIXELS = 64 * 1024 * 1024; // 全部のコマを合わせた画素数（大きすぎると作るのに時間がかかる）
  const gifModal = document.getElementById('gif-export-modal');
  const gifScaleGrid = document.getElementById('gif-scale-grid');
  const gifInfo = document.getElementById('gif-export-info');
  const gifBgBtns = [...gifModal.querySelectorAll('[data-gif-bg]')];
  let gifTransparent = false;
  let gifScale = 1;

  const gifScaleAllowed = s => cols * s <= GIF_MAX_SIDE && rows * s <= GIF_MAX_SIDE
    && cols * s * rows * s * frames.length <= GIF_MAX_PIXELS;

  function buildGifModal() {
    gifBgBtns.forEach(b => b.classList.toggle('active', (b.dataset.gifBg === 'transparent') === gifTransparent));
    gifScaleGrid.innerHTML = '';
    PNG_SCALES.forEach(s => {
      const b = document.createElement('button');
      const ok = gifScaleAllowed(s);
      b.className = s === gifScale ? 'active' : '';
      b.disabled = !ok;
      b.title = ok ? '' : '大きすぎるため選べません';
      b.textContent = `×${s}`;
      const size = document.createElement('span');
      size.textContent = `${cols * s}×${rows * s}px`;
      b.appendChild(size);
      b.addEventListener('click', () => { gifScale = s; buildGifModal(); });
      gifScaleGrid.appendChild(b);
    });
    const custom = frames.filter(f => f.delay).length;
    gifInfo.textContent = `${frames.length}コマ・${animFps}fps（1コマ ${gifDelayCs(-1) / 100}秒`
      + `${custom ? `・${custom}コマは個別の時間` : ''}）・くり返し再生`;
  }

  // コマの表示時間（GIFは0.01秒単位）。i が -1 なら全体の速さでの時間
  const gifDelayCs = i => Math.max(2, Math.round((i >= 0 && frames[i].delay ? frames[i].delay : 1000 / animFps) / 10));

  function openGifExport() {
    closeFileMenu();
    if (!started) return;
    stopPlayback();
    let saved = NaN;
    try { saved = parseInt(localStorage.getItem(PNG_SCALE_KEY), 10); } catch (err) { /* 読めなければ×1から */ }
    gifScale = [...PNG_SCALES].reverse().find(s => s <= (PNG_SCALES.includes(saved) ? saved : 1) && gifScaleAllowed(s)) || 1;
    buildGifModal();
    gifModal.style.display = 'flex';
  }

  gifBgBtns.forEach(b => b.addEventListener('click', () => {
    gifTransparent = b.dataset.gifBg === 'transparent';
    buildGifModal();
  }));
  document.getElementById('btn-download-gif').addEventListener('click', openGifExport);
  document.getElementById('btn-gif-export').addEventListener('click', openGifExport);
  document.getElementById('btn-gif-export-cancel').addEventListener('click', () => { gifModal.style.display = 'none'; });
  document.getElementById('btn-gif-export-ok').addEventListener('click', () => {
    gifModal.style.display = 'none';
    showToast('GIFを作っています…');
    // 作っている間は画面が止まるので、先に案内を表示させてから作る
    setTimeout(() => {
      try {
        const { bytes, reduced, w, h } = buildGif(gifScale, gifTransparent);
        const blob = new Blob([bytes], { type: 'image/gif' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.download = `pixel-anim${gifTransparent ? '-transparent' : ''}_${w}x${h}.gif`;
        a.href = url;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        markProjectSaved();
        showToast(reduced
          ? 'GIFを保存しました（GIFは256色までのため、近い色にまとめました）'
          : 'GIFを保存しました');
      } catch (err) {
        console.error(err);
        showToast('GIFを作れませんでした（大きすぎるかもしれません）', true);
      }
    }, 50);
  });

  // コマの合成後の色（0xRRGGBB、透明は-1）。PNG保存（compositeAt）と同じく、
  // 見えているレイヤーを下から不透明度込みで重ねる
  function frameColors(frame) {
    const out = new Int32Array(cols * rows).fill(-1);
    const parsed = new Map();
    const rgbOf = hex => {
      let v = parsed.get(hex);
      if (v === undefined) { v = parseInt(hex.slice(1), 16); parsed.set(hex, v); }
      return v;
    };
    for (const layer of frame.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const a = layer.opacity;
      for (let r = 0; r < rows; r++) {
        const row = layer.cells[r];
        for (let c = 0; c < cols; c++) {
          const hex = row[c];
          if (!hex) continue;
          const i = r * cols + c;
          const top = rgbOf(hex);
          const bottom = out[i];
          if (a >= 1 || bottom < 0) { out[i] = top; continue; }
          const mix = sh => Math.round(((top >> sh) & 255) * a + ((bottom >> sh) & 255) * (1 - a));
          out[i] = (mix(16) << 16) | (mix(8) << 8) | mix(0);
        }
      }
    }
    return out;
  }

  // 全部のコマを1つのGIF（くり返し再生）にする
  function buildGif(scale, transparent) {
    frames[currentFrame].active = activeLayerIndex;
    const colorFrames = frames.map(frameColors);
    const WHITE = 0xffffff;
    if (!transparent) colorFrames.forEach(f => { for (let i = 0; i < f.length; i++) if (f[i] < 0) f[i] = WHITE; });

    // 色の表（GIFは256色まで。透過するなら1つを透明用に空ける）。多すぎるときはよく使う色に寄せる
    const counts = new Map();
    colorFrames.forEach(f => f.forEach(v => { if (v >= 0) counts.set(v, (counts.get(v) || 0) + 1); }));
    const limit = transparent ? 255 : 256;
    let palette = [...counts.keys()];
    const reduced = palette.length > limit;
    if (reduced) palette = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit).map(e => e[0]);
    if (!palette.length) palette = [WHITE];
    const indexOf = new Map(palette.map((v, i) => [v, i]));
    const nearest = v => {
      let idx = indexOf.get(v);
      if (idx !== undefined) return idx;
      let best = 0, bestD = Infinity;
      palette.forEach((p, i) => {
        const dr = ((p >> 16) & 255) - ((v >> 16) & 255);
        const dg = ((p >> 8) & 255) - ((v >> 8) & 255);
        const db = (p & 255) - (v & 255);
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < bestD) { bestD = d; best = i; }
      });
      indexOf.set(v, best);
      return best;
    };
    const transIndex = transparent ? palette.length : -1;
    const tableColors = transparent ? [...palette, 0] : palette;

    const w = cols * scale, h = rows * scale;
    const gif = new GifWriter(w, h, tableColors);
    const px = new Uint8Array(w * h);
    colorFrames.forEach((f, fi) => {
      // 1マスを scale×scale に広げながら、色を色の表の番号にする
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = f[r * cols + c];
          const idx = v < 0 ? transIndex : nearest(v);
          const x0 = c * scale;
          for (let dy = 0; dy < scale; dy++) px.fill(idx, (r * scale + dy) * w + x0, (r * scale + dy) * w + x0 + scale);
        }
      }
      gif.addFrame(px, gifDelayCs(fi), transIndex);
    });
    return { bytes: gif.finish(), reduced, w, h };
  }

  // ── GIFの書き出し（GIF89a・LZW圧縮） ──
  function GifWriter(w, h, colors) {
    const out = [];
    const byte = b => out.push(b & 255);
    const word = v => { byte(v); byte(v >> 8); };
    const text = s => [...s].forEach(ch => byte(ch.charCodeAt(0)));
    // 色の表の大きさは2のべき乗（2〜256）
    let bits = 1;
    while ((1 << bits) < colors.length) bits++;
    const tableSize = 1 << bits;

    text('GIF89a');
    word(w); word(h);
    byte(0x80 | 0x70 | (bits - 1)); // 全体の色の表あり・色の深さ8bit・表の大きさ
    byte(0); byte(0);                // 背景色の番号・縦横比
    for (let i = 0; i < tableSize; i++) {
      const v = colors[i] || 0;
      byte(v >> 16); byte(v >> 8); byte(v);
    }
    // くり返し再生（NETSCAPE2.0拡張・回数0＝無限）
    byte(0x21); byte(0xff); byte(11); text('NETSCAPE2.0');
    byte(3); byte(1); word(0); byte(0);

    const minCodeSize = Math.max(2, bits);
    this.addFrame = (indices, delayCs, transIndex) => {
      // 表示時間と透明色。透過するときは次のコマの前に消す（前のコマが透けて残らないように）
      byte(0x21); byte(0xf9); byte(4);
      byte(transIndex >= 0 ? (2 << 2) | 1 : (1 << 2));
      word(delayCs);
      byte(transIndex >= 0 ? transIndex : 0);
      byte(0);
      // 画像（画面全体・この画像だけの色の表なし）
      byte(0x2c); word(0); word(0); word(w); word(h); byte(0);
      byte(minCodeSize);
      lzw(indices, minCodeSize);
    };
    this.finish = () => { byte(0x3b); return Uint8Array.from(out); };

    // LZW圧縮して、255バイトずつの区切りで書き出す
    function lzw(indices, minSize) {
      const clearCode = 1 << minSize, eoiCode = clearCode + 1;
      let codeSize = minSize + 1, nextCode = eoiCode + 1;
      let table = new Map();
      const block = [];
      let cur = 0, curBits = 0;
      const flushBlock = () => {
        if (!block.length) return;
        out.push(block.length, ...block);
        block.length = 0;
      };
      const emit = code => {
        cur |= code << curBits;
        curBits += codeSize;
        while (curBits >= 8) {
          block.push(cur & 255);
          if (block.length === 255) flushBlock();
          cur >>>= 8;
          curBits -= 8;
        }
      };
      emit(clearCode);
      let prefix = indices[0];
      for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = (prefix << 8) | k;
        const code = table.get(key);
        if (code !== undefined) { prefix = code; continue; }
        emit(prefix);
        if (nextCode === 4096) {
          // 表がいっぱいになったら作り直す
          emit(clearCode);
          table = new Map();
          codeSize = minSize + 1;
          nextCode = eoiCode + 1;
        } else {
          if (nextCode >= (1 << codeSize)) codeSize++;
          table.set(key, nextCode++);
        }
        prefix = k;
      }
      emit(prefix);
      emit(eoiCode);
      if (curBits > 0) { block.push(cur & 255); if (block.length === 255) flushBlock(); }
      flushBlock();
      out.push(0); // 画像データの終わり
    }
  }
})();
