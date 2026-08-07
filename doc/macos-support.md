# macOS で動作しない原因（調査記録）

調査日: 2026-08-07
調査環境: macOS 15 (Darwin 25.6.0) / Apple Silicon (arm64)
対象バージョン: PhySim 0.3.0 / `NameousChangey.lifeboatapi` 0.0.33 / `actboy168.lua-debug` 1.61.0 (darwin-arm64)

## 結論

**PhySim 側のバグではない。** 依存先の LifeBoatAPI 拡張が Windows 専用のバイナリに依存しているため、
LifeBoatAPI シミュレーター自体が macOS では起動できない。PhySim は TCP サーバ (14239) を listen した
まま接続を待ち続けるので、ユーザーから見た症状は「パネルは開くが値が更新されない」になる。

ブロッカーは 2 つあり、**片方だけ直しても動くようにはならない**。

---

## ブロッカー 1: 同梱 luasocket が Windows DLL のみ（即座に失敗）

LifeBoatAPI が同梱する luasocket のネイティブバイナリは `.dll` しかなく、`.so` / `.dylib` が存在しない。

```
~/.vscode/extensions/nameouschangey.lifeboatapi-0.0.33/assets/luasocket/
├── socket.lua, mime.lua, ltn12.lua, ...   ← 純 Lua 部分（プラットフォーム非依存）
└── dll/
    ├── socket/core.dll                     ← Windows のみ
    └── mime/core.dll                       ← Windows のみ
```

さらに `out/settingsManagement.js` の `getDebugCPaths()` がこの 2 つのパスをハードコードして
`config.cpath` に流し込む（ユーザー設定で上書きできない — 危険な DLL の読み込みを防ぐため、と
コメントに書かれている）。

```js
function getDebugCPaths(context) {
    // no user-defined cpaths allowed, as it opens up people including and using dangerous dlls very easily
    const defaultCPaths = [
        utils.sanitizeFolderPath(context.extensionPath) + "assets/luasocket/dll/socket/core.dll",
        utils.sanitizeFolderPath(context.extensionPath) + "assets/luasocket/dll/mime/core.dll",
    ];
    return defaultCPaths.join(";");
}
```

`Simulator.lua:17` と `SimulatorConnection.lua:7` はどちらもファイル先頭（サンドボックス外）で
`require("socket")` を呼ぶ。`socket.lua` が `require("socket.core")` を呼び、cpath 経由で
Windows DLL を dlopen しようとして失敗する。

### 再現手順

```bash
LD=~/.vscode/extensions/actboy168.lua-debug-1.61.0-darwin-arm64
LB=~/.vscode/extensions/nameouschangey.lifeboatapi-0.0.33
"$LD/runtime/darwin-x64/lua53/lua" -e '
package.path="'"$LB"'/assets/luasocket/?.lua;'"$LB"'/assets/lua/Common/?.lua;"..package.path
package.cpath="'"$LB"'/assets/luasocket/dll/socket/core.dll;'"$LB"'/assets/luasocket/dll/mime/core.dll"
print(pcall(require,"LifeBoatAPI.Tools.Simulator.Simulator"))'
```

実際の出力:

```
false	error loading module 'socket.core' from file '.../assets/luasocket/dll/socket/core.dll':
	dlopen(.../core.dll, 0x0006): tried: '.../core.dll' (slice is not valid mach-o file),
	'/System/Volumes/Preboot/Cryptexes/OS/.../core.dll' (no such file),
	'.../core.dll' (slice is not valid mach-o file)
```

つまり生成された `_build/_simulator.lua` は 1 行目の
`require("LifeBoatAPI.Tools.Simulator.Simulator")` で落ちる。PhySim が
[`debugConfigPatcher.ts`](../src/debugConfigPatcher.ts) で注入する
`sandboxEnv._physim_socket = require("socket")` も同じ理由で失敗するが、実行順序としては
Simulator.lua の失敗が先に来る。

### 修正時の落とし穴: cpath は「前に」入れないと効かない

`getDebugCPaths()` が生成するエントリには `?` テンプレートが含まれていない。
`package.searchpath` は「最初に読めたファイル」をそのまま返す仕様なので、モジュール名が何であれ
常に `core.dll` がヒットする。したがって **cpath の後ろに `.so` のパスを追記しても一切効かない**。
先頭に prepend する必要がある。

