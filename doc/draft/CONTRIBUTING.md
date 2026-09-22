# 開発に参加する

不具合報告・要望は [GitHub Issues](https://github.com/Shannon-toppo/PhySim/issues) へお願いします。
コードを変更する場合は、先に Issue で相談してもらえると確実です。

## 準備

- Node.js 20.19 以上（ESLint 10 の要件）
- VSCode と [Stormworks Lua with LifeBoatAPI](https://marketplace.visualstudio.com/items?itemName=NameousChangey.lifeboatapi)

```bash
npm install          # three.js を media/three/ に配置（postinstall）
```

## ビルドと実行

```bash
npm run compile      # 拡張ホスト側ビルド (tsc → out/)
npm run watch        # 変更を監視してビルド
```

このフォルダを VSCode で開いて **F5** を押すと、PhySim を読み込んだ Extension Development Host が起動します。
その中で LifeBoatAPI のプロジェクトを開き、**F6** でシミュレーターを起動してください。

配布用の `.vsix` は次のコマンドで作れます。

```bash
npx vsce package
```

## テストと検査

```bash
npm run lint         # eslint
npm run check:media  # WebView モジュールの strict JSDoc 型検査
npm test             # test/ 以下の node:test スイート
```

テストはワイヤプロトコル（encode → 実物の `PhySim.lua` パーサでの往復。
Lua 5.3 は [fengari](https://fengari.io/) で実行）、CH13–17 の派生値計算、
モニター描画の実機スクリーンショットとの照合などをカバーします。
**JS⇄Lua パリティテスト**が `media/channels.js` と `PhySim.lua:injectAsInputs` の数式一致を保証します。

## 変更するときの注意

- チャンネルやプロトコルを変えるときは、JS 側・拡張ホスト側・Lua 側・テストを揃えて変更する必要があります。
  対象ファイルの一覧は `CLAUDE.md` の「When changing the protocol or channels」にあります。
- モニターの描画規則は実機のスクリーンショットに合わせてあります。変える前に
  [`doc/monitor-rendering.md`](https://github.com/Shannon-toppo/PhySim/blob/main/doc/monitor-rendering.md) と
  [`doc/ingame-findings.md`](https://github.com/Shannon-toppo/PhySim/blob/main/doc/ingame-findings.md) を読んでください。
- `PhySim.lua` は LifeBoatAPI のサンドボックス内で動くため、メタテーブルや `pcall` は使いません。
  経緯は [`doc/worklog.md`](https://github.com/Shannon-toppo/PhySim/blob/main/doc/worklog.md) にあります。
- README は日本語版（`README.md`）と英語版（`doc/README_en.md`）を揃えて更新してください。
