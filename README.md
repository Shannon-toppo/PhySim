# Stormworks Physics Sensor Sim (PhySim)

### [English](https://github.com/Shannon-toppo/PhySim/blob/main/doc/README_en.md)

**Stormworks Lua with LifeBoatAPI** と連携して動作するVSCode拡張機能です。
3Dギズモウィンドウから仮想 `physics sensor` を操作できるため、ゲームを起動せずに
PIDコントローラー・INS・オートパイロットなどのロジックをテストできます。

**F6** を押してLifeBoatAPIシミュレーターを起動すると、この拡張機能が自動的にパネルを開きます:

- 平行移動・回転ギズモ付き3Dビューポート（右マウスドラッグで視点回転）
- 線形・角速度、および線形・角加速度のスライダー
- **Simulate** トグル（スペースキー）— 毎ティック速度・加速度を位置/回転に積分し、
  ギズモが自動で動きます
- **軌跡（トレイル）と速度ベクトル矢印** — 直近Nティックの通過位置を3Dシーンに線で描き、
  現在の線速度を矢印で示します。サイドバーの「Visualization」で切り替え、
  トレイル長は 2/5/10/30 秒から選べます
- 全17チャンネルのライブ表示

値はローカルTCPソケット経由で小さなLuaヘルパー（`PhySim.lua`）にストリーミングされ、次のいずれかとして利用できます:

- 標準の `input.getNumber(N)` テーブルへの注入
- `phys:position()`・`phys:rotation()` などによる直接クエリ

