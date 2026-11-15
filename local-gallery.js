// ── ギャラリー（この端末に保存） ────────────────────────
// ログインなしで、作品をいくつでも保存して一覧から開けるようにする。
// ・ブラウザ（PWA を含む）：このブラウザの中（IndexedDB）に保存する
// ・デスクトップアプリ：パソコンのフォルダ（ドキュメント\SuperDotEditor）に、作品ファイル（.dotkai.json）として保存する
//   （desktop/preload.js の window.desktopApi.works を使う）
// 保存する中身は「作品ファイルとして保存」と同じ形 { app, format, project }。
// script.js のグローバル関数（serializeProject / loadProjectData / projectThumbnailDataURL /
// markProjectSaved / showToast / closeFileMenu / sanitizeProjectFile）を使う。
(() => {
  // ── 保存先 ──
  // どちらも同じ形で使えるようにする：
  //   list() → [{ id, name, updatedAt(ミリ秒), thumb(画像のURL), cols, rows }]（新しい順）
  //   load(id) → 作品ファイルの中身 / create(name, file, thumb) → { id, name } /
  //   update(id, file, thumb) → { id, name } / remove(id)
  const desktopStore = window.desktopApi && window.desktopApi.works;

  const idbStore = (() => {
    const DB_NAME = 'superdot-gallery';
    let dbPromise = null;
    function openDb() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            // 一覧に出す情報（小さい）と、作品の中身（大きい）を分けて、一覧を軽くする
            db.createObjectStore('meta', { keyPath: 'id' });
            db.createObjectStore('data', { keyPath: 'id' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return dbPromise;
    }
    function done(tx) {
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    function get(store, id) {
      return openDb().then(db => new Promise((resolve, reject) => {
        const req = db.transaction(store).objectStore(store).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    }
    // ブラウザが容量に困ったときに勝手に消さないよう頼む（断られても保存はできる）
    let askedPersist = false;
    function askPersist() {
      if (askedPersist || !navigator.storage || !navigator.storage.persist) return;
      askedPersist = true;
      navigator.storage.persist().catch(() => {});
    }
    async function put(id, name, file, thumb, isNew) {
      const db = await openDb();
      const now = Date.now();
      const old = isNew ? null : await get('meta', id);
      const tx = db.transaction(['meta', 'data'], 'readwrite');
      tx.objectStore('meta').put({
        id, name, thumb,
        cols: file.project.cols, rows: file.project.rows,
        createdAt: old ? old.createdAt : now, updatedAt: now,
      });
      tx.objectStore('data').put({ id, file });
      await done(tx);
      askPersist();
      return { id, name };
    }
    return {
      where: 'このブラウザの中に保存しています（ブラウザのデータを消すと消えます。大事な作品は「作品ファイルとして保存」もしておくと安心です）',
      async list() {
        const db = await openDb();
        const all = await new Promise((resolve, reject) => {
          const req = db.transaction('meta').objectStore('meta').getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return all.sort((a, b) => b.updatedAt - a.updatedAt);
      },
      async load(id) {
        const rec = await get('data', id);
        return rec ? rec.file : null;
      },
      create(name, file, thumb) {
        const id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return put(id, name, file, thumb, true);
      },
      async update(id, file, thumb) {
        const meta = await get('meta', id);
        if (!meta) throw new Error('作品が見つかりません');
        return put(id, meta.name, file, thumb, false);
      },
      async remove(id) {
        const db = await openDb();
        const tx = db.transaction(['meta', 'data'], 'readwrite');
        tx.objectStore('meta').delete(id);
        tx.objectStore('data').delete(id);
        await done(tx);
      },
    };
  })();

  const store = desktopStore || idbStore;

  // ── 開いている作品（上書き保存の先） ──
  let current = null; // { id, name }
  const chip = document.getElementById('artwork-chip');
  const chipName = document.getElementById('artwork-chip-name');
  function setLocalWork(id, name) {
    if (id && window.clearCurrentArtwork) window.clearCurrentArtwork(); // クラウドの作品とは同時に開かない
    current = id ? { id, name: name || '無題' } : null;
    if (current) {
      chip.title = desktopStore ? '開いている作品（フォルダに保存）' : '開いている作品（ギャラリー）';
      chipName.textContent = current.name;
      chip.style.display = 'inline-flex';
    } else if (!(window.getCurrentArtwork && window.getCurrentArtwork())) {
      chip.style.display = 'none';
    }
  }
  window.getLocalWork = () => (current ? { ...current } : null);
  window.setLocalWork = setLocalWork;
  window.clearLocalWork = () => { if (current) setLocalWork(null); };

  // ── 保存 ──
  function currentFile() {
    return { app: window.PROJECT_FILE_APP, format: 1, project: serializeProject() };
  }

  const saveModal = document.getElementById('local-save-modal');
  const saveName = document.getElementById('local-save-name');
  function askName() {
    saveName.value = current ? current.name : '';
    saveModal.style.display = 'flex';
    saveName.focus();
    saveName.select();
  }
  async function saveNew(name) {
    try {
      const res = await store.create(name, currentFile(), projectThumbnailDataURL());
      setLocalWork(res.id, res.name);
      markProjectSaved();
      showToast(`「${res.name}」をギャラリーに保存しました`);
    } catch (err) {
      console.warn(err);
      showToast('ギャラリーに保存できませんでした', true);
    }
  }
  async function saveOver() {
    try {
      const res = await store.update(current.id, currentFile(), projectThumbnailDataURL());
      setLocalWork(res.id, res.name);
      markProjectSaved();
      showToast(`「${res.name}」に上書き保存しました`);
    } catch (err) {
      // 消されていたなど、上書きできなかったときは新しく保存し直す
      console.warn(err);
      setLocalWork(null);
      askName();
    }
  }
  // 「ギャラリーに保存」（Ctrl+S）：開いている作品があれば上書き、無ければ名前を付けて保存
  function save(asNew) {
    closeFileMenu();
    if (!isEditorStarted()) return;
    if (!asNew && current) saveOver();
    else askName();
  }
  document.getElementById('btn-local-save').addEventListener('click', () => save(false));
  document.getElementById('btn-local-save-as').addEventListener('click', () => save(true));
  document.getElementById('btn-local-save-ok').addEventListener('click', () => {
    saveModal.style.display = 'none';
    saveNew(saveName.value.trim() || '無題');
  });
  document.getElementById('btn-local-save-cancel').addEventListener('click', () => {
    saveModal.style.display = 'none';
  });
  saveName.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) document.getElementById('btn-local-save-ok').click();
    if (e.key === 'Escape') document.getElementById('btn-local-save-cancel').click();
    e.stopPropagation();
  });

  // Ctrl+S：ギャラリーに保存／Ctrl+Shift+S：名前を付けて保存（ブラウザの「ページを保存」の代わり）
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.code !== 'KeyS') return;
    e.preventDefault();
    if (saveModal.style.display !== 'none') return;
    save(e.shiftKey);
  });

  // ── 一覧 ──
  const modal = document.getElementById('local-gallery-modal');
  const list = document.getElementById('local-gallery-list');
  const title = document.getElementById('local-gallery-title');
  document.getElementById('local-gallery-where').textContent = desktopStore
    ? `保存先：${desktopStore.folder}`
    : idbStore.where;

  const dateText = ms => new Date(ms).toLocaleString('ja-JP', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  function showEmpty(text) {
    list.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'gallery-empty';
    el.textContent = text;
    list.appendChild(el);
  }

  async function openGallery() {
    closeFileMenu();
    title.textContent = 'ギャラリー';
    showEmpty('読み込み中…');
    modal.style.display = 'flex';
    let works;
    try {
      works = await store.list();
    } catch (err) {
      console.warn(err);
      showEmpty('ギャラリーを読み込めませんでした');
      return;
    }
    title.textContent = `ギャラリー（${works.length}）`;
    if (!works.length) {
      showEmpty('保存した作品はまだありません。「ファイル ▸ 保存 ▸ ギャラリーに保存」（Ctrl+S）で保存できます');
      return;
    }
    list.innerHTML = '';
    works.forEach(w => list.appendChild(galleryItem(w, works)));
  }

  function galleryItem(w, works) {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    const img = document.createElement('img');
    img.className = 'gallery-thumb';
    img.alt = '';
    if (w.thumb) img.src = w.thumb;

    const info = document.createElement('div');
    info.className = 'gallery-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'gallery-name';
    nameEl.textContent = w.name;
    nameEl.title = w.name;
    const dateEl = document.createElement('div');
    dateEl.className = 'gallery-date';
    dateEl.textContent = dateText(w.updatedAt) + (w.cols ? `　${w.cols}×${w.rows}` : '');
    info.append(nameEl, dateEl);

    const actions = document.createElement('div');
    actions.className = 'gallery-actions';
    const btnOpen = document.createElement('button');
    btnOpen.className = 'primary';
    btnOpen.textContent = '開く';
    btnOpen.addEventListener('click', () => openWork(w));
    const btnDel = document.createElement('button');
    btnDel.className = 'danger';
    btnDel.textContent = '削除';
    btnDel.addEventListener('click', async () => {
      // 2段階クリックで誤削除を防ぐ
      if (btnDel.dataset.confirm !== '1') {
        btnDel.dataset.confirm = '1';
        btnDel.textContent = '本当に削除？';
        setTimeout(() => { btnDel.dataset.confirm = ''; btnDel.textContent = '削除'; }, 2500);
        return;
      }
      try {
        await store.remove(w.id);
      } catch (err) {
        console.warn(err);
        showToast('削除できませんでした', true);
        return;
      }
      if (current && current.id === w.id) setLocalWork(null);
      item.remove();
      works.splice(works.indexOf(w), 1);
      title.textContent = `ギャラリー（${works.length}）`;
      if (!works.length) showEmpty('保存した作品はまだありません');
      // デスクトップアプリはごみ箱に移すので、そこから戻せる
      showToast(desktopStore ? `「${w.name}」をごみ箱に移しました` : `「${w.name}」を削除しました`);
    });
    actions.append(btnOpen, btnDel);
    item.append(img, info, actions);
    return item;
  }

  async function openWork(w) {
    let project = null;
    try {
      project = sanitizeProjectFile(await store.load(w.id));
    } catch (err) {
      console.warn(err);
    }
    if (!project) {
      showToast('作品を読み込めませんでした', true);
      return;
    }
    loadProjectData(project);
    setLocalWork(w.id, w.name);
    markProjectSaved(); // 開いた直後は保存済みの状態。自動保存にも反映する
    modal.style.display = 'none';
    showToast(`「${w.name}」を開きました`);
  }

  document.getElementById('btn-local-gallery').addEventListener('click', openGallery);
  document.getElementById('btn-start-gallery').addEventListener('click', openGallery);
  document.getElementById('btn-local-gallery-close').addEventListener('click', () => { modal.style.display = 'none'; });
  document.getElementById('btn-local-gallery-cloud').addEventListener('click', () => {
    modal.style.display = 'none';
    if (window.openCloudGallery) window.openCloudGallery();
    else showToast('クラウドにつながっていません（オフラインのときは使えません）', true);
  });
  document.getElementById('btn-local-gallery-folder').addEventListener('click', () => {
    if (desktopStore) desktopStore.openFolder();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none';
  });
})();
