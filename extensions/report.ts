import type { EvidenceRecord, PageExtras, PageMeta, WritePayload } from "./report-types.ts";
import { esc, inline, katexCss, prose } from "./markup.ts";

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

function output(label: string, text: string, cut = 0): string {
  const view = cut > 0 ? "" : structured(text);
  return `<section class="output"><h4>${label}</h4>${cut > 0 ? `<p class="warning">Truncated: ${esc(cut)} bytes omitted from ${label.toLowerCase()}. This is not the complete output.</p>` : ""}${view}${view ? `<details><summary>Exact recorded ${label.toLowerCase()}</summary>` : ""}<pre><code>${esc(text)}</code></pre>${view ? "</details>" : ""}</section>`;
}

const CSS = `
:root{color-scheme:light;--paper:#fcfcfa;--ink:#242a30;--muted:#535e68;--rule:#d9dfe2;--tint:#f0f3f4;--link:#185a86;--warning:#933a22}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:850px;margin:auto;padding:48px 28px 80px}h1,h2,h3,h4{line-height:1.25;text-wrap:balance}h1{font-size:2.1rem;margin:8px 0 18px}h2{font-size:1.45rem;margin:36px 0 16px}h3{font-size:1.1rem}h4{font-size:1rem;margin-bottom:8px}p{margin:12px 0;white-space:pre-line;overflow-wrap:anywhere}p code,li code,td code,th code,h2 code{font-size:.88em;background:var(--tint);padding:1px 4px;border-radius:3px}.math-display{overflow-x:auto;overflow-y:hidden;margin:16px 0}.katex-display{margin:0}.prose-table{margin:18px 0;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink)}.prose-table th{border-bottom:1px solid var(--ink);font-weight:600}.prose-table td,.prose-table th{white-space:normal;min-width:5rem}.prose-table tbody tr:last-child td{border-bottom:0}ol{padding-left:24px}a{color:var(--link);text-underline-offset:3px;overflow-wrap:anywhere}a:hover{text-decoration-thickness:2px}:focus-visible{outline:3px solid #a65f00;outline-offset:4px}:target{scroll-margin-top:20px}.mode,.secondary,figcaption{font-size:.875rem;color:var(--muted)}.mode{letter-spacing:.04em}.lead{font-size:1.15rem}.status{font-size:.8rem;font-weight:600;border:1px solid var(--rule);padding:2px 6px;border-radius:4px;margin-right:6px;white-space:nowrap}.warning{color:var(--warning);font-weight:600}.evidence{border-left:2px solid var(--rule);padding-left:16px;margin:20px 0}.evidence p{margin:8px 0}.record-id{font-size:.75rem;color:var(--muted);margin-left:5px}section,header,details{min-width:0}details{border-top:1px solid var(--rule);padding:12px 0}summary{cursor:pointer;overflow-wrap:anywhere}summary:hover{color:var(--link)}details[open]>summary{margin-bottom:16px}details details{margin:12px 0 0 16px}.record>summary{font-weight:600}.record>summary .secondary{font-weight:400}pre{background:var(--tint);padding:14px;overflow:auto;max-height:34rem;font-size:.8rem;line-height:1.6;tab-size:4}pre code{white-space:pre;overflow-wrap:normal}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}blockquote{margin:10px 0}blockquote pre{max-height:18rem}.table-scroll{overflow:auto;max-height:32rem}table{border-collapse:collapse;width:100%;font-size:.875rem}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--rule);padding:9px 12px;white-space:pre-wrap;overflow-wrap:anywhere;min-width:7rem}dl{font-size:.875rem;display:grid;grid-template-columns:9rem minmax(0,1fr);gap:8px 16px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}ul{padding-left:24px}li{margin:12px 0;overflow-wrap:anywhere}figure{margin:26px 0}figure img{display:block;width:100%;height:auto}.image-map{position:relative;width:100%;line-height:0}.image-map>a{position:absolute;display:block;border:2px solid transparent;border-radius:3px}.image-map>a:hover{background:#185a8618;border-color:#185a8680}.image-map>a:focus-visible{outline:3px solid #a65f00;outline-offset:0;background:#ffffff55}.figure-links{font-size:.875rem;display:flex;flex-wrap:wrap;gap:8px 20px;list-style:none;padding:0}.figure-links li{margin:0}figcaption{margin-top:10px}#limits{border-left:3px solid #ad7952;padding-left:18px}#log,#technical{margin-top:32px}.prepared-output>h4{color:var(--muted)}section>ul>li,section>ol>li,.lead li{margin:6px 0;line-height:1.55}section ul ul{margin:4px 0}
@media(max-width:500px){body{font-size:16px}main{padding:24px 18px 48px}h1{font-size:1.7rem}h2{font-size:1.3rem}dl{grid-template-columns:1fr;gap:3px}dd{margin-bottom:10px}details details{margin-left:8px}}
@media print{body{background:white;color:black;font-size:11pt}main{max-width:none;padding:0}a{color:inherit}pre,.table-scroll{max-height:none}pre{white-space:pre-wrap}pre code{white-space:pre-wrap;overflow-wrap:anywhere}figure{break-inside:avoid}.image-map>a{display:none}summary{color:black}}
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
    const anchor = event.target.closest && event.target.closest('a[href^="#"]');
    if (anchor && anchor.hash === location.hash) setTimeout(reveal, 0);
  });
  reveal();
})();`;

