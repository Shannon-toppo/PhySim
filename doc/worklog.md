# PhySim 開発履歴

## 設計フェーズ
- 要件確認：Stormworks の物理センサを VSCode 内でシミュレートし、LifeBoatAPI のマイコンデバッグ (F6) と並走させる
- 座標系：**Stormworks 左手系** (X+=East / Y+=Up / Z+=North) を採用
- センサ範囲：位置 + Euler 回転 + 線速度 + 角速度 の **12ch**
- Lua 公開 API：composite input 注入 + モジュールAPI の両方
- UI：VSCode WebviewPanel + Three.js
- 通信：TCP `127.0.0.1:14239` (LifeBoatAPI の `14238` と分離)

## 初期実装
- 拡張スケルトン作成 (`package.json`, `tsconfig.json`, `.vscodeignore`)
- TCP サーバ `src/physServer.ts`（length-prefix プロトコル、LifeBoatAPI と同形式）
- LibraryPath 自動注入 `src/libraryPathInjector.ts`
- WebView パネル `src/physSimPanel.ts`
- アクティベーション `src/extension.ts`（debug session 監視で panel/server を駆動）
- Three.js シーン `media/panel.js`（OrbitControls + TransformControls）
- Lua ライブラリ `lua/PhySim.lua`
- Three.js を `media/three/` へコピーする `scripts/copy-three.js`

## サンドボックス対応（複数イテレーション）
LifeBoatAPI の `SimulatorSandbox.lua` は環境が極端に制限されており、何度か仕様の壁にぶつかった。

| 発覚した制限 | 対応 |
|------------|------|
| `socket` が解決できない（C モジュール） | `DebugConfigurationProvider` で `_build/_simulator.lua` を patch し、`sandboxEnv._physim_socket = require("socket")` を注入 |
| サンドボックスの `require` が戻り値を捨てる | `PhySim` をグローバルに登録（`return PhySim` から `PhySim = {...}` へ） |
| `setmetatable` 不在 | クラスパターン廃止 → **シングルトン**へ書き換え |
| `pcall` / `error` / `assert` 不在 | `print` + 早期 `return` に置換 |

## UI 改善
- スライダー横の `<output>` を編集可能な `<input type=number>` に変更（双方向バインド）
- ターゲット形状を箱から**小型飛行機**へ（胴体 + 機首コーン + 主翼 + 翼端航法灯 + キャノピー + 垂直/水平尾翼）
- 航法灯の色を視覚的に直感的になるよう入れ替え（赤=+X / 緑=-X）

## チャンネル拡張（CH13-17 追加）
ユーザー要望で derived 値を追加：

| CH | 内容 | 計算 |
|----|------|------|
| 13 | LinearVelocityABS [m/s] | √(vx²+vy²+vz²) × 60 |
| 14 | AngularVelocityABS [RPS] | √(ax²+ay²+az²) × 60 / 2π |
| 15 | Tilt.z [rotation] | local +Z の鉛直成分 |
| 16 | Tilt.x [rotation] | local +X の鉛直成分 |
| 17 | compassBearing [rotation] | 方位（N=0, W=+0.25, S=±0.5, E=-0.25） |

Lua 側 `injectAsInputs` と JS 側 `refreshChannelTable` の両方に同じ式を実装し、パネルでもリアルタイム表示。

## 新規プロジェクト対応
`activate` は一度しか走らず、後から開いた新プロジェクトでは `libraryPaths` 注入が走らない問題が発覚。
- **解決**：`DebugConfigurationProvider` 内で `config.arg` に拡張の `lua/` ディレクトリを直接追加。設定ファイル経由ではなく runtime で渡るため、どのワークスペースでも追加設定不要で動作する
- 補完用に `onDidChangeWorkspaceFolders` でも `ensureInjected` を再実行

## リファクタリング（v0.3.0, 2026-07）

6 フェーズの挙動保存リファクタリングを実施。事前調査の結論は「デッドコードはほぼゼロ、
本当の負債は二重管理数式・テスト不在・モノリス WebView」だったため、削除よりも保護と分割に注力。

1. **ツーリング**：ESLint (flat config、correctness ルールのみ)、`tsconfig.media.json`
   (WebView JS の strict JSDoc 型検査)、`node:test`。vsix から `.claude/` や開発ドキュメントを除外。