```
✗ <既存の dll パス>;<ext>/luasocket/darwin/?.so     ← 常に dll が先に当たって失敗
✓ <ext>/luasocket/darwin/?.so;<既存の dll パス>     ← socket.core → socket/core.so に解決される
```

---

## ブロッカー 2: シミュレーター本体が Windows 実行ファイル（socket を直しても残る）

LifeBoatAPI の描画・入力 UI は同梱の .NET WPF アプリが担っている。

```
$ file assets/simulator/STORMWORKS_Simulator.exe
STORMWORKS_Simulator.exe: PE32 executable (GUI) Intel 80386 Mono/.Net assembly, for MS Windows
```

`Simulator.lua:_beginSimulation` はこれを起動する:

```lua
local simulatorExePath = LifeBoatAPI.Tools.Filepath:new(simulatorFile)
local simLaunchCommand = '"' .. simulatorExePath:win() .. '" -logfile "' .. simulatorLogFile .. '"'
self._simulatorProcess = io.popen('"' .. simLaunchCommand .. '"', "w") -- additional outer quotes needed, due to windows cmd
```

`Filepath:win()` はパス区切りを `/` → `\` に変換する（`Filepath.lua:65`）。加えて外側の余分な
クォートは Windows の `cmd` 前提。macOS の `sh` からは起動できない。`mono` も `wine` も
この環境には入っていない（`assets/simulator/` に `libSkiaSharp.dylib` と gtk-sharp 系 DLL が
含まれてはいるが、起動コマンドが `mono` を経由しないので使われない）。

その後 `SimulatorConnection:new()` はこの exe が listen するはずの `127.0.0.1:14238` へ
connect する。exe が居ないので接続は拒否されるが、コードは戻り値を見ずに `isAlive = true` を
立てるため例外にはならず、`_giveControlToMainLoop` に入ってから最初の送受信で崩れる。

---

## ブロッカー 3（実際には自動回避されている）: `luaArch: "x86"`

`out/runSimulator.js` は debug config に `luaArch: "x86"` を渡す。lua-debug の
`package.json` では macOS の有効値は `arm64` / `x86_64` だけなので、一見ここで失敗しそうに見える。

しかし lua-debug の `script/frontend/debuger_factory.lua` が arm64 Mac 向けに読み替えを行うため、
実際には落ちない:

```lua
elseif OS == "macos" then
    if IsArm64Macos() then
        ARCH = ARCH or "x86_64"
        if ARCH == "x86" then
            ARCH = "x86_64"
        end
    ...
```

**ただし副作用が 1 つある。** 選択されるランタイムは `runtime/darwin-x64/lua53/lua`、つまり
Rosetta 経由の **x86_64 プロセス**になる。ブロッカー 1 を塞ぐために自前で luasocket を
ビルドする場合、`.so` は **arm64 ではなく x86_64** で作る必要がある。あるいは PhySim 側で
`config.luaArch = "arm64"` に上書きしてネイティブ実行にしてから arm64 の `.so` を用意する。

---

## PhySim 自身に macOS 固有の問題は無い

`src/` 配下を確認した結果、パス処理・ソケット・WebView いずれもプラットフォーム中立だった。

- `physServer.ts` — `net.createServer` を `127.0.0.1` に bind。プラットフォーム非依存。
- `physSimPanel.ts` — `vscode.Uri.joinPath` / `asWebviewUri` のみ。ハードコードされた区切り文字なし。
- `debugConfigPatcher.ts` / `libraryPathInjector.ts` — `vscode.Uri.joinPath(...).fsPath` を使用。
- `pathUtils.ts` の `normalize()` が `toLowerCase()` するのは唯一の Windows 寄りの実装。
  大文字小文字を区別するボリュームでは別のパスを同一視しうるが、用途が
  `config.arg` / `libraryPaths` の重複排除だけなので実害はない。

また LifeBoatAPI が `package.path` / `cpath` を `;` で連結している点は問題ない
（Lua の `LUA_PATH_SEP` は全プラットフォームで `;`）。

### ただしテストスイートには Windows 前提が残っている

`npm test` を macOS で走らせると `test/pathUtils.test.mjs` の 2 件が失敗する（22 pass / 2 fail）。

```
✖ backslashes become forward slashes
    actual:   '/users/user/documents/github/physim/c:/foo/bar'
    expected: 'c:/foo/bar'
