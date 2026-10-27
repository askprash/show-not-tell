import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../extensions/report.ts';

const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[c]);
const meta = { repo: 'example', branch: 'main', sha: 'f'.repeat(40), dirty: false, date: '2026-01-01', cwd: '/tmp/example' };
function fixture() {
  return {
    payload: {
      title: 'A reader-first account', mode: 'verification',
      scope: { label: 'Bound the solver error', head: 'HEAD' },
      summary: 'The corrected bound holds in the recorded cases.\n\nThe stored results remain context, not a fresh measurement.',
      sections: [{ id: 'bound', title: 'Why the bound holds', text: 'The bound follows from the stopping rule.', evidence: [{ record_id: 'R8', summary: 'The recorded examples meet the bound.', quote: 'bound: 0.25' }] }],
      checks: [{ label: 'Examples', status: 'passed', summary: 'Recorded examples meet the stated tolerance.', record_ids: ['R8'] }],
      limits: [], changes: [], visuals: [],
    },
    log: [{ id: 'R8', command: 'node check.mjs', why: 'Check the stopping bound', cwd: '/tmp/example', started_at: '2026-01-01T12:00:00Z', exit: 0, stdout: 'bound: 0.25\n', stderr: '', ms: 14 }],
    extras: { scope: { label: 'Bound the solver error', head_sha: 'f'.repeat(40), base_sha: 'a'.repeat(40), include_working_tree: false, compare_url: 'https://example.com/repo/compare/base...head', commits: [{ sha: 'f'.repeat(40), subject: 'Correct stopping tolerance', url: 'https://example.com/repo/commit/head' }] }, visuals: [], autoLimits: [] },
  };
}
const render = ({ payload, log, extras }) => renderPage(payload, log, meta, extras);
const summaries = (html) => [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) => m[1]).join('\n');
const region = (html, id) => html.match(new RegExp(`<section id="${id}">([\\s\\S]*?)</section>`))?.[1];
const rawOutputs = (html) => [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => decode(m[1]));

test('R8 multiline command is exact, once, only within the expandable record body', () => {
  const f = fixture();
  const command = ["python3 - <<'PY'", 'import json', ...Array.from({ length: 24 }, (_, i) => `    print(${i}, "bound < tolerance")`), 'print("done")', 'PY'].join('\n');
  assert.equal(command.split('\n').length, 28);
  f.log[0].command = command;
  f.extras.visuals.push({ record_id: 'R8', kind: 'plot', caption: 'The recorded bound stays below tolerance.', src: 'data:image/png;base64,aGVsbG8=' });
  const html = render(f);
  assert.equal(html.split(escape(command)).length - 1, 1);
  assert.ok(html.includes(`<h4>Exact command</h4><pre><code>${escape(command)}</code></pre>`));
  assert.ok(!summaries(html).includes('python3'));
  assert.match(summaries(html), /Check the stopping bound/);
  assert.match(summaries(html), /exit 0/);
  assert.ok(!region(html, 'bound').includes('python3'));
  assert.ok(!html.match(/<figcaption>(.*?)<\/figcaption>/s)[1].includes('python3'));
  assert.match(html, /<details id="log"><summary>/);
  assert.match(html, /<details class="record" id="R8"><summary>/);
  assert.ok(!html.includes('<h4>Stderr</h4>'));
  assert.match(html, /Figure source<small class="record-id">R8/);
});

test('whole JSON has a readable view and a separate byte-faithful recorded output', () => {
  const f = fixture();
  const json = ' {"large":900719925474099312345,"exp":1e-20,"dup":1,"dup":2,"nested":["<script>", {"ok":true}]}\n';
  f.log[0].stdout = json;
  const html = render(f);
  assert.match(html, /JSON view/);
  assert.match(html, /<summary>Exact recorded stdout<\/summary>/);
  assert.ok(rawOutputs(html).includes(json));
  const formatted = rawOutputs(html).find((s) => s !== json && s.includes('"large"'));
  assert.deepEqual(JSON.parse(formatted), JSON.parse(json));
  assert.ok(formatted.includes('900719925474099312345'));
  assert.ok(formatted.includes('1e-20'));
  assert.equal((formatted.match(/"dup"/g) ?? []).length, 2);
  assert.ok(!html.includes('<script></script>'));
});

