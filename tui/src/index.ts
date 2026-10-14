import blessed from "blessed";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Metrics = Record<string, number | string | null>;
interface SymbolInfo {
  id: string; name: string; short_name: string; kind: string; path: string; line: number;
  end_line: number; parent: string | null; confidence: string; signature: string; metrics?: Metrics; structural: Metrics;
}
interface FileInfo {
  path: string; language: string; category: string; lines: number; status: string;
  symbols: SymbolInfo[]; metrics: Metrics; diagnostics: string[];
  imports: { target: string; line: number }[]; churn: { added: number; removed: number; commits: number };
}
interface Finding { type: string; severity: string; confidence: string; path: string; line: number; message: string; evidence: string[] }
interface Edge { source: string; target: string; confidence: string; line: number; kind: string; evidence: string }
interface Commit { revision: string; date: string; subject: string }
interface Report {
  root: string; revision: string; summary: Record<string, unknown>; incremental: { analyzed: number; cached: number };
  files: FileInfo[]; findings: Finding[]; edges: Edge[]; symbol_edges: Edge[]; limitations: string[];
  diagnostics: string[]; dependencies: { name: string; version: string; ecosystem: string; path: string }[];
  history: { commits: Commit[]; branches: string[] };
  graphs: Record<string, { nodes: string[]; edges?: [string, string][] }>;
}
interface Comparison {
  before: { root: string; revision: string; summary: Record<string, unknown> };
  after: { root: string; revision: string; summary: Record<string, unknown> };
  delta: Record<string, number>; added_files: string[]; removed_files: string[];
  changed_files: { path: string; complexity_delta: number; lines_delta: number }[];
  added_edges: [string, string][]; removed_edges: [string, string][];
}
type Row = { label: string; file?: FileInfo; symbol?: SymbolInfo; finding?: Finding; commit?: Commit; node?: string; directory?: string };
const root = resolve(process.argv[2] || ".");
const engineRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const python = process.env.REPOLENS_PYTHON || (process.platform === "win32" ? resolve(engineRoot, ".venv/Scripts/python.exe") : resolve(engineRoot, ".venv/bin/python"));
const initialArgs = process.argv.slice(3);
let revision = initialArgs.includes("--revision") ? initialArgs[initialArgs.indexOf("--revision") + 1] : undefined;
const cache = initialArgs.includes("--cache") ? initialArgs[initialArgs.indexOf("--cache") + 1] : undefined;
// Some terminal hosts forward streams without reporting their dimensions.
process.stdout.columns ||= Number(process.env.COLUMNS) || 80;
process.stdout.rows ||= Number(process.env.LINES) || 24;
const screen = blessed.screen({ smartCSR: true, title: "RepoLens", fullUnicode: true,
  terminal: !process.env.TERM || process.env.TERM === "dumb" ? "xterm-256color" : process.env.TERM });
const header = blessed.box({ parent: screen, top: 0, left: 0, height: 3, width: "100%", wrap: false,
  style: { fg: "white", bg: "black" }, padding: { left: 1, right: 1 } });
const list = blessed.list({ parent: screen, top: 3, bottom: 2, left: 0, width: "42%", keys: true, vi: true,
  mouse: true, border: "line", label: " Explorer ", scrollbar: { ch: "│" },
  style: { fg: "white", border: { fg: "gray" }, selected: { bg: "cyan", fg: "black" } } });
const detail = blessed.box({ parent: screen, top: 3, bottom: 2, left: "42%", width: "58%", border: "line", label: " Detail ",
  scrollable: true, alwaysScroll: true, keys: true, vi: true, mouse: true, scrollbar: { ch: "│" },
  padding: { left: 1, right: 1 }, style: { fg: "white", border: { fg: "gray" } } });
const footer = blessed.box({ parent: screen, bottom: 0, left: 0, height: 2, width: "100%", padding: { left: 1 } });
const prompt = blessed.prompt({ parent: screen, top: "center", left: "center", height: 7, width: "80%", border: "line",
  style: { fg: "white", bg: "black", border: { fg: "cyan" } } });
const views = ["Overview", "Files", "Symbols", "Findings", "History", "Graph", "Compare"];
let view = 0;
let report: Report | undefined;
let comparison: Comparison | undefined;
let rows: Row[] = [];
let query = "";
let filter = "";
let sorted = false;
let busy = false;
let status = "Starting analysis…";
let graphLevel = "module";
let generation = 0;
const expanded = new Set<string>(["."]);
const children = new Set<ChildProcess>();
let previewChild: ChildProcess | undefined;