2. **テスト**：プロトコル往復・CH13–17 golden 値・**JS⇄Lua パリティテスト**。
   Lua 実行系は **fengari**（Lua 5.3 セマンティクスの純 JS 実装）を採用 — lua-debug と同じ
   5.3 系で、Windows にネイティブ依存なし。`PhySim.lua` は無改変のままテスト可能
   （`_physim_socket` をスタブし `PhySim._buf` を直接駆動）。
3. **デッドウェイト除去**：未使用設定 `physim.channelOffset` を削除（コードから一切読まれていなかった）。
   `normalize()` を `src/pathUtils.ts` に一本化。π の `3.1416` リテラルを `Math.PI.toFixed(4)` 化。
4. **panel.js 分割**：612 行のモノリスを 9 モジュールへ（vscodeApi / channels / dom / scene /
   pose / messaging / simulation / presets / panel=エントリ）。CSP nonce はエントリ script から
   module graph 全体へ伝播するため `buildHtml` 変更ゼロ。`_syncing` ガードは単一フラグのまま
   `dom.js` の `syncGuard` に移設（分割すると再入挙動が変わる）。
5. **HTML テンプレート抽出**：インライン HTML 約 100 行を `media/panel.html` へ（`{{token}}`
   置換方式・未解決トークンは throw）。スタブだった panel.html が「正」になった。
   注意：テンプレート内の HTML コメントに二重波括弧のリテラルを書くと leftover 検知が誤爆する。
6. **ドキュメント同期**：README EN/JP・CLAUDE.md 更新、version 0.3.0。

## モニタープロトコルの引数個数バグ（v0.4.4, 2026-08）

自前のモニターシミュレーション（macOS 常時 / Windows は `physim.monitors.useBuiltInOnWindows`）で、
三角形を使う描画だけが大きく崩れるという報告。三角形ファンで多角形を塗る PFD スクリプトでは
空と地面のポリゴンが斜めに割れ、バンク角ポインタの三角形が画面最上部まで縦に伸びていた。

**原因** — LifeBoatAPI の `Simulator_ScreenAPI.lua` は `drawTriangle` / `drawTriangleF` を
どちらも 8 パラメータで送る：

```
TRIANGLE|screen|fill|x1|y1|x2|y2|x3|y3
```

ところが `src/simStubServer.ts` の `ARG_COUNTS` が `TRIANGLE: 7` になっていた。

厄介なのは、この不一致が**例外にもコマンド落ちにもならない**こと。`splitBody(body, limit)` は
TEXT / TEXTBOX の末尾自由テキスト（それ自体が `|` を含みうる）を保つために、`limit` に達した
時点で残りを最後のフィールドへまとめる設計になっている。したがって個数が 1 つ足りないと、
最後のフィールドが `"30|42"` のような文字列になり、`parseFloat("30|42")` が `30` を返して
そのまま通る。結果 `y3` が読まれず `media/mcScreen.js` 側で `n(c[8])` が `0` になり、
**すべての三角形の第3頂点が y=0 に貼り付いていた**。

**教訓** — 可変長の末尾フィールドを許すパーサでは、引数個数テーブルが上流の送信側と
1 つでもずれると、壊れ方が「明確なエラー」ではなく「もっともらしい数値」になる。
`ARG_COUNTS` は上流の `sendCommand(...)` 呼び出しと 1 対 1 で対応させること。

**対応**
- `ARG_COUNTS.TRIANGLE` を 8 に修正（なぜ短いと黙って壊れるのかをコメントで明記）
- 他コマンド（`COLOUR` / `CLEAR` / `LINE` / `CIRCLE` / `RECT` / `TEXT` / `TEXTBOX` / `MAP*` /
  `SCREENCONFIG`）の個数も `Simulator_ScreenAPI.lua` / `Simulator.lua` の送信箇所と
  総当たりで照合。ずれていたのは `TRIANGLE` のみ
- `test/simstub.test.mjs` に、塗り／枠線それぞれ 6 座標が保持されることを検証する
  回帰テストを追加

影響範囲は自前モニターシミュレーションのみで、Windows 既定の `STORMWORKS_Simulator.exe`
経由の表示、および CH1–17 のチャンネル仕様には影響しない。

## 軌跡トレイルと速度ベクトル（v0.4.5, 2026-08）

README「今後追加予定の機能」3 番目の実装。Simulate で動かしている間、ギズモが今どこを
通ってきたのか、どちらへどれだけの速さで進んでいるのかが画面から読み取れなかった。

