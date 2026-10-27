import type { EvidenceRecord, PageExtras, PageMeta, WritePayload } from "./report-types.ts";
import { esc, inline, katexCss, prose, withReferences } from "./markup.ts";

function paragraphs(text: string): string {
  return text.split(/\r?\n\s*\r?\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p)}</p>`).join("");
}

// Runtime-generated text (paths, warnings) is plain; only authored prose gets markup and math.
// URLs come from the runtime's resolved scope, never from article prose.
function safeUrl(value?: string): string | undefined {
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
  } catch { /* An invalid URL is displayed as text, not a link. */ }
}

function linked(label: string, url?: string): string {
  const href = safeUrl(url);
  return href ? `<a href="${esc(href)}" rel="noreferrer">${esc(label)}</a>` : esc(label);
}

function status(r: EvidenceRecord): string {
  if (r.refused) return `not run (${r.refused})`;
  if (r.timed_out) return "timed out";
  return r.exit == null ? "exit not recorded" : `exit ${r.exit}`;
}

function issue(r: EvidenceRecord): boolean {
  return Boolean(r.refused || r.timed_out || (r.exit != null && r.exit !== 0));
}

// A CSV view requires a complete rectangular document, including a header and data.
// No delimiter guessing, shell splitting, or recovery from malformed quoting.
function csvRows(text: string): string[][] | undefined {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", state: "start" | "plain" | "quoted" | "closed" = "start";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === "quoted") {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else state = "closed";
      } else cell += c;
      continue;
    }
    if (c === ",") { row.push(cell); cell = ""; state = "start"; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] !== "\n") return;
      if (c === "\r") i++;
      row.push(cell); rows.push(row); row = []; cell = ""; state = "start";
      continue;
    }
    if (state === "closed") return;
    if (c === '"') {
      if (state !== "start") return;
      state = "quoted";
    } else { cell += c; state = "plain"; }
  }
  if (state === "quoted") return;
  if (row.length || cell || state !== "start") { row.push(cell); rows.push(row); }
  if (rows.length < 2 || rows[0].length < 2 || rows.some((r) => r.length !== rows[0].length)) return;
  return rows;
}

function structured(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      // Format the validated original tokens rather than serializing parsed numbers:
      // large integers, exponent spellings, duplicate keys and string escapes survive.
      let depth = 0, quoted = false, escaped = false, formatted = "";
      const indent = () => "  ".repeat(depth);
      const compact = text.trim();
      for (let i = 0; i < compact.length; i++) {
        const c = compact[i];
        if (quoted) {
          formatted += c;
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') { quoted = true; formatted += c; }
        else if (c === "{" || c === "[") { depth++; formatted += c + "\n" + indent(); }
        else if (c === "}" || c === "]") { depth--; formatted += "\n" + indent() + c; }
        else if (c === ",") formatted += ",\n" + indent();
        else if (c === ":") formatted += ": ";
        else if (!/\s/.test(c)) formatted += c;
      }
      return `<div class="prepared-output"><h4>JSON view</h4><pre><code>${esc(formatted)}</code></pre></div>`;
    }
  } catch { /* Only whole-output JSON is eligible. */ }
  const rows = csvRows(text);
  if (!rows) return "";
  return `<div class="prepared-output"><h4>CSV view</h4><div class="table-scroll" tabindex="0" role="region" aria-label="CSV output"><table><thead><tr>${rows[0].map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;
}

