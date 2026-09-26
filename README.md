# CC-Log-View

<table>
  <thead>
    <tr>
      <th style="text-align:center">English</th>
      <th style="text-align:center"><a href="README_ja.md">日本語</a></th>
    </tr>
  </thead>
</table>

A Node.js tool that merges Claude Code chat logs (JSONL) into a single, readable `ChatLog.html` / `ChatLog.md`.

## Features

- Merges every session (`*.jsonl`) of a project in timestamp order
- Recreates the readability of the Claude Code chat view (user and assistant messages on opposite sides; thinking and tool input/output are collapsible)
- Outputs HTML, Markdown, or both
- Incremental updates: records the last timestamp at the end of the file and appends only newer entries on each run
- Writes to `~/.claude-logs/<project>/`, outside the repository, so the output is never tracked by git
- Works from any subfolder of a project (walks up to find the project root)
- No dependencies (Node.js standard library only)

## Requirements

- Node.js
- Claude Code (logs are read from `~/.claude/projects/`)

## Installation

```sh
git clone https://github.com/sadakenji/CC-Log-View.git
cd CC-Log-View
npm run deploy   # copies cclogview.js to ~/.claude/scripts/
```

## Usage

Run inside a Claude Code project (the root or any subfolder).

```sh
node ~/.claude/scripts/cclogview.js                # generate / append ChatLog.html (default)
node ~/.claude/scripts/cclogview.js --format md    # ChatLog.md (--md also works)
node ~/.claude/scripts/cclogview.js --format both  # both HTML and Markdown (--both also works)
node ~/.claude/scripts/cclogview.js --rebuild      # ignore existing output and rebuild everything
node ~/.claude/scripts/cclogview.js --log-dir <p>  # specify the JSONL log folder directly
node ~/.claude/scripts/cclogview.js --print-dir    # print the output folder path and exit
```

Aliases for `--rebuild`: `-r` / `--full` / `--all`.

### Output location

Output is always written to `~/.claude-logs/<project>/`, where `<project>` is the name of the project root folder (not an encoded full path). The folder is created automatically.
If `ChatLog.*` files from an older version remain in the project root, they are moved to the new location automatically and later runs append to them.

### Finding the project root

Starting from the current folder, the tool walks up the parent folders and uses the nearest folder that matches, checking in this order:

1. A matching log folder exists under `~/.claude/projects/`
2. It contains `.claude/` (`~/.claude` in the home folder is excluded)
3. It contains `.git`

If no root is found, the tool exits with an error.

### Specifying the log folder

If the log folder cannot be detected automatically, use `--log-dir "<path>"` or add the following to the project's `.claude/settings.local.json`:

```json
{ "cclogview": { "logDir": "<absolute path of the folder containing the JSONL files>" } }
```

`projectDir` (a folder name directly under `~/.claude/projects`) can be used instead of `logDir`.

## Updating automatically with a Stop hook

Add the following to the user-scope `~/.claude/settings.json` to update the log every time Claude Code finishes a response (Windows / PowerShell example):

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

## Utility scripts (Windows)

Batch files in [scripts/](scripts/). They use the `%USERPROFILE%` environment variable to locate `~/.claude/scripts/cclogview.js`.

| File | Description |
| --- | --- |
| `mkcclog.bat` | Generates the log manually (`--format both`) |
| `cclog.bat` | Opens the project's `ChatLog.html` in Chrome |
| `ch.bat` | Launches Chrome with the given arguments (used by `cclog.bat`) |

## Live reload

To see `ChatLog.html` refresh automatically after each run, open it through a local server such as the VS Code extension **Live Server**. A page opened directly with `file://` does not reload automatically.

## License

MIT