**構成** — 三角関数やバッファ操作のような純粋な部分を `media/trail.js` に、three.js の
オブジェクトと UI 配線を `media/visuals.js` に分けた。`raster.js` / `channels.js` と同じ
分け方で、前者は Node からそのまま import してテストできる（`test/trail.test.mjs`）。

**リングバッファにしなかった理由** — Line の頂点順がそのまま描画順になるため、
書き込み位置を巻き戻す本来のリングバッファだと、継ぎ目をまたぐ 1 本の線が画面を横切る。
満杯時は `copyWithin(0, 3)` で 1 点ぶん詰める方式にした。最長 1800 点でも 1 フレームに
数千 float のコピーで、しかも点が実際に増えたティックにしか走らない。

**サンプリングはティック単位** — 当初は rAF ごとに 1 点取っていたが、パネルが非表示だったり
ホストが重かったりで rAF が間引かれると、シミュレーション自体は壁時計ベースで進むのに
トレイルだけが粗い折れ線になる（動作確認中に実際に発生した）。`simulation.js` の固定
タイムステップループから `sampleTrail()` を呼び、GPU への転送は rAF ごとに 1 回だけ行う。
rAF 側でも 1 点サンプルしているので、ギズモのドラッグや数値入力での移動も拾える。

**その他の判断**
- 1 mm 未満の移動は捨てる。静止中に同じ点でバッファが埋まると、動き出した時に履歴が無い
- Reset / プリセット読み込み / 再生の巻き戻しではトレイルを消す。いずれもワープであり、
  残しておくと実際には通っていない直線が描かれる
- 矢印は m/tick をそのまま長さにすると 1.0 で 60 m/s ぶんになりグリッド（20 単位）を
  はみ出すため、ゲイン 4 倍・下限 1・上限 12 単位に丸めた。速度はワールド座標系
  （CH7-9 と同じ）なので、矢印は `scene` 直下に置き機体の回転には追従させない
- トレイルは古い側を暗く、新しい側を明るいシアンにする頂点カラー。線幅は 1 px 固定
  （WebGL の制約。太くするには Line2 が必要で、three の addons を追加で vendor することになる）

## モニター描画の CPU 使用率調査と修正（v0.4.5, 2026-08）

「モニターシミュレーション中に CPU をかなり使う」との報告。経路
（Lua → TCP → 拡張ホスト → postMessage → WebView → canvas）を段ごとに実測した。

**計測条件** — PFD 風の合成ワークロード（COLOUR / RECT 塗り・枠 / LINE / TEXT /
TRIANGLE 塗り・枠 / CIRCLE 塗り・枠 / TEXTBOX を均等に混在）を 96x96 モニター 1 枚へ
60 tick/s。数値は CPU 1 コアに対する割合。

| 段 | 200 cmd/tick | 500 | 1000 | 2000 |
|---|---|---|---|---|
| 拡張ホスト（TCP 受信 + パース） | 4.0% | 6.9% | 11.5% | 19.5% |
| postMessage の JSON 符号化・復号 | 0.2% | 0.4% | 0.7% | 1.3% |
| WebView の再描画 | 19.6% | 69.4% | 127% | 236% |
| three.js のレンダリングループ | 約 3%（コマンド数に無関係） | | | |

ホスト側の 6.9% のうち、実際のパース処理（`FrameParser.feed` + `splitBody`）は 0.7% しかなく、
残りは Node のソケット受信そのもの。LifeBoatAPI がコマンド 1 個ごとに `send()` する仕様なので
こちらで減らせる余地はほぼ無い。**犯人は WebView の再描画**だった。

**原因** — ピクセル 1 個ごとに `ctx.fillRect(x, y, 1, 1)` を呼んでいた。コマンド 1 個あたりの
コストは、`fillRect` 1 回で済む塗りつぶし矩形が 0.3 µs なのに対し、ピクセルを打つ経路
（LINE 23.7 / TEXT 28.4 / 三角形の枠 57.4 µs）は 100 倍近い。

**遠回りした点** — 最初に「1 ピクセルずつの `fillRect` が原因」と決め打ちして、
`fillRect` だけをバッファ書き込みに差し替えたプロトタイプを作ったが、まったく速くならなかった
（11.57 → 11.74 ms）。原因はプロトタイプ側で、`fillRect` ごとに `this.fillStyle` を読んで
色を解決していたこと。canvas の `fillStyle` は読むたびに文字列を作る。仮説を立てたら
必ず A/B を取る、という当たり前の話だが、ここで一度間違えた。

