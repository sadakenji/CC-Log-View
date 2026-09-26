#!/usr/bin/env node
"use strict";

/**
 * CC-Log-View
 *
 * Claude Code のチャットログ（~/.claude/projects/<encoded>/ *.jsonl）を集約・整形し、
 * ~/.claude-logs/<プロジェクト名>/ に ChatLog.html / ChatLog.md として出力する。
 * （<プロジェクト名> はフルパスのエンコードではなく、実行ディレクトリの名前のみ）
 *
 * - 複数セッション(*.jsonl)をタイムスタンプ順にマージ
 * - 元のチャット表示の読みやすさを再現（思考/ツール入出力は折りたたみ）
 * - 出力形式は --format html|md（既定 html、--md は md の短縮）
 * - ファイル末尾に最後のチャット行のタイムスタンプを記録し、
 *   再実行時はそれより新しい分のみを追記する（差分更新）
 *
 * 使い方:
 *   node cclogview.js                 HTML を生成／差分追記
 *   node cclogview.js --format md     Markdown を生成／差分追記
 *   node cclogview.js --format both   HTML と Markdown を両方
 *   node cclogview.js --rebuild       既存出力を無視して全件を作り直す
 *   node cclogview.js --log-dir <p>   ログ(jsonl)フォルダを直接指定
 *
 * ログフォルダの自動検出に失敗する場合は、--log-dir で直接指定するか、
 * プロジェクトの .claude/settings.local.json に次を記述する:
 *   { "cclogview": { "logDir": "<jsonl のあるフォルダの絶対パス>" } }
 *   （または { "cclogview": { "projectDir": "<~/.claude/projects 直下のフォルダ名>" } }）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TS_MARKER_RE = /<!--\s*CCLOGVIEW:LAST_TS=([^\s]+)\s*-->/;
const BODY_END_MARK = "<!-- CCLOGVIEW:BODY_END -->";
const BODY_START_MARK = "<!-- CCLOGVIEW:BODY_START -->";

// ---------------------------------------------------------------------------
// ログファイルの特定
// ---------------------------------------------------------------------------

/** cwd を Claude Code のプロジェクトフォルダ名へエンコードする（`:` `\` `/` → `-`）。 */
function encodeProjectDir(cwd) {
  return cwd.replace(/[:\\/]/g, "-");
}

const PROJECTS_BASE = path.join(os.homedir(), ".claude", "projects");
const OUTPUT_BASE = path.join(os.homedir(), ".claude-logs");

/** 出力先フォルダ（~/.claude-logs/<プロジェクト名>/）を解決し、無ければ作成する。 */
function resolveOutputDir() {
  const dir = path.join(OUTPUT_BASE, path.basename(process.cwd()));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** プロジェクトの設定ファイルから cclogview 用の設定を読む（無ければ null）。 */
function readProjectConfig() {
  for (const name of ["settings.local.json", "settings.json"]) {
    const file = path.join(process.cwd(), ".claude", name);
    if (!fs.existsSync(file)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (cfg && cfg.cclogview) return cfg.cclogview;
    } catch {
      // 壊れた JSON は無視して次へ
    }
  }
  return null;
}

/** base 直下から name を大小無視で探す（ドライブレター等の大小差を吸収）。 */
function findDirCaseInsensitive(base, name) {
  if (!fs.existsSync(base)) return null;
  const lower = name.toLowerCase();
  const hit = fs.readdirSync(base).find((d) => d.toLowerCase() === lower);
  return hit ? path.join(base, hit) : null;
}

/**
 * ログ（jsonl）のあるフォルダを解決する。
 * 優先: CLI --log-dir > settings.local.json の cclogview.logDir / projectDir
 *       > cwd からの自動検出（完全一致 → 大小無視）。
 */
function resolveLogDir(cliLogDir) {
  // 1) CLI 明示指定
  if (cliLogDir) return path.resolve(cliLogDir);

  // 2) プロジェクト設定での明示指定
  const cfg = readProjectConfig();
  if (cfg) {
    if (cfg.logDir) return path.resolve(cfg.logDir);
    if (cfg.projectDir) return path.join(PROJECTS_BASE, cfg.projectDir);
  }

  // 3) cwd から自動検出
  const encoded = encodeProjectDir(process.cwd());
  const exact = path.join(PROJECTS_BASE, encoded);
  if (fs.existsSync(exact)) return exact;
  const ci = findDirCaseInsensitive(PROJECTS_BASE, encoded);
  if (ci) return ci;

  return exact; // 見つからない（呼び出し側でエラー表示）
}

function findLogFiles(cliLogDir) {
  const dir = resolveLogDir(cliLogDir);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `ログフォルダが見つかりません: ${dir}\n` +
        `自動検出できない場合は、プロジェクトの .claude/settings.local.json に\n` +
        `  { "cclogview": { "logDir": "<jsonl のあるフォルダの絶対パス>" } }\n` +
        `を記述するか、--log-dir "<パス>" で直接指定してください。`
    );
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f));
}