## クイックスタート
1. [Stormworks Lua with LifeBoatAPI](https://marketplace.visualstudio.com/items?itemName=NameousChangey.lifeboatapi) をインストールします。
2. [Release](https://github.com/Shannon-toppo/PhySim/releases)から.vsixファイルをダウンロードし、VScodeにドラッグアンドドロップ。
3. Stormworksマイコンプロジェクトを開きます。拡張機能が `lifeboatapi.stormworks.libs.libraryPaths` に `PhySim/lua/` を自動追加するか確認します。
4. `Mymicrocontroller.lua` に以下のように追記します:

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

5. **F6** を押してLifeBoatAPIシミュレーターを起動します。PhySimパネルが隣に開きます
   （`physim.panel.openLocation` を `newWindow` に設定すると別ウィンドウで開きます）。
   ギズモをドラッグすると、Luaがリアルタイムに値の変化を受け取ります。



## 対応プラットフォーム

- **Windows** — LifeBoatAPI 自体のシミュレーターUI（`STORMWORKS_Simulator.exe`）をそのまま使用します。
  PhySim 側のモニター表示に切り替えることもできます（後述の
  [Windowsで自前のモニター表示を使う](#windowsで自前のモニター表示を使う実験的機能)）。
- **macOS** — LifeBoatAPI が Windows 専用のため、モニターシミュレーション（**ベータ版**）を
  含めて PhySim 側で自前に用意しています。詳細は下記。

### macOS — モニターシミュレーションはPhySimの自前実装

> **この機能はベータ版です。** モニターシミュレーションは上流ではなくPhySimが自前で
> 実装・保守しているため、描画・プロトコル処理・UIがリリース間で破壊的に変更される
> 可能性があります（利用側の対応が必要になる変更を含みます）。

LifeBoatAPI（`NameousChangey.lifeboatapi` 0.0.33）は Windows 用バイナリしか同梱しておらず、
何もしなければ macOS ではデバッグセッションすら起動しません。PhySim 側で次のように回避しています。

- **luasocket** — LifeBoatAPI が Windows の `.dll` しか持たないため、Lua 5.3 向けの
  universal バイナリ（arm64 + x86_64）を同梱し、Lua の `cpath` に差し込みます。
- **シミュレーターウィンドウ** — `STORMWORKS_Simulator.exe` は Windows 実行ファイルで
  macOS では動かしようがないため、**モニターシミュレーション機能を PhySim が自前で実装**
  しています。exe と同じプロトコルで14238番ポートを待ち受け、マイコンの描画命令を
  PhySim パネル内の `<canvas>` に描画し、タッチ入力を返します。図形はアンチエイリアス
  されたパスではなくピクセルグリッド上にラスタライズするので、ゲーム内のモニターと同じ
  ドット感になります。表示倍率は Zoom のドロップダウン、トラックパッドのピンチ、
  Ctrl/Cmd + ホイールで変更できます。
- **色** — LifeBoatAPI はゲームの見た目を再現するためLua側で全ての色にガンマ補正を
  かけており、暗い色ほど大きく持ち上げられます（`setColor` の30は112として届き、
  217以上は白に張り付きます）。PhySim は exe と同様、届いた値をそのまま描画します。
  Monitors ヘッダーの **True colour** をONにするとこの補正を打ち消し、`setColor` に
  渡した生の値で表示します。デフォルトはOFFです（白っぽい見え方がゲーム再現として
  正しいため）。

ゲーム本体の描画ではなく独自の再実装のため、本来のシミュレーターとは以下の点が異なります。

- 文字は手書きの 4x5 ビットマップフォントで描画するため、ゲーム内フォントに近いものの
  完全に同じ字形ではありません
- `screen.drawMap` の背後に地形データが無いため、代わりに海一色で塗りつぶします
- タッチはプライマリのみ（alt 側のタッチ値は常に 0）
- exe の入出力パネルは再現していません。チャンネルは PhySim パネルから操作してください

LifeBoatAPI 0.0.33 で動作確認済みです。調査の詳細は
[`doc/macos-support.md`](doc/macos-support.md) を参照してください。

### Windowsで自前のモニター表示を使う（実験的機能）

`physim.monitors.useBuiltInOnWindows` を `true` にすると、Windows でも
`STORMWORKS_Simulator.exe` を起動せず、マイコンのモニターを PhySim パネル内に
描画します。この場合 PhySim は LifeBoatAPI 自身の `attachToExistingProcess` の経路を
使って exe の起動を抑止し、代わりに14238番ポートに応答するので、ポートの奪い合いは
起きません。設定は次の **F6** から反映され、ウィンドウの再読み込みは不要です。

ONにしても変化が無い場合は、コマンドパレットから **PhySim: Show Log** を実行してください。
F6ごとにどちらの描画を選んだか、14238番ポートを実際に確保できたか、`_simulator.lua` への
パッチが当たったかがログに出ます。

デフォルトはOFFで、パネル内で見たい理由が特に無ければOFFのままを推奨します。Windows では
実物の exe の方が忠実で、切り替えると上記の再実装由来の制約（ビットマップフォントの文字、
地形データの無い `screen.drawMap`、プライマリのみのタッチ）に加えて、PhySim が再現していない
exe の入出力パネルも失われるためです。チャンネルは PhySim パネルから操作してください。

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
| 17  | コンパス          | rotation    | 北=0, 西=+0.25, 南=±0.5, 東=-0.25（上から見てCCW） |

「rotation」単位: 1.0 = 1回転（2π rad）。Tiltの範囲は [-0.25, +0.25]（水平から±90°）。
コンパスは ±0.5 で折り返します。


## ビルドして利用する場合

1. [Stormworks Lua with LifeBoatAPI](https://marketplace.visualstudio.com/items?itemName=NameousChangey.lifeboatapi) をインストールします。
2. PhySimをビルドして起動します（Extension Development Host: このフォルダをVSCodeで開いて **F5** を押すか、`npx vsce package` で生成された `.vsix` をインストールします）。
3. Stormworksマイコンプロジェクトを開きます。拡張機能が `lifeboatapi.stormworks.libs.libraryPaths` に `PhySim/lua/` を自動追加するか確認します。
4. `Mymicrocontroller.lua` に以下を追加します:

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

5. **F6** を押してLifeBoatAPIシミュレーターを起動します。PhySimパネルが隣に開きます。
   ギズモをドラッグすると、Luaがリアルタイムに値の変化を受け取ります。

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
| `phys:injectAsInputs(simulator, n?)`  | CH `n..n+16` を `input.getNumber(...)` に書き込む    |
| `phys:close()`                        | ソケットを閉じる                                      |

## 拡張機能の設定

| 設定                                 | デフォルト | 説明                                                                   |
|--------------------------------------|------------|------------------------------------------------------------------------|
| `physim.port`                        | 14239      | 拡張機能がリッスンするTCPポート                                         |
| `physim.autoOpenOnSimulate`          | true       | LifeBoatAPIの「Run Simulator」起動時にパネルを自動で開く               |
| `physim.panel.openLocation`          | beside     | パネルを開く位置。`beside` = アクティブエディタの隣に分離、`newWindow` = 別ウィンドウで開く（VSCode 1.85以降が必要） |
| `physim.autoInjectLibraryPath`       | true       | `<extension>/lua/` を `lifeboatapi.stormworks.libs.libraryPaths` に追加 |
| `physim.monitors.useBuiltInOnWindows` | false     | **実験的機能・Windows専用。** `STORMWORKS_Simulator.exe` を起動せず、モニターを PhySim パネルに描画する。macOSでは自前実装しか選択肢が無いため無視されます |

## 開発とテスト

```bash
npm install          # three.js を media/three/ に配置（postinstall）
npm run compile      # 拡張ホスト側ビルド (tsc → out/)
npm run lint         # eslint
npm run check:media  # WebView モジュールの strict JSDoc 型検査
npm test             # test/ 以下の node:test スイート
```

テストはワイヤプロトコル（encode → 実物の `PhySim.lua` パーサでの往復。
Lua 5.3 は [fengari](https://fengari.io/) で実行）と CH13–17 の派生値計算を
カバーします。**JS⇄Lua パリティテスト**が `media/channels.js` と
`PhySim.lua:injectAsInputs` の数式一致を機械的に保証します。

## スコープ外（v0.1）

- センサーへの操作のスクリプト化
- 1つのパネルを複数マイコンデバッグセッションで共有

## 今後追加予定の機能

以下は検討中の機能です。いずれも未実装で、記載順は優先度を意味しません。

1. ~~**位置 / 回転の数値直接入力 + プリセット保存・呼び出し**~~
   
   ~~現在、位置と回転はギズモのドラッグでのみ設定可能です。線速度・角速度スライダーと同様の数値入力欄を追加し、「水平定常飛行」「45°バンク」などの定番姿勢を保存・呼び出しできるようにすれば、繰り返しテスト時にギズモを手で合わせ直す手間がなくなります。~~ →v0.2.0で実装済み

2. ~~**連続物理モード（速度を位置に積分）**~~

   ~~現在は velocity と position が独立しており、velocity を設定してもギズモは動きません。トグルで「毎ティック `velocity * dt` を position に加える」モードを追加すれば、PID 制御や姿勢安定化 MC を CH1–3 が時間変化する状況でデバッグでき、ゲーム内挙動により近づきます。~~ →v0.2.0で実装済み

3. ~~**トレイル / 速度ベクトルの可視化**~~

   ~~過去 N ティックの軌跡をトレイルとして 3D シーンに描画し、現在の速度ベクトルを矢印で表示します。上記の連続物理モードと組み合わせると特に効果的です。~~ →v0.4.5で実装済み

4. **複数物理センサー対応**
   1つの MC で複数の physics sensor ブロックを使うケースに対応します。複数のギズモターゲットを配置し、それぞれ独立したチャンネル範囲にマップできるようにします。

5. **ゲームパッド入力**
   接続されたゲームパッド / ジョイスティックでギズモを操作します。動的シナリオではマウスドラッグより滑らかな入力が可能になります。

6. **チャンネル値の CSV ロギング**
   CH1–17 の値を CSV ファイルにストリーミング出力し、オフライン解析やグラフ作成に利用できるようにします。