**修正 1: ImageData バッファ化** — `ImageData` を `Uint32Array` ビュー越しに書き、
フレーム末尾にモニターごと `putImageData` 1 回だけ。新旧モジュールを同じページに読み込んで
同条件で A/B した結果:

| cmd/tick | 旧 | 新 | 倍率 |
|---|---|---|---|
| 200 | 1.70 ms | 0.24 ms | 7.2x |
| 500 | 2.85 ms | 0.45 ms | 6.3x |
| 1000 | 6.23 ms | 0.90 ms | 6.9x |
| 2000 | 12.01 ms | 1.76 ms | 6.8x |

（この A/B はタブが非表示の状態で取っているため絶対値は上の表より小さい。canvas への描画は
実際に合成される状態だとさらに高くつくので、表示中の倍率はこれ以上になる。）

新実装の 500 cmd の内訳は、クリア 0.003 ms・描画 0.722 ms・`putImageData` 0.007 ms。
つまりピクセル書き込みも転送も実質ゼロで、残りはラスタライザそのもののコスト。

- 色は `rgba()` の CSS 文字列生成をやめ、`makeColour()` が
  「不透明用のパック済みワード + ブレンド用のチャンネル値」を返す形にした
- パックとブレンドは `media/blend.js`（純粋モジュール、`test/blend.test.mjs`）。
  ImageData のバイト順は RGBA なので、32 bit ワードへの詰め方はエンディアンに依存する。
  リトルエンディアン決め打ちにせず起動時に 1 回だけ判定している
- **バッファ書き込みは自前でクリップが要る**。canvas は範囲外を黙って捨ててくれていたが、
  生バッファでは x = -1 が「前の行の右端」に着弾する。実際に画面外へ出る TEXT を
  描いて、右端の行が汚れないことを確認した

**修正 2: 再描画を rAF に載せる** — `applyScreenFrame` は `message` ハンドラから同期的に
`repaint()` を呼んでいた。フレームはシミュレータ側の都合で届き、表示側の都合とは無関係で、
しかも意味があるのは最新の 1 枚だけ。`scheduleRepaint()` で 1 アニメーションフレームに
1 回へ束ねた。

副次効果の方が大きい: `retainContextWhenHidden: true` のため、パネルを裏のタブに置いても
WebView はメッセージを受け取り続け、**見えていないキャンバスを 60 Hz で描き続けていた**。
rAF は非表示中は発火しないので、描画ごと消える。復帰時は保留中のコールバックが発火し、
`lastCommands` に入っている最新フレームが描かれる。

（この挙動は動作確認中に実際に踏んだ。ブラウザペインが非表示の間 `repaintPending` が
立ちっぱなしになり再描画が完全に止まる。意図どおりだが、ベンチマークを取るときは
これに引っかかるので注意。）

**修正 3: 不透明色では重複除去を省く** — `plotter()` の `Set` による重複除去は、半透明色を
二重合成して明るい点を作らないためのもの。不透明なら二度書きは冪等なので除去自体が不要で、
色に応じてクロージャを分けた。混在フレームで 1.6 倍、枠線中心のフレームで 3.5 倍。
半透明パスは `Set` のまま（スタンプバッファ化の計画と実測は `doc/monitor-dedup-plan.md`）。
修正 1 の状態と全ピクセル比較して差分 0 を確認済み。

**合成結果の旧実装との差** — ImageData 化に伴い、半透明の合成が canvas の
プリマルチプライ演算から自前の lerp に変わった。不透明描画はビット一致、α=128/254 では
チャンネル差 1 以内、α=64 で 3 以内。極端なケース（全描画が α=1 で 40 回以上重なる合成テスト）
では最大 32 まで開く。どちらも近似で、基準は本来ゲーム側の描画なので追随はしていない。

## チャンネル値の CSV ロギング（v0.4.6, 2026-08）

README「今後追加予定の機能」6 番目の実装。CH1-17 を CSV に書き出して、オフラインで
グラフ化したり PID の応答を見比べたりできるようにする。