✖ mixed separators and dot segments resolve
    actual:   '/users/user/documents/github/physim/c:/foo/./baz/../bar'
    expected: 'c:/foo/bar'
```

原因は `normalize()` が使う `path.resolve` がプラットフォーム依存だから。macOS では
`C:\foo\bar` は相対パス扱いになって cwd が前置され、`\` も区切り文字として解釈されない。
`normalize()` の実装自体は（Windows パスを扱う用途では）正しく、**テストのアサーションが
Windows 専用**というだけ。他の 2 件（case-folds / trailing separators）は両辺に同じ変換が
かかるので macOS でも通る。

クロスプラットフォームで通したいなら `path.win32.resolve` を使うか、
`os.platform() === "win32"` で skip する。ブロッカー 1 / 2 とは無関係で、
拡張機能の実行時挙動には影響しない。

なお `parity.test.mjs` / `roundtrip.test.mjs` が `Cannot find module 'fengari'` で落ちる場合は
単に依存が入っていないだけなので `npm install` で解決する（プラットフォームの問題ではない）。

---

## 対処の選択肢

### A. Windows で動かす（現実的・今すぐできる）

VM / Parallels / Boot Camp を使う。README に macOS 非対応を明記するのが正直な対応。
現状の README にはプラットフォーム要件の記載がない。

### B. ブロッカー 1 だけ PhySim 側で塞ぐ

1. macOS x86_64 向けに Lua 5.3 ABI の luasocket をビルドし、PhySim に同梱
   （`luasocket/darwin-x64/socket/core.so`, `luasocket/darwin-x64/mime/core.so`）。
2. `debugConfigPatcher.ts` の `resolveDebugConfigurationWithSubstitutedVariables` で
   `config.cpath` の**先頭**に `<extensionPath>/luasocket/darwin-x64/?.so` を prepend。

これで `require("socket")` は 3 箇所すべて通るようになるが、**ブロッカー 2 が残るので
LifeBoatAPI のシミュレーターはまだ動かない**。切り分けの第一歩としては有効。

### C. ブロッカー 2 も塞ぐ（PhySim が exe の代役を務める）

PhySim が 14238 でも listen し、`SimulatorConnection` のプロトコル
（`"%04d" + "COMMAND|arg|arg"` の長さプレフィックス方式 — PhySim の 14239 と同形式）に
最低限応答するダミーサーバを実装する。PhySim は既に同じ形式のサーバを持っているので
構造的には自然な拡張だが、`Simulator.lua` の `_handlers` に登録された各コマンドへの
応答実装が必要で、画面描画の扱いも決める必要がある。作業量は大きい。

### D. 上流に修正を投げる

[STORMWORKS_VSCodeExtension](https://github.com/nameouschangey/STORMWORKS_VSCodeExtension) に
macOS / Linux 向け luasocket バイナリと `getDebugCPaths()` のプラットフォーム分岐を PR する。
ブロッカー 1 は解決するが、ブロッカー 2（WPF アプリ）は上流でも簡単には解決しない。

---

## 参照した箇所

| ファイル | 内容 |
| --- | --- |
| `nameouschangey.lifeboatapi-0.0.33/out/settingsManagement.js` | `getDebugCPaths()` が DLL パスをハードコード |
| `nameouschangey.lifeboatapi-0.0.33/out/runSimulator.js` | `luaArch: "x86"`、`arg[1]` に exe パス |
| `.../assets/lua/Common/LifeBoatAPI/Tools/Simulator/Simulator.lua` | 17 行目 `require("socket")`、`_beginSimulation` の `io.popen` |
| `.../assets/lua/Common/LifeBoatAPI/Tools/Simulator/SimulatorConnection.lua` | 7 行目 `require("socket")`、14238 へ connect |
| `.../assets/lua/Common/LifeBoatAPI/Tools/Utils/Filepath.lua` | `win()` が `/` → `\` 変換 |
| `.../assets/luasocket/dll/` | `.dll` のみ |
| `.../assets/simulator/STORMWORKS_Simulator.exe` | PE32 / Mono/.NET / WPF |
| `actboy168.lua-debug-1.61.0/script/frontend/debuger_factory.lua` | `getLuaExe()` の arch 読み替えと `PLATFORM` テーブル |