// ---------------------------------------------------------------------------
// JSONL の読み込みと正規化
// ---------------------------------------------------------------------------

/**
 * 全 jsonl を読み、描画対象のエントリだけを {ts, role, parts[]} に正規化して返す。
 * parts の各要素: {kind, ...}  kind = command|text|thinking|tool_use|tool_result
 */
function loadEntries(files) {
  const entries = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // 壊れた行はスキップ
      }
      const norm = normalize(o);
      if (norm && norm.parts.length) entries.push(norm);
    }
  }
  // タイムスタンプ昇順。同時刻は元の出現順を保つため安定ソート前提（Node は安定）。
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return entries;
}

function normalize(o) {
  if (o.type !== "user" && o.type !== "assistant") return null;
  if (o.isMeta) return null; // コマンド展開などの注入メッセージは表示しない
  const ts = o.timestamp || "";
  const msg = o.message || {};
  const parts = [];

  if (typeof msg.content === "string") {
    const c = parseUserString(msg.content);
    if (c) parts.push(c);
  } else if (Array.isArray(msg.content)) {
    for (const c of msg.content) {
      const p = normalizePart(c, o.type);
      if (p) parts.push(p);
    }
  }
  if (!parts.length) return null;
  return { ts, role: o.type, parts };
}

/** 文字列コンテンツ（主にユーザー入力）をパーツ化。スラッシュコマンドは専用表示。 */
function parseUserString(text) {
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) return { kind: "command", name: cmd[1].trim() };
  const cleaned = stripNoise(text);
  if (!cleaned.trim()) return null;
  return { kind: "text", text: cleaned };
}

function normalizePart(c, role) {
  switch (c.type) {
    case "text": {
      const cleaned = stripNoise(c.text || "");
      if (!cleaned.trim()) return null;
      return { kind: "text", text: cleaned };
    }
    case "thinking": {
      if (!c.thinking || !c.thinking.trim()) return null;
      return { kind: "thinking", text: c.thinking };
    }
    case "tool_use":
      return { kind: "tool_use", name: c.name || "tool", input: c.input };
    case "tool_result":
      return {
        kind: "tool_result",
        text: stringifyToolResult(c.content),
        isError: !!c.is_error,
      };
    default:
      return null;
  }
}

/** ツール結果の content（string | parts[]）を表示用テキストへ。 */
function stringifyToolResult(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p.type === "text") return p.text;
        if (p.type === "image") return "[画像]";
        return JSON.stringify(p);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

/** ハーネス注入タグ（system-reminder / ide_* / command-*）を除去して見た目を実際の画面に近づける。 */
function stripNoise(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, "")
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .replace(/<ide_diagnostics>[\s\S]*?<\/ide_diagnostics>/g, "")
    .trim();
}

