# 開発に参加する

不具合報告・要望は [GitHub Issues](https://github.com/Shannon-toppo/PhySim/issues) へお願いします。
コードを変更する場合は、先に Issue で相談してもらえると確実です。

## 準備

- Node.js 22.18 以上（Storm Lua Engine の要件。CI は Node 24 を使っています）
- VSCode 1.101 以上

```bash
npm install          # Storm Lua Engine などを入れ、three.js を media/three/ に配置する（postinstall）
```

LifeBoatAPI は要りません。

## ビルドと実行

```bash
npm run compile      # 拡張ホスト側ビルド (tsc → out/)
npm run watch        # 変更を監視してビルド
```

このフォルダを VSCode で開いて F5 を押すと、PhySim を読み込んだ Extension Development Host が起動します。
その中でマイコンの Lua ファイルを置いたフォルダを開き、Lua ファイルをエディタで開いて F6 で実行してください。

配布用の `.vsix` は次のコマンドで作れます。

```bash
npx vsce package
npm run check:package   # .vsix に必要なファイル（Storm Lua Engine の dist/ を含む）が入っているかを確かめる
```

## テストと検査

```bash
npm run lint         # eslint
npm run check:media  # WebView モジュールの strict JSDoc 型検査
npm test             # test/ 以下の node:test スイート
```

テストの多くは、拡張機能と同じ Storm Lua Engine（WebAssembly）とワーカースレッドを使って、実際にスクリプトを動かします。
対象は、ティックの順序と `simulator` オブジェクト、`require` の探し方、デバッガ（Debug Adapter Protocol）、ビルド、
モニター描画の実機スクリーンショットとの照合（86 ページ）、CH13–17 の派生値計算などです。
JS⇄Lua パリティテストが `media/channels.js` と `PhySim.lua:injectAsInputs` の数式一致を保証します（Lua 5.3 は [fengari](https://fengari.io/) で実行）。
各テストが何を守っているかは `CLAUDE.md` の「Tests」にあります。

VSCode の画面を使う部分（パネルへのモニター表示、デバッグ UI、F6 / F7 のキー割り当て）は自動テストの対象外です。
変更したときは Extension Development Host で動かして確かめてください。

## 変更するときの注意

- チャンネルや姿勢の値の受け渡しを変えるときは、WebView 側・拡張ホスト側・Lua 側・テストを揃えて変更する必要があります。
  対象ファイルの一覧は `CLAUDE.md` の「When changing the pose or channels」にあります。
- モニターの描画は Storm Lua Engine が行います。実機のスクリーンショットとの照合（`test/ingame.test.mjs`）が通らなくなったら、
  fixture ではなくエンジン側を疑ってください。描画規則と検証の記録は
  [`doc/monitor-rendering.md`](https://github.com/Shannon-toppo/PhySim/blob/main/doc/monitor-rendering.md) と
  [`doc/ingame-findings.md`](https://github.com/Shannon-toppo/PhySim/blob/main/doc/ingame-findings.md) にあります。
- LifeBoatAPI 向けに書かれたスクリプトがそのまま動くことを保ってください。`simulator` オブジェクトと `require` の規則は
  `src/engine/prelude.ts` と `src/engine/sourceRoots.ts` にあり、`CLAUDE.md` の「LifeBoatAPI compatibility」に経緯があります。
- `PhySim.lua` はメタテーブルや `pcall` を使わず、グローバル変数として公開します。1.x の API（`PhySim:new(host, port)`、`phys:close()`）も残してください。
- README は日本語版と英語版を揃えて更新してください。2.x がプレリリースの間は、2.x の内容を `doc/next/README.md` と `doc/next/README_en.md`、変更履歴を `doc/next/CHANGELOG.md` に書きます。リポジトリ直下の `README.md`、`doc/README_en.md`、`CHANGELOG.md` は 1.x の内容のまま触りません。
