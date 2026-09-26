# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの目的

Claude Code のチャットログを集約・整形し、1つの読みやすい HTML ファイル（`ChatLog.html`）
として出力する Node.js ツール。正式な仕様は [PROMPT.md](PROMPT.md) を参照。

要件:

- **プロジェクトルートで実行** — Claude Code プロジェクトのルートで実行し、
  `~/.claude-logs/<プロジェクト名>/` に `ChatLog.html` を出力する（`<プロジェクト名>` は
  フルパスのエンコードではなく、実行ディレクトリの名前のみ）。git の管理対象外。
- **読みやすさの再現** — HTML 出力で、元の Claude Code チャット表示の読みやすさを再現する。
- **差分更新** — 出力ファイル末尾に最後のチャット行のタイムスタンプを記録し、再実行時は
  全体を再生成せず、それより新しいエントリのみを追記する。

## コマンド

```sh
node cclogview.js                # ChatLog.html を生成／差分追記（既定）
node cclogview.js --format md    # ChatLog.md を生成／差分追記（--md でも可）
node cclogview.js --format both  # HTML と Markdown を両方（--both でも可）
node cclogview.js --rebuild      # 既存出力を無視して全件を作り直す（動作確認用）
node cclogview.js --log-dir <p>  # ログ(jsonl)フォルダを直接指定
node cclogview.js --print-dir    # 出力先フォルダのパスだけを表示して終了（フォルダは作らない）
npm start                        # node cclogview.js と同じ
npm run deploy                   # 完成版を ~/.claude/scripts/ へ配置（下記参照）
```

### 配置（デプロイ）

開発・テストは本プロジェクトで行い、完成したものを `npm run deploy` で
`~/.claude/scripts/cclogview.js` へコピーする。ユーザスコープの Stop hook はこの配置先を
参照しているため、全プロジェクトで使えるようになる（hook コマンド: `node
"$env:USERPROFILE\.claude\scripts\cclogview.js" --format both`）。**本プロジェクトの編集は
deploy するまで他プロジェクトに反映されない**点に注意。

`--format html|md|both`（既定 html、`--md`/`--both` は短縮）。`--rebuild` のエイリアス: `-r` /
`--full` / `--all`。HTML と Markdown は別ファイル・別マーカーなので、それぞれ独立に差分更新
できる。

出力（`ChatLog.*`）は常に `~/.claude-logs/<プロジェクト名>/` に書き出す（フォルダは自動作成）。
リポジトリ外なので git の管理対象にはならない。旧仕様の出力（プロジェクト直下の
`ChatLog.*`）が残っている場合は実行時に新しい出力先へ自動移動し（`migrateLegacyOutput`）、
以降はそこへ差分追記する。移動先に同名ファイルが既にあるときは移動せず警告のみ。
出力先のパスは `--print-dir` で取得できる（他プロジェクトでは
`node "$env:USERPROFILE\.claude\scripts\cclogview.js" --print-dir`。例: `ii (…)` で
エクスプローラを開く）。
読み取り元の jsonl フォルダは
自動検出するが、見つからない場合は `--log-dir "<パス>"`、またはプロジェクトの
`.claude/settings.local.json` に次を記述して直接指定できる:

```json
{ "cclogview": { "logDir": "<jsonl のあるフォルダの絶対パス>" } }
```

`logDir` の代わりに `projectDir`（`~/.claude/projects` 直下のフォルダ名）でも可。

依存パッケージは無し（Node.js 標準ライブラリのみ）。ビルド・テスト・lint の設定は未導入。

### 自動リロード（生成 HTML をライブ表示）

`cclogview.js` を再実行するたびに `ChatLog.html` を自動で再表示したい場合は、出力先の
`~/.claude-logs/<プロジェクト名>/ChatLog.html` を VS Code 拡張 **Live Server** などで開く
（フォルダを VS Code で開き、`ChatLog.html` を右クリック → "Open with Live Server"）。Live Server が
ファイル変更を監視して即座にブラウザをリロードする。`file://` 直開きでは自動リロードできない
ため、この用途では Live Server（または任意のローカルサーバ）経由で開く。HTML 側に自動リロード
用のコードは持たせていない（サーバ側に任せる方針）。

