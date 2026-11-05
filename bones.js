// ── ボーン（部品ごとのレイヤーに骨を入れて動かす） ───────
// 体の部品（頭・体・腕・脚…）をレイヤーごとに描き、関節に骨を置いて親子につなぐ。
// 骨を回すと、その骨に割り当てたレイヤーの絵と、先につながった骨が一緒に回る（切り絵アニメ）。
// ポーズを覚えて、2つのポーズの間のコマを自動で作り、アニメーションのコマとして焼き付ける。
//
// ・骨を置いた（形を決めた）コマを「元の絵」とし、ポーズはその絵を動かして作る
// ・回すときはドット絵が崩れにくい RotSprite（Scale2x で8倍にしてから回し、元の大きさで拾う）を使う
// ・骨の組み立て（リグ）は作品データに保存し、骨の追加・削除などは「元に戻す」で戻せる
// script.js・anim.js のグローバルを使うため、それらの後に読み込むこと。
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const section = document.getElementById('bone-section');
  const hintEl = document.getElementById('bone-hint');
  const listEl = document.getElementById('bone-list');
  const poseBox = document.getElementById('bone-pose-box');
  const buildActions = document.getElementById('bone-build-actions');
  const poseListEl = document.getElementById('bone-pose-list');
  const genFrom = document.getElementById('bone-gen-from');
  const genTo = document.getElementById('bone-gen-to');
  const HANDLE_R = 0.9;   // 関節・先の丸の大きさ（マス）
  const SNAP_R = 1.6;     // この距離までなら、骨の先・関節をつかんだことにする（マス）

  // ── 骨の組み立て（リグ） ──
  // bones: { id, name, parent, x, y（関節）, tx, ty（先） } 座標は元の絵のマス単位（小数あり）
  // bind: { レイヤー番号: 骨の id }   current: 今のポーズ   poses: 覚えたポーズ
  // ポーズ: { name, rot: { 骨の id: 回した角度（ラジアン） }, off: [x, y]（全体をずらした量） }
  const emptyRig = () => ({ source: 0, bones: [], bind: {}, poses: [], current: { rot: {}, off: [0, 0] }, nextId: 1 });
  let rig = emptyRig();
  let mode = 'build';   // 'build'（骨を置く）| 'pose'（ポーズ）
  let selected = null;  // 選んでいる骨の id
  let active = false;   // ボーンツールを使っているか

  const bone = id => rig.bones.find(b => b.id === id);
  const children = id => rig.bones.filter(b => b.parent === id);

  // ── 変換（行列 [a, b, c, d, e, f]：x' = a x + c y + e、y' = b x + d y + f） ──
  const IDENT = [1, 0, 0, 1, 0, 0];
  const compose = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const rotAbout = (cx, cy, t) => {
    const c = Math.cos(t), s = Math.sin(t);
    return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
  };
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const invert = m => {
    const det = m[0] * m[3] - m[1] * m[2];
    const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
    return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
  };

  // 骨の動き：親の動きに、この骨の関節を中心にした回転を重ねる。いちばん元の骨は全体のずれも足す
  function boneMatrix(id, pose, memo = new Map()) {
    if (memo.has(id)) return memo.get(id);
    const b = bone(id);
    const local = rotAbout(b.x, b.y, pose.rot[id] || 0);
    const base = b.parent != null && bone(b.parent)
      ? boneMatrix(b.parent, pose, memo)
      : [1, 0, 0, 1, pose.off[0] || 0, pose.off[1] || 0];
    const m = compose(base, local);
    memo.set(id, m);
    return m;
  }

  // ── RotSprite の下ごしらえ：レイヤーの絵を Scale2x で3回（8倍）なめらかに拡大しておく ──
  // 色は番号（0 = 透明）にして扱う。レイヤーの中身が変わったら作り直す
  let upCache = new Map(); // レイヤー番号 → { key, x0, y0, w, h, S, data, palette }
  const MAX_UP_PIXELS = 4 * 1024 * 1024;

  function scale2x(src, w, h) {
    const dst = new Uint16Array(w * h * 4);
    const W = w * 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const E = src[y * w + x];
        const B = y > 0 ? src[(y - 1) * w + x] : E;
        const H = y < h - 1 ? src[(y + 1) * w + x] : E;
        const D = x > 0 ? src[y * w + x - 1] : E;
        const F = x < w - 1 ? src[y * w + x + 1] : E;
        let e0 = E, e1 = E, e2 = E, e3 = E;
        if (B !== H && D !== F) {
          if (D === B) e0 = D;
          if (B === F) e1 = F;
          if (D === H) e2 = D;
          if (H === F) e3 = F;
        }
        const o = (y * 2) * W + x * 2;
        dst[o] = e0; dst[o + 1] = e1; dst[o + W] = e2; dst[o + W + 1] = e3;
      }
    }
    return dst;
  }

  function layerKey(cellsOfLayer) {
    // 中身が変わったかを見分けるための簡単な目印（色の並びから作る）
    let h = 0;
    for (let y = 0; y < cellsOfLayer.length; y++) {
      const row = cellsOfLayer[y];
      for (let x = 0; x < row.length; x++) {
        const v = row[x];
        if (v) h = (h * 31 + x * 7 + y * 13 + v.charCodeAt(1) + v.charCodeAt(6)) | 0;
      }
    }
    return `${cols}x${rows}:${h}`;
  }

  function upscaled(li) {
    const layer = frames[rig.source].layers[li];
    const key = layerKey(layer.cells);
    const hit = upCache.get(li);
    if (hit && hit.key === key) return hit;
    // 絵のある範囲（＋1マス）だけを拡大する
    let x0 = cols, y0 = rows, x1 = -1, y1 = -1;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (layer.cells[y][x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) { const empty = { key, empty: true }; upCache.set(li, empty); return empty; }
    x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(cols - 1, x1 + 1); y1 = Math.min(rows - 1, y1 + 1);
    let w = x1 - x0 + 1, h = y1 - y0 + 1;
    const palette = [null];
    const idx = new Map();
    let data = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = layer.cells[y0 + y][x0 + x];
      if (!v) continue;
      let i = idx.get(v);
      if (i === undefined) { i = palette.length; palette.push(v); idx.set(v, i); }
      data[y * w + x] = i;
    }
    let S = 1;
    // 大きすぎる絵は拡大せず、そのまま（ふつうの回し方）で回す
    while (S < 8 && w * h * 4 <= MAX_UP_PIXELS) { data = scale2x(data, w, h); w *= 2; h *= 2; S *= 2; }
    const entry = { key, x0, y0, w, h, S, data, palette };
    upCache.set(li, entry);
    return entry;
  }

  // ポーズを付けた絵を作る。返り値は元の絵と同じ並びのレイヤーのマス（割り当ての無いレイヤーはそのまま）
  function renderPose(pose) {
    const src = frames[rig.source].layers;
    const memo = new Map();
    return src.map((layer, li) => {
      const id = rig.bind[li];
      if (id == null || !bone(id)) return layer.cells.map(r => [...r]);
      const up = upscaled(li);
      const out = makeCells(cols, rows);
      if (up.empty) return out;
      const inv = invert(boneMatrix(id, pose, memo));
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          // 出来上がりのマスの真ん中が、元の絵のどこに当たるかを逆向きに調べて色を拾う（穴が空かない）
          const [rx, ry] = apply(inv, x + 0.5, y + 0.5);
          const u = Math.floor((rx - up.x0) * up.S), v = Math.floor((ry - up.y0) * up.S);
          if (u < 0 || v < 0 || u >= up.w || v >= up.h) continue;
          const c = up.data[v * up.w + u];
          if (c) out[y][x] = up.palette[c];
        }
      }
      return out;
    });
  }

  const isRestPose = p => !Object.values(p.rot).some(Boolean) && !p.off[0] && !p.off[1];

  // ── 表示：ポーズの下書き（canvas-pose）と骨（SVG） ──
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'bone-overlay';
  svg.setAttribute('preserveAspectRatio', 'none');
  document.getElementById('canvas-wrap').appendChild(svg);

  function drawPosePreview() {
    // 元の絵のコマを見ているときだけ、動かした形を重ねて見せる（ほかのコマはそのまま見せる）
    const showing = active && mode === 'pose' && rig.bones.length && currentFrame === rig.source && !isRestPose(rig.current);
    cMain.style.visibility = showing ? 'hidden' : '';
    cPose.style.display = showing ? 'block' : 'none'; // CSS では隠してあるので、見せるときは block を指定する
    if (!showing) return;
    const posed = renderPose(rig.current);
    const ctx = cPose.getContext('2d');
    ctx.clearRect(0, 0, cPose.width, cPose.height);
    ctx.imageSmoothingEnabled = false;
    const tmp = document.createElement('canvas');
    tmp.width = cols; tmp.height = rows;
    const tctx = tmp.getContext('2d');
    const px = cellPx();
    frames[rig.source].layers.forEach((layer, li) => {
      if (!layer.visible || layer.opacity <= 0) return;
      tctx.putImageData(layerImageData(tctx, posed[li]), 0, 0);
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(tmp, 0, 0, cols, rows, 0, 0, cols * px, rows * px);
    });
    ctx.globalAlpha = 1;
  }

  function drawBones() {
    svg.setAttribute('viewBox', `0 0 ${cols} ${rows}`);
    svg.style.display = active ? '' : 'none';
    svg.innerHTML = '';
    if (!active) return;
    const posing = mode === 'pose';
    const pose = posing ? rig.current : { rot: {}, off: [0, 0] };
    const memo = new Map();
    const sw = Math.max(0.12, Math.min(0.35, cols / 160)); // 線の太さ（キャンバスが大きいほど太く）
    for (const b of rig.bones) {
      const m = boneMatrix(b.id, pose, memo);
      const [jx, jy] = apply(m, b.x, b.y);
      const [tx, ty] = apply(m, b.tx, b.ty);
      const isSel = b.id === selected;
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'bone' + (isSel ? ' selected' : ''));
      // 骨の形：関節側が太いひし形
      const len = Math.hypot(tx - jx, ty - jy) || 0.001;
      const nx = -(ty - jy) / len, ny = (tx - jx) / len;
      const wdt = Math.min(len * 0.18, 1.2);
      const mx = jx + (tx - jx) * 0.2, my = jy + (ty - jy) * 0.2;
      const body = document.createElementNS(SVG_NS, 'polygon');
      body.setAttribute('points', `${jx},${jy} ${mx + nx * wdt},${my + ny * wdt} ${tx},${ty} ${mx - nx * wdt},${my - ny * wdt}`);
      body.setAttribute('class', 'bone-body');
      body.setAttribute('stroke-width', sw);
      body.dataset.bone = b.id;
      body.dataset.part = 'body';
      const joint = document.createElementNS(SVG_NS, 'circle');
      joint.setAttribute('cx', jx); joint.setAttribute('cy', jy); joint.setAttribute('r', HANDLE_R * 0.75);
      joint.setAttribute('class', 'bone-joint' + (b.parent == null ? ' root' : ''));
      joint.setAttribute('stroke-width', sw);
      joint.dataset.bone = b.id;
      joint.dataset.part = 'joint';
      const tip = document.createElementNS(SVG_NS, 'circle');
      tip.setAttribute('cx', tx); tip.setAttribute('cy', ty); tip.setAttribute('r', HANDLE_R * 0.6);
      tip.setAttribute('class', 'bone-tip');
      tip.setAttribute('stroke-width', sw);
      tip.dataset.bone = b.id;
      tip.dataset.part = 'tip';
      g.append(body, joint, tip);
      svg.appendChild(g);
    }
  }

  function refresh() {
    drawBones();
    drawPosePreview();
    renderPanel();
  }

  // ── 操作（SVG の上でのドラッグ） ──
  function svgPoint(e) {
    const r = svg.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * cols, (e.clientY - r.top) / r.height * rows];
  }
  const snapHalf = v => Math.round(v * 2) / 2; // 骨を置く位置は半マス単位にそろえる

  // いちばん近い骨の先（なければ関節）を探す
  function nearestHandle(x, y, pose) {
    let best = null, bestD = SNAP_R;
    const memo = new Map();
    for (const b of rig.bones) {
      const m = boneMatrix(b.id, pose, memo);
      for (const part of ['tip', 'joint']) {
        const [hx, hy] = part === 'tip' ? apply(m, b.tx, b.ty) : apply(m, b.x, b.y);
        const d = Math.hypot(hx - x, hy - y);
        if (d < bestD) { bestD = d; best = { id: b.id, part }; }
      }
    }
    return best;
  }

  let drag = null;
  svg.addEventListener('pointerdown', e => {
    if (!active || e.button > 0) return;
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 捕捉できなくてもキャンバスの上では動かせる */ }
    const [x, y] = svgPoint(e);
    const tgt = e.target.dataset && e.target.dataset.bone ? { id: Number(e.target.dataset.bone), part: e.target.dataset.part } : null;
    if (mode === 'pose') {
      const h = tgt || nearestHandle(x, y, rig.current);
      if (!h) return;
      selected = h.id;
      const b = bone(h.id);
      // いちばん元の骨の関節は全体を動かす。それ以外は骨を回す
      drag = b.parent == null && h.part === 'joint'
        ? { kind: 'move-all', x, y, off: [...rig.current.off] }
        : { kind: 'rotate', id: h.id };
      refresh();
      return;
    }
    // 骨を置く
    //   骨の先から → つながった子の骨（ひじから前腕など）
    //   骨の途中から → その骨の子（背骨の途中から腕など）。動かさずに離すと、その骨を選ぶだけ
    //   関節から → 同じ関節から出る骨（腰から脚など）
    //   Shift を押しながら関節・先をつかむ → その位置を直す
    //   何もない所から → 新しい根元の骨
    const h = tgt && tgt.part !== 'body' ? tgt : nearestHandle(x, y, { rot: {}, off: [0, 0] });
    if (h && e.shiftKey) {
      selected = h.id;
      drag = { kind: h.part === 'joint' ? 'move-joint' : 'move-tip', id: h.id, pushed: false };
      refresh();
      return;
    }
    let parent = null, jx = snapHalf(x), jy = snapHalf(y);
    if (h && h.part === 'tip') { parent = h.id; jx = bone(h.id).tx; jy = bone(h.id).ty; }
    else if (h && h.part === 'joint') { const b = bone(h.id); parent = b.parent; jx = b.x; jy = b.y; }
    else if (tgt && tgt.part === 'body') { parent = tgt.id; selected = tgt.id; }
    if (!rig.bones.length) rig.source = currentFrame;
    drag = { kind: 'new', parent, jx, jy, x, y, selectOnly: tgt && tgt.part === 'body' ? tgt.id : null };
    drawNewBonePreview(jx, jy, x, y);
  });

  function drawNewBonePreview(jx, jy, x, y) {
    drawBones();
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', jx); line.setAttribute('y1', jy);
    line.setAttribute('x2', snapHalf(x)); line.setAttribute('y2', snapHalf(y));
    line.setAttribute('class', 'bone-new');
    line.setAttribute('stroke-width', Math.max(0.15, cols / 140));
    svg.appendChild(line);
  }

  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const [x, y] = svgPoint(e);
    if (drag.kind === 'new') { drag.x = x; drag.y = y; drawNewBonePreview(drag.jx, drag.jy, x, y); return; }
    if (drag.kind === 'move-joint' || drag.kind === 'move-tip') {
      if (!drag.pushed) { pushFramesHistory(); drag.pushed = true; }
      const b = bone(drag.id);
      const nx = snapHalf(x), ny = snapHalf(y);
      if (drag.kind === 'move-joint') { b.x = nx; b.y = ny; }
      else {
        // 先につながっていた子の関節も一緒に動かす
        children(b.id).forEach(c => { if (c.x === b.tx && c.y === b.ty) { c.x = nx; c.y = ny; } });
        b.tx = nx; b.ty = ny;
      }
      drawBones();
      return;
    }
    if (drag.kind === 'move-all') {
      rig.current.off = [Math.round(drag.off[0] + x - drag.x), Math.round(drag.off[1] + y - drag.y)];
      drawBones(); drawPosePreview();
      return;
    }
    if (drag.kind === 'rotate') {
      const b = bone(drag.id);
      const m = boneMatrix(b.id, rig.current);
      const [jx, jy] = apply(m, b.x, b.y);
      const [tx, ty] = apply(m, b.tx, b.ty);
      let d = Math.atan2(y - jy, x - jx) - Math.atan2(ty - jy, tx - jx);
      if (e.shiftKey) {
        // Shift を押しながらだと 15 度ずつ
        const total = (rig.current.rot[b.id] || 0) + d;
        const step = Math.PI / 12;
        d = Math.round(total / step) * step - (rig.current.rot[b.id] || 0);
      }
      rig.current.rot[b.id] = normalize((rig.current.rot[b.id] || 0) + d);
      drawBones(); drawPosePreview();
    }
  });

  const normalize = a => Math.atan2(Math.sin(a), Math.cos(a));

  function endDrag(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === 'new') {
      const tx = snapHalf(d.x), ty = snapHalf(d.y);
      if (Math.hypot(tx - d.jx, ty - d.jy) >= 1) {
        pushFramesHistory();
        const id = rig.nextId++;
        rig.bones.push({ id, name: `骨${id}`, parent: d.parent, x: d.jx, y: d.jy, tx, ty });
        selected = id;
      } else if (d.selectOnly != null) {
        selected = d.selectOnly; // 骨の途中を押しただけなら、その骨を選ぶ
      }
    }
    refresh();
  }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  // ── パネル ──
  function renderPanel() {
    if (!active) return;
    document.querySelectorAll('.bone-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.boneMode === mode));
    hintEl.textContent = mode === 'build'
      ? '部品ごとにレイヤーを分けて描き、関節から先へドラッグして骨を置きます。骨の先（小さい丸）や骨の途中からドラッグすると、その骨につながった骨に、関節（大きい丸）からだと同じ関節から出る骨になります。Shift を押しながら丸をドラッグすると、位置を直せます。'
      : '骨の先（小さい丸）をドラッグして回します（Shift で15度ずつ）。いちばん元の骨の関節（オレンジの丸）をドラッグすると、全体が動きます。';
    if (rig.bones.length && frames.length > 1) hintEl.textContent += `　元の絵：コマ ${rig.source + 1}`;
    buildActions.style.display = mode === 'build' ? '' : 'none';
    poseBox.style.display = mode === 'pose' ? '' : 'none';

    // 骨の一覧：名前と、割り当てたレイヤー
    listEl.innerHTML = '';
    const srcLayers = frames[rig.source] ? frames[rig.source].layers : layers;
    const depth = b => (b.parent != null && bone(b.parent) ? depth(bone(b.parent)) + 1 : 0);
    // 根元の骨から、つながった順に並べる
    const ordered = [];
    const visit = b => { ordered.push(b); children(b.id).forEach(visit); };
    rig.bones.filter(b => b.parent == null || !bone(b.parent)).forEach(visit);
    for (const b of ordered) {
      const row = document.createElement('div');
      row.className = 'bone-row' + (b.id === selected ? ' selected' : '');
      row.style.paddingLeft = `${4 + depth(b) * 12}px`;
      const name = document.createElement('span');
      name.className = 'bone-name';
      name.textContent = (b.parent == null ? '◆ ' : '└ ') + b.name;
      name.addEventListener('click', () => { selected = b.id; refresh(); });
      const sel = document.createElement('select');
      sel.title = 'この骨で動かすレイヤー';
      sel.innerHTML = '<option value="">（レイヤーなし）</option>';
      srcLayers.forEach((l, li) => {
        const o = document.createElement('option');
        o.value = li;
        o.textContent = l.name;
        if (rig.bind[li] === b.id) o.selected = true;
        sel.appendChild(o);
      });
      // 1つの骨に1つのレイヤーを選ぶ（同じ骨に複数のレイヤーを付けたいときは、レイヤー側を自動で割り当てる）
      sel.addEventListener('change', () => {
        pushFramesHistory();
        Object.keys(rig.bind).forEach(k => { if (rig.bind[k] === b.id) delete rig.bind[k]; });
        if (sel.value !== '') rig.bind[sel.value] = b.id;
        refresh();
      });
      const boundCount = Object.values(rig.bind).filter(v => v === b.id).length;
      if (boundCount > 1) sel.title += `（このほか ${boundCount - 1} 枚のレイヤーも動かします）`;
      row.append(name, sel);
      listEl.appendChild(row);
    }
    if (!rig.bones.length) listEl.innerHTML = '<div class="layer-hint">まだ骨がありません</div>';

    // 覚えたポーズ
    poseListEl.innerHTML = '';
    rig.poses.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'bone-pose-row';
      const use = document.createElement('button');
      use.textContent = p.name;
      use.title = 'このポーズにする';
      use.addEventListener('click', () => { rig.current = clonePose(p); refresh(); });
      const del = document.createElement('button');
      del.textContent = '✕';
      del.className = 'danger';
      del.title = 'このポーズを消す';
      del.addEventListener('click', () => { pushFramesHistory(); rig.poses.splice(i, 1); refresh(); });
      row.append(use, del);
      poseListEl.appendChild(row);
    });
    // コマを作るときのポーズの選択（「形を戻す」と同じ、骨を置いたときの形も選べる）
    const opts = ['<option value="rest">骨を置いたときの形</option>', ...rig.poses.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`)];
    const keepFrom = genFrom.value, keepTo = genTo.value;
    genFrom.innerHTML = opts.join('');
    genTo.innerHTML = opts.join('');
    genFrom.value = [...genFrom.options].some(o => o.value === keepFrom) ? keepFrom : 'rest';
    genTo.value = [...genTo.options].some(o => o.value === keepTo) ? keepTo : (rig.poses.length ? String(rig.poses.length - 1) : 'rest');
  }

  const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const clonePose = p => ({ name: p.name, rot: { ...p.rot }, off: [...p.off] });

  document.querySelectorAll('.bone-mode-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.boneMode)));

  function setMode(m) {
    mode = m;
    // ポーズは元の絵のコマで付ける
    if (mode === 'pose' && rig.bones.length && currentFrame !== rig.source && frames[rig.source]) window.animApi.selectFrame(rig.source);
    refresh();
  }

  document.getElementById('btn-bone-auto').addEventListener('click', () => {
    if (!rig.bones.length) return;
    pushFramesHistory();
    autoBind();
    refresh();
  });

  // レイヤーごとに、絵のまん中にいちばん近い骨を割り当てる
  function autoBind() {
    const src = frames[rig.source].layers;
    rig.bind = {};
    src.forEach((l, li) => {
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (l.cells[y][x]) { sx += x + 0.5; sy += y + 0.5; n++; }
      if (!n) return;
      const cx = sx / n, cy = sy / n;
      let best = null, bestD = Infinity;
      for (const b of rig.bones) {
        const d = distToSegment(cx, cy, b.x, b.y, b.tx, b.ty);
        if (d < bestD) { bestD = d; best = b.id; }
      }
      rig.bind[li] = best;
    });
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  document.getElementById('btn-bone-delete').addEventListener('click', () => {
    const b = bone(selected);
    if (!b) return;
    pushFramesHistory();
    // 先につながった骨は、消した骨の親につなぎ直す
    children(b.id).forEach(c => { c.parent = b.parent; });
    rig.bones = rig.bones.filter(x => x.id !== b.id);
    Object.keys(rig.bind).forEach(k => { if (rig.bind[k] === b.id) delete rig.bind[k]; });
    rig.poses.forEach(p => { delete p.rot[b.id]; });
    delete rig.current.rot[b.id];
    selected = null;
    refresh();
  });

  document.getElementById('btn-pose-reset').addEventListener('click', () => { rig.current = { rot: {}, off: [0, 0] }; refresh(); });
  document.getElementById('btn-pose-save').addEventListener('click', () => {
    pushFramesHistory();
    let k = rig.poses.length + 1;
    while (rig.poses.some(p => p.name === `ポーズ${k}`)) k++;
    rig.poses.push({ ...clonePose(rig.current), name: `ポーズ${k}` });
    genTo.value = String(rig.poses.length - 1);
    refresh();
    genTo.value = String(rig.poses.length - 1);
  });

  // ── コマを作る：2つのポーズの間を計算して、アニメーションのコマにする ──
  const lerpAngle = (a, b, t) => a + normalize(b - a) * t;
  const ease = t => t * t * (3 - 2 * t); // ゆっくり始まって、ゆっくり止まる

  function poseOf(value) {
    return value === 'rest' ? { name: 'rest', rot: {}, off: [0, 0] } : rig.poses[Number(value)];
  }

  function blendPose(a, b, t) {
    const rot = {};
    rig.bones.forEach(bn => { rot[bn.id] = lerpAngle(a.rot[bn.id] || 0, b.rot[bn.id] || 0, t); });
    return { rot, off: [Math.round(a.off[0] + (b.off[0] - a.off[0]) * t), Math.round(a.off[1] + (b.off[1] - a.off[1]) * t)] };
  }

  document.getElementById('btn-bone-generate').addEventListener('click', () => {
    if (!rig.bones.length || !frames[rig.source]) return;
    const a = poseOf(genFrom.value), b = poseOf(genTo.value);
    if (!a || !b) return;
    const between = Math.max(0, Math.min(30, Math.round(Number(document.getElementById('bone-gen-count').value) || 0)));
    const back = document.getElementById('bone-gen-back').checked;
    const smooth = document.getElementById('bone-gen-ease').checked;
    // 始め → 間 → 終わり（往復なら、終わり → 間 → 始めの手前まで戻り、続けて再生するとつながる）
    const ts = [];
    for (let i = 0; i <= between + 1; i++) ts.push(i / (between + 1));
    if (back) for (let i = between; i >= 1; i--) ts.push(i / (between + 1));
    const srcLayers = frames[rig.source].layers;
    pushFramesHistory();
    frames[currentFrame].active = activeLayerIndex;
    const firstNew = frames.length;
    for (const t of ts) {
      const posed = renderPose(blendPose(a, b, smooth ? ease(t) : t));
      frames.push({
        layers: srcLayers.map((l, li) => ({ name: l.name, visible: l.visible, opacity: l.opacity, locked: l.locked, cells: posed[li] })),
        active: frames[rig.source].active,
      });
    }
    window.onFramesChanged();
    window.animApi.openTimeline();
    window.animApi.selectFrame(firstNew);
    showToast(`コマを ${ts.length} 枚作りました（コマ ${firstNew + 1}〜${frames.length}）。1枚ずつ手直しもできます`);
    refresh();
  });

  // ── ツールの切り替え ──
  window.onToolChanged = t => {
    active = t === 'bone';
    section.style.display = active ? '' : 'none';
    svg.classList.toggle('active', active);
    if (active && mode === 'pose' && rig.bones.length && currentFrame !== rig.source && frames[rig.source]) window.animApi.selectFrame(rig.source);
    refresh();
  };

  // ── script.js から使う入り口 ──
  window.boneApi = {
    exportRig: () => (rig.bones.length || rig.poses.length ? JSON.parse(JSON.stringify(rig)) : null),
    importRig: data => {
      rig = data ? JSON.parse(JSON.stringify(data)) : emptyRig();
      if (!rig.current) rig.current = { rot: {}, off: [0, 0] };
      if (!rig.poses) rig.poses = [];
      if (!rig.bind) rig.bind = {};
      if (!rig.nextId) rig.nextId = Math.max(0, ...rig.bones.map(b => b.id)) + 1;
      if (!frames[rig.source]) rig.source = 0;
      selected = null;
      upCache = new Map();
      refresh();
    },
    onCanvasResized: () => { upCache = new Map(); drawBones(); drawPosePreview(); },
    // 確かめる用（AI との接続などからも使える）
    renderPose: pose => renderPose(pose || rig.current),
    getRig: () => rig,
  };

  // 元の絵が描き変わったら、ポーズの下書きも描き直す
  const prevEdited = window.onFrameEdited;
  window.onFrameEdited = () => {
    if (prevEdited) prevEdited();
    if (active && mode === 'pose') drawPosePreview();
  };
})();