// ---------------------------------------------------------------------------
// HTML 描画
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 軽量 Markdown → HTML（コードブロック・見出し・リスト・強調・インラインコード・リンク）。 */
function mdToHtml(src) {
  const codeBlocks = [];
  // 1) フェンスドコードブロックを退避
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.length;
    codeBlocks.push(
      `<pre class="code"><code>${esc(code.replace(/\n$/, ""))}</code></pre>`
    );
    return ` CB${i} `;
  });

  text = esc(text);

  // 2) ブロック単位で処理
  const lines = text.split("\n");
  const out = [];
  let listType = null; // 'ul' | 'ol'
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const cb = line.match(/^ CB(\d+) $/);
    if (cb) {
      closeList();
      out.push(codeBlocks[+cb[1]]);
      continue;
    }
    // GFM テーブル: ヘッダ行 + 区切り行(---) を検出
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const headers = parseTableRow(line);
      i += 2;
      const rows = [];
      while (
        i < lines.length &&
        lines[i].includes("|") &&
        lines[i].trim() !== ""
      ) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      i--; // for ループ側の i++ を相殺
      out.push(renderTable(headers, rows));
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    if (ul) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") out.push("");
    else out.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  let html = out.join("\n");
  // 退避したコードブロックを戻す
  html = html.replace(/ CB(\d+) /g, (_, i) => codeBlocks[+i]);
  return html;
}

/** インライン要素（コード・強調・リンク）。入力は escape 済みである前提。 */
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, t, u) => `<a href="${u}">${t}</a>`
    );
}

/** GFM テーブルの区切り行（|---|:--:| など）か判定。 */
function isTableSep(line) {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) &&
    line.includes("-");
}