**列の定義を webview 側に置いた** — 列名は `media/csv.js` の `CSV_COLUMNS` が持ち、
ヘッダー行も webview が「最初の 1 行」として送る。拡張ホスト側の `src/csvLogger.ts` は
渡された文字列を追記して数えるだけで、チャンネルが何本あるかを知らない。CH を追加しても
触る場所が 1 箇所で済む。

**行が生まれる場所は 2 つ** — Simulate / Play 中は `simulation.js` の固定タイムステップ
ループから 1 ティック 1 行（トレイルと同じ理由で、rAF が間引かれてもログは粗くならない）。
停止中はギズモのドラッグや数値入力で `sendState()` が走るたびに 1 行。

問題は `stepSimulation()` がティックループの**後に** `sendState()` を呼ぶこと。素直に
両方から書くと、シミュレーション中は毎フレーム末尾に直前のティックと同じ行が重複する。
`csv.js` の `tickRow` / `sendRow` が `tickLogged` フラグでこれを 1 回だけ食う。この
受け渡しが今回いちばん壊しやすい部分なので、DOM に依存しない形で `csv.js` に置いて
`test/csv.test.mjs` から直接叩けるようにした。

**開始はホストとの往復** — 保存先ダイアログはキャンセルできるので、ボタンが点灯するのは
ホストが `csvState` を返してきてからにした。停止側は拒否されないので即座に落とす
（返事を待つ間に積んだ行は、ファイルが閉じた後に届いてしまう）。

**その他の判断**
- 行は 250 ms または 240 行ごとにまとめて `postMessage`。60 Hz で 1 行 1 通は無駄が多い
- 数値の丸めは `physServer.ts:fmt()` と同じ小数 6 桁。CSV の CH1-12 が実際にワイヤへ
  出た値と一致するので、ログとマイコンの挙動を突き合わせられる
- 改行は CRLF（RFC 4180）。webview から来た行に含まれる改行は空白へ潰す。レンダラ由来の
  文字列をそのまま流すと、1 行が 2 レコードに割れて以降の列が全部ずれる
- サンプル間隔が一定でないので `time_s` 列を持たせた。時間軸にはこちらを使う

## CSV 保存先ダイアログが Windows で開かない（v0.4.6, 2026-08）

macOS では動作したが、Windows で「⬇ CSV Log」を押してもダイアログが出ず、以降何も
起きないとの報告。

**原因** — 保存先ダイアログの初期パス。ワークスペースフォルダが開かれていない場合、
`vscode.Uri.file(defaultLogFileName())` とファイル名だけから URI を作っていた。macOS では
`/physim-log-….csv` という一応妥当な絶対パスに解決されてダイアログが開くが、Windows では
`\physim-log-….csv` というドライブ相対パスになり、ネイティブダイアログが開けない。
同じコードが片方の OS でだけ通る典型で、パス解決の差がそのまま出た。

**症状が「無反応」になった理由** — 例外が `async` な `onDidReceiveMessage` ハンドラの中で
起きるため、VSCode に握り潰されて通知もログも出ない。さらに webview 側は `csvState` の
返事が来るまでボタンを disabled にしていたので、押した瞬間にグレーアウトしたまま二度と
戻らない。エラーも出ず操作もできない、いちばん困る壊れ方だった。

**修正**
- 初期パスの決定を `csvLogger.ts:defaultLogPath()` に切り出し、フォルダ未オープン時は
  ホームディレクトリへフォールバックさせて必ず絶対パスにした。`vscode` 非依存なので
  `test/csvLogger.test.mjs` から Windows 形状も含めて検証できる
- `startCsvLog()` 全体を try/catch で囲み、どの経路を通っても必ず `csvState` を返す。
  ダイアログの表示・却下・失敗をすべて `log()` に残す
- webview のボタンは待機中「… Choose a file」と表示し、120 秒で自動復帰する。ネイティブ
  ダイアログは他ウィンドウの背後に回ることがあり（Windows では LifeBoatAPI のシミュレータ
  exe が別ウィンドウで前に出る）、無言のグレーアウトは機能が死んだようにしか見えない
- ホスト側にもダイアログ多重表示のガードを入れた

### 続報：真因は out/ の作り忘れだった（2026-08-26）

上の修正を入れても Windows では同じ症状のまま。改めて実機を調べたところ、原因は
**拡張ホストのビルドが古かった**こと。`out/` の最終更新は 0.4.4 を vsce package した
時点（8/22）で止まっており、`out/csvLogger.js` は存在せず `out/physSimPanel.js` には
`csv` の文字すら無かった。CSV ロギングを実装したのは 8/26 の macOS 側なので、Windows で
動くはずがなかった。

