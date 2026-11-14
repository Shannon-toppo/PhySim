# 変更履歴

> 2.x（プレリリース）の変更履歴です。2.xが正式版になるまで、リポジトリ直下の`CHANGELOG.md`は1.xの内容のままにしています。正式版にするときに、このファイルと入れ替えます。

PhySimの主な変更点です。各バージョンの詳細は[GitHub Releases](https://github.com/Shannon-toppo/PhySim/releases)を参照してください。

## [Unreleased]

## [2.0.0] - 未リリース

PhySimがマイコンのLuaを自分で実行するようになりました。Luaの実行には[Storm Lua Engine](https://www.npmjs.com/package/@stormcat-works/storm-lua-engine) 0.4.1を使います。LifeBoatAPIは不要になり、Windows・macOS・Linuxで同じ実装が動きます。

### 互換性のない変更
- LifeBoatAPI（`NameousChangey.lifeboatapi`）に依存しなくなりました。PhySimを入れてもLifeBoatAPIは一緒に入りません。スクリプトはLifeBoatAPIのF6ではなく、PhySimの`PhySim: Run`（F6）で実行します。
- PhySimのF6（実行）とF7（ビルド）はLifeBoatAPIと同じキーです。両方を入れていると競合します。設定`physim.keybindings.useF6F7`をオフにすると、PhySimはF6とF7を使わなくなります。Shift+F6（実行）とShift+F7（ビルド）は、設定に関係なく使えます。
- LifeBoatAPIのLuaライブラリ（LBVecなど）は同梱していません。LifeBoatAPIで作ったプロジェクトなら、ワークスペースの`_build/libs`にライブラリがあり、PhySimはそこを自動で探します。別の場所に置いている場合は、そのフォルダを`physim.libraryPaths`に追加してください。
- モニターの色に、LifeBoatAPIと同じ明るさの補正をかけなくなりました。`setColor`に渡した値のまま表示するので、1.xより暗く見えます。MonitorsヘッダーのTrue colourは最初からオンになりました。1.xと同じ明るさで見たいときは、True colourをオフにします。
- 設定`physim.port`、`physim.autoInjectLibraryPath`、`physim.monitors.useBuiltInOnWindows`を削除しました。
- エディタの補完用に、同梱の`lua/`を`lifeboatapi.stormworks.libs.libraryPaths`へ書き込む処理を削除しました。
- `simulator:setFrameRate`は何もしません。実行の速さはパネルのシミュレーション速度で決まります。
- `onDraw`の中で`input`や`output`の関数を呼ぶと、ゲームと同じくエラーになり、スクリプトが止まります。`onTick`の中で`screen`の関数を呼んだときも同じです。
- `screen.drawMap`は地形を描かず、海の色（`screen.setMapColorOcean`の色）で塗りつぶします。1.xのPhySimのモニター表示と同じ扱いです。`map.screenToMap` / `map.mapToScreen`はLifeBoatAPIのシミュレーターと同じ式で計算します。
- 対応するVS Codeを1.101以降にしました。

### 追加
- `PhySim: Run (Current Lua File)`（F6）、`PhySim: Run Without Debugging`、`PhySim: Stop`。エディタの右上にも実行・停止ボタンが出ます。
- デバッガ。行ブレークポイント、ステップイン / オーバー / アウト、呼び出し履歴、ローカル変数とアップバリュー、テーブルの展開、ウォッチ式とホバーでの値の表示に対応しています。`print`と`debug.log`の出力はデバッグコンソールに出て、行をクリックすると呼び出した場所に移動します。一時停止ボタンは使えません。
- `PhySim: Build (Link and Minify)`（F7）。`require`したファイルを結合し、`---@section __LB_SIMULATOR_ONLY__`と使われていない`---@section`を取り除き、minifyします。ゲームの上限8192文字と比べた文字数を通知し、問題は問題ビューに出します。
- 設定`physim.libraryPaths`、`physim.build.minify`、`physim.build.outputDirectory`。
- `launch.json`に書ける`physim`型のデバッグ構成。
- ボタンとスライダー。LifeBoatAPIのシミュレーター画面にあったものを、パネルのモニターの下に出します。スクリプトが`simulator:getIsClicked(n)`、`getIsToggled(n)`、`getSlider(n)`で使っている番号（1〜10）だけが出ます。
- ワークスペースの`_build/libs`を`require`の探索先に加えました。LifeBoatAPIがライブラリを置く場所なので、`require("LifeBoatAPI")`が設定なしで動きます。
- AIエージェント連携（ベータ）。MCPサーバーを同梱しました。エージェントは姿勢の設定、tick単位の実行、入力チャンネルとプロパティの設定、モニターのタッチ、ビルドを行い、出力チャンネル、ログ、Luaエラー、モニターの画素を数値で受け取ります。設定は`PhySim: Copy MCP Server Config for AI Agents (Beta)`でコピーします。Node.js 22.18以上が必要です。ツールの名前と引数は、ベータの間は変わることがあります。
- AIエージェントの実行をパネルに映す機能（ベータ）。スクリプトのフォルダをVSCodeで開いていると、エージェントがツールを呼ぶたびに、モニターの画像とギズモの姿勢がパネルに映ります。パネルは見るだけで、エージェントの実行は変えられません。設定`physim.agent.showInPanel`で切れます。接続にはホームフォルダの`.physim`に置くローカルのソケット（Windowsでは名前付きパイプ）を使い、ネットワークのポートは開きません。

### 変更
- LifeBoatAPI向けのスクリプトはそのまま動きます。グローバル`simulator`、`onLBSimulatorTick`、ドット区切りで同じファイルを2回読まない`require`をPhySimが用意します。ワークスペースに残っている`lifeboatapi.stormworks.libs.libraryPaths`も読みます。
- `require("PhySim")`は設定なしで見つかります。`PhySim.lua`のAPI（`PhySim:new()`、`update()`、`injectAsInputs()`、各値の取得、`tickRate()`、`close()`）は変わりません。`PhySim:new(host, port)`の引数と`close()`は受け付けて無視します。
- モニターはStorm Lua Engineが描きます。実機のスクリーンショット86ページすべてで、エンジンの描画が画素単位で一致することをテストで確かめています。
- シミュレーション速度は、`phys:injectAsInputs`を呼ばないスクリプトにも効くようになりました。
- 複数モニターで取り外したモニターは、電源OFFではなく実際に取り除かれます。
- `_build/_simulator.lua`を書き換えなくなりました。

### 修正
- 1.xを使ったことのあるワークスペースで、`require("PhySim")`が1.xの`PhySim.lua`を読み込んでしまう問題を直しました。1.xは`lifeboatapi.stormworks.libs.libraryPaths`に自分の`lua/`を書き込んでいたため、この設定を同梱の`lua/`より後に探すようにしました。
- 回転の値が-πよりごくわずかに小さいとき、[-π, π)に収めた結果が+πになることがある問題を直しました。

### 削除
- TCPポート14238 / 14239と、接続を確かめるトークン。PhySimはポートを開きません。
- 同梱していたmacOS用のluasocket。

### 未確認（リリース前に確かめること）
- 自動テストはmacOSのNodeでだけ実行しました。実際のVS Code上での動作（パネルへのモニター表示、デバッグUI、F6 / F7のキー割り当て、`.vsix`からのインストール）と、Windows・Linuxでの動作はまだ確かめていません。
- Storm Lua EngineはNode 22.18以降を求めます。これを満たすNodeを同梱した最初のVS Codeがどのバージョンかは確かめていません。`engines.vscode`の`^1.101.0`が正しいかは、この点を確かめてから決めます。

## [1.2.1] - 2026-10-24

### 修正
- PhySimが開くポート（14238と14239）に、F6で起動したシミュレーター以外のプログラムが接続できないようにしました。以前は同じマシン上のプログラムやWebページが接続するだけで、動いているシミュレーションを止められました。F6のたびに作り直すトークンで接続を確かめます。

## [1.2.0] - 2026-10-03

### 追加
- モニター表示だけを別ウィンドウに出す設定`physim.monitors.openInNewWindow`（既定はoff）と、コマンド`PhySim: Open Monitors in New Window`。別ウィンドウを開いている間、パネル側のモニター欄は消えて3Dビューが広がります。ウィンドウを閉じると、モニターはパネルに戻ります。
- VS Codeの表示言語が日本語のとき、設定画面の説明文・コマンド名・通知メッセージを日本語で表示するようにしました。パネル内のボタンは英語のままです。

### 変更
- マーケットプレイスのプレビュー表示を外しました。
- 対応するVS Codeを1.73以降にしました（通知メッセージの翻訳に`vscode.l10n`を使うため）。

## [1.1.2] - 2026-09-25

### 修正
- 自前モニター表示の描画を、新しく撮った実機のスクリーンショットに合わせて2点直しました。1x1〜9x5のモニターで撮った86ページを、画素単位で再現します。
  - 塗り円（`drawCircleF`）の水平な辺がちょうど画素の行に乗ったとき、下の辺の行は描かれ、上の辺の行は描かれないようにしました。以前は逆でした。
  - 頂点がちょうど1/512pxの境目に乗ったときの丸め方を、Windows（GeForce RTX 4070Ti）の実機に合わせました。向きはモニターの大きさで変わります。Macの実機とは、この場合に1画素ずれることがあります。

### 変更
- READMEをマーケットプレイス向けに書き直しました。変更履歴（このCHANGELOG）と開発者向けの内容（CONTRIBUTING.md）をREADMEから分けました。
- `physim.monitors.useBuiltInOnWindows`の説明文を今の実装に合わせました。

## [1.1.1] - 2026-09-24

VS Code Marketplaceで公開した最初のバージョンです（プレビュー）。

### 追加
- シミュレーション速度（×1 / ×0.5 / ×0.25 / ×0.1）。パネルのSimulate / Playと、LifeBoatAPI側のマイコンのtickを同じ倍率で遅くします。1ティックの中身（m/tick・rad/tick）は変わりません。
- `phys:tickRate()`。パネルのシミュレーション速度をティック/秒で返します。
- CSVログに`game_time_s`（ゲーム内秒数）と`time_scale`（記録時の速度）の列を追加しました（19 → 21列）。
- 拡張機能のアイコン。

### 変更
- 信頼されていないワークスペースと仮想ワークスペースでは動かないことを`package.json`に明記しました。
- 実機検証用のスクリプト（`tools/ingame/verify*.lua`）をASCIIだけにしました。ゲーム内エディタにそのまま貼れます。

## [1.1.0] - 2026-09-22

### 変更
- 自前モニター表示の描画を、実機Stormworksのスクリーンショットに合わせました。1x1〜9x5の8種類のモニターで撮った62ページを、画素単位で再現します。
  - 線: 終点の画素は描かれません。0.5pxの線は1画素、0.3pxの線は描かれません。
  - 円: 半径に応じた8〜16角形として描かれます。負の半径は絶対値の円と同じになります。
  - 塗り（`drawCircleF` / `drawTriangleF` / `drawRectF`）の縁の画素が実機と同じになりました。
  - `drawRect`は(w+1)×(h+1)の大きさになり、幅0でも描かれます。
  - 半透明色の合成が実機と同じ式になりました。
  - 文字: ASCII全95字を実機と照合し、20字の形を直して`&`と`` ` ``を追加しました。
  - `drawTextBox`は実機と同じく文字数で折り返し、空白を削りません。

## [1.0.0] - 2026-09-09

### 追加
- 複数モニター。自前モニター表示で、1つのマイコンに複数のモニターを繋いだ構成を再現できます。
- サイドバーの表示切り替え（◫ Values / **H**）。
- 3Dビューポートとモニター表示の境界をドラッグして、モニター領域の高さを変えられるようにしました。

## [0.4.6] - 2026-08-26

### 追加
- CH1–17のCSVロギング。

### 修正
- WindowsでCSVの保存先ダイアログが開かない問題。

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
- **True colour** オプション。LifeBoatAPIのガンマ補正を打ち消し、`setColor`に渡した値のまま表示します。
- Windowsでも自前モニター表示を使える実験的設定（`physim.monitors.useBuiltInOnWindows`、既定OFF）。

### 変更
- 自前モニター表示の図形を、アンチエイリアス無しでピクセルグリッドに描くようにしました。

## [0.4.2] - 2026-08-18

### 追加
- モニター表示のピンチズーム（Ctrl/Cmd + ホイールも同じ操作）。

## [0.4.1] - 2026-08-08

### 変更
- CH4–6（回転）を[-π, π)に正規化しました。`phys:rotation()`も同じ値を返します。

## [0.4.0] - 2026-08-07

### 追加
- macOS対応。luasocketを同梱し、`STORMWORKS_Simulator.exe`の代わりにモニターをパネル内に描画します。

## [0.3.0] - 2026-07-03

### 追加
- シミュレーション動作の録画と再生。

### 修正
- 飛行機モデルの尾翼の形。

## [0.2.0] - 2026-06-09

### 追加
- Simulateモード。速度・加速度を位置・回転に積分し、ギズモが自動で動きます。
- 位置・回転の数値入力と、姿勢プリセットの保存・呼び出し。

## [0.1.3] - 2026-05-25

### 追加
- パネルを開く位置の設定（`physim.panel.openLocation`）。

### 修正
- モード切り替え時に、パネルが補助ウィンドウへ復元される問題。

## [0.1.1] - 2026-05-23

- 最初の公開版。

[Unreleased]: https://github.com/Shannon-toppo/PhySim/compare/1.2.1...HEAD
[2.0.0]: https://github.com/Shannon-toppo/PhySim/releases/tag/2.0.0
[1.2.1]: https://github.com/Shannon-toppo/PhySim/releases/tag/1.2.1
[1.2.0]: https://github.com/Shannon-toppo/PhySim/releases/tag/1.2.0
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