function clean(text: unknown): string {
  return String(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      .on("error", () => child.kill());
  } else child.kill();
}

function run<T>(command: string, args: string[] = [], selectedRevision = revision): Promise<T> {
  return new Promise((accept, reject) => {
    if (command === "source" && previewChild) stopChild(previewChild);
    const child = spawn(python, ["-m", "repolens", command, root, "--json", ...(selectedRevision ? ["--revision", selectedRevision] : []),
      ...(cache ? ["--cache", cache] : []), ...args], { cwd: engineRoot, windowsHide: true });
    children.add(child);
    if (command === "source") previewChild = child;
    let output = "";
    let errors = "";
    let size = 0;
    child.stdout.on("data", (data: Buffer) => {
      size += data.length;
      if (size > 128 * 1024 * 1024) { child.kill(); reject(new Error("Report exceeded 128 MiB")); }
      else output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      errors = (errors + data.toString()).slice(-16384);
      status = clean(errors.trim().split(/\r?\n/).at(-1) || "Analyzing…");
      renderHeader();
    });
    child.on("error", reject);
    child.on("close", code => {
      children.delete(child);
      if (previewChild === child) previewChild = undefined;
      if (code !== 0) reject(new Error(errors.trim() || `Engine exited with status ${code}`));
      else {
        try { accept(JSON.parse(output) as T); }
        catch { reject(new Error("Engine returned an invalid response")); }
      }
    });
  });
}

function renderHeader(): void {
  header.setContent(`RepoLens  ${clean(root)}\n${views.map((name, i) => `${i + 1} ${i === view ? "[" + name + "]" : name}`).join("  ")}\n${clean(status)}`);
  footer.setContent("↑↓ move · Enter drill · Tab focus · / search · f filter · s sort · l graph\nr rescan · b revision · c compare · e export · g README · ? help · q quit");
  screen.render();
}

function overview(index = 0): string {
  if (!report) return "Analysis is running. Progress appears above.";
  if (index === 1) return ["COVERAGE AND DIAGNOSTICS", "", ...report.limitations, "", ...report.diagnostics,
    "", ...report.files.filter(f => f.status !== "parsed").flatMap(f => [`${f.path} [${f.status}]`, ...f.diagnostics])].map(clean).join("\n");
  if (index === 2) return ["DEPENDENCY INVENTORY", "", ...report.dependencies.map(d => `${d.ecosystem}: ${d.name} ${d.version}\n  ${d.path}`)].map(clean).join("\n");
  const summary = report.summary;
  const ranking = [...report.files].sort((a, b) => Number(b.metrics.hotspot) - Number(a.metrics.hotspot)).slice(0, 10);
  return ["REPOSITORY", `${report.root}\n${report.revision}`, "",
    ...Object.entries(summary).map(([key, value]) => `${key.replaceAll("_", " ").padEnd(19)} ${typeof value === "object" ? JSON.stringify(value) : value}`),
    "", `INCREMENTAL   ${report.incremental.analyzed} analyzed · ${report.incremental.cached} cached`,
    "", "MAINTENANCE HOTSPOTS", ...ranking.filter(f => Number(f.metrics.hotspot) > 0).map(f => `${f.metrics.hotspot}  ${f.path}  (${f.churn.commits} commits)`),
    "", "DEPENDENCIES", ...report.dependencies.slice(0, 40).map(d => `${d.ecosystem}: ${d.name} ${d.version}  [${d.path}]`),
    "", "COVERAGE & LIMITATIONS", ...report.limitations.map(l => `• ${l}`), ...report.diagnostics].map(clean).join("\n");
}

