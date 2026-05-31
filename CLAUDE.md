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
node cclogview.js              # ChatLog.html を生成／差分追記（既定）
node cclogview.js --format md  # ChatLog.md を生成／差分追記（--md でも可）
node cclogview.js --rebuild    # 既存出力を無視して全件を作り直す（動作確認用）
npm start                      # node cclogview.js と同じ
```

`--format html|md`（既定 html、`--md` は md の短縮）。`--rebuild` のエイリアス: `-r` /
`--full` / `--all`。HTML と Markdown は別ファイル・別マーカーなので、それぞれ独立に差分更新
できる。

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
