// ページ（editor.html）に、デスクトップアプリでだけ使える機能を渡す。
// window.desktopApi があると、editor.html はアプリとして動く（ログインや PEPORIS を隠す・
// ギャラリーの保存先をフォルダにする。local-gallery.js）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  isDesktop: true,
  works: {
    folder: ipcRenderer.sendSync('works:folder'),
    list: () => ipcRenderer.invoke('works:list'),
    load: id => ipcRenderer.invoke('works:load', id),
    create: (name, file, thumb) => ipcRenderer.invoke('works:create', name, file, thumb),
    update: (id, file, thumb) => ipcRenderer.invoke('works:update', id, file, thumb),
    remove: id => ipcRenderer.invoke('works:remove', id),
    openFolder: () => ipcRenderer.invoke('works:openFolder'),
  },
});
