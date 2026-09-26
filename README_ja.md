# CC-Log-View

<table>
  <thead>
    <tr>
      <th style="text-align:center"><a href="README.md">English</a></th>
      <th style="text-align:center">日本語</th>
    </tr>
  </thead>
</table>

Claude Code のチャットログ（JSONL）を集約・整形し、読みやすい 1 つの `ChatLog.html` / `ChatLog.md` として出力する Node.js ツールです。

## 特徴

- プロジェクトの全セッション（`*.jsonl`）をタイムスタンプ順にマージ
- Claude Code のチャット表示の読みやすさを再現（ユーザと Claude の発言を左右に配置し、思考やツールの入出力は折りたたみ表示）
- HTML、Markdown、またはその両方を出力
- 差分更新：ファイル末尾に最終タイムスタンプを記録し、再実行時は新しいエントリだけを追記
- 出力先はリポジトリ外の `~/.claude-logs/<プロジェクト名>/` なので、git の管理対象にならない
- プロジェクトのサブフォルダからでも実行可能（親へさかのぼってプロジェクトルートを特定）
- 依存パッケージなし（Node.js 標準ライブラリのみ）

## 必要環境

- Node.js
- Claude Code（ログは `~/.claude/projects/` から読み込みます）

## インストール

```sh
git clone https://github.com/sadakenji/CC-Log-View.git
cd CC-Log-View
npm run deploy   # cclogview.js を ~/.claude/scripts/ へコピー
```

## 使い方

Claude Code のプロジェクト内（ルートまたはそのサブフォルダ）で実行します。

```sh
node ~/.claude/scripts/cclogview.js                # ChatLog.html を生成／差分追記（既定）
node ~/.claude/scripts/cclogview.js --format md    # ChatLog.md（--md でも可）
node ~/.claude/scripts/cclogview.js --format both  # HTML と Markdown を両方（--both でも可）
node ~/.claude/scripts/cclogview.js --rebuild      # 既存出力を無視して全件を作り直す
node ~/.claude/scripts/cclogview.js --log-dir <p>  # ログ（JSONL）フォルダを直接指定
node ~/.claude/scripts/cclogview.js --print-dir    # 出力先フォルダのパスを表示して終了
```

`--rebuild` の別名：`-r` / `--full` / `--all`

### 出力先

出力は常に `~/.claude-logs/<プロジェクト名>/` に書き出します。`<プロジェクト名>` はフルパスのエンコードではなく、プロジェクトルートのフォルダ名です。フォルダは自動で作成します。
旧バージョンの出力（プロジェクト直下の `ChatLog.*`）が残っている場合は、新しい出力先へ自動で移動し、以降はそこへ追記します。

### プロジェクトルートの特定

実行したフォルダから親へさかのぼり、次の順に判定して、最も近い階層のフォルダをルートとします。

1. `~/.claude/projects/` に対応するログフォルダがある
2. `.claude/` がある（ホームの `~/.claude` は除外）
3. `.git` がある

見つからない場合はエラー終了します。

### ログフォルダの指定

ログフォルダを自動検出できない場合は、`--log-dir "<パス>"` を指定するか、プロジェクトの `.claude/settings.local.json` に次を記述します。

```json
{ "cclogview": { "logDir": "<JSONL のあるフォルダの絶対パス>" } }
```

`logDir` の代わりに `projectDir`（`~/.claude/projects` 直下のフォルダ名）でも指定できます。

## Stop hook による自動更新

ユーザスコープの `~/.claude/settings.json` に次を追加すると、Claude Code の応答が終わるたびにログを更新します（Windows / PowerShell の例）。

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$env:USERPROFILE\\.claude\\scripts\\cclogview.js\" --format both; exit 0",
            "shell": "powershell"
          }
        ]
      }
    ]
  }
}
```

## ユーティリティスクリプト（Windows）

[scripts/](scripts/) にあるバッチファイルです。`~/.claude/scripts/cclogview.js` の場所は環境変数 `%USERPROFILE%` で解決します。

| ファイル | 内容 |
| --- | --- |
| `mkcclog.bat` | ログを手動で生成（`--format both`） |
| `cclog.bat` | プロジェクトの `ChatLog.html` を Chrome で開く |
| `ch.bat` | 引数を渡して Chrome を起動（`cclog.bat` から使用） |

## 自動リロード

実行のたびに `ChatLog.html` を自動で再表示したい場合は、VS Code 拡張 **Live Server** などのローカルサーバ経由で開いてください。`file://` で直接開いた場合は自動リロードされません。

## ライセンス

MIT