/** テーブル行を升目配列に分割（先頭・末尾の | は除去）。入力は escape 済み前提。 */
function parseTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function renderTable(headers, rows) {
  const th = headers.map((c) => `<th>${inline(c)}</th>`).join("");
  const body = rows
    .map(
      (r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`
    )
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 1 メッセージ（user/assistant）を HTML 断片へ。 */
function renderEntry(e) {
  const blocks = e.parts.map((p) => renderPart(p)).filter(Boolean);
  if (!blocks.length) return "";
  // ツール結果のみのユーザーメッセージは「ツール出力」扱いで左（Claude 側）へ。
  const toolOnly =
    e.role === "user" && e.parts.every((p) => p.kind === "tool_result");
  const side = e.role === "assistant" || toolOnly ? "left" : "right";
  const label = toolOnly ? "ツール" : e.role === "user" ? "ユーザー" : "Claude";
  return (
    `<div class="msg ${side}${toolOnly ? " tool-msg" : ""}">` +
    `<div class="meta"><span class="who">${label}</span>` +
    `<span class="time">${esc(fmtTime(e.ts))}</span></div>` +
    `<div class="body">${blocks.join("")}</div>` +
    `</div>`
  );
}

function renderPart(p) {
  switch (p.kind) {
    case "command":
      return `<div class="cmd">${esc(p.name)}</div>`;
    case "text":
      return `<div class="text">${mdToHtml(p.text)}</div>`;
    case "thinking":
      return (
        `<details class="thinking"><summary>💭 思考</summary>` +
        `<div class="text">${mdToHtml(p.text)}</div></details>`
      );
    case "tool_use": {
      const input = p.input == null ? "" : JSON.stringify(p.input, null, 2);
      return (
        `<details class="tool"><summary>🔧 ${esc(p.name)}</summary>` +
        `<pre class="code"><code>${esc(input)}</code></pre></details>`
      );
    }
    case "tool_result": {
      const cls = p.isError ? "tool-result error" : "tool-result";
      const head = p.isError ? "⚠️ 結果（エラー）" : "📄 結果";
      const text = p.text.length > 0 ? p.text : "(空)";
      return (
        `<details class="${cls}"><summary>${head}</summary>` +
        `<pre class="code"><code>${esc(text)}</code></pre></details>`
      );
    }
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// ページの組み立て（新規作成 / 差分追記）
// ---------------------------------------------------------------------------

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font-family:"Segoe UI",system-ui,sans-serif;
  background:#f5f5f7;color:#1d1d1f;line-height:1.6}
@media(prefers-color-scheme:dark){body{background:#1a1a1c;color:#e6e6e6}}
header{position:sticky;top:0;background:#5b4cf0;color:#fff;
  padding:14px 20px;font-weight:600;box-shadow:0 1px 6px rgba(0,0,0,.2);z-index:5}
header small{font-weight:400;opacity:.85;margin-left:10px}
main{max-width:920px;margin:0 auto;padding:20px}
.msg{position:relative;margin:14px 0;padding:12px 16px;border-radius:14px;
  max-width:80%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);
  word-break:break-word}
@media(prefers-color-scheme:dark){.msg{background:#262629;box-shadow:none}}
/* LINE 風: Claude の発言とツール出力は左、ユーザー入力は右に寄せる */
.msg.left{margin-right:auto;border-top-left-radius:4px}
.msg.right{margin-left:auto;border-top-right-radius:4px;background:#c8f0b4}
@media(prefers-color-scheme:dark){.msg.right{background:#2f5d3a}}
.msg.tool-msg{max-width:90%;opacity:.92}
.meta{display:flex;gap:10px;align-items:baseline;
  font-size:12px;margin-bottom:8px;opacity:.75}
.msg.right .meta{flex-direction:row-reverse}
.who{font-weight:600}
.body>*{margin:6px 0}
.body>*:first-child{margin-top:0}
.body>*:last-child{margin-bottom:0}
.cmd{display:inline-block;background:#eceafc;color:#5b4cf0;
  padding:3px 10px;border-radius:6px;font-family:ui-monospace,monospace;font-weight:600}
@media(prefers-color-scheme:dark){.cmd{background:#33305a}}
.text p{margin:.4em 0}
.code{background:#0d1117;color:#d6deeb;padding:12px 14px;border-radius:8px;
  overflow:auto;font-family:ui-monospace,"Cascadia Code",monospace;font-size:13px;margin:6px 0}
.text code{background:rgba(120,120,120,.18);padding:1px 5px;border-radius:4px;
  font-family:ui-monospace,monospace;font-size:.92em}
.text pre.code code{background:none;padding:0}
details{border-radius:8px;padding:2px 0;margin:6px 0}
details summary{cursor:pointer;font-size:13px;opacity:.8;user-select:none;padding:4px 0}
details summary:hover{opacity:1}
.thinking{background:rgba(120,120,120,.06);padding:4px 12px;border-radius:8px}
.thinking .text{font-style:italic;opacity:.85}
.tool-result.error summary{color:#d83b3b}
h1,h2,h3,h4{line-height:1.3}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px}
table th,table td{border:1px solid #c9c9d4;padding:6px 10px;text-align:left}
table th{background:#eceafc;font-weight:600}
table tr:nth-child(even) td{background:rgba(120,120,120,.05)}
@media(prefers-color-scheme:dark){
  table th,table td{border-color:#444}
  table th{background:#33305a}
}
a{color:#5b4cf0}
footer{max-width:920px;margin:0 auto;padding:10px 20px 40px;font-size:12px;opacity:.6}
`;

function buildNewPage(bodyHtml, lastTs) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code チャットログ</title>
<style>${STYLE}</style>
</head>
<body>
<header>Claude Code チャットログ<small>${esc(
    path.basename(process.cwd())
  )}</small></header>
<main id="log">
${BODY_START_MARK}
${bodyHtml}
${BODY_END_MARK}
</main>
<footer>生成: ${esc(fmtTime(new Date().toISOString()))} ／ 最終ログ: ${esc(
    fmtTime(lastTs)
  )}</footer>
${tsMarker(lastTs)}
</body>
</html>
`;
}

function tsMarker(ts) {
  return `<!-- CCLOGVIEW:LAST_TS=${ts} -->`;
}

// 構造マーカーは常に本文より後（ファイル末尾側）にある。一方チャット本文中にも同じ
// 文字列が引用混入し得る（特に未エスケープの Markdown）。そのため検索・置換はすべて
// 「最後の出現」を対象にして、本文中の擬似マーカーとの衝突を防ぐ。

/** ファイル末尾側の正規マーカーから前回の最終タイムスタンプを取り出す。 */
function readPrevTs(text) {
  const re = new RegExp(TS_MARKER_RE.source, "g");
  let m;
  let last = "";
  while ((m = re.exec(text))) last = m[1];
  return last;
}

/** 最後の find（文字列）を replacement に置換。 */
function replaceLastStr(str, find, replacement) {
  const i = str.lastIndexOf(find);
  if (i === -1) return str;
  return str.slice(0, i) + replacement + str.slice(i + find.length);
}

/** 最後にマッチした正規表現箇所を replacement に置換。 */
function replaceLastRe(str, re, replacement) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m;
  let last = null;
  while ((m = g.exec(str))) last = m;
  if (!last) return str;
  return str.slice(0, last.index) + replacement + str.slice(last.index + last[0].length);
}

/** 既存ファイルに新規断片を差し込み、フッターとマーカーを更新する。 */
function appendToPage(existing, bodyHtml, lastTs) {
  let out = replaceLastStr(existing, BODY_END_MARK, `${bodyHtml}\n${BODY_END_MARK}`);
  out = replaceLastRe(
    out,
    /<footer>[\s\S]*?<\/footer>/,
    `<footer>生成: ${esc(fmtTime(new Date().toISOString()))} ／ 最終ログ: ${esc(
      fmtTime(lastTs)
    )}</footer>`
  );
  out = replaceLastRe(out, TS_MARKER_RE, tsMarker(lastTs));
  return out;
}

// ---------------------------------------------------------------------------
// Markdown 描画
// ---------------------------------------------------------------------------

/** content 中の連続バックティックより長いフェンスを返す（コード内 ``` での崩れ防止）。 */
function fenceFor(text) {
  let max = 0;
  for (const m of String(text).matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return "`".repeat(Math.max(3, max + 1));
}

/** GFM の <details> ブロック（Markdown が中身を解釈できるよう前後に空行を入れる）。 */
function detailsMd(summary, inner) {
  return `<details><summary>${summary}</summary>\n\n${inner}\n\n</details>`;
}

/** 1 メッセージを Markdown 断片へ。 */
function renderEntryMd(e) {
  const blocks = e.parts.map((p) => renderPartMd(p)).filter(Boolean);
  if (!blocks.length) return "";
  const label = e.role === "user" ? "👤 ユーザー" : "🤖 Claude";
  const head = `### ${label} · ${fmtTime(e.ts)}`;
  return `${head}\n\n${blocks.join("\n\n")}`;
}

function renderPartMd(p) {
  switch (p.kind) {
    case "command":
      return `\`${p.name}\``;
    case "text":
      return p.text; // 既に Markdown
    case "thinking":
      return detailsMd("💭 思考", p.text);
    case "tool_use": {
      const input = p.input == null ? "" : JSON.stringify(p.input, null, 2);
      const f = fenceFor(input);
      return detailsMd(`🔧 ${p.name}`, `${f}json\n${input}\n${f}`);
    }
    case "tool_result": {
      const head = p.isError ? "⚠️ 結果（エラー）" : "📄 結果";
      const text = p.text.length > 0 ? p.text : "(空)";
      const f = fenceFor(text);
      return detailsMd(head, `${f}\n${text}\n${f}`);
    }
    default:
      return "";
  }
}

function buildNewPageMd(bodyMd, lastTs) {
  return (
    `# Claude Code チャットログ — ${path.basename(process.cwd())}\n\n` +
    `${BODY_START_MARK}\n\n` +
    `${bodyMd}\n\n` +
    `${BODY_END_MARK}\n\n` +
    `---\n\n` +
    `*生成: ${fmtTime(new Date().toISOString())} ／ 最終ログ: ${fmtTime(
      lastTs
    )}*\n\n` +
    `${tsMarker(lastTs)}\n`
  );
}

function appendToPageMd(existing, bodyMd, lastTs) {
  let out = replaceLastStr(existing, BODY_END_MARK, `${bodyMd}\n\n${BODY_END_MARK}`);
  out = replaceLastRe(
    out,
    /\*生成:[^*]*?\*/,
    `*生成: ${fmtTime(new Date().toISOString())} ／ 最終ログ: ${fmtTime(
      lastTs
    )}*`
  );
  out = replaceLastRe(out, TS_MARKER_RE, tsMarker(lastTs));
  return out;
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

/** コマンドライン引数を解釈する。 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const rebuild = args.some((a) =>
    ["--rebuild", "-r", "--full", "--all"].includes(a)
  );
  let format = "html";
  if (args.includes("--md")) format = "md";
  if (args.includes("--both")) format = "both";
  const fi = args.indexOf("--format");
  if (fi !== -1 && args[fi + 1]) format = args[fi + 1].toLowerCase();
  if (!["html", "md", "both"].includes(format)) {
    throw new Error(
      `未対応の形式です: ${format}（html / md / both を指定してください）`
    );
  }
  // --log-dir <path>: ログフォルダを直接指定
  let logDir = null;
  const di = args.indexOf("--log-dir");
  if (di !== -1 && args[di + 1]) logDir = args[di + 1];
  return { rebuild, format, logDir };
}

/** 出力形式ごとの差分。 */
const RENDERERS = {
  html: {
    file: "ChatLog.html",
    renderEntry,
    buildNewPage,
    appendToPage,
  },
  md: {
    file: "ChatLog.md",
    renderEntry: renderEntryMd,
    buildNewPage: buildNewPageMd,
    appendToPage: appendToPageMd,
  },
};

/**
 * 旧仕様の出力（プロジェクト直下の ChatLog.*）が残っていれば新しい出力先へ移動する。
 * 移動後はそのファイル末尾のマーカーを基準に差分追記が継続される。
 */
function migrateLegacyOutput(outDir) {
  for (const { file } of Object.values(RENDERERS)) {
    const src = path.join(process.cwd(), file);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(outDir, file);
    if (fs.existsSync(dest)) {
      console.warn(
        `[移行] ${dest} が既に存在するため、旧ファイル ${src} は移動しませんでした。` +
          `不要であれば手動で削除してください。`
      );
      continue;
    }
    try {
      fs.renameSync(src, dest);
    } catch {
      // 別ドライブ間など rename できない場合はコピー＋削除
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    }
    console.log(`[移行] 旧出力を移動しました: ${src} → ${dest}`);
  }
}

/** 1 形式分の出力を生成／差分追記する。entries は読込済みの全エントリ。 */
function generate(format, rebuild, entries, outDir) {
  const r = RENDERERS[format];
  const outputFile = path.join(outDir, r.file);

  // 既存出力から前回の最終タイムスタンプを取得（差分更新の基準）
  let prevTs = "";
  let existing = null;
  if (!rebuild && fs.existsSync(outputFile)) {
    existing = fs.readFileSync(outputFile, "utf8");
    prevTs = readPrevTs(existing);
  }

  const isAppend = existing && existing.includes(BODY_END_MARK) && prevTs;
  const targets = isAppend
    ? entries.filter((e) => e.ts > prevTs)
    : entries;

  if (!targets.length) {
    console.log(`[${format}] 更新はありません（最終ログ: ${fmtTime(prevTs)}）。`);
    return;
  }

  const sep = format === "md" ? "\n\n" : "\n";
  const body = targets.map(r.renderEntry).filter(Boolean).join(sep);
  const lastTs = targets[targets.length - 1].ts;

  const content = isAppend
    ? r.appendToPage(existing, body, lastTs)
    : r.buildNewPage(body, lastTs);

  fs.writeFileSync(outputFile, content, "utf8");

  const action = isAppend ? "追記" : rebuild ? "再生成" : "生成";
  console.log(
    `[${format}] ${action}完了: ${outputFile}\n` +
      `  対象メッセージ: ${targets.length} 件 ／ 最終ログ: ${fmtTime(lastTs)}`
  );
}

function main() {
  const { rebuild, format, logDir } = parseArgs(process.argv);

  const files = findLogFiles(logDir);
  if (!files.length) {
    console.log("jsonl ログが見つかりませんでした。");
    return;
  }
  const entries = loadEntries(files);
  if (!entries.length) {
    console.log("表示対象のチャットがありませんでした。");
    return;
  }

  const outDir = resolveOutputDir();
  migrateLegacyOutput(outDir);
  const formats = format === "both" ? ["html", "md"] : [format];
  for (const f of formats) generate(f, rebuild, entries, outDir);
}

try {
  main();
} catch (err) {
  console.error("エラー:", err.message);
  process.exitCode = 1;
}