## アーキテクチャ

実装は単一ファイル [cclogview.js](cclogview.js) に集約。データの流れは
**ルート特定 → ログ特定 → 読込/正規化 → 描画 → 新規生成 or 差分追記**。

- **ルートの特定** (`findProjectRoot`): 実行ディレクトリから親へさかのぼり、① 対応する
  `~/.claude/projects` のログフォルダ ② `.claude/`（ホームの `~/.claude` は除外）③ `.git`
  の順に、それぞれ最も近い階層をプロジェクトルートとして `process.chdir` する。以降の
  `process.cwd()` はすべてルートを指すため、サブフォルダからの実行でも同じ結果になる。
  見つからなければエラー終了。`--log-dir` の相対パスは移動前に解決する。

- **ログの特定** (`resolveLogDir` / `findLogFiles`): jsonl フォルダを次の優先順で解決する
  — ① CLI `--log-dir` ② `.claude/settings.local.json`（無ければ `settings.json`）の
  `cclogview.logDir` / `projectDir` ③ `process.cwd()` の `:` `\` `/` を `-` に置換した
  自動検出（完全一致 → 大小無視フォールバック。ドライブレターの大小差を吸収）。解決した
  フォルダ内の全セッション `*.jsonl` を対象にする。出力先は `getOutputDir` が返す
  `~/.claude-logs/<basename(process.cwd())>/`（`resolveOutputDir` が無ければ作成）。
- **読込と正規化** (`loadEntries` / `normalize`): 各 jsonl 行をパースし、`user`/`assistant`
  のみを `{ts, role, parts[]}` に正規化してタイムスタンプ昇順にマージ。`isMeta`（コマンド
  展開などの注入メッセージ）は除外。`parts` の種別は command / text / thinking / tool_use /
  tool_result。`stripNoise` で `<system-reminder>` や `<ide_*>` などハーネス注入タグを除去し、
  実際のチャット画面に近づける。
- **描画**: 出力形式ごとに 2 系統。`main` 内の `RENDERERS` テーブルが形式（html/md）に
  応じて `renderEntry` / `buildNewPage` / `appendToPage` を切り替える。共通の構造マーカーを
  使うため `loadEntries` / `normalize` 以降の差分更新ロジックは形式非依存。
  - **HTML** (`renderEntry` / `renderPart` / `mdToHtml`): thinking・tool_use・tool_result は
    `<details>` で折りたたみ。`mdToHtml` は軽量 Markdown（コードブロック・見出し・リスト・
    強調・インラインコード・リンク・GFM テーブル）に対応。テーブルは `isTableSep` /
    `parseTableRow` / `renderTable` で処理し CSS の `border-collapse` で枠線を繋ぐ。
    スタイルは `STYLE` 定数にインライン埋め込み。
  - **Markdown** (`renderEntryMd` / `renderPartMd`): text パーツは元が Markdown なのでそのまま
    出力。thinking・tool は GFM の `<details>` で折りたたみ（`detailsMd`）。コード片の中身に
    ``` ``` ``` が含まれても壊れないよう `fenceFor` でフェンス長を調整する。
- **差分更新 / 再生成** (`buildNewPage(Md)` / `appendToPage(Md)` / `main`): 出力末尾の
  `<!-- CCLOGVIEW:LAST_TS=... -->` マーカーを基準に、それより新しいエントリだけを
  `<!-- CCLOGVIEW:BODY_END -->` の直前へ挿入し、フッターとマーカーを更新する。
  `--rebuild` 指定時は既存出力を読まず、全エントリで新規ページを作り直す。

### 注意点

- 差分判定はタイムスタンプの文字列比較（`e.ts > prevTs`）。ISO8601 なので辞書順＝時刻順。
- **マーカー衝突対策**: チャット本文中にマーカー文字列が引用混入し得る（特に非エスケープの
  Markdown）。構造マーカーは常に本文より後にあるため、読み取り・置換はすべて「最後の出現」を
  対象にする（`readPrevTs` / `replaceLastStr` / `replaceLastRe`）。HTML 側も同様に統一。
