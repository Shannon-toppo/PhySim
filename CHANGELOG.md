# 変更履歴

PhySim の主な変更点です。各バージョンの詳細は [GitHub Releases](https://github.com/Shannon-toppo/PhySim/releases) を参照してください。

## [Unreleased]

## [1.1.2] - 2026-09-25

### 修正
- 自前モニター表示の描画を、新しく撮った実機のスクリーンショットに合わせて2点直しました。1x1〜9x5 のモニターで撮った86ページを、画素単位で再現します。
  - 塗り円（`drawCircleF`）の水平な辺がちょうど画素の行に乗ったとき、下の辺の行は描かれ、上の辺の行は描かれないようにしました。以前は逆でした。
  - 頂点がちょうど 1/512px の境目に乗ったときの丸め方を、Windows（GeForce RTX 4070Ti）の実機に合わせました。向きはモニターの大きさで変わります。Mac の実機とは、この場合に1画素ずれることがあります。

### 変更
- README をマーケットプレイス向けに書き直しました。変更履歴（この CHANGELOG）と開発者向けの内容（CONTRIBUTING.md）を README から分けました。
- `physim.monitors.useBuiltInOnWindows` の説明文を今の実装に合わせました。

## [1.1.1] - 2026-09-24

VS Code Marketplace で公開した最初のバージョンです（プレビュー）。

### 追加
- シミュレーション速度（×1 / ×0.5 / ×0.25 / ×0.1）。パネルの Simulate / Play と、LifeBoatAPI 側のマイコンの tick を同じ倍率で遅くします。1ティックの中身（m/tick・rad/tick）は変わりません。
- `phys:tickRate()`。パネルのシミュレーション速度をティック/秒で返します。
- CSV ログに `game_time_s`（ゲーム内秒数）と `time_scale`（記録時の速度）の列を追加しました（19 → 21 列）。
- 拡張機能のアイコン。

### 変更
- 信頼されていないワークスペースと仮想ワークスペースでは動かないことを `package.json` に明記しました。
- 実機検証用のスクリプト（`tools/ingame/verify*.lua`）を ASCII だけにしました。ゲーム内エディタにそのまま貼れます。

## [1.1.0] - 2026-09-22

### 変更
- 自前モニター表示の描画を、実機 Stormworks のスクリーンショットに合わせました。1x1〜9x5 の8種類のモニターで撮った62ページを、画素単位で再現します。
  - 線: 終点の画素は描かれません。0.5px の線は1画素、0.3px の線は描かれません。
  - 円: 半径に応じた 8〜16 角形として描かれます。負の半径は絶対値の円と同じになります。
  - 塗り（`drawCircleF` / `drawTriangleF` / `drawRectF`）の縁の画素が実機と同じになりました。
  - `drawRect` は (w+1)×(h+1) の大きさになり、幅0でも描かれます。
  - 半透明色の合成が実機と同じ式になりました。
  - 文字: ASCII 全95字を実機と照合し、20字の形を直して `&` と `` ` `` を追加しました。
  - `drawTextBox` は実機と同じく文字数で折り返し、空白を削りません。

## [1.0.0] - 2026-09-09

### 追加
- 複数モニター。自前モニター表示で、1つのマイコンに複数のモニターを繋いだ構成を再現できます。
- サイドバーの表示切り替え（◫ Values / **H**）。
- 3Dビューポートとモニター表示の境界をドラッグして、モニター領域の高さを変えられるようにしました。

## [0.4.6] - 2026-08-26

### 追加
- CH1–17 の CSV ロギング。

### 修正
- Windows で CSV の保存先ダイアログが開かない問題。

## [0.4.5] - 2026-08-25

### 追加
- 3Dビューに軌跡（トレイル）と速度ベクトル矢印を表示するようにしました。

### 変更
- 自前モニター表示の描画コストを約7分の1にしました。パネルが裏に隠れている間は描画しません。

## [0.4.4] - 2026-08-22

### 追加
- 診断ログ（`PhySim: Show Log`）。

### 修正
- 自前モニター表示で、三角形を使う描画が崩れる問題。

## [0.4.3] - 2026-08-22

### 追加
- **True colour** オプション。LifeBoatAPI のガンマ補正を打ち消し、`setColor` に渡した値のまま表示します。
- Windows でも自前モニター表示を使える実験的設定（`physim.monitors.useBuiltInOnWindows`、既定OFF）。

### 変更
- 自前モニター表示の図形を、アンチエイリアス無しでピクセルグリッドに描くようにしました。

## [0.4.2] - 2026-08-18

### 追加
- モニター表示のピンチズーム（Ctrl/Cmd + ホイールも同じ操作）。

## [0.4.1] - 2026-08-08

### 変更
- CH4–6（回転）を [-π, π) に正規化しました。`phys:rotation()` も同じ値を返します。

## [0.4.0] - 2026-08-07

### 追加
- macOS 対応。luasocket を同梱し、`STORMWORKS_Simulator.exe` の代わりにモニターをパネル内に描画します。

## [0.3.0] - 2026-07-03

### 追加
- シミュレーション動作の録画と再生。

### 修正
- 飛行機モデルの尾翼の形。

## [0.2.0] - 2026-06-09

### 追加
- Simulate モード。速度・加速度を位置・回転に積分し、ギズモが自動で動きます。
- 位置・回転の数値入力と、姿勢プリセットの保存・呼び出し。

## [0.1.3] - 2026-05-25

### 追加
- パネルを開く位置の設定（`physim.panel.openLocation`）。

### 修正
- モード切り替え時に、パネルが補助ウィンドウへ復元される問題。

## [0.1.1] - 2026-05-23

- 最初の公開版。

[Unreleased]: https://github.com/Shannon-toppo/PhySim/compare/1.1.2...HEAD
[1.1.2]: https://github.com/Shannon-toppo/PhySim/releases/tag/1.1.2
[1.1.1]: https://github.com/Shannon-toppo/PhySim/releases/tag/1.1.1
[1.1.0]: https://github.com/Shannon-toppo/PhySim/releases/tag/1.1.0
[1.0.0]: https://github.com/Shannon-toppo/PhySim/releases/tag/1.0.0
[0.4.6]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.4.6
[0.4.5]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.4.5
[0.4.4]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.4.4
[0.4.3]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.4.3
[0.4.2]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.4.2
[0.4.1]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.4.1
[0.4.0]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.4.0
[0.3.0]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.3.0
[0.2.0]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.2.0
[0.1.3]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.1.3
[0.1.1]: https://github.com/Shannon-toppo/PhySim/releases/tag/0.1.1
