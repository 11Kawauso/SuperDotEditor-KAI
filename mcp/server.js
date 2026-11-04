#!/usr/bin/env node
// スーパードットエディター・改 × AI の橋渡し（MCP サーバー）
//
// AI のアプリ（Claude のデスクトップアプリなど）が、このプログラムを MCP サーバーとして起動する。
// AI からの道具の呼び出し（ドットを置く・今の絵を見る…）を、ブラウザで開いているエディタへ
// パソコンの中だけの WebSocket（127.0.0.1）で伝え、エディタの答えを AI に返す。
//
//   AI のアプリ ⇄ (MCP / 標準入出力) ⇄ このプログラム ⇄ (WebSocket) ⇄ エディタ（ai-bridge.js）
//
// Node.js だけで動く（npm install は不要）。標準出力は MCP の通信専用なので、記録は標準エラーに出す。
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PIXELART_BRIDGE_PORT) || 17321;
// エディタとして接続を受け付けるページ（ほかのサイトがつないで AI に偽の答えを返せないように）
const ALLOWED_ORIGINS = (process.env.PIXELART_ALLOWED_ORIGINS || 'https://11kawauso.github.io').split(',');
const isAllowedOrigin = origin => ALLOWED_ORIGINS.includes(origin)
  || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
const REQUEST_TIMEOUT_MS = 30000;
const SERVER_VERSION = '1.1.0';
// export_png で保存してよいフォルダ（この中だけに書く）。初期値はユーザーのフォルダ全体
const EXPORT_ROOTS = (process.env.PIXELART_EXPORT_DIRS || os.homedir())
  .split(path.delimiter).filter(Boolean).map(p => path.resolve(p));

const log = (...a) => process.stderr.write(`[superdot-bridge] ${a.join(' ')}\n`);

// ── ドット絵を描くときのコツ（AI に最初に渡す） ──
const INSTRUCTIONS = `You can draw pixel art in "SuperDotEditor-KAI" (スーパードットエディター・改), a pixel-art editor open in the user's browser.

Workflow:
1. Call get_canvas_info first (canvas size, layers, frames). Coordinates are x = column, y = row, 0-based from the top-left.
2. Resize with set_canvas_size if needed (e.g. 16x16 or 32x32 for icons and sprites).
3. Draw mainly with draw_pixel_map (a small character map + color legend). It is the most reliable way to place many pixels.
4. Call get_canvas_image to look at the result, then fix mistakes with more drawing calls. Repeat until it looks right.
5. Every tool call can be undone by the user (and by the undo tool).

Pixel-art tips:
- Keep the palette small (about 4-16 colors). Use a darker shade of the base color for shadows and a lighter one for highlights.
- Give characters and objects a 1-pixel outline (dark, or a darker version of the neighboring color).
- Avoid lonely stray pixels and jagged single-pixel steps in curves ("jaggies"); use consistent line steps (1-1, 2-2, 2-1).
- Put the light source in one direction (usually top-left) and shade consistently.
- Draw big shapes and the silhouette first, then details.
- Use a separate layer (add_layer) for background, character, etc. when it helps.

Game assets (Unity, Godot, etc.):
- Save with export_png into the game project (e.g. Assets/Sprites/...). Use scale 1 and a transparent background.
- For animations use frames "all" + layout "sheet": the frames are placed left to right, and a .json next to the PNG
  records frameWidth/frameHeight, the frame count and each frame's duration in ms.
- In Unity import the sheet with Texture Type = Sprite, Sprite Mode = Multiple, Filter Mode = Point (no filter),
  Compression = None, then slice it by cell size (frameWidth x frameHeight). Pixels Per Unit = the size of one tile.`;

