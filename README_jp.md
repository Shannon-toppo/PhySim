# Stormworks Physics Sensor Sim (PhySim)

**Stormworks Lua with LifeBoatAPI** と連携して動作するVSCode拡張機能です。
3Dギズモウィンドウから仮想 `physics sensor` を操作できるため、ゲームを起動せずに
PIDコントローラー・INS・オートパイロットなどのロジックをテストできます。

**F6** を押してLifeBoatAPIシミュレーターを起動すると、この拡張機能が自動的にパネルを開きます:

- 平行移動・回転ギズモ付き3Dビューポート（右マウスドラッグで視点回転）
- 線形・角速度スライダー
- 全12チャンネルのライブ表示

値はローカルTCPソケット経由で小さなLuaヘルパー（`PhySim.lua`）にストリーミングされ、次のいずれかとして利用できます:

- 標準の `input.getNumber(N)` テーブルへの注入
- `phys:position()`・`phys:rotation()` などによる直接クエリ

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

回転はThree.jsのEuler XYZ順のラジアンで報告されます。
コントローラーが特定の符号規約を期待する場合（Stormworksは公式に文書化していません）、
Luaコード内で該当コンポーネントを符号反転してください。

## チャンネルレイアウト

`PhySim:injectAsInputs(simulator, startCh)` は `startCh`（デフォルト: `1`）から
始まる17個の連続したチャンネルに書き込みます:

| CH  | 物理量                | 単位        | 備考                                           |
|-----|-----------------------|-------------|------------------------------------------------|
| 1   | 位置 X                | m (東方向)  |                                                |
| 2   | 位置 Y                | m (上方向)  |                                                |
| 3   | 位置 Z                | m (北方向)  |                                                |
| 4   | 回転 X                | rad         | Euler XYZ（内在的）                             |
| 5   | 回転 Y                | rad         |                                                |
| 6   | 回転 Z                | rad         |                                                |
| 7   | 線速度 X              | m/tick      |                                                |
| 8   | 線速度 Y              | m/tick      |                                                |
| 9   | 線速度 Z              | m/tick      |                                                |
| 10  | 角速度 X              | rad/tick    |                                                |
| 11  | 角速度 Y              | rad/tick    |                                                |
| 12  | 角速度 Z              | rad/tick    |                                                |
| 13  | 線速度絶対値          | m/s         | √(vx²+vy²+vz²) × 60                           |
| 14  | 角速度絶対値          | RPS         | √(ax²+ay²+az²) × 60 / 2π                      |
| 15  | Tilt.z                | rotation    | ローカル+Z（前方）の水平面からの傾き            |
| 16  | Tilt.x                | rotation    | ローカル+X（右方向）の水平面からの傾き          |
| 17  | コンパス方位          | rotation    | 北=0, 西=+0.25, 南=±0.5, 東=-0.25（上から見てCCW） |

「rotation」単位: 1.0 = 1回転（2π rad）。Tiltの範囲は [-0.25, +0.25]（水平から±90°）。
コンパスは ±0.5 で折り返します。

## クイックスタート

1. [Stormworks Lua with LifeBoatAPI](https://marketplace.visualstudio.com/items?itemName=NameousChangey.lifeboatapi) をインストールします。
2. PhySimをビルドして起動します（Extension Development Host: このフォルダをVSCodeで開いて **F5** を押すか、`npx vsce package` で生成された `.vsix` をインストールします）。
3. Stormworksマイコンプロジェクトを開きます。拡張機能が `lifeboatapi.stormworks.libs.libraryPaths` に `PhySim/lua/` を自動追加するか確認します。
4. `script.lua` に以下を追加します:

   ```lua
   -- LifeBoatAPIのサンドボックス require() は戻り値を破棄するため、
   -- モジュールはグローバルとして公開されます。
   -- `phys = require("PhySim"):new()` ではなく、以下のペアを使用してください。
   require("PhySim")
   phys = PhySim:new()

   function onLBSimulatorTick(simulator, ticks)
       phys:update()
       phys:injectAsInputs(simulator, 1)   -- input.getNumber(1..12) に書き込む
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
| `phys:injectAsInputs(simulator, n?)`  | CH `n..n+11` を `input.getNumber(...)` に書き込む    |
| `phys:close()`                        | ソケットを閉じる                                      |

## 拡張機能の設定

| 設定                                 | デフォルト | 説明                                                                   |
|--------------------------------------|------------|------------------------------------------------------------------------|
| `physim.port`                        | 14239      | 拡張機能がリッスンするTCPポート                                         |
| `physim.autoOpenOnSimulate`          | true       | LifeBoatAPIの「Run Simulator」起動時にパネルを自動で開く               |
| `physim.channelOffset`               | 1          | `injectAsInputs` の開始CH（参考値）                                    |
| `physim.autoInjectLibraryPath`       | true       | `<extension>/lua/` を `lifeboatapi.stormworks.libs.libraryPaths` に追加 |

## スコープ外（v0.1）

- ネットワーク経由での実行中ゲームインスタンスへの接続
- 重力・加速度計・衝突センサー
- 物理状態の録画＆再生
- 1つのパネルを複数マイコンデバッグセッションで共有