// A unified diff, or diff lines filtered with grep: file or hunk headers, or mostly +/- lines with
// both additions and deletions. A Markdown bullet list (only "-" lines) is not a diff.
const DIFF_FILE = /^(?:diff --git |index [0-9a-f]+\.\.|(?:---|\+\+\+) (?:a\/|b\/|\/dev\/null)|new file mode|deleted file mode|similarity index|rename (?:from|to) )/;
type DiffKind = "add" | "del" | "hunk" | "file" | "ctx";
// grep -n / -C output prefixes each line with "NNN:" (match) or "NNN-" (context); look past it.
const GREP_PREFIX = /^\d+[-:]/;
function diffKind(line: string): DiffKind {
  if (GREP_PREFIX.test(line)) {
    const rest = line.replace(GREP_PREFIX, "");
    if (rest.startsWith("+") || rest.startsWith("-") || rest.startsWith("@@")) return diffKind(rest);
  }
  if (DIFF_FILE.test(line)) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (/^-{3,}\s*$/.test(line) || /^\+{3,}\s*$/.test(line)) return "ctx"; // separators such as "----"
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

export function isDiff(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;
  const kinds = lines.map(diffKind);
  const adds = kinds.filter((k) => k === "add").length, dels = kinds.filter((k) => k === "del").length;
  if (!adds && !dels) return false;
  if (kinds.some((k) => k === "hunk" || k === "file")) return true;
  return adds > 0 && dels > 0 && (adds + dels) / lines.length >= 0.5;
}

/**
 * The exact text, one span per line, so additions and deletions can be shaded. Tags only:
 * the text content is byte-for-byte the recorded output. Colors are vermilion and blue, which
 * stay distinct with red-green color blindness, and the +/- markers keep the meaning without color.
 */
function diffCode(text: string): string {
  const lines = text.split("\n");
  return lines.map((l, i) => {
    const k = diffKind(l);
    const nl = i < lines.length - 1 ? "\n" : "";
    return k === "ctx" ? esc(l) + nl : `<span class="d-${k}">${esc(l)}${nl}</span>`;
  }).join("");
}

function diffSummary(text: string): string {
  const kinds = text.split("\n").map(diffKind);
  const adds = kinds.filter((k) => k === "add").length, dels = kinds.filter((k) => k === "del").length;
  return `<p class="diff-key"><span class="d-add">+${adds} added</span> <span class="d-del">\u2212${dels} removed</span></p>`;
}

/** Exact recorded text in a code block, shaded as a diff when it is one. */
export function codeBlock(text: string): string {
  return isDiff(text) ? `<pre class="diff"><code>${diffCode(text)}</code></pre>` : `<pre><code>${esc(text)}</code></pre>`;
}

function output(label: string, text: string, cut = 0): string {
  const view = cut > 0 ? "" : structured(text);
  const diff = !view && isDiff(text);
  return `<section class="output"><h4>${label}</h4>${cut > 0 ? `<p class="warning">Truncated: ${esc(cut)} bytes omitted from ${label.toLowerCase()}. This is not the complete output.</p>` : ""}${view}${view ? `<details><summary>Exact recorded ${label.toLowerCase()}</summary>` : ""}${diff ? diffSummary(text) : ""}${codeBlock(text)}${view ? "</details>" : ""}</section>`;
}

const CSS = `
:root{color-scheme:light;--paper:#fcfcfa;--ink:#242a30;--muted:#535e68;--rule:#d9dfe2;--tint:#f0f3f4;--link:#185a86;--warning:#933a22}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:850px;margin:auto;padding:48px 28px 80px}h1,h2,h3,h4{line-height:1.25;text-wrap:balance}h1{font-size:2.1rem;margin:8px 0 18px}h2{font-size:1.45rem;margin:36px 0 16px}h3{font-size:1.1rem}h4{font-size:1rem;margin-bottom:8px}p{margin:12px 0;white-space:pre-line;overflow-wrap:anywhere}p code,li code,td code,th code,h2 code{font-size:.88em;background:var(--tint);padding:1px 4px;border-radius:3px}.math-display{overflow-x:auto;overflow-y:hidden;margin:16px 0}.katex-display{margin:0}a.ref{text-decoration-style:dotted}.prose-table{margin:18px 0;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink)}.prose-table th{border-bottom:1px solid var(--ink);font-weight:600}.prose-table td,.prose-table th{white-space:normal;min-width:5rem}.prose-table tbody tr:last-child td{border-bottom:0}ol{padding-left:24px}a{color:var(--link);text-underline-offset:3px;overflow-wrap:anywhere}a:hover{text-decoration-thickness:2px}:focus-visible{outline:3px solid #a65f00;outline-offset:4px}:target{scroll-margin-top:20px}.mode,.secondary,figcaption{font-size:.875rem;color:var(--muted)}.mode{letter-spacing:.04em}.lead{font-size:1.15rem}.status{font-size:.8rem;font-weight:600;border:1px solid var(--rule);padding:2px 6px;border-radius:4px;margin-right:6px;white-space:nowrap}.warning{color:var(--warning);font-weight:600}.evidence{border-left:2px solid var(--rule);padding-left:16px;margin:20px 0}.evidence p{margin:8px 0}.record-id{font-size:.75rem;color:var(--muted);margin-left:5px}section,header,details{min-width:0}details{border-top:1px solid var(--rule);padding:12px 0}summary{cursor:pointer;overflow-wrap:anywhere}summary:hover{color:var(--link)}details[open]>summary{margin-bottom:16px}details details{margin:12px 0 0 16px}.record>summary{font-weight:600}.record>summary .secondary{font-weight:400}pre{background:var(--tint);padding:14px;overflow:auto;max-height:34rem;font-size:.8rem;line-height:1.6;tab-size:4}pre code{white-space:pre;overflow-wrap:normal}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}blockquote{margin:10px 0}blockquote pre{max-height:18rem}.table-scroll{overflow:auto;max-height:32rem}table{border-collapse:collapse;width:100%;font-size:.875rem}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--rule);padding:9px 12px;white-space:pre-wrap;overflow-wrap:anywhere;min-width:7rem}dl{font-size:.875rem;display:grid;grid-template-columns:9rem minmax(0,1fr);gap:8px 16px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}ul{padding-left:24px}li{margin:12px 0;overflow-wrap:anywhere}figure{margin:26px 0}figure img{display:block;width:100%;height:auto}.image-map{position:relative;width:100%;line-height:0}.image-map>a{position:absolute;display:block;border:2px solid transparent;border-radius:3px}.image-map>a:hover{background:#185a8618;border-color:#185a8680}.image-map>a:focus-visible{outline:3px solid #a65f00;outline-offset:0;background:#ffffff55}.figure-links{font-size:.875rem;display:flex;flex-wrap:wrap;gap:8px 20px;list-style:none;padding:0}.figure-links li{margin:0}figcaption{margin-top:10px}#limits{border-left:3px solid #ad7952;padding-left:18px}#log,#technical{margin-top:32px}.prepared-output>h4{color:var(--muted)}.toc{font-size:.875rem;border-left:2px solid var(--rule);padding:2px 0 2px 14px;margin:0 0 24px}.toc p{margin:0 0 4px;color:var(--muted);font-weight:600;white-space:normal}.toc ol{margin:0;padding-left:18px}.toc li{margin:3px 0}.toc a{text-decoration:none}.toc a:hover{text-decoration:underline}@media(min-width:1320px){.toc{position:fixed;top:48px;left:calc(50% - 425px - 240px);width:210px;max-height:calc(100vh - 96px);overflow:auto}}.with-tool{display:flex;align-items:center;gap:10px}.copy,.log-tools button{font:inherit;font-size:.75rem;font-weight:400;padding:2px 9px;border:1px solid var(--rule);border-radius:4px;background:var(--paper);color:var(--ink);cursor:pointer}.copy:hover{border-color:var(--link);color:var(--link)}.log-tools{display:flex;gap:8px;margin:0 0 8px}.log-tools button{font:inherit;font-size:.8rem;padding:3px 10px;border:1px solid var(--rule);border-radius:4px;background:var(--paper);color:var(--ink);cursor:pointer}.log-tools button:hover{border-color:var(--link);color:var(--link)}pre.diff code>span{display:block;margin:0 -14px;padding:0 14px}.d-add{background:#dcebf9;color:#0b3d6b}.d-del{background:#fbe1d7;color:#7a2408}.d-hunk{color:#6b4a9b;background:#f1ecf7}.d-file{font-weight:600;color:var(--ink)}pre.diff code{display:block;min-width:max-content}.diff-key{font-size:.8rem;margin:4px 0 6px;white-space:normal}.diff-key span{padding:1px 6px;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;margin-right:6px}section>ul>li,section>ol>li,.lead li{margin:6px 0;line-height:1.55}section ul ul{margin:4px 0}
@media(max-width:500px){body{font-size:16px}main{padding:24px 18px 48px}h1{font-size:1.7rem}h2{font-size:1.3rem}dl{grid-template-columns:1fr;gap:3px}dd{margin-bottom:10px}details details{margin-left:8px}}
@media print{.toc,.log-tools,.copy{display:none}.d-add,.d-del,.d-hunk{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{background:white;color:black;font-size:11pt}main{max-width:none;padding:0}a{color:inherit}pre,.table-scroll{max-height:none}pre{white-space:pre-wrap}pre code{white-space:pre-wrap;overflow-wrap:anywhere}figure{break-inside:avoid}.image-map>a{display:none}summary{color:black}}
`;

// Static script: no report data is evaluated or interpolated into executable text.
const SCRIPT = `(() => {
  function reveal() {
    let id; try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    let node = target;
    while (node) { if (node.tagName === 'DETAILS') node.open = true; node = node.parentElement; }
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
  }
  addEventListener('hashchange', reveal);
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('button[data-records]');
    if (!button) return;
    const open = button.getAttribute('data-records') === 'open';
    for (const record of document.querySelectorAll('#log details.record')) record.open = open;
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest && event.target.closest('button[data-copy]');
    if (!button) return;
    const source = document.getElementById(button.getAttribute('data-copy'));
    if (!source) return;
    const text = source.textContent;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const area = document.createElement('textarea');
      area.value = text; document.body.appendChild(area); area.select();
      document.execCommand('copy'); area.remove();
    }
    const label = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = label; }, 1200);
  });
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest && event.target.closest('a[href^="#"]');
    if (anchor && anchor.hash === location.hash) setTimeout(reveal, 0);
  });
  reveal();
})();`;

export function renderPage(payload: WritePayload, log: EvidenceRecord[], meta: PageMeta, extras: PageExtras): string {
  const refs = new Map((extras.references ?? []).map((r) => [r.id, r]));
  return withReferences((id) => {
    const r = refs.get(id);
    if (!r) return;
    const title = [r.identifier, r.path, r.sha?.slice(0, 12)].filter(Boolean).join(" · ") || r.label;
    return { href: safeUrl(r.url) ?? `#ref-${id}`, label: r.label, title };
  }, () => renderBody(payload, log, meta, extras));
}

function renderBody(payload: WritePayload, log: EvidenceRecord[], meta: PageMeta, extras: PageExtras): string {
  const byId = new Map(log.map((r) => [r.id, r]));
  const sectionIds = new Set(["overview", ...payload.sections.map((s) => s.id)]);
  const cite = (id: string, label?: string) => {
    const record = byId.get(id);
    return record ? `<a href="#${esc(id)}">${esc(label || record.why || "Recorded evidence")}<small class="record-id">${esc(id)}</small></a>` : esc(label || id);
  };
  const diagramTarget = (target: string): string | undefined => {
    const match = /^(section|record):([a-zA-Z][a-zA-Z0-9-]*)$/.exec(target);
    if (!match) return;
    return (match[1] === "section" ? sectionIds.has(match[2]) : byId.has(match[2])) ? `#${match[2]}` : undefined;
  };
  const visuals = (section: string) => extras.visuals.filter((v) => (v.section_id ?? "overview") === section).map((v) => {
    // SVG is allowed only as an inert image resource, never inline markup.
    if (!/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(v.src)) return "";
    const links = v.kind === "diagram" ? (v.links ?? []).flatMap((l) => {
      const href = diagramTarget(l.target);
      if (!href || ![l.x, l.y, l.width, l.height].every(Number.isFinite) || l.x < 0 || l.y < 0 || l.width <= 0 || l.height <= 0 || l.x + l.width > 100 || l.y + l.height > 100) return [];
      return [{ ...l, href }];
    }) : [];
    return `<figure><div class="image-map"><img src="${esc(v.src)}" alt="${esc(v.alt || v.caption)}">${links.map((l) => `<a href="${esc(l.href)}" aria-label="${esc(l.label)}" style="left:${l.x}%;top:${l.y}%;width:${l.width}%;height:${l.height}%"></a>`).join("")}</div><figcaption>${inline(v.caption)} — ${cite(v.record_id, "Figure source")}</figcaption>${links.length ? `<ul class="figure-links" aria-label="Diagram destinations">${links.map((l) => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`).join("")}</ul>` : ""}</figure>`;
  }).join("");
  const evidence = (items: NonNullable<WritePayload["sections"][number]["evidence"]>) => {
    const groups = new Map<string, typeof items>();
    for (const item of items) groups.set(item.record_id, [...(groups.get(item.record_id) ?? []), item]);
    return [...groups].map(([id, items]) => `<div class="evidence">${items.map((item) => `${prose(item.summary)}${item.quote ? `<blockquote>${codeBlock(item.quote)}</blockquote>` : ""}`).join("")}<p>${cite(id)}</p></div>`).join("");
  };
  const tree = extras.tree;
  const treeWarning = tree && (!tree.checked || tree.changed.length) ? [
    !tree.checked ? "Working-tree comparison could not be completed; repository changes may be undetected." : "",
    tree.changed.length ? `Files changed during the walkthrough: ${tree.changed.join(", ")}.` : "",
  ].filter(Boolean).join(" ") : "";
  const snapshotCitations = treeWarning ? [
    tree?.before_id ? cite(tree.before_id, "Before snapshot") : "",
    tree?.after_id ? cite(tree.after_id, "After snapshot") : "",
  ].filter(Boolean).join(" · ") : "";
  const authoredLimits = new Set(payload.limits);
  const limits = [...payload.limits, ...extras.autoLimits].filter((l) => !treeWarning || l.text !== treeWarning);
  if (extras.scope.warning && !limits.some((l) => l.text === extras.scope.warning)) limits.push({ text: extras.scope.warning });
  // Runtime supplies automatic limits; preserve visibility even for an incomplete caller.
  for (const record of log.filter(issue)) {
    if (treeWarning && (record.id === tree?.before_id || record.id === tree?.after_id)) continue;
    if (!limits.some((l) => l.record_id === record.id) && !payload.checks.some((c) => ["failed", "blocked", "not-run"].includes(c.status) && c.record_ids?.includes(record.id))) {
      limits.push({ text: `Recorded execution ${status(record)}.`, record_id: record.id });
    }
  }
  const uniqueLimits = limits.filter((l, i) => limits.findIndex((other) => other.text === l.text && other.record_id === l.record_id) === i);
  const scopeUrl = safeUrl(extras.scope.compare_url) || safeUrl(extras.scope.head_url) || "#scope";
  const recordHtml = log.map((r) => {
    const metadata: [string, unknown][] = [["Working directory", r.cwd], ["Started", r.started_at], ["Duration (ms)", r.ms], ["Execution status", status(r)], ["Requested ref", r.at_ref], ["Resolved commit", r.ref_sha], ["Overlay files", r.overlay?.join("\n")], ["Paths mapped", r.mapped_paths == null ? undefined : String(r.mapped_paths)], ["Snapshot", r.snapshot]];
    return `<details class="record" id="${esc(r.id)}"><summary>${esc(r.why || "Recorded execution")} <span class="secondary">— ${esc(status(r))}${r.truncated?.stdout || r.truncated?.stderr ? " · truncated output" : ""}<small class="record-id">${esc(r.id)}</small></span></summary>${r.refused ? `<p class="warning">Not run: ${esc(r.refused_reason || r.refused)}</p>` : ""}${r.stdout || r.truncated?.stdout ? output("Stdout", r.stdout ?? "", r.truncated?.stdout) : ""}${r.stderr || r.truncated?.stderr ? output("Stderr", r.stderr ?? "", r.truncated?.stderr) : ""}<h4 class="with-tool">Exact command <button type="button" class="copy" data-copy="cmd-${esc(r.id)}">Copy</button></h4><pre id="cmd-${esc(r.id)}"><code>${esc(r.command)}</code></pre><h4>Technical metadata</h4><dl>${metadata.filter(([, value]) => value !== undefined && value !== "").map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`).join("")}</dl>${r.figures?.length ? `<h4>Figure artifacts</h4><ul>${r.figures.map((f) => `<li><code>${esc(f.path)}</code> · ${esc(f.bytes)} bytes<br><span class="secondary">SHA-256: ${esc(f.sha256)}</span>${f.lint ? `<br><span class="secondary">figkit lint: ${f.lint.length ? esc(f.lint.join("; ")) : "0 findings"}</span>` : ""}${f.outline_failed ? `<br><span class="warning">Text outlining failed: ${esc(f.outline_failed)}</span>` : ""}${f.outlined ? `<br><span class="secondary">Embedded as text outlines: <code>${esc(f.outlined.path)}</code> · SHA-256 ${esc(f.outlined.sha256)}</span>` : ""}</li>`).join("")}</ul>` : ""}${r.produces ? `<p class="secondary">Requested artifact: ${esc(r.produces)}</p>` : ""}${r.produces_missing ? `<p class="warning">Figure not captured: ${esc(r.produces_missing)}</p>` : ""}${r.tree ? `<details><summary>Recorded tree snapshot</summary><pre><code>${esc(JSON.stringify(r.tree, null, 2))}</code></pre></details>` : ""}</details>`;
  }).join("");
  const scope = extras.scope;
  const scopeDetails = `<details id="scope"><summary>Scope and commits</summary><p>${esc(scope.label)}${scope.include_working_tree ? " · includes working-tree content" : " · committed content"}</p><dl>${scope.base_sha ? `<dt>Base commit</dt><dd>${esc(scope.base_sha)}</dd>` : ""}${scope.head_sha ? `<dt>Head commit</dt><dd>${esc(scope.head_sha)}</dd>` : ""}</dl>${scope.commits.length ? `<ul>${scope.commits.map((c) => `<li>${linked(c.subject, c.url)}<br><small>${esc(c.sha)}</small></li>`).join("")}</ul>` : ""}${payload.scope.record_id ? `<p>${cite(payload.scope.record_id, "Scope resolution")}</p>` : ""}</details>`;
  const changes = payload.changes.length ? `<details id="changes"><summary>Changed files</summary><ul>${payload.changes.map((c) => `<li>${linked(c.path, extras.fileUrls?.[c.path])}${c.lines ? ` <span class="secondary">${esc(c.lines)}</span>` : ""}${prose(c.note)}${c.record_id ? cite(c.record_id, "Change evidence") : ""}</li>`).join("")}</ul></details>` : "";
  const refList = extras.references ?? [];
  const references = refList.length ? `<details id="references"><summary>References</summary><ul>${refList.map((r) => `<li id="ref-${esc(r.id)}">${linked(r.label, r.url)}<br><span class="secondary">${esc([r.identifier, r.path, r.sha].filter(Boolean).join(" · "))}</span>${r.missing ? `<br><span class="warning">${esc(r.missing)}</span>` : ""}${r.record_id && byId.has(r.record_id) ? ` ${cite(r.record_id, "Where it was read")}` : ""}</li>`).join("")}</ul></details>` : "";
  const metadata: [string, unknown][] = [["Repository", meta.repo], ["Branch", meta.branch], ["Commit", meta.sha], ["Working tree", meta.dirty === undefined ? "not recorded" : meta.dirty ? "uncommitted changes" : "clean"], ["Recorded on", meta.date], ["Model", meta.model], ["Budget", meta.limits], ["Working directory", meta.cwd]];
  const technical = `<details id="technical"><summary>Report metadata</summary><dl>${metadata.filter(([, value]) => value !== undefined).map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`).join("")}</dl>${tree && !treeWarning ? `<p>Working-tree comparison: checked; no changed paths detected.</p>${tree.before_id ? cite(tree.before_id, "Before snapshot") : ""} ${tree.after_id ? cite(tree.after_id, "After snapshot") : ""}` : ""}</details>`;
  const navItems: [string, string][] = [...payload.sections.map((s) => [s.id, s.title] as [string, string]),
    ...(payload.checks.length ? [["checks", "Checks"] as [string, string]] : []),
    ...(uniqueLimits.length || treeWarning ? [["limits", "Material limits"] as [string, string]] : []),
    ...(log.length ? [["log", "Exact command log"] as [string, string]] : [])];
  const toc = payload.sections.length >= 3 ? `<nav class="toc" aria-label="Contents"><p>Contents</p><ol>${navItems.map(([id, title]) => `<li><a href="#${esc(id)}">${inline(title, false)}</a></li>`).join("")}</ol></nav>` : "";
  const body = `${toc}<header><p class="mode">${payload.mode === "explanation" ? "Explanation" : "Verification"}</p><h1>${esc(payload.title)}</h1><p>Scope: <a href="${esc(scopeUrl)}">${esc(scope.label)}</a></p></header>
<section id="overview"><div class="lead">${prose(payload.summary)}</div>${visuals("overview")}</section>
${payload.sections.map((s) => `<section id="${esc(s.id)}"><h2>${inline(s.title)}</h2>${prose(s.text)}${visuals(s.id)}${evidence(s.evidence ?? [])}</section>`).join("\n")}
${payload.checks.length ? `<section id="checks"><h2>Checks</h2><ul>${payload.checks.map((c) => `<li><span class="status${c.status === "failed" || c.status === "blocked" ? " warning" : ""}">${esc(c.status)}</span><strong>${inline(c.label, false)}</strong>${prose(c.summary)}${c.record_ids?.map((id) => cite(id)).join(" · ") ?? ""}</li>`).join("")}</ul></section>` : ""}
${uniqueLimits.length || treeWarning ? `<section id="limits"><h2>Material limits</h2><ul>${treeWarning ? `<li class="warning">${paragraphs(treeWarning)}${snapshotCitations}</li>` : ""}${uniqueLimits.map((l) => `<li>${authoredLimits.has(l) ? prose(l.text) : paragraphs(l.text)}${l.record_id ? cite(l.record_id) : ""}</li>`).join("")}</ul></section>` : ""}
${changes}${references}${scopeDetails}${log.length ? `<details id="log"><summary>Exact command log · ${log.length} record${log.length === 1 ? "" : "s"}</summary><p class="log-tools"><button type="button" data-records="open">Expand all</button><button type="button" data-records="close">Collapse all</button></p>${recordHtml}</details>` : ""}${technical}`;
  // Fonts are inlined only when KaTeX output is present, so plain reports stay small.
  const mathCss = body.includes('class="katex') ? katexCss() : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'"><title>${esc(payload.title)}</title><style>${CSS}</style>${mathCss ? `<style>${mathCss}</style>` : ""}</head><body><main>
${body}
</main><script>${SCRIPT}</script></body></html>`;
}
