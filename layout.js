// ── 画面の並び ────────────────────────────────────────
// 画面は「上にメニューと今の道具の設定・左に道具バー・中央にキャンバス・右に色とレイヤー」。
// このファイルは、その並びを動かす部分をまとめている。
//   ・メニュー（キャンバス・画像・表示）の開け閉め
//   ・メニューから開く設定の小窓（グリッドサイズ・列や行の強調・画像から変換・トレース）
//   ・今の道具の設定の出し分け（updateOptbar）
//   ・道具バーの「選択」の小窓
//   ・右のパネルの出し入れ（スマホでは下から出る）と、欄の折りたたみ
// 道具そのものの動きは script.js にある。script.js のグローバル（currentTool, selectionMode,
// selectionMask, clipboard, canvasScreenPos など）を使うため、script.js の後に読み込むこと。
(() => {
  const $ = id => document.getElementById(id);
  const body = document.body;
  // スマホの幅（style.css の 640px の境目と揃える）
  const phone = matchMedia('(max-width: 640px)');

  function load(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, value); } catch (err) { /* 覚えられなくても使える */ }
  }

  // ── メニュー（キャンバス・画像・表示） ──
  // ファイルメニューは script.js が開け閉めする。ここではそれ以外のメニューを扱う
  const menus = [...document.querySelectorAll('.menubar .menu')].filter(m => m.id !== 'file-menu');
  const dropdownOf = menu => menu.querySelector('.menu-dropdown');
  function closeMenus(except) {
    menus.forEach(menu => {
      if (menu === except) return;
      dropdownOf(menu).style.display = 'none';
      menu.querySelector('.menubar-btn').classList.remove('open');
    });
  }
  menus.forEach(menu => {
    const btn = menu.querySelector('.menubar-btn');
    btn.addEventListener('click', () => {
      const dd = dropdownOf(menu);
      const open = dd.style.display === 'none';
      closeMenus(menu);
      dd.style.display = open ? 'flex' : 'none';
      btn.classList.toggle('open', open);
    });
    // 項目を押したら閉じる（チェックや色の丸は、続けて切り替えられるよう開いたままにする）
    dropdownOf(menu).addEventListener('click', e => {
      if (e.target.closest('.menu-item')) closeMenus();
    });
  });
  // メニューの外を押したら閉じる
  document.addEventListener('click', e => {
    closeMenus(menus.find(menu => menu.contains(e.target)));
  });
  // ファイルメニューを開いたら、ほかのメニューは閉じる（あちらはクリックを外へ伝えないため）
  $('btn-file-menu').addEventListener('click', () => closeMenus());

  // ── メニューから開く設定の小窓 ──
  const sheet = $('sheet');
  const sheetPages = [...sheet.querySelectorAll('.sheet-page')];
  let sheetPage = null;
  function openSheet(name) {
    const page = sheetPages.find(p => p.dataset.sheetPage === name);
    if (!page) return;
    sheetPages.forEach(p => { p.style.display = p === page ? '' : 'none'; });
    $('sheet-title').textContent = page.dataset.sheetTitle;
    sheet.style.display = '';
    sheetPage = name;
    if (phone.matches) setDockOpen(false); // スマホでは場所が重なるので、右のパネルは閉じる
  }
  function closeSheet() {
    sheet.style.display = 'none';
    sheetPage = null;
  }
  document.querySelectorAll('[data-sheet]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (sheetPage === btn.dataset.sheet) closeSheet(); // 同じ項目をもう一度選んだら閉じる
      else openSheet(btn.dataset.sheet);
    });
  });
  $('btn-sheet-close').addEventListener('click', closeSheet);
  // 小窓の上でホイールを回したときは、キャンバスを動かさず小窓の中をスクロールする
  sheet.addEventListener('wheel', e => e.stopPropagation());
  // 変換する画像を選んだら（最初の画面の「画像を読み込む」からでも）、変換の小窓を出す
  $('file-input').addEventListener('change', () => openSheet('convert'));
  // スマホでは小窓がキャンバスを隠すので、変換したら閉じて結果を見せる
  $('btn-convert').addEventListener('click', () => { if (phone.matches) closeSheet(); });

  // ── 今の道具の設定の出し分け ──
  const optGroups = {
    brush: $('opt-brush'),
    style: $('draw-style-section'),
    move: $('move-target-section'),
    bone: $('opt-bone'),
    select: $('opt-select'),
  };
  const optHint = $('opt-hint');
  const rail = $('tool-rail');
  const btnRailSelect = $('btn-rail-select');
  const HINTS = {
    fill: 'つながった同じ色の範囲を、今の色で塗ります',
    pick: '押したマスの色を、今の色にします',
    move: '選択範囲があれば、その中だけを動かします。矢印キーでも動かせます',
    shape: 'キャンバスをドラッグして描きます',
    bone: '骨の一覧とポーズは、右のパネルに出ます',
    range: 'キャンバスをドラッグして選びます',
    color: '押したマスと同じ色を、キャンバス全体から選びます',
    flood: '押したマスとつながった同じ色だけを選びます',
  };
  // script.js から、道具・選択・貼り付けられるものが変わるたびに呼ばれる
  window.updateOptbar = () => {
    const selecting = selectionMode !== 'none'; // 選択ボタンを押した直後は、道具より選択が優先される
    const tool = currentTool;
    const drawing = tool === 'pen' || tool === 'erase';
    const show = (el, on) => { el.style.display = on ? '' : 'none'; };
    show(optGroups.brush, !selecting && (drawing || tool === 'shape'));
    show(optGroups.style, !selecting && drawing);
    show(optGroups.move, !selecting && tool === 'move');
    show(optGroups.bone, !selecting && tool === 'bone');
    show(optGroups.select, selecting || !!selectionMask || !!clipboard);
    optHint.textContent = (selecting ? HINTS[selectionMode] : HINTS[tool]) || '';
    btnRailSelect.classList.toggle('active', selecting);
    rail.classList.toggle('selecting', selecting);
  };

  // ── 道具バーの「選択」の小窓 ──
  const selectPop = $('rail-pop-select');
  function setSelectPopOpen(open) {
    selectPop.classList.toggle('open', open);
    btnRailSelect.classList.toggle('open', open);
  }
  btnRailSelect.addEventListener('click', () => setSelectPopOpen(!selectPop.classList.contains('open')));
  selectPop.addEventListener('click', e => {
    if (e.target.closest('button')) setSelectPopOpen(false); // 選び方を決めたら閉じる
  });
  document.addEventListener('click', e => {
    if (!btnRailSelect.parentElement.contains(e.target)) setSelectPopOpen(false);
  });
  // キャンバスに Pencil で描き始めたときも閉じる（Pencilのタッチはクリックにならないので、pointerdownで受け取る）
  $('canvas-area').addEventListener('pointerdown', () => setSelectPopOpen(false));

  // ── 右のパネル（色とレイヤー）の出し入れ ──
  // パソコン・タブレットでは横（縦向きのタブレットでは下）に並べ、スマホでは下から出す。
  // パソコン・タブレットでの出し入れは覚えておく。スマホでは毎回閉じた状態から始める
  const DOCK_KEY = 'pixelart-dock-open';
  const btnDock = $('btn-dock-toggle');
  function setDockOpen(open, remember) {
    if (body.classList.contains('dock-open') === open) return;
    const anchor = canvasScreenPos(); // 出し入れでキャンバスをずらさない
    body.classList.toggle('dock-open', open);
    btnDock.classList.toggle('active', open);
    if (remember && !phone.matches) save(DOCK_KEY, open ? '1' : '0');
    if (open && phone.matches) closeSheet();
    updateScrollPadding(); // キャンバスエリアの大きさが変わったので余白を取り直す
    restoreCanvasScreenPos(anchor);
    if (open) updateLayerThumbnails();
  }
  btnDock.addEventListener('click', () => setDockOpen(!body.classList.contains('dock-open'), true));
  $('dock-backdrop').addEventListener('click', () => setDockOpen(false));
  function resetDockForScreen() {
    setDockOpen(phone.matches ? false : load(DOCK_KEY) !== '0');
  }
  phone.addEventListener('change', resetDockForScreen);
  resetDockForScreen();

  // ── 右のパネルの欄の折りたたみ（見出しを押す） ──
  const FOLD_KEY = 'pixelart-dock-folds';
  let folds = {};
  try { folds = JSON.parse(load(FOLD_KEY)) || {}; } catch (err) { folds = {}; }
  document.querySelectorAll('.dock [data-fold]').forEach(section => {
    const key = section.dataset.fold;
    const toggle = section.querySelector('.fold-toggle');
    const apply = () => {
      section.classList.toggle('folded', !!folds[key]);
      toggle.title = folds[key] ? '押すと開きます' : '押すと折りたたみます';
    };
    toggle.addEventListener('click', () => {
      folds[key] = !folds[key];
      save(FOLD_KEY, JSON.stringify(folds));
      apply();
      if (!folds[key] && key === 'layers') updateLayerThumbnails();
    });
    apply();
  });

  // Esc で、開いているメニューと「選択」の小窓を閉じる
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeMenus();
    setSelectPopOpen(false);
  });

  window.layoutApi = { openSheet, closeSheet, setDockOpen };
  window.updateOptbar();
})();
