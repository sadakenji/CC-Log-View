# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの目的

Claude Code のチャットログを集約・整形し、1つの読みやすい HTML ファイル（`ChatLog.html`）
として出力する Node.js ツール。正式な仕様は [PROMPT.md](PROMPT.md) を参照。

要件:

- **プロジェクトルートで実行** — Claude Code プロジェクトのルートで実行し、そこに
  `ChatLog.html` を出力する。
- **読みやすさの再現** — HTML 出力で、元の Claude Code チャット表示の読みやすさを再現する。
- **差分更新** — 出力ファイル末尾に最後のチャット行のタイムスタンプを記録し、再実行時は
  全体を再生成せず、それより新しいエントリのみを追記する。

## コマンド

```sh
node cclogview.js              # カレントプロジェクトの ChatLog.html を生成／差分追記
node cclogview.js --rebuild    # 既存出力を無視して全件を作り直す（動作確認用）
npm start                      # node cclogview.js と同じ
```

`--rebuild` のエイリアス: `-r` / `--full` / `--all`。

依存パッケージは無し（Node.js 標準ライブラリのみ）。ビルド・テスト・lint の設定は未導入。

## アーキテクチャ

実装は単一ファイル [cclogview.js](cclogview.js) に集約。データの流れは
**ログ特定 → 読込/正規化 → 描画 → 新規生成 or 差分追記**。

- **ログの特定** (`encodeProjectDir` / `findLogFiles`): `process.cwd()` の `:` `\` `/` を
  `-` に置換して Claude Code のプロジェクトフォルダ名を求め、
  `~/.claude/projects/<encoded>/*.jsonl` 内の全セッションを対象にする。
- **読込と正規化** (`loadEntries` / `normalize`): 各 jsonl 行をパースし、`user`/`assistant`
  のみを `{ts, role, parts[]}` に正規化してタイムスタンプ昇順にマージ。`isMeta`（コマンド
  展開などの注入メッセージ）は除外。`parts` の種別は command / text / thinking / tool_use /
  tool_result。`stripNoise` で `<system-reminder>` や `<ide_*>` などハーネス注入タグを除去し、
  実際のチャット画面に近づける。
- **描画** (`renderEntry` / `renderPart` / `mdToHtml`): メッセージを HTML 断片へ変換。
  thinking・tool_use・tool_result は `<details>` で折りたたみ。`mdToHtml` は軽量 Markdown
  （コードブロック・見出し・リスト・強調・インラインコード・リンク・GFM テーブル）に対応。
  テーブルは `isTableSep` / `parseTableRow` / `renderTable` で処理し、CSS の
  `border-collapse` で枠線が繋がる表示にする。スタイルは `STYLE` 定数にインライン埋め込み。
- **差分更新 / 再生成** (`buildNewPage` / `appendToPage` / `main`): 出力末尾の
  `<!-- CCLOGVIEW:LAST_TS=... -->` マーカーを基準に、それより新しいエントリだけを
  `<!-- CCLOGVIEW:BODY_END -->` の直前へ挿入し、フッターとマーカーを更新する。
  `--rebuild` 指定時は既存出力を読まず、全エントリで新規ページを作り直す。

### 注意点

- 差分判定はタイムスタンプの文字列比較（`e.ts > prevTs`）。ISO8601 なので辞書順＝時刻順。
- 本文は必ず `esc()` で HTML エスケープするため、ログ本文中にマーカー文字列が現れても
  実際の構造マーカー（非エスケープ）とは衝突しない。差分追記の `replace` はこの前提に依存。