// ── 道具の一覧（AI に見せる説明と、受け取る値の形） ──
const color = { type: 'string', description: 'Color as #rrggbb' };
const int = description => ({ type: 'integer', description });
const TOOLS = [
  {
    name: 'get_canvas_info',
    description: 'Get the canvas size, layers (index 0 = bottom), active layer, animation frames, current color and the user\'s custom palette. Call this first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_canvas_image',
    description: 'Get a PNG image of the canvas (all visible layers of the current frame) scaled up so you can see it. Transparent areas are shown as a light checkerboard. Use it to check your drawing.',
    inputSchema: {
      type: 'object',
      properties: {
        grid: { type: 'boolean', description: 'Draw faint grid lines between pixels (helps counting). Default false.' },
        layer: { type: 'string', enum: ['all', 'active'], description: 'Show all visible layers (default) or only the active layer.' },
      },
    },
  },
  {
    name: 'get_pixels',
    description: 'Read the pixels of a rectangle on the active layer as a character map with a color legend ("." = transparent). Max 64x64 per call.',
    inputSchema: {
      type: 'object',
      properties: { x: int('Left column'), y: int('Top row'), width: int('Width (max 64)'), height: int('Height (max 64)') },
      required: ['x', 'y', 'width', 'height'],
    },
  },
  {
    name: 'set_canvas_size',
    description: 'Resize the canvas (4..1024 each side). Existing pixels are kept from the top-left.',
    inputSchema: {
      type: 'object',
      properties: { cols: int('Width in pixels'), rows: int('Height in pixels') },
      required: ['cols', 'rows'],
    },
  },
  {
    name: 'draw_pixel_map',
    description: 'Draw a block of pixels on the active layer using a character map. Each string in "rows" is one row; each character is looked up in "legend". Characters not in the legend (and "." / space) leave the pixel unchanged. A legend value of "transparent" erases the pixel. Example: x=0, y=0, rows=["..K..",".KRK."], legend={"K":"#222034","R":"#d95763"}.',
    inputSchema: {
      type: 'object',
      properties: {
        x: int('Column of the left edge of the map'),
        y: int('Row of the top edge of the map'),
        rows: { type: 'array', items: { type: 'string' }, description: 'Rows of characters, top to bottom' },
        legend: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map from character to "#rrggbb" or "transparent"' },
      },
      required: ['x', 'y', 'rows', 'legend'],
    },
  },
  {
    name: 'draw_pixels',
    description: 'Set individual pixels on the active layer. Use color "transparent" to erase.',
    inputSchema: {
      type: 'object',
      properties: {
        pixels: {
          type: 'array',
          items: { type: 'object', properties: { x: int('Column'), y: int('Row'), color }, required: ['x', 'y', 'color'] },
        },
      },
      required: ['pixels'],
    },
  },
  {
    name: 'draw_rect',
    description: 'Draw a rectangle on the active layer (filled or outline only).',
    inputSchema: {
      type: 'object',
      properties: {
        x: int('Left column'), y: int('Top row'), width: int('Width'), height: int('Height'), color,
        filled: { type: 'boolean', description: 'Fill the inside (default true)' },
      },
      required: ['x', 'y', 'width', 'height', 'color'],
    },
  },
  {
    name: 'draw_line',
    description: 'Draw a 1-pixel straight line on the active layer.',
    inputSchema: {
      type: 'object',
      properties: { x1: int('Start column'), y1: int('Start row'), x2: int('End column'), y2: int('End row'), color },
      required: ['x1', 'y1', 'x2', 'y2', 'color'],
    },
  },
  {
    name: 'flood_fill',
    description: 'Fill the connected area of the same color starting at (x, y) on the active layer. Use "transparent" to erase it.',
    inputSchema: {
      type: 'object',
      properties: { x: int('Column'), y: int('Row'), color },
      required: ['x', 'y', 'color'],
    },
  },
  {
    name: 'clear_layer',
    description: 'Erase everything on the active layer.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_layer',
    description: 'Add a new empty layer above the active layer and make it active.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Layer name' } } },
  },
  {
    name: 'select_layer',
    description: 'Make a layer active (index 0 = bottom layer).',
    inputSchema: { type: 'object', properties: { index: int('Layer index') }, required: ['index'] },
  },
  {
    name: 'set_layer',
    description: 'Change a layer\'s name, visibility or opacity.',
    inputSchema: {
      type: 'object',
      properties: {
        index: int('Layer index'),
        name: { type: 'string' },
        visible: { type: 'boolean' },
        opacity: { type: 'number', description: '0 to 1' },
      },
      required: ['index'],
    },
  },
  {
    name: 'add_frame',
    description: 'Animation: add a frame right after the current one and switch to it. "copy" duplicates the current frame (default true), otherwise the new frame is empty.',
    inputSchema: { type: 'object', properties: { copy: { type: 'boolean' } } },
  },
  {
    name: 'select_frame',
    description: 'Animation: switch to a frame (0-based).',
    inputSchema: { type: 'object', properties: { index: int('Frame index') }, required: ['index'] },
  },
  {
    name: 'set_animation_speed',
    description: 'Animation: set the playback speed in frames per second (1-50), or the display time of the current frame in milliseconds.',
    inputSchema: {
      type: 'object',
      properties: {
        fps: int('Frames per second for the whole animation'),
        frame_ms: { type: 'integer', description: 'Display time of the current frame in ms (20-10000). Use 0 to follow fps.' },
      },
    },
  },
  {
    name: 'undo',
    description: 'Undo the last change.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'export_png',
    description: 'Save the artwork as PNG file(s) on the user\'s computer, e.g. into a game project\'s asset folder. '
      + 'frames "current" saves the current frame; "all" saves every animation frame, either as one horizontal sprite sheet '
      + '(layout "sheet") or as numbered files name_00.png, name_01.png ... (layout "sequence"). '
      + 'A .json with frame size, count and durations is saved next to it. Existing files are not overwritten unless overwrite is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the .png file to write (for "sequence", the base name)' },
        frames: { type: 'string', enum: ['current', 'all'], description: 'Default "current"' },
        layout: { type: 'string', enum: ['sheet', 'sequence'], description: 'For frames "all". Default "sheet"' },
        columns: { type: 'integer', description: 'Sheet: frames per row (default: all in one row)' },
        scale: { type: 'integer', description: 'Integer scale 1-16 (default 1 = one pixel per dot, best for games)' },
        background: { type: 'string', enum: ['transparent', 'white'], description: 'Default "transparent"' },
        metadata: { type: 'boolean', description: 'Also write a .json with frame info (default true)' },
        overwrite: { type: 'boolean', description: 'Replace existing files (default false)' },
      },
      required: ['path'],
    },
  },
];