test('CSV view handles quoted commas, escaped quotes, newlines and CRLF without changing raw text', () => {
  const f = fixture();
  const csv = 'name,value\r\n"x,y","say ""yes"""\r\n"two\nlines",0.125\r\n';
  f.log[0].stdout = csv;
  const html = render(f);
  assert.match(html, /CSV view/);
  assert.match(html, /<th scope="col">name<\/th>/);
  assert.match(html, /<td>x,y<\/td><td>say &quot;yes&quot;<\/td>/);
  assert.match(html, /<td>two\nlines<\/td><td>0.125<\/td>/);
  assert.ok(rawOutputs(html).includes(csv));
});

test('mixed, malformed and truncated output never gets a guessed structured view', () => {
  for (const text of ['log first\n{"a":1}', '{"a":1}\ntrailer', 'a,b\n1,2,3', 'a,b\n"unclosed,2', 'a,b\n"quoted"x,2', 'a,b\r1,2', 'single column\nvalue']) {
    const f = fixture();
    f.log[0].stdout = text;
    const html = render(f);
    assert.doesNotMatch(html, /JSON view|CSV view/);
    assert.ok(rawOutputs(html).includes(text));
  }
  const f = fixture();
  f.log[0].stdout = '{"a":1}';
  f.log[0].truncated = { stdout: 200, stderr: 12 };
  const html = render(f);
  assert.doesNotMatch(html, /JSON view/);
  assert.match(html, /Truncated: 200 bytes omitted from stdout/);
  assert.match(html, /Truncated: 12 bytes omitted from stderr/);
  assert.match(summaries(html), /truncated output/);
});

