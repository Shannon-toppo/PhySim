# マーケットプレイス公開の準備

公開までの作業場所です。`doc/**` は `.vscodeignore` で除外されているので、ここに置いたものは `.vsix` に入りません。
公開するときに、下の「このフォルダの中身」の表の通りにリポジトリの直下などへ移してください。

## このフォルダの中身

| ファイル | 公開時の置き場所 | 内容 |
|----------|------------------|------|
| `README.md` | `README.md`（今のものと差し替え） | マーケットプレイス向けに書き直した README |
| `README_en.md` | `doc/README_en.md`（今のものと差し替え） | README の英語版。リンクはすべて GitHub の絶対 URL なので、置き場所を変えても切れない |
| `CHANGELOG.md` | `CHANGELOG.md` | 変更履歴。マーケットプレイスの Changelog タブに表示される |
| `CONTRIBUTING.md` | `CONTRIBUTING.md` | 今の README の「ビルドして利用する場合」「開発とテスト」の移し先 |
| `PUBLISHING.md` | 削除 | このファイル |

draft の README は `CHANGELOG.md` / `CONTRIBUTING.md` / `LICENSE` を相対パスで参照しているので、
このフォルダの中では `LICENSE` へのリンクだけ切れています。直下に移せば全部つながります。

## 残っている作業

### アカウントと公開者

- [ ] Azure DevOps の組織と Personal Access Token（Marketplace の Manage 権限）を作る
- [ ] マーケットプレイスで公開者 `shannon-toppo` を作る（`package.json` の `publisher` と一致させる）
- [ ] `npx vsce login shannon-toppo`

### アイコン

- [ ] 128×128 以上の PNG を作る（SVG は不可）
- [ ] `package.json` に `"icon": "images/icon.png"` などを追加する

### package.json

- [ ] `icon`
- [ ] `license`: `"MIT"`
- [ ] `keywords`: `stormworks`, `lifeboatapi`, `lua`, `microcontroller`, `physics sensor` など
- [ ] `bugs`: `{ "url": "https://github.com/Shannon-toppo/PhySim/issues" }`
- [ ] `homepage`: `"https://github.com/Shannon-toppo/PhySim#readme"`
- [ ] `galleryBanner`（任意）
- [ ] `physim.monitors.useBuiltInOnWindows` の説明文を更新する。まだ "text uses a bitmap font" と書かれていて、
  文字をゲームから写し取った今の実装と合わない。exe より円などがゲームに近い点も書けるとよい
- [ ] `version` を上げる

### リポジトリ

- [ ] `.vscodeignore` に `Animation.gif`（2.6MB）を追加する。README からは GitHub の raw URL で参照している
- [ ] ルートに溜まっている `physim-*.vsix` を片付ける（vsce は `*.vsix` を自動で除外するので、パッケージには入らない）
- [x] `doc/README_en.md` を draft の README と同じ構成で英訳し直す（`README_en.md`。日本語版を直したら合わせて直す）
- [ ] `CLAUDE.md` の README の説明を更新する（CONTRIBUTING.md の追加など）

### 公開前の確認

- [ ] `npx vsce ls` で `.vsix` に入るファイルを確認する（`doc/`、`Animation.gif`、`test/` などが入っていないこと）
- [ ] `npx vsce package` で作った `.vsix` を、Windows と macOS のまっさらな VSCode に入れて F6 まで動かす
- [ ] README の GIF・リンクが、マーケットプレイスのプレビューで表示されるか確認する

## 公開の手順

1. このフォルダの `README.md` / `CHANGELOG.md` / `CONTRIBUTING.md` を直下へ、`README_en.md` を `doc/` へ移し、`PUBLISHING.md` を削除する
2. `CHANGELOG.md` の `[Unreleased]` を公開するバージョン番号と日付に書き換える
3. `npx vsce publish`（または `npx vsce package` で作った `.vsix` を Web から上げる）
4. 同じ `.vsix` を GitHub Releases にも添付する

## GitHub Releases のノートに添える文面

マーケットプレイス公開後は、各 Release の「インストール」節を次のように書き換えます。

```markdown
### インストール

VSCode の拡張機能ビューで「Stormworks Physics Sensor Sim」を検索してインストールできます。
マーケットプレイスを使えない場合は、下の `physim-x.y.z.vsix` をダウンロードして、
拡張機能ビューの「…」メニューから **VSIX からのインストール** を選んでください。
マーケットプレイス版と同じものです。
```