**なぜ「片方の OS だけ」に見えたか** — `media/` は webview がディスクから毎回読むので
パネルには CSV ボタンが出る。`out/` はコンパイル成果物なので古いまま。つまり
「ボタンはある／ホストには `csvStart` のハンドラが無い」というちぐはぐな状態になり、
押すとメッセージは無視され、返事が来ないので webview は 120 秒グレーのまま。
macOS 側は実装直後にビルドしていたので普通に動いた。**OS 差ではなくビルド差**だった。

`.vscode/launch.json` の `preLaunchTask` が `npm: compile`（ワンショット）だったのも
効いている。F5 のときしか走らないので、他 OS の作業を pull したあと開発ホストを
Reload Window しただけでは `out/` が更新されない。

**対策**
- `preLaunchTask` を `npm: watch` に変更。開発ホストの reload でも常に最新の `out/` を読む
- `csvStart` に **ack を追加**。ホストは `showSaveDialog` を出す直前に `csvDialog` を
  返し、webview は 3 秒以内に ack が来なければ「no response」をツールバーに赤字で出して
  ボタンを戻す（ツールチップに「ホストのビルドが古い可能性」を明記）。
  「ダイアログが他ウィンドウの背後にいる」と「ホストがそもそも知らない」を
  区別できなかったことが、この誤診の直接の原因だった

なお前段の `defaultLogPath()` 修正自体は無駄ではない（フォルダ未オープン時に
ドライブ相対パスになるのは実際に不正）が、今回の症状の原因ではなかった。

## ファイル構成（最終）
```
PhySim/
├── package.json / tsconfig.json / tsconfig.media.json / eslint.config.mjs / .vscodeignore
├── README.md / CLAUDE.md / LICENSE
├── doc/
│   ├── README_jp.md              # 日本語版 README
│   ├── worklog.md                # このファイル（反復履歴）
│   └── macos-support.md          # macOS 非対応の原因調査
├── src/
│   ├── extension.ts              # activate / debug 監視
│   ├── physServer.ts             # TCP サーバ (14239)、encode/fmt は export（テスト用）
│   ├── physSimPanel.ts           # WebView 管理（media/panel.html を読み込んで {{token}} 置換）
│   ├── libraryPathInjector.ts    # 設定注入（補完用）
│   ├── debugConfigPatcher.ts     # _simulator.lua patch + config.arg 注入
│   ├── csvLogger.ts              # CSV ファイルの開閉と追記（vscode 非依存）
│   └── pathUtils.ts              # normalize() 共有ユーティリティ
├── media/
│   ├── panel.html                # WebView マークアップの正（テンプレート）
│   ├── panel.css
│   ├── panel.js                  # エントリ（配線のみ）
│   ├── vscodeApi.js / channels.js / dom.js / scene.js / pose.js
│   ├── messaging.js / simulation.js / presets.js
│   ├── visuals.js                # トレイル＋速度矢印（three.js 側）
│   ├── trail.js                  # トレイルのバッファと矢印長（純粋モジュール）
│   ├── logging.js                # CSV ロギングの UI とバッチ送信
│   ├── csv.js                    # CSV の列定義・行整形・採番（純粋モジュール）
│   ├── blend.js                  # 色のパックと合成（純粋モジュール）
│   ├── globals.d.ts              # acquireVsCodeApi 型宣言
│   └── three/                    # vendored Three.js
├── lua/
│   └── PhySim.lua                # Lua 側ライブラリ（シングルトン）
├── test/
│   ├── helpers/luaRunner.mjs     # fengari ハーネス
│   ├── protocol.test.mjs / channels.test.mjs / roundtrip.test.mjs
│   ├── parity.test.mjs           # JS⇄Lua CH13–17 一致検証
│   ├── trail.test.mjs            # トレイルバッファ／矢印スケール
│   ├── csv.test.mjs              # CSV の列幅・golden 行・重複排除
│   ├── csvLogger.test.mjs        # ファイル書き出しと行のサニタイズ
│   ├── blend.test.mjs            # 色パックのバイト順／合成
│   └── pathUtils.test.mjs
└── scripts/
    └── copy-three.js             # postinstall で Three.js 配置
```