// ── export_png：エディタが作った PNG を、決めたフォルダの中にだけ保存する ──
function checkExportPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('path must be an absolute file path, e.g. C:\\Game\\Assets\\Sprites\\slash.png');
  const full = path.resolve(p);
  if (path.extname(full).toLowerCase() !== '.png') throw new Error('path must end with .png');
  // Windows はフォルダ名の大文字・小文字を区別しないので、そろえてから比べる
  const norm = p2 => (process.platform === 'win32' ? p2.toLowerCase() : p2);
  const inside = EXPORT_ROOTS.some(root => {
    const r = norm(root), f = norm(full);
    return f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
  if (!inside) {
    throw new Error(`Saving is only allowed inside: ${EXPORT_ROOTS.join(', ')} (set PIXELART_EXPORT_DIRS to change this)`);
  }
  return full;
}

async function exportPng(args) {
  const full = checkExportPath(args.path);
  const frames = args.frames === 'all' ? 'all' : 'current';
  const layout = frames === 'all' && args.layout === 'sequence' ? 'sequence' : 'sheet';
  const result = await callEditor('export_png', {
    frames, layout,
    columns: args.columns,
    scale: args.scale,
    background: args.background === 'white' ? 'white' : 'transparent',
  });
  // 書くファイルの一覧を先に決め、上書きになるなら何も書かずに止める
  const base = full.slice(0, -path.extname(full).length);
  const digits = Math.max(2, String(result.images.length - 1).length); // 連番は 00, 01 … と桁をそろえる
  const pngPaths = layout === 'sequence'
    ? result.images.map((_, i) => `${base}_${String(i).padStart(digits, '0')}.png`)
    : [full];
  const jsonPath = `${base}.json`;
  const writeMeta = args.metadata !== false;
  const targets = writeMeta ? [...pngPaths, jsonPath] : pngPaths;
  if (!args.overwrite) {
    const exists = targets.filter(f => fs.existsSync(f));
    if (exists.length) throw new Error(`These files already exist (use overwrite: true to replace): ${exists.join(', ')}`);
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  pngPaths.forEach((f, i) => fs.writeFileSync(f, Buffer.from(result.images[i], 'base64')));
  if (writeMeta) {
    const meta = {
      source: 'SuperDotEditor-KAI',
      images: pngPaths.map(f => path.basename(f)),
      layout,
      frameWidth: result.frameWidth,
      frameHeight: result.frameHeight,
      frameCount: result.frameCount,
      columns: result.columns,
      rows: result.rows,
      scale: result.scale,
      fps: result.fps,
      durationsMs: result.durationsMs,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2) + '\n');
  }
  return {
    text: `Saved ${targets.length} file(s):\n${targets.join('\n')}\n`
      + `frame ${result.frameWidth}x${result.frameHeight}px, ${result.frameCount} frame(s)`
      + (layout === 'sheet' && result.frameCount > 1 ? `, sheet ${result.columns} column(s) x ${result.rows} row(s)` : ''),
  };
}

// ── WebSocket（エディタとの通信）。Node.js だけで動くよう、必要な分だけ自前で書く ──
let page = null;            // つながっているエディタ { socket, send }
let nextId = 1;
const pending = new Map();  // 送った命令 id → { resolve, reject, timer }

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

function attachSocket(socket) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  const conn = {
    socket,
    send: obj => socket.write(encodeFrame(JSON.stringify(obj))),
  };
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    // 届いた分から、まとまったフレームを順に取り出す（ブラウザからのフレームは必ずマスクされている）
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let data = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        data = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
      }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { socket.end(); return; }                              // 閉じる
      if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; } // ping → pong
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(data);
        if (!fin) continue;
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        onPageMessage(conn, text);
      }
    }
  });
  socket.on('close', () => {
    if (page === conn) {
      page = null;
      log('editor disconnected');
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('エディタとの接続が切れました')); }
      pending.clear();
    }
  });
  socket.on('error', () => {});
  return conn;
}