function comparisonText(): string {
  const current = comparison;
  if (!current) return "Press c and enter a Git revision to compare it with the current analysis.\nPress b to analyze another commit or branch. Leave b empty for the working tree.";
  return [`BASE                                     CURRENT`,
    `${current.before.revision.slice(0, 30).padEnd(41)}${current.after.revision.slice(0, 30)}`, "",
    ...Object.keys(current.delta).map(key => `${key.padEnd(22)} ${String(current.before.summary[key]).padStart(9)} → ${String(current.after.summary[key]).padStart(9)}  (${current.delta[key] >= 0 ? "+" : ""}${current.delta[key]})`),
    "", "ADDED FILES", ...current.added_files, "", "REMOVED FILES", ...current.removed_files,
    "", "CHANGED FILES", ...current.changed_files.map(f => `${f.path}   complexity ${f.complexity_delta >= 0 ? "+" : ""}${f.complexity_delta} · lines ${f.lines_delta >= 0 ? "+" : ""}${f.lines_delta}`),
    "", "ADDED DEPENDENCIES", ...current.added_edges.map(e => e.join(" → ")),
    "", "REMOVED DEPENDENCIES", ...current.removed_edges.map(e => e.join(" → "))].map(clean).join("\n");
}

function rebuild(selectedDirectory?: string): void {
  generation++;
  layout();
  if (!report) { rows = []; list.setItems([]); detail.setContent(overview()); renderHeader(); return; }
  list.setLabel(` ${views[view]}${query ? " / " + clean(query) : ""}${filter ? " · " + clean(filter) : ""} `);
  let items: Row[] = [];
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  if (view === 0) items = [{ label: "Repository summary" }, { label: "Coverage and diagnostics" }, { label: "Dependency inventory" }];
  if (view === 1) {
    const files = report.files.filter(f => matches(f.path) && (!filter || f.language === filter || f.category === filter || f.status === filter));
    if (query || filter || sorted) items = files.map(file => ({ label: `${String(file.metrics.cyclomatic || 0).padStart(4)}  ${file.path}`, file }));
    else {
      const directories = new Set<string>();
      for (const file of files) {
        const parts = file.path.split("/");
        for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
      }
      const visible = (path: string): boolean => {
        const parts = path.split("/");
        return parts.slice(0, -1).every((_, i) => expanded.has(parts.slice(0, i + 1).join("/")));
      };
      items = [...[...directories].filter(visible).map<Row>(directory => ({ label: `${"  ".repeat(directory.split("/").length - 1)}${expanded.has(directory) ? "▾" : "▸"} ${directory.split("/").at(-1)}/`, directory })),
        ...files.filter(f => visible(f.path)).map<Row>(file => ({ label: `${"  ".repeat(file.path.split("/").length - 1)}  ${file.path.split("/").at(-1)}`, file }))]
        .sort((a, b) => (a.directory || a.file?.path || "").localeCompare(b.directory || b.file?.path || ""));
    }
  }
  if (view === 2) items = report.files.flatMap(f => f.symbols).filter(s => matches(`${s.name} ${s.path}`) && (!filter || s.kind === filter || s.confidence === filter))
    .map(symbol => ({ label: `${String(symbol.metrics?.cyclomatic || 0).padStart(3)}  ${symbol.name}  ${symbol.path}:${symbol.line}`, symbol }));
  if (view === 3) items = report.findings.filter(f => matches(`${f.path} ${f.message}`) && (!filter || f.type === filter || f.severity === filter || f.confidence === filter))
    .map(finding => ({ label: `${finding.severity === "warning" ? "!" : "·"} ${finding.path}:${finding.line} ${finding.message}`, finding }));
  if (view === 4) items = report.history.commits.filter(c => matches(c.subject + c.revision)).map(commit => ({ label: `${commit.revision.slice(0, 8)} ${commit.date.slice(0, 10)} ${commit.subject}`, commit }));
  if (view === 5) items = report.graphs[graphLevel].nodes.filter(matches).map(node => ({ label: node, node }));
  if (view === 6) items = [{ label: comparison ? "Revision comparison" : "Press c to compare" }];
  if (sorted) items.sort((a, b) => Number(b.symbol?.metrics?.cyclomatic || b.file?.metrics.cyclomatic || 0) - Number(a.symbol?.metrics?.cyclomatic || a.file?.metrics.cyclomatic || 0) || a.label.localeCompare(b.label));
  rows = items;
  list.setItems(rows.map(r => clean(r.label)));
  const selected = selectedDirectory ? Math.max(0, rows.findIndex(row => row.directory === selectedDirectory)) : 0;
  list.select(selected);
  void show(selected);
  renderHeader();
}

function layout(): void {
  if (view === 6) {
    list.hide(); detail.left = 0; detail.width = "100%"; detail.setLabel(" Comparison ");
  } else {
    list.show();
    const width = Number(screen.width) < 100 ? "38%" : "42%";
    list.width = width; detail.left = width; detail.width = Number(screen.width) < 100 ? "62%" : "58%";
    detail.setLabel(" Detail ");
  }
}

