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

## ファイル構成（最終）
```
PhySim/
├── package.json / tsconfig.json / .vscodeignore
├── README.md / worklog.md
├── src/
│   ├── extension.ts              # activate / debug 監視
│   ├── physServer.ts             # TCP サーバ (14239)
│   ├── physSimPanel.ts           # WebView 管理
│   ├── libraryPathInjector.ts    # 設定注入（補完用）
│   └── debugConfigPatcher.ts     # _simulator.lua patch + config.arg 注入
├── media/
│   ├── panel.html / panel.css / panel.js   # Three.js シーン + UI
│   └── three/                              # vendored Three.js
├── lua/
│   └── PhySim.lua                # Lua 側ライブラリ（シングルトン）
└── scripts/
    └── copy-three.js             # postinstall で Three.js 配置
```