test('escapes prose, metadata, exact output, paths, labels and attributes; rejects active URLs', () => {
  const f = fixture();
  const attack = '<img src=x onerror="alert(1)"> & </script>';
  f.payload.title = attack;
  f.payload.summary = attack;
  f.payload.sections[0].text = attack;
  f.payload.sections[0].evidence[0].summary = attack;
  f.payload.checks[0].label = attack;
  f.log[0].why = attack;
  f.log[0].stdout = attack;
  f.log[0].stderr = attack;
  f.log[0].command = attack;
  f.payload.changes = [{ path: attack, note: attack }];
  f.extras.fileUrls = { [attack]: 'javascript:alert(1)' };
  f.extras.scope.compare_url = 'javascript:alert(1)';
  f.extras.scope.head_url = 'data:text/html,bad';
  f.extras.scope.commits[0].url = 'https://example.com/" onmouseover="x';
  f.extras.visuals = [{ record_id: 'R8', kind: 'diagram', caption: attack, alt: attack, src: 'data:image/png;base64,aGVsbG8=', links: [{ label: attack, target: 'record:R8', x: 0, y: 0, width: 10, height: 10 }] }];
  const html = render(f);
  assert.ok(html.includes(escape(attack)));
  assert.ok(!html.includes(attack));
  assert.doesNotMatch(html, /href="(?:javascript|data):/);
  assert.doesNotMatch(html, / onerror="| onmouseover="/);
  assert.match(html, /Scope: <a href="#scope">/);
  assert.match(html, /<h4>Stderr<\/h4>/);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.match(html, /default-src 'none'/);
  for (const url of ['//evil.test', 'file:///tmp/x', 'https://user:pass@example.com/', 'https://example.com/\nattack']) {
    f.extras.scope.compare_url = url;
    assert.match(render(f), /Scope: <a href="#scope">/);
  }
});

test('visuals keep authored placement and percent image overlays with accessible fallback links', () => {
  const f = fixture();
  f.extras.visuals = [
    { record_id: 'R8', kind: 'plot', caption: 'Overview plot.', src: 'data:image/png;base64,aGVsbG8=' },
    { record_id: 'R8', kind: 'diagram', section_id: 'bound', caption: 'Stopping rule flow.', alt: 'The stopping rule branches to the bound.', src: 'data:image/svg+xml;base64,PHN2Zy8+', links: [
      { label: 'Read the bound', target: 'section:bound', x: 12.5, y: 30, width: 20, height: 14 },
      { label: 'Inspect recorded examples', target: 'record:R8', x: 40, y: 50, width: 50, height: 30 },
      { label: 'Bad target', target: 'javascript:alert(1)', x: 0, y: 0, width: 1, height: 1 },
      { label: 'Missing target', target: 'record:R404', x: 0, y: 0, width: 1, height: 1 },
      { label: 'Bad bounds', target: 'record:R8', x: 90, y: 0, width: 20, height: 1 },
      { label: 'NaN bounds', target: 'record:R8', x: NaN, y: 0, width: 20, height: 1 },
    ] },
  ];
  const html = render(f);
  assert.match(region(html, 'overview'), /Overview plot/);
  assert.doesNotMatch(region(html, 'overview'), /Stopping rule flow/);
  assert.match(region(html, 'bound'), /Stopping rule flow/);
  assert.match(html, /href="#bound" aria-label="Read the bound" style="left:12.5%;top:30%;width:20%;height:14%"/);
  assert.match(html, /<li><a href="#bound">Read the bound<\/a><\/li>/);
  assert.match(html, /<li><a href="#R8">Inspect recorded examples<\/a><\/li>/);
  assert.doesNotMatch(html, /Bad target|Missing target|Bad bounds|NaN bounds/);
  assert.doesNotMatch(html, /<svg|<object|<embed/);
  assert.match(html, /\.image-map\{position:relative;width:100%/);
  assert.match(html, /figure img\{display:block;width:100%;height:auto\}/);
  assert.match(html, /\.image-map>a:focus-visible/);
  f.extras.visuals[0].src = 'https://evil.test/image.svg';
  assert.doesNotMatch(render(f), /Overview plot/);
});

test('scope is descriptive, hashes stay in details, commits and filenames use supplied safe links', () => {
  const f = fixture();
  f.payload.changes = [{ path: 'src/solver.ts', note: 'Correct stopping rule.' }];
  f.extras.fileUrls = { 'src/solver.ts': 'https://example.com/repo/blob/head/src/solver.ts' };
  const html = render(f);
  const article = html.slice(0, html.indexOf('<details id="changes">'));
  assert.match(article, /<a href="https:\/\/example.com\/repo\/compare\/base\.\.\.head">Bound the solver error<\/a>/);
  assert.ok(!article.includes('f'.repeat(40)));
  assert.ok(!summaries(html).includes('f'.repeat(40)));
  assert.match(html, /<a href="https:\/\/example.com\/repo\/commit\/head" rel="noreferrer">Correct stopping tolerance<\/a>/);
  assert.match(html, /<a href="https:\/\/example.com\/repo\/blob\/head\/src\/solver.ts" rel="noreferrer">src\/solver.ts<\/a>/);
  delete f.extras.scope.compare_url;
  assert.match(render(f), /Scope: <a href="#scope">/);
  f.extras.scope.head_url = 'https://example.com/repo/commit/head';
  assert.match(render(f), /Scope: <a href="https:\/\/example.com\/repo\/commit\/head">/);
});

test('failed, refused, timed-out, authored and automatic limits stay in the reading path', () => {
  const f = fixture();
  f.payload.checks = [];
  f.log[0].exit = 1;
  f.log.push({ ...f.log[0], id: 'R9', why: 'Long check', timed_out: true });
  f.log.push({ ...f.log[0], id: 'R10', why: 'Unsafe operation', refused: 'report-only', refused_reason: 'Operation is outside report-only mode.' });
  f.payload.limits = [{ text: 'Stored measurements were not rerun.' }];
  f.extras.autoLimits = [{ text: 'Long run timed out.', record_id: 'R9' }];
  f.extras.scope.warning = 'Scope could not be fully resolved.';
  const html = render(f);
  const limits = region(html, 'limits');
  assert.match(limits, /Stored measurements were not rerun/);
  assert.match(limits, /Long run timed out/);
  assert.match(limits, /Recorded execution exit 1/);
  assert.match(limits, /not run \(report-only\)/);
  assert.match(limits, /Scope could not be fully resolved/);
  assert.ok(html.indexOf('<section id="limits">') < html.indexOf('<details id="scope">'));
  assert.doesNotMatch(limits, /passed/);
  assert.match(html, /Operation is outside report-only mode/);
});

test('working-tree mutations and unchecked comparisons are visible with snapshot citations', () => {
  for (const checked of [true, false]) {
    const f = fixture();
    f.log.push({ ...f.log[0], id: 'before', snapshot: 'before' });
    f.log.push({ ...f.log[0], id: 'after', snapshot: 'after', exit: checked ? 0 : 1 });
    f.extras.tree = { checked, changed: checked ? ['dirty.py', '<new>.txt'] : [], before_id: 'before', after_id: 'after' };
    const warning = checked ? 'Files changed during the walkthrough: dirty.py, <new>.txt.' : 'Working-tree comparison could not be completed; repository changes may be undetected.';
    // Supplying the same warning explicitly must not duplicate it.
    f.extras.autoLimits = [{ text: warning }];
    const html = render(f);
    const limits = region(html, 'limits');
    assert.ok(limits.includes(escape(warning)));
    assert.equal(html.split(escape(warning)).length - 1, 1);
    assert.match(limits, /href="#before">Before snapshot/);
    assert.match(limits, /href="#after">After snapshot/);
    assert.doesNotMatch(limits, /Recorded execution exit 1/);
    const prefix = html.slice(0, html.indexOf(escape(warning)));
    assert.equal((prefix.match(/<details\b/g) ?? []).length, (prefix.match(/<\/details>/g) ?? []).length, 'warning is outside expandable details');
  }
  const f = fixture();
  f.extras.tree = { checked: true, changed: [] };
  assert.equal(region(render(f), 'limits'), undefined, 'clean-tree result remains routine metadata');
});

test('checks distinguish inspected, not-run and executed results without inventing provenance', () => {
  const f = fixture();
  f.payload.sections[0].title = 'Stored numerical results';
  f.payload.checks = [
    { label: 'Stored table', status: 'inspected', summary: 'Read the committed table.', record_ids: ['R8'] },
    { label: 'Full suite', status: 'not-run', summary: 'Not run in this walkthrough.' },
    { label: 'Unavailable harness', status: 'blocked', summary: 'No harness available.' },
  ];
  const html = render(f);
  assert.match(html, /Stored numerical results/);
  assert.match(region(html, 'checks'), />inspected<|>not-run<|>blocked</);
  assert.doesNotMatch(html, /confidence|citation-count|Look for|spot-check list|diffstat/i);
  f.payload.mode = 'explanation';
  assert.match(render(f), /<p class="mode">Explanation<\/p>/);
});

test('empty optional sections and log are omitted; prose keeps plain-text paragraph breaks', () => {
  const f = fixture();
  f.payload.sections = [];
  f.payload.checks = [];
  f.log = [];
  f.payload.summary = 'First **bold** paragraph costs $5 and $10.\n\nSecond paragraph.';
  const html = render(f);
  for (const id of ['checks', 'changes', 'limits', 'log']) assert.ok(!html.includes(`id="${id}"`));
  assert.match(html, /<p>First <strong>bold<\/strong> paragraph costs \$5 and \$10\.<\/p><p>Second paragraph\.<\/p>/);
  assert.doesNotMatch(html, /class="katex/);
  assert.doesNotMatch(html, /@font-face/);
  assert.match(html, /id="scope"/);
  assert.doesNotMatch(html, /Nothing listed|No files listed|No commands were recorded/);
});

test('hash reveal script opens nested details on click, initial load and navigation without data interpolation', async () => {
  const { runInNewContext } = await import('node:vm');
  const f = fixture();
  const html = render(f);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const parent = { tagName: 'DETAILS', open: false, parentElement: null };
  const target = { tagName: 'DETAILS', open: false, parentElement: parent, setAttribute(name, value) { this[name] = value; }, focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; } };
  const handlers = {};
  const location = { hash: '#R8' };
  runInNewContext(script, {
    location,
    document: { getElementById: (id) => id === 'R8' ? target : null, addEventListener: (type, fn) => { handlers[type] = fn; } },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    setTimeout: (fn) => fn(),
  });
  assert.equal(parent.open, true);
  assert.equal(target.open, true);
  assert.equal(target.tabindex, '-1');
  assert.equal(target.focused, true);
  assert.equal(target.scrolled, true);
  parent.open = false;
  handlers.hashchange();
  assert.equal(parent.open, true);
  parent.open = false;
  handlers.click({ target: { closest: () => ({ hash: '#R8' }) } });
  assert.equal(parent.open, true);
  location.hash = '#%broken';
  assert.doesNotThrow(handlers.hashchange);
  assert.ok(!script.includes(f.payload.title));
});

test('pipe tables render as tables with inline code, math and escaped pipes', () => {
  const f = fixture();
  f.payload.sections[0].text = 'Before.\n| Stage | What runs | Cost |\n|---|---|---:|\n| Direct | `solve!` once, a \\| b | $n^2$ |\n| Retry | <b>x</b> | 8 |\nAfter.';
  const html = render(f);
  const section = region(html, 'bound');
  assert.match(section, /<p>Before\.<\/p><div class="table-scroll prose-table"[^>]*><table><thead><tr><th scope="col">Stage<\/th>/);
  assert.match(section, /<th scope="col" style="text-align:right">Cost<\/th>/);
  assert.match(section, /<td><code>solve!<\/code> once, a \| b<\/td>/);
  assert.match(section, /<td style="text-align:right"><span class="katex">/);
  assert.match(section, /<td>&lt;b&gt;x&lt;\/b&gt;<\/td>/);
  assert.match(section, /<p>After\.<\/p>/);
  assert.doesNotMatch(section, /\|---/);
});

test('math renders with KaTeX offline; untrusted commands do not create links', () => {
  const f = fixture();
  f.payload.sections[0].text = 'The row is $\\phi(a,b) = a + b - \\sqrt{a^2+b^2}$.\n\n$$\n\\phi = 0 \\iff a \\ge 0,\\ b \\ge 0,\\ ab = 0\n$$\n\nBad: $\\href{javascript:alert(1)}{x}$ and $\\frac{1$.';
  const html = render(f);
  assert.match(html, /<span class="katex">/);
  assert.match(html, /<div class="math-display"><span class="katex-display">/);
  assert.match(html, /<annotation encoding="application\/x-tex">\\phi\(a,b\)/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /@font-face\{[^}]*src:url\(data:font\/woff2;base64,/);
  assert.doesNotMatch(html, /url\(fonts\//);
  assert.match(html, /font-src data:/);
});


test('table cells keep currency, math, escaped pipes and extra cells', async () => {
  const { prose } = await import('../extensions/markup.ts');
  const table = prose('| s | cost | r |\n|---|---|---|\n| a | $5 | Passed |\n| a \\| b | $x$ | four | extra |');
  assert.match(table, /<td>a<\/td><td>\$5<\/td><td>Passed<\/td>/);
  assert.match(table, /<td>a \| b<\/td><td><span class="katex">/);
  assert.match(table, /<td>four<\/td><td>extra<\/td>/, 'extra cells are kept, not dropped');
});

test('outline failures stay visible in the figure record', async () => {
  const f = fixture();
  f.log[0].figures = [{ path: '.walkthrough/figs/R8-x.svg', sha256: 'a'.repeat(64), bytes: 10, lint: [], outline_failed: 'rsvg-convert: not found' }];
  assert.match(render(f), /<span class="warning">Text outlining failed: rsvg-convert: not found<\/span>/);
});
