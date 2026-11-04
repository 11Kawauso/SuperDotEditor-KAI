# AI にドット絵を描いてもらう（MCP の橋渡し）

AI のチャット（Claude のデスクトップアプリなど）から、ブラウザで開いたスーパードットエディター・改を直接操作して、ドット絵を描いてもらうための橋渡しのプログラムです。

```
AI のアプリ ⇄ (MCP) ⇄ mcp/server.js（あなたのパソコンで動く） ⇄ (パソコンの中だけの通信) ⇄ エディタ
```

- API キーは不要です。考えるのは、あなたが使っている AI のアプリです。
- 通信はパソコンの中（127.0.0.1）だけで行い、外には出ません。
- AI の操作は1回ずつ、エディタの「元に戻す」で取り消せます。
- 今は試験中のため、エディタの URL の最後に `?ai` を付けたときだけ使えます。

## 必要なもの

- [Node.js](https://nodejs.org/)（18 以上）。`npm install` は不要です。
- MCP に対応した AI のアプリ（下を参照）
- Chrome または Edge（Safari はパソコンの中への接続を止めてしまうため使えません）

## 1. AI のアプリに登録する

`server.js` の場所は、このフォルダを置いた場所に合わせて書きかえてください。

### Claude のデスクトップアプリ

設定 → 開発者 → 「構成を編集」で開く `claude_desktop_config.json` に書き足し、アプリを再起動します。

```json
{
  "mcpServers": {
    "superdot-editor": {
      "command": "node",
      "args": ["C:\\path\\to\\SuperDotEditor-KAI\\mcp\\server.js"]
    }
  }
}
```

### Cursor / Claude Code / VS Code / Gemini CLI など

それぞれの MCP の設定に、同じく「コマンド `node`、引数 `server.js` のパス」の標準入出力（stdio）のサーバーとして登録します。

- Claude Code：`claude mcp add superdot-editor -- node /path/to/mcp/server.js`
- Cursor：`.cursor/mcp.json` の `mcpServers` に上と同じ形で書く
- VS Code：`.vscode/mcp.json` の `servers` に `"type": "stdio"` を付けて書く
- Gemini CLI：`~/.gemini/settings.json` の `mcpServers` に上と同じ形で書く

ChatGPT のアプリは今のところ、インターネット上にある MCP サーバーにしかつなげないため、このパソコンの中で動く橋渡しは使えません。

## 2. エディタをつなぐ

1. エディタを URL の最後に `?ai` を付けて開きます：<https://11kawauso.github.io/SuperDotEditor-KAI/editor.html?ai>
2. ヘッダーの **🤖 AI** を押します。
   - 「待機中…」：AI のアプリで橋渡しが起動するのを待っています（アプリを開くと自動でつながります）
   - 「接続中」（緑）：つながりました
3. ブラウザが「ローカルネットワーク上のデバイスへのアクセス」の許可を求めてきたら、許可してください（パソコンの中の橋渡しにつなぐためです）。
4. AI のチャットで「16×16 のスライムを描いて」のように頼みます。

## AI が使える道具

| 道具 | できること |
| --- | --- |
| `get_canvas_info` | キャンバスの大きさ・レイヤー・コマ・カスタムカラーを調べる |
| `get_canvas_image` | 今の絵を画像で見る（マス目の線も付けられる） |
| `get_pixels` | 範囲のドットを文字の地図で読む |
| `set_canvas_size` | キャンバスの大きさを変える |
| `draw_pixel_map` | 文字の地図と色の対応表で、まとめてドットを置く |
| `draw_pixels` / `draw_rect` / `draw_line` / `flood_fill` / `clear_layer` | 点・四角・線・塗り潰し・消去 |
| `add_layer` / `select_layer` / `set_layer` | レイヤーの追加・選択・名前や表示の変更 |
| `add_frame` / `select_frame` / `set_animation_speed` | アニメーションのコマと速さ |
| `undo` | 元に戻す |

## 設定（環境変数）

- `PIXELART_BRIDGE_PORT`：通信に使うポート（初期値 17321。変えるときは `ai-bridge.js` の `PORT` も合わせる）
- `PIXELART_ALLOWED_ORIGINS`：つないでよいエディタのアドレス（初期値 `https://11kawauso.github.io`。`http://localhost` と `http://127.0.0.1` はいつでも可）

## うまくいかないとき

- **ずっと「待機中…」のまま**：AI のアプリを再起動して、MCP の一覧に `superdot-editor` が出ているか確かめてください。
- **「Port 17321 is already in use」**：同じ橋渡しを別の AI のアプリがすでに動かしています。片方を閉じてください。
- **AI が「エディタがつながっていません」と言う**：エディタを `?ai` 付きで開き、🤖 AI を押してください。