async function show(index: number): Promise<void> {
  const row = rows[index];
  const version = ++generation;
  detail.setScroll(0);
  if (view === 0) { detail.setContent(overview(index)); screen.render(); return; }
  if (view === 6) { detail.setContent(comparisonText()); screen.render(); return; }
  if (!row || !report) { detail.setContent("No matching entries."); screen.render(); return; }
  let text = "";
  let path: string | undefined;
  let line = 1;
  if (row.directory) text = `${row.directory}/\n\nPress Enter to expand or collapse.\n${report.files.filter(f => f.path.startsWith(row.directory + "/")).length} files in this directory.`;
  if (row.file) {
    const f = row.file; path = f.path;
    text = [f.path, `${f.language} · ${f.category} · ${f.status} · ${f.lines} lines`, "", "METRICS", JSON.stringify(f.metrics, null, 2),
      "", "IMPORTS", ...f.imports.map(i => `${i.line}: ${i.target}`), "", "SYMBOLS", ...f.symbols.map(s => `${s.line}: ${s.name}`), "", ...f.diagnostics].join("\n");
  }
  if (row.symbol) {
    const s = row.symbol; path = s.path; line = s.line;
    const incoming = report.symbol_edges.filter(e => e.target === s.id);
    const outgoing = report.symbol_edges.filter(e => e.source === s.id);
    const visibleMetrics = Object.fromEntries(Object.entries(s.metrics || s.structural).filter(([key]) => !["fingerprint", "shingles"].includes(key)));
    text = [s.name, `${s.kind} · ${s.path}:${s.line}-${s.end_line} · ${s.confidence} confidence`, s.signature, "", JSON.stringify(visibleMetrics, null, 2),
      "", "CALLED BY", ...incoming.map(e => `${e.source} [${e.confidence}]`), "", "CALLS", ...outgoing.map(e => `${e.target} [${e.confidence}]`)].join("\n");
  }
  if (row.finding) {
    const f = row.finding; path = f.path; line = f.line;
    text = `${f.message}\n${f.path}:${f.line}\n${f.severity} · ${f.confidence} confidence\n\nEVIDENCE\n${f.evidence.join("\n")}`;
  }
  if (row.commit) text = `${row.commit.revision}\n${row.commit.date}\n${row.commit.subject}\n\nEnter: compare with current revision\nb: select a branch or commit\n\nBRANCHES\n${report.history.branches.join("\n")}`;
  if (row.node) {
    const graph = report.graphs[graphLevel];
    text = `${graphLevel.toUpperCase()} GRAPH\n${row.node}\n\nDEPENDS ON\n${(graph.edges || []).filter(e => e[0] === row.node).map(e => e[1]).join("\n")}\n\nUSED BY\n${(graph.edges || []).filter(e => e[1] === row.node).map(e => e[0]).join("\n")}\n\nEnter: follow an adjacent node · l: change graph level`;
    if (graphLevel === "module") path = row.node;
  }
  detail.setContent(clean(text)); screen.render();
  if (path) {
    try {
      await new Promise(accept => setTimeout(accept, 100));
      if (version !== generation) return;
      const preview = await run<string>("source", ["--path", path, "--line", String(line), "--count", "45"]);
      if (version === generation) { detail.setContent(clean(text + "\n\nSOURCE\n" + preview)); screen.render(); }
    } catch (error) {
      if (version === generation) { detail.setContent(clean(text + "\n\nPreview unavailable: " + String(error))); screen.render(); }
    }
  }
}

async function action(operation: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try { await operation(); }
  catch (error) { status = `Error: ${clean(error instanceof Error ? error.message : error)}`; }
  finally { busy = false; renderHeader(); }
}

async function refresh(): Promise<void> {
  status = "Analyzing…"; renderHeader();
  const next = await run<Report>("scan");
  report = next;
  status = `${next.files.length} files · ${next.incremental.analyzed} analyzed · ${next.incremental.cached} cached · ${next.revision.slice(0, 12)}`;
  comparison = undefined;
  rebuild();
}