export function renderPage(payload: WritePayload, log: EvidenceRecord[], meta: PageMeta, extras: PageExtras): string {
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
    return [...groups].map(([id, items]) => `<div class="evidence">${items.map((item) => `${prose(item.summary)}${item.quote ? `<blockquote><pre><code>${esc(item.quote)}</code></pre></blockquote>` : ""}`).join("")}<p>${cite(id)}</p></div>`).join("");
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
    return `<details class="record" id="${esc(r.id)}"><summary>${esc(r.why || "Recorded execution")} <span class="secondary">— ${esc(status(r))}${r.truncated?.stdout || r.truncated?.stderr ? " · truncated output" : ""}<small class="record-id">${esc(r.id)}</small></span></summary>${r.refused ? `<p class="warning">Not run: ${esc(r.refused_reason || r.refused)}</p>` : ""}${r.stdout || r.truncated?.stdout ? output("Stdout", r.stdout ?? "", r.truncated?.stdout) : ""}${r.stderr || r.truncated?.stderr ? output("Stderr", r.stderr ?? "", r.truncated?.stderr) : ""}<h4>Exact command</h4><pre><code>${esc(r.command)}</code></pre><h4>Technical metadata</h4><dl>${metadata.filter(([, value]) => value !== undefined && value !== "").map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`).join("")}</dl>${r.figures?.length ? `<h4>Figure artifacts</h4><ul>${r.figures.map((f) => `<li><code>${esc(f.path)}</code> · ${esc(f.bytes)} bytes<br><span class="secondary">SHA-256: ${esc(f.sha256)}</span>${f.lint ? `<br><span class="secondary">figkit lint: ${f.lint.length ? esc(f.lint.join("; ")) : "0 findings"}</span>` : ""}${f.outline_failed ? `<br><span class="warning">Text outlining failed: ${esc(f.outline_failed)}</span>` : ""}${f.outlined ? `<br><span class="secondary">Embedded as text outlines: <code>${esc(f.outlined.path)}</code> · SHA-256 ${esc(f.outlined.sha256)}</span>` : ""}</li>`).join("")}</ul>` : ""}${r.produces ? `<p class="secondary">Requested artifact: ${esc(r.produces)}</p>` : ""}${r.produces_missing ? `<p class="warning">Figure not captured: ${esc(r.produces_missing)}</p>` : ""}${r.tree ? `<details><summary>Recorded tree snapshot</summary><pre><code>${esc(JSON.stringify(r.tree, null, 2))}</code></pre></details>` : ""}</details>`;
  }).join("");
  const scope = extras.scope;
  const scopeDetails = `<details id="scope"><summary>Scope and commits</summary><p>${esc(scope.label)}${scope.include_working_tree ? " · includes working-tree content" : " · committed content"}</p><dl>${scope.base_sha ? `<dt>Base commit</dt><dd>${esc(scope.base_sha)}</dd>` : ""}${scope.head_sha ? `<dt>Head commit</dt><dd>${esc(scope.head_sha)}</dd>` : ""}</dl>${scope.commits.length ? `<ul>${scope.commits.map((c) => `<li>${linked(c.subject, c.url)}<br><small>${esc(c.sha)}</small></li>`).join("")}</ul>` : ""}${payload.scope.record_id ? `<p>${cite(payload.scope.record_id, "Scope resolution")}</p>` : ""}</details>`;
  const changes = payload.changes.length ? `<details id="changes"><summary>Changed files</summary><ul>${payload.changes.map((c) => `<li>${linked(c.path, extras.fileUrls?.[c.path])}${c.lines ? ` <span class="secondary">${esc(c.lines)}</span>` : ""}${prose(c.note)}${c.record_id ? cite(c.record_id, "Change evidence") : ""}</li>`).join("")}</ul></details>` : "";
  const metadata: [string, unknown][] = [["Repository", meta.repo], ["Branch", meta.branch], ["Commit", meta.sha], ["Working tree", meta.dirty === undefined ? "not recorded" : meta.dirty ? "uncommitted changes" : "clean"], ["Recorded on", meta.date], ["Model", meta.model], ["Working directory", meta.cwd]];
  const technical = `<details id="technical"><summary>Report metadata</summary><dl>${metadata.filter(([, value]) => value !== undefined).map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`).join("")}</dl>${tree && !treeWarning ? `<p>Working-tree comparison: checked; no changed paths detected.</p>${tree.before_id ? cite(tree.before_id, "Before snapshot") : ""} ${tree.after_id ? cite(tree.after_id, "After snapshot") : ""}` : ""}</details>`;
  const body = `<header><p class="mode">${payload.mode === "explanation" ? "Explanation" : "Verification"}</p><h1>${esc(payload.title)}</h1><p>Scope: <a href="${esc(scopeUrl)}">${esc(scope.label)}</a></p></header>
<section id="overview"><div class="lead">${prose(payload.summary)}</div>${visuals("overview")}</section>
${payload.sections.map((s) => `<section id="${esc(s.id)}"><h2>${inline(s.title)}</h2>${prose(s.text)}${visuals(s.id)}${evidence(s.evidence ?? [])}</section>`).join("\n")}
${payload.checks.length ? `<section id="checks"><h2>Checks</h2><ul>${payload.checks.map((c) => `<li><span class="status${c.status === "failed" || c.status === "blocked" ? " warning" : ""}">${esc(c.status)}</span><strong>${inline(c.label, false)}</strong>${prose(c.summary)}${c.record_ids?.map((id) => cite(id)).join(" · ") ?? ""}</li>`).join("")}</ul></section>` : ""}
${uniqueLimits.length || treeWarning ? `<section id="limits"><h2>Material limits</h2><ul>${treeWarning ? `<li class="warning">${paragraphs(treeWarning)}${snapshotCitations}</li>` : ""}${uniqueLimits.map((l) => `<li>${authoredLimits.has(l) ? prose(l.text) : paragraphs(l.text)}${l.record_id ? cite(l.record_id) : ""}</li>`).join("")}</ul></section>` : ""}
${changes}${scopeDetails}${log.length ? `<details id="log"><summary>Exact command log · ${log.length} record${log.length === 1 ? "" : "s"}</summary>${recordHtml}</details>` : ""}${technical}`;
  // Fonts are inlined only when KaTeX output is present, so plain reports stay small.
  const mathCss = body.includes('class="katex') ? katexCss() : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'"><title>${esc(payload.title)}</title><style>${CSS}</style>${mathCss ? `<style>${mathCss}</style>` : ""}</head><body><main>
${body}
</main><script>${SCRIPT}</script></body></html>`;
}
