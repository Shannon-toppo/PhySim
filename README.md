# Stormworks Physics Sensor Sim (PhySim)

### [English](https://github.com/Shannon-toppo/PhySim/blob/main/doc/README_en.md)

Stormworks のマイコン開発で、`physics sensor` ブロックの値を 3D ギズモから与えられる VSCode 拡張機能です。
**Stormworks Lua with LifeBoatAPI** のシミュレーターと連携して動くので、ゲームを起動せずに
PIDコントローラー・INS・オートパイロットなどのロジックをテストできます。

![PhySimの使用例](https://raw.githubusercontent.com/Shannon-toppo/PhySim/main/Animation.gif)

- 3Dギズモで機体の位置・姿勢を動かすと、その値が `input.getNumber(1..17)` にそのまま届きます
- 速度・加速度を与えて自動で動かす **Simulate** モード、記録と再生
- シミュレーション速度の切り替え（×1 / ×0.5 / ×0.25 / ×0.1）と CSV ロギング
- macOS でも動作します。マイコンのモニター表示は、実機のスクリーンショットと画素単位で照合した PhySim の自前実装です

## 動作要件

| 項目 | 要件 |
|------|------|
| VSCode | 1.62 以上（`physim.panel.openLocation` の `newWindow` は 1.85 以上） |
| LifeBoatAPI | [Stormworks Lua with LifeBoatAPI](https://marketplace.visualstudio.com/items?itemName=NameousChangey.lifeboatapi)。0.0.33 で動作確認済み。PhySim をインストールすると自動で一緒に入ります |
| OS | Windows / macOS（Apple Silicon・Intel）。Linux は非対応 |

## インストール

VSCode の拡張機能ビューで「**Stormworks Physics Sensor Sim**」を検索してインストールするか、
コマンドパレット（Ctrl+P / Cmd+P）で次を実行します。

```
ext install shannon-toppo.physim
```

### GitHub Releases の .vsix から入れる

マーケットプレイスを使えない環境向けに、同じものを [GitHub Releases](https://github.com/Shannon-toppo/PhySim/releases)
でも `.vsix` として配布しています。ダウンロードした `.vsix` を拡張機能ビューにドラッグ&ドロップするか、
拡張機能ビューの「…」メニューの **VSIX からのインストール** で入れてください。

- マーケットプレイス版と同じ拡張機能（`shannon-toppo.physim`）として扱われるので、両方を入れる必要はありません。
- `.vsix` で入れた場合でも、マーケットプレイスに新しいバージョンが出ると VSCode の自動更新で置き換わります。
  特定のバージョンに固定したいときは、拡張機能ビューで PhySim の自動更新をオフにしてください。
- `.vsix` でも LifeBoatAPI はマーケットプレイスから自動でインストールされます（オフライン環境では先に入れておいてください）。

## クイックスタート

1. Stormworksマイコンプロジェクト（LifeBoatAPI のプロジェクト）を開きます。
   補完用のライブラリパスは自動で `lifeboatapi.stormworks.libs.libraryPaths` に追加されます
   （`physim.autoInjectLibraryPath` で無効にできます）。
2. `MyMicrocontroller.lua` に以下を追記します:

   ```lua
   -- LifeBoatAPIのサンドボックス require() は戻り値を破棄するため、
   -- モジュールはグローバルとして公開されます。
   -- `phys = require("PhySim"):new()` ではなく、以下のペアを使用してください。
   require("PhySim")
   phys = PhySim:new()

   function onLBSimulatorTick(simulator, ticks)
       phys:update()
       phys:injectAsInputs(simulator, 1)   -- input.getNumber(1..17) に書き込む
   end

   function onTick()
       local px, py, pz = input.getNumber(1), input.getNumber(2), input.getNumber(3)
       local rx, ry, rz = input.getNumber(4), input.getNumber(5), input.getNumber(6)
       -- ... 実際のphysics sensorブロックから来た値として使用 ...
   end
   ```

   モニターのタッチ入力も使う場合は、開始チャンネルを 1 以外にしてください（下記「タッチ入力とチャンネルの競合」）。

3. **F6** を押してLifeBoatAPIシミュレーターを起動します。PhySimパネルが隣に開きます
   （`physim.panel.openLocation` を `newWindow` に設定すると別ウィンドウで開きます）。
   ギズモをドラッグすると、Luaがリアルタイムに値の変化を受け取ります。

## 機能

- 平行移動・回転ギズモ付き3Dビューポート
- 線形・角速度、および線形・角加速度のスライダー。位置・回転は数値でも入力でき、姿勢をプリセットとして保存・呼び出しできます
- **Simulate** トグル — 毎ティック速度・加速度を位置/回転に積分し、ギズモが自動で動きます
- **シミュレーション速度** — パネルの Simulate / Play と、マイコン側の tick を同じ倍率で遅くします（下記「シミュレーション速度」）
- **軌跡（トレイル）と速度ベクトル矢印** — 直近Nティックの通過位置を3Dシーンに線で描き、
  現在の線速度を矢印で示します。サイドバーの「Visualization」で切り替え、
  トレイル長は 2/5/10/30 秒から選べます
- **CSV ロギング** — CH1–17 を CSV ファイルに書き出します（下記「CSV ロギング」）
- **表示領域のリサイズ** — 3Dビューポートとモニター表示の境界をドラッグすると、
  モニター領域の高さを変えられます
- **サイドバーの表示切り替え** — ツールバーの「◫ Values」で右側のスライダー・数値入力・チャンネル表を隠し、
  3Dビューポートとモニター表示をパネル幅いっぱいに広げられます
- 全17チャンネルのライブ表示

値はローカルTCPソケット経由で小さなLuaヘルパー（`PhySim.lua`）にストリーミングされ、次のいずれかとして利用できます:

- 標準の `input.getNumber(N)` テーブルへの注入
- `phys:position()`・`phys:rotation()` などによる直接クエリ

## 操作方法

### コマンド

コマンドパレット（Ctrl+Shift+P / Cmd+Shift+P）から実行できます。

| コマンド | 内容 |
|----------|------|
| `PhySim: Open Physics Sensor Panel` | パネルを開く（自動で開かなかったとき用） |
| `PhySim: Reset Gizmo` | Simulate を止め、位置・回転・速度・加速度をすべて 0 に戻す |
| `PhySim: Show Log` | PhySim の動作ログを表示する（不具合の調査用） |

### パネル内のショートカット

数値入力欄にフォーカスがあるときは無効です。

| キー / 操作 | 内容 |
|-------------|------|
| **Space** | Simulate のオン/オフ |
| **W** / **E** | ギズモを平行移動 / 回転モードに切り替え |
| **R** | ギズモのリセット |
| **H** | サイドバーの表示切り替え |
| 左ドラッグ（ギズモ以外の場所） | 視点の回転 |
| 右ドラッグ / ホイールドラッグ | 視点の平行移動 |
| ホイール | ズーム |

3Dビューとモニター表示の境界では、ドラッグで高さ変更、矢印キー（Shiftで大きく）で微調整、
ダブルクリックまたは Home / End で内容に合わせた自動サイズに戻ります。

## 座標系

Stormworksは**左手系**ワールド座標系を使用しています:

| 軸  | 方向               |
|-----|--------------------|
| X+  | 東 (East)          |
| Y+  | 上 (Up/垂直)       |
| Z+  | 北 (North)         |

ギズモビューポートはThree.jsの右手系座標でレンダリングされており、カメラは
+Zが画面**奥方向**（視点から離れる方向）に伸びるように配置されています。
これにより「北が前方」という直感的なレイアウトになっています。

回転はThree.jsのEuler XYZ順のラジアンで出力され、**[-π, π)** に正規化されます。
1回転を超えても値が積み上がらず、折り返します。

## チャンネルレイアウト

`PhySim:injectAsInputs(simulator, startCh)` は `startCh`（デフォルト: `1`）から
始まる17個の連続したチャンネルに書き込みます:

| CH  | 物理量                | 単位        | 備考                                           |
|-----|-----------------------|-------------|------------------------------------------------|
| 1   | 位置 X                | m (東方向)  |                                                |
| 2   | 位置 Y                | m (上方向)  |                                                |
| 3   | 位置 Z                | m (北方向)  |                                                |
| 4   | 回転 X                | rad         | Euler XYZ（内在的）、[-π, π) に正規化           |
| 5   | 回転 Y                | rad         | 〃                                             |
| 6   | 回転 Z                | rad         | 〃                                             |
| 7   | 線速度 X              | m/tick      |                                                |
| 8   | 線速度 Y              | m/tick      |                                                |
| 9   | 線速度 Z              | m/tick      |                                                |
| 10  | 角速度 X              | rad/tick    |                                                |
| 11  | 角速度 Y              | rad/tick    |                                                |
| 12  | 角速度 Z              | rad/tick    |                                                |
| 13  | 線速度絶対値          | m/s         | √(vx²+vy²+vz²) × 60                           |
| 14  | 角速度絶対値          | RPS         | √(ax²+ay²+az²) × 60 / 2π                      |
| 15  | Tilt.z                | rotation    | ローカル+Z（前方）の水平面からの傾き            |
| 16  | Tilt.x                | rotation    | ローカル-X（左方向）の水平面からの傾き          |
| 17  | コンパス              | rotation    | 北=0, 西=+0.25, 南=±0.5, 東=-0.25（上から見てCCW） |

「rotation」単位: 1.0 = 1回転（2π rad）。Tiltの範囲は [-0.25, +0.25]（水平から±90°）。
コンパスは ±0.5 で折り返します。

### タッチ入力とチャンネルの競合

LifeBoatAPI は毎ティック `input.getNumber(1..6)` に画面幅・高さ・タッチX・タッチY・
altタッチX・altタッチY を書き込みます（`Simulator._simulateDefaultInputs`）。
`phys:injectAsInputs(simulator, 1)` はこの直後に走って CH1-6 を上書きするため、
**モニターのタッチ座標はマイコンに届きません**。LifeBoatAPI は外部から値を設定した
チャンネルを優先する仕組みなので、以降はタッチの値で上書きされません。
タッチ座標を使う場合は開始チャンネルをずらしてください。

```lua
phys:injectAsInputs(simulator, 7)   -- CH7-23。CH1-6 をタッチ用に空ける
```

`input.getBool(1)`（押されているか）は PhySim が bool を書かないため、開始チャンネルが
1 のままでも使えます。また `_simulateDefaultInputs` が読むのは画面1だけなので、
2枚目以降のモニターのタッチは `simulator:getTouchScreen(2)` で自分で読んでください
（`STORMWORKS_Simulator.exe` でも同じです）。alt タッチは PhySim では未実装で常に0です。

## シミュレーション速度

ツールバーのドロップダウン（×1 / ×0.5 / ×0.25 / ×0.1）で、動きをゆっくり観察できます。
遅くなるのは次の2つで、どちらも同じ倍率です。

- パネル側: **Simulate** の積分と **Play** の再生
- マイコン側: LifeBoatAPI のメインループ（`onLBSimulatorTick` / `onTick` / `onDraw` の呼び出し間隔）

1ティックに進む量はスライダーの値（m/tick・rad/tick）のままで、CH13/14 の「×60」も
ゲーム内の1秒としてそのまま正しい値です。マイコンから見ると、ゲームがゆっくり動いているのと同じです。
片方だけを遅くしないのは、位置の変化と速度チャンネルが食い違うのを避けるためです。

選んだ速度はワークスペースごとに保存され、次回のデバッグセッションでも使われます。
×1 以外のときはドロップダウンが黄色になるので、前回の設定が残っていても分かります。

注意点:

- マイコン側に速度を伝えるのは `phys:injectAsInputs(simulator, …)` です。これを呼ばず
  `phys:update()` だけを使っている場合、遅くなるのはパネル側だけです。
- パネルを閉じる、`phys:close()` を呼ぶ、PhySim との接続が切れる、のいずれかで
  マイコン側は 60 ティック/秒に戻ります。
- Windows で `STORMWORKS_Simulator.exe` 側からもティックレートを変えた場合は、後から
  変えたほうが有効になります。PhySim は速度を変えたときと接続したときにだけ書き込みます。
- 一時停止やコマ送りには対応していません。

## CSV ロギング

ツールバーの **⬇ CSV Log** を押すと保存先を尋ねるダイアログが開き、選択した時点から
記録が始まります。もう一度押すと停止し、通知の **Open** からそのまま開けます。
記録中はボタンの横に行数が出ます。

行が書かれるタイミングは2つです。**Simulate** / **Play** 実行中は1ティック（1/60秒）
につき1行、停止中はギズモのドラッグや数値入力でセンサー値が変わるたびに1行。
つまりサンプル間隔は一定ではないので、時間軸には `time_s` か `game_time_s` 列を使ってください。
シミュレーション速度を落として記録した場合、速度の列と合うのは `game_time_s` のほうです。

列は `sample,time_s,game_time_s,time_scale,ch1_pos_x,…,ch17_compass` の21列です。

| 列        | 内容                                             |
|-----------|--------------------------------------------------|
| `sample`  | そのログ内での行番号（0始まり）                  |
| `time_s`  | 記録開始からの経過秒数（実時間）                 |
| `game_time_s` | 記録開始からのゲーム内秒数（ティック数 ÷ 60）。停止中のドラッグでは進まない |
| `time_scale`  | その行を記録したときのシミュレーション速度（1 = 等速） |
| `ch1`–`ch17` | チャンネル値。上の表と同じ単位・同じ丸め（小数6桁）|

改行は CRLF、数値は Lua 側へ送られる値と同じ書式なので、Excel・pandas・
gnuplot などにそのまま読み込めます。

## Lua API

`require("PhySim")` 後、グローバル `PhySim` がクラステーブルになります。

| メソッド                              | 戻り値 / 効果                                        |
|---------------------------------------|------------------------------------------------------|
| `PhySim:new(host?, port?)`            | 構築＆接続。デフォルト: `127.0.0.1:14239`            |
| `phys:update()`                       | ソケットを読み出す。1tickに1回呼び出してください      |
| `phys:position()`                     | `x, y, z` (m)                                        |
| `phys:rotation()`                     | `rx, ry, rz` (rad)                                   |
| `phys:velocity()`                     | `vx, vy, vz` (m/tick)                                |
| `phys:angularVelocity()`              | `ax, ay, az` (rad/tick)                              |
| `phys:injectAsInputs(simulator, n?)`  | CH `n..n+16` を `input.getNumber(...)` に書き込む。パネルのシミュレーション速度もここで反映される |
| `phys:tickRate()`                     | パネルのシミュレーション速度（ティック/秒、60 = 等速） |
| `phys:close()`                        | ソケットを閉じ、ティックレートを 60 に戻す            |

## 拡張機能の設定

| 設定                                 | デフォルト | 説明                                                                   |
|--------------------------------------|------------|------------------------------------------------------------------------|
| `physim.port`                        | 14239      | 拡張機能がリッスンするTCPポート。変えた場合は Lua 側も `PhySim:new("127.0.0.1", ポート)` で合わせてください |
| `physim.autoOpenOnSimulate`          | true       | LifeBoatAPIの「Run Simulator」起動時にパネルを自動で開く               |
| `physim.panel.openLocation`          | beside     | パネルを開く位置。`beside` = アクティブエディタの隣に分離、`newWindow` = 別ウィンドウで開く（VSCode 1.85以降が必要） |
| `physim.autoInjectLibraryPath`       | true       | `<extension>/lua/` を `lifeboatapi.stormworks.libs.libraryPaths` に追加 |
| `physim.monitors.useBuiltInOnWindows` | false     | **実験的機能・Windows専用。** `STORMWORKS_Simulator.exe` を起動せず、モニターを PhySim パネルに描画する。macOSでは自前実装しか選択肢が無いため無視されます |

## 対応プラットフォーム

- **Windows** — LifeBoatAPI 自体のシミュレーターUI（`STORMWORKS_Simulator.exe`）をそのまま使用します。
  設定で PhySim 側のモニター表示に切り替えることもできます（下記「Windowsで自前のモニター表示を使う」）。
- **macOS** — LifeBoatAPI は Windows 向けに作られています。PhySim が macOS で必要なものを用意するので、macOS でも使えます。
  モニター表示は PhySim の自前実装です。

### PhySim のモニター表示

macOS では `STORMWORKS_Simulator.exe` が動かないため、マイコンのモニターは PhySim パネル内に描画されます。
タッチ入力もパネルのモニターから送れます。表示倍率は Zoom のドロップダウン、
トラックパッドのピンチ、Ctrl/Cmd + ホイールで変更できます。

**描画の精度** — 描画規則は、ゲーム内のモニター（Stormworks v1.15.23）に検証用スクリプトを
表示させたスクリーンショットから求めています。線・円・塗りつぶし・矩形・文字・`drawTextBox` の
折り返し・半透明色の重ね合わせについて、撮影した全ページ（1x1〜9x5 の各サイズ）を
画素単位で再現することをテストで確認しています。

- 円はゲームと同じく、半径に応じた 8〜16 角形で描かれます
- 文字はゲームのフォント（ASCII 32〜126 の全95文字）と一致してます
- アンチエイリアスは無く、ゲームと同じドット感で表示されます

検証の詳細は [`doc/ingame-findings.md`](https://github.com/Shannon-toppo/PhySim/blob/main/doc/ingame-findings.md) にあります。

> **ベータ版です。** モニター表示は LifeBoatAPI ではなく PhySim が実装・保守しているため、
> UI や動作がリリース間で変わる可能性があります。

**色** — LifeBoatAPI はゲームの見た目に合わせるため、Lua 側で全ての色にガンマ補正を
かけています。暗い色ほど明るく表示されます（`setColor` の30は112になり、
217以上は白になります）。PhySim は exe と同様、届いた値をそのまま描画します。
Monitors ヘッダーの **True colour** をONにするとこの補正を打ち消し、`setColor` に
渡した生の値で表示します。デフォルトはOFFです（白っぽい見え方がゲーム再現として
正しいため）。

`STORMWORKS_Simulator.exe` と比べて、以下の点は再現していません。

- `screen.drawMap` の背後に地形データが無いため、代わりに海一色で塗りつぶします
- タッチはプライマリのみ（alt 側のタッチ値は常に 0）
- exe の入出力パネル。チャンネルは PhySim パネルから操作してください
- 縦置き（Portrait）のモニターは、実機との照合がまだ済んでいません

macOS 対応の仕組みは [`doc/macos-support.md`](https://github.com/Shannon-toppo/PhySim/blob/main/doc/macos-support.md) にまとめています。

### 複数モニター

ゲーム内でマイコンに複数のモニターを繋いだ構成を、そのままパネル上で再現できます。

Monitors ヘッダーの **+ Monitor** で画面を追加し、各モニターのキャプション行にある
ドロップダウンでサイズ（`1x1` 〜 `9x5`）、**Portrait** で縦置き、**✕** で取り外しを
操作します。シミュレーターは有効なモニターごとに `onDraw` を1回ずつ呼び、その中の
`screen.getWidth()` / `getHeight()` は「今描いている画面」のサイズを返すので、
マイコン側のコードはゲーム内と同じ書き方で画面を出し分けられます。タッチ入力も
モニターごとに独立して送られますが、コンポジット入力に自動で流れるのは画面1だけです
（上記「タッチ入力とチャンネルの競合」）。

- マイコンのスクリプトが `simulator:setScreen(...)` で宣言した画面が優先されます。
  パネルの設定は、スクリプトが触っていない画面番号にだけ効きます。
- 画面1は取り外せません。LifeBoatAPI の既定の画面であり、サイズとタッチが
  コンポジット入力に流れる唯一の画面のためです。
- 取り外しは電源OFFとして送られます。Lua 側に画面を削除する手段が無いためで、
  もう一度追加するか、スクリプトが `setScreen` を呼べば復活します。
- レイアウトはワークスペースごとに保存され、次のデバッグセッションで復元されます。
- 表示倍率は全モニター共通です。画面ごとに合わせると 1x1 が 3x3 より大きく表示されて
  しまい、相対的な大きさが分からなくなるためです。

この機能は PhySim のモニター表示を使っている場合（macOS 常時 / Windows は
`physim.monitors.useBuiltInOnWindows`）にのみ利用できます。`STORMWORKS_Simulator.exe`
を使う通常の Windows 環境では、モニターの構成は従来どおりスクリプト側の
`simulator:setScreen` で行ってください。

### Windowsで自前のモニター表示を使う（実験的機能）

`physim.monitors.useBuiltInOnWindows` を `true` にすると、Windows でも
`STORMWORKS_Simulator.exe` を起動せず、マイコンのモニターを PhySim パネル内に
描画します。LifeBoatAPI に用意されている、起動済みのシミュレーターに接続する設定を
使うので、exe は起動しません。設定は次の **F6** から反映され、ウィンドウの再読み込みは不要です。

ONにしても変化が無い場合は、コマンドパレットから **PhySim: Show Log** を実行してください。
F6ごとにどちらの描画を選んだか、14238番ポートを実際に確保できたか、`_simulator.lua` への
パッチが当たったかがログに出ます。

デフォルトはOFFです。どちらを使うかは次の違いで選んでください。

- **PhySim の表示が向いている場合** — 図形や文字を、実機のスクリーンショットに合わせた規則で確かめたいとき。
- **exe が向いている場合** — `screen.drawMap` の地図、alt タッチ、exe の入出力パネルを使いたいとき。

### Tip: モニターシミュレーションだけ使う場合

モニター表示だけが目的なら、マイコンのスクリプトに `require("PhySim")`・`PhySim:new()`・
`phys:update()`・`phys:injectAsInputs()` を書き足す必要はありません。モニター表示は
LifeBoatAPI 自身の描画命令を14238番ポートで受け取っているだけで、`PhySim.lua` とは
独立しています。いつもどおり **F6** を押せば、既存のプロジェクトのまま PhySim パネルに
モニターが表示され、タッチ入力も届きます（macOS 常時 / Windows は
`physim.monitors.useBuiltInOnWindows` が有効な場合）。

この場合 physics sensor のチャンネル（CH1–17）はマイコンに届かないので、ギズモを
動かしてもスクリプトには影響しません。その代わり、上記「タッチ入力とチャンネルの競合」
で説明している CH1-6 の上書きも起きません。

## 通信について

PhySim は LifeBoatAPI のシミュレーターと値をやり取りするため、自分のPC内（`127.0.0.1`）だけで
TCPポートを待ち受けます。外部のサーバーとは一切通信しません。

| ポート | 使うとき | 用途 |
|--------|----------|------|
| 14239（`physim.port` で変更可） | シミュレーター実行中は常に | パネル → `PhySim.lua` へのセンサー値の送信 |
| 14238 | PhySim のモニター表示を使うとき（macOS / Windows の実験的設定） | `STORMWORKS_Simulator.exe` の代わりにモニター描画を受け取る |

どちらもデバッグセッションの開始時に開き、終了時に閉じます。

### LifeBoatAPI が生成するファイルへの追記

PhySim は F6 のたびに、LifeBoatAPI がワークスペースに生成する `_build/_simulator.lua` に
接続用の数行を追加します。LifeBoatAPI 本体のファイルは変更しません。

## トラブルシューティング

**F6 を押してもパネルが開かない**
- `physim.autoOpenOnSimulate` が `false` になっていないか確認してください。
  コマンドパレットの **PhySim: Open Physics Sensor Panel** で手動でも開けます。
- PhySim が反応するのは LifeBoatAPI の F6 で起動される「Run Simulator」セッションだけです。
  独自の launch 構成で Lua を起動している場合は対象外です。
- **PhySim: Show Log** で、セッションを検出したか、パッチが当たったかを確認できます。

**「failed to bind TCP port 14239」と表示される**
- 別のプロセス（前回のシミュレーターの残りなど）がポートを使っています。VSCode を再起動するか、
  `physim.port` を別の番号にして Lua 側の `PhySim:new("127.0.0.1", ポート)` も合わせてください。

**`phys = require("PhySim"):new()` でエラーになる**
- LifeBoatAPI のサンドボックスでは `require` が戻り値を返しません。
  `require("PhySim")` と `phys = PhySim:new()` の2行に分けてください（クイックスタート参照）。

**モニターのタッチがマイコンに届かない**
- `injectAsInputs(simulator, 1)` が CH1-6 のタッチ値を上書きしています。
  開始チャンネルを 7 などにずらしてください（「タッチ入力とチャンネルの競合」参照）。

**macOS でモニターが真っ暗のまま**
- 「could not listen on port 14238」と出ている場合は、前回のシミュレーターがポートを
  掴んだままです。デバッグセッションを止めてから F6 をやり直してください。

**Lua 側で `require("PhySim")` が見つからない / 補完が効かない**
- 実行時は PhySim が自動でパスを通すので設定は不要です。補完だけが効かない場合は
  `physim.autoInjectLibraryPath` が有効か確認し、ウィンドウを再読み込みしてください。

## 既知の制限

- Linux には対応していません
- センサーへの操作をスクリプトで自動化することはできません
- 1つのパネルを複数のマイコンデバッグセッションで共有することはできません
- シミュレーションの一時停止・コマ送りには対応していません
- PhySim のモニター表示で再現していない機能は「PhySim のモニター表示」を参照してください

## 今後追加予定の機能

以下は検討中の機能です。いずれも未実装で、記載順は優先度を意味しません。
これまでに実装した機能は [CHANGELOG](CHANGELOG.md) を参照してください。

- **複数物理センサー対応** —
  1つの MC で複数の physics sensor ブロックを使うケースに対応します。複数のギズモターゲットを配置し、
  それぞれ独立したチャンネル範囲にマップできるようにします。
- **ゲームパッド入力** —
  接続されたゲームパッド / ジョイスティックでギズモを操作します。動的シナリオではマウスドラッグより
  滑らかな入力が可能になります。

## フィードバック

不具合報告・要望は [GitHub Issues](https://github.com/Shannon-toppo/PhySim/issues) へお願いします。
不具合の場合は、**PhySim: Show Log** の内容と OS・LifeBoatAPI のバージョンを添えていただけると調査が早くなります。

PhySim を入れた状態で起きた問題は、LifeBoatAPI ではなく、まず PhySim の Issues に報告してください。

ビルド方法・テストの実行方法など、開発に参加する場合は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

PhySim は [MIT License](LICENSE) で公開しています。

### サードパーティ

PhySim には次のソフトウェアが同梱されています。

| ソフトウェア | 用途 | ライセンス |
|--------------|------|------------|
| [three.js](https://threejs.org/) r160（`three.module.js`、`OrbitControls`、`TransformControls`） | パネルの3D表示とギズモ | MIT License — Copyright © 2010-2023 three.js authors |
| [LuaSocket](https://github.com/lunarmodules/luasocket) 3.0（macOS 用バイナリ） | macOS で Lua からTCP通信するため | MIT License — Copyright © 2004-2013 Diego Nehab |

LuaSocket のライセンス全文は拡張機能内の `luasocket/darwin/LICENSE` に同梱しています。
three.js のライセンス全文は [three.js のリポジトリ](https://github.com/mrdoob/three.js/blob/r160/LICENSE) を参照してください。

### 免責

PhySim は個人が開発した非公式の拡張機能です。Stormworks: Build and Rescue の開発元である Geometa、
および Stormworks Lua with LifeBoatAPI の作者とは関係ありません。
Stormworks は Geometa の商標です。