function ask(label: string, initial: string, callback: (answer: string) => void): void {
  if (busy) return;
  prompt.input(label, initial, (_error, answer) => {
    list.focus();
    if (typeof answer === "string") callback(answer.trim());
    screen.render();
  });
}

async function compareWith(base: string): Promise<void> {
  status = `Comparing ${clean(base)}…`; renderHeader();
  comparison = await run<Comparison>("compare", ["--base", base]);
  view = 6; status = "Comparison complete"; rebuild();
}

list.on("select item", (_item, index) => { if (typeof index === "number") void show(index); });
list.on("select", (_item, index: number) => {
  const row = rows[index];
  if (!row || !report) return;
  if (row.directory) { expanded.has(row.directory) ? expanded.delete(row.directory) : expanded.add(row.directory); rebuild(row.directory); }
  else if (row.commit) void action(() => compareWith(row.commit!.revision));
  else if (row.file) { query = row.file.path; filter = ""; view = 2; rebuild(); }
  else if (row.node) {
    const neighbors = (report.graphs[graphLevel].edges || []).filter(e => e[0] === row.node).map(e => e[1]);
    if (!neighbors.length) status = "No outgoing relationship; select another node with ↑↓";
    else ask("Follow dependency (enter a node path/id)", neighbors[0], answer => {
      const next = rows.findIndex(r => r.node === answer);
      if (next >= 0) { list.select(next); void show(next); }
      else { query = ""; rebuild(); const found = rows.findIndex(r => r.node === answer); if (found >= 0) { list.select(found); void show(found); } }
    });
  } else detail.focus();
});
screen.key(["q", "C-c"], () => { for (const child of children) stopChild(child); screen.destroy(); process.exit(0); });
screen.key(["tab"], () => { view === 6 || screen.focused === list ? detail.focus() : list.focus(); });
for (let i = 0; i < views.length; i++) screen.key(String(i + 1), () => { if (prompt.visible) return; view = i; query = ""; filter = ""; rebuild(); view === 6 ? detail.focus() : list.focus(); });
screen.key("/", () => ask("Search names and paths (empty clears)", query, answer => { query = answer; rebuild(); }));
screen.key("f", () => ask("Filter: language/category/status, symbol kind, finding type/severity (empty clears)", filter, answer => { filter = answer; rebuild(); }));
screen.key("s", () => { sorted = !sorted; rebuild(); });
screen.key("l", () => { const levels = Object.keys(report?.graphs || {}); if (!levels.length) return; graphLevel = levels[(levels.indexOf(graphLevel) + 1) % levels.length]; view = 5; rebuild(); });
screen.key("r", () => { void action(refresh); });
screen.key("b", () => ask("Commit or branch (empty = working tree)", revision || "", answer => { void action(async () => {
  const previous = revision; revision = answer || undefined;
  try { await refresh(); } catch (error) { revision = previous; throw error; }
}); }));
screen.key("c", () => ask("Compare base commit/branch with current analysis", "HEAD", answer => { if (answer) void action(() => compareWith(answer)); }));
screen.key("e", () => ask("Export JSON report to path", resolve(root, ".repolens/report.json"), answer => { if (answer) void action(async () => {
  const { mkdir } = await import("node:fs/promises"); const { dirname } = await import("node:path");
  await mkdir(dirname(resolve(answer)), { recursive: true });
  const result = await run<{ output: string }>("export", ["--output", resolve(answer)]); status = `Exported ${result.output}`;
}); }));
screen.key("g", () => ask("Generate managed architecture section in root README.md? Type yes", "", answer => { if (answer === "yes") void action(async () => {
  const result = await run<{ output: string }>("readme"); status = `Updated ${result.output}`;
}); }));
screen.key("?", () => { detail.setContent("RepoLens keyboard controls\n\n1–7 switch views\n↑↓ / j k navigate; Enter expands folders and drills into symbols\nTab focuses source/detail; PageUp/PageDown scroll\n/ searches; f filters; s sorts by complexity\nl cycles repository, directory, module, class, function graphs\nb analyzes a revision without checking it out\nc compares revisions; History Enter compares selected commit\nr rescans with content-hash caching\ne exports JSON; g generates a managed root README section\nq / Ctrl+C exits\n\nImports and calls have confidence labels. Unknown relationships remain unresolved. See Overview for limitations."); detail.focus(); screen.render(); });
screen.on("resize", () => { layout(); screen.render(); });
list.focus(); rebuild();
void action(refresh);
