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

## ファイル構成（最終）
```
PhySim/
├── package.json / tsconfig.json / tsconfig.media.json / eslint.config.mjs / .vscodeignore
├── README.md / README_jp.md / worklog.md
├── src/
│   ├── extension.ts              # activate / debug 監視
│   ├── physServer.ts             # TCP サーバ (14239)、encode/fmt は export（テスト用）
│   ├── physSimPanel.ts           # WebView 管理（media/panel.html を読み込んで {{token}} 置換）
│   ├── libraryPathInjector.ts    # 設定注入（補完用）
│   ├── debugConfigPatcher.ts     # _simulator.lua patch + config.arg 注入
│   └── pathUtils.ts              # normalize() 共有ユーティリティ
├── media/
│   ├── panel.html                # WebView マークアップの正（テンプレート）
│   ├── panel.css
│   ├── panel.js                  # エントリ（配線のみ）
│   ├── vscodeApi.js / channels.js / dom.js / scene.js / pose.js
│   ├── messaging.js / simulation.js / presets.js
│   ├── globals.d.ts              # acquireVsCodeApi 型宣言
│   └── three/                    # vendored Three.js
├── lua/
│   └── PhySim.lua                # Lua 側ライブラリ（シングルトン）
├── test/
│   ├── helpers/luaRunner.mjs     # fengari ハーネス
│   ├── protocol.test.mjs / channels.test.mjs / roundtrip.test.mjs
│   ├── parity.test.mjs           # JS⇄Lua CH13–17 一致検証
│   └── pathUtils.test.mjs
└── scripts/
    └── copy-three.js             # postinstall で Three.js 配置
```