function onPageMessage(conn, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.type === 'hello') { log(`editor connected (${msg.cols}x${msg.rows})`); return; }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
}

function callEditor(method, params) {
  if (!page) {
    return Promise.reject(new Error(
      'The editor is not connected. Ask the user to open SuperDotEditor-KAI with "?ai" at the end of the URL '
      + '(https://11kawauso.github.io/SuperDotEditor-KAI/editor.html?ai) and press the 🤖 AI button. '
      + '（エディタがつながっていません。URL の最後に ?ai を付けてエディタを開き、🤖 AI ボタンを押してください）'));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('エディタからの返事がありません（タイムアウト）')); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    page.send({ id, method, params: params || {} });
  });
}

let portError = null;
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('SuperDotEditor-KAI AI bridge is running.\n');
});
httpServer.on('upgrade', (req, socket) => {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin) || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    log(`rejected connection from ${origin}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  // 新しくつながったエディタを使う（前のタブは閉じる）
  if (page) page.socket.end();
  page = attachSocket(socket);
});
httpServer.on('error', err => {
  portError = err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use (another AI app may already be running this bridge). Close the other app, or set PIXELART_BRIDGE_PORT.`
    : String(err.message);
  log(portError);
});
httpServer.listen(PORT, '127.0.0.1', () => log(`waiting for the editor on ws://127.0.0.1:${PORT}`));

// ── MCP（AI のアプリとの通信。標準入出力で1行に1つの JSON-RPC） ──
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function replyError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function handleToolCall(name, args) {
  if (!TOOLS.some(t => t.name === name)) throw new Error(`Unknown tool: ${name}`);
  if (portError) throw new Error(portError);
  const result = name === 'export_png' ? await exportPng(args || {}) : await callEditor(name, args || {});
  // エディタからの答えを MCP の形にする（画像はそのまま画像として渡す）
  const content = [];
  if (result && result.image) content.push({ type: 'image', data: result.image, mimeType: 'image/png' });
  const text = result && result.text !== undefined ? result.text : JSON.stringify(result);
  if (text) content.push({ type: 'text', text });
  return { content };
}

let inputBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inputBuf += chunk;
  let nl;
  while ((nl = inputBuf.indexOf('\n')) >= 0) {
    const line = inputBuf.slice(0, nl).trim();
    inputBuf = inputBuf.slice(nl + 1);
    if (line) handleMessage(line);
  }
});
process.stdin.on('end', () => process.exit(0)); // AI のアプリが閉じたら終わる

async function handleMessage(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { replyError(null, -32700, 'Parse error'); return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // 通知（notifications/initialized など）には返事をしない
  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'superdot-editor', title: 'スーパードットエディター・改', version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
        break;
      case 'ping':
        reply(id, {});
        break;
      case 'tools/list':
        reply(id, { tools: TOOLS });
        break;
      case 'tools/call':
        try {
          reply(id, await handleToolCall(params.name, params.arguments));
        } catch (err) {
          // 道具の失敗は、AI が読んで直せるよう結果として返す
          reply(id, { content: [{ type: 'text', text: String(err.message || err) }], isError: true });
        }
        break;
      default:
        replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    replyError(id, -32603, String(err.message || err));
  }
}
