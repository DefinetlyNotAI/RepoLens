import blessed from "blessed";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, resolve } from "node:path";
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
type Row = { label: string; file?: FileInfo; symbol?: SymbolInfo; finding?: Finding; commit?: Commit; node?: string; directory?: string; section?: string };
type Section = { name: string; text: string; source?: { path: string; line: number } };
type Mouse = blessed.Widgets.Events.IMouseEventArg & { button?: string; type?: string; raw?: [number, ...unknown[]] };
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
const header = blessed.box({ parent: screen, top: 0, left: 1, height: 1, right: 1, wrap: false, style: { fg: "white" } });
const navigation = blessed.box({ parent: screen, top: 1, height: 1, left: 1, right: 1 });
const statusLine = blessed.box({ parent: screen, top: 2, height: 1, left: 1, right: 1, wrap: false, style: { fg: "gray" } });
const list = blessed.list({ parent: screen, top: 3, bottom: 2, left: 0, width: "42%", keys: true, vi: true,
  mouse: true, border: "line", label: " Explorer ", wrap: false, scrollbar: { ch: "│", style: { fg: "gray" } },
  style: { fg: "white", border: { fg: "gray" }, selected: { bg: "blue", fg: "white", bold: true } } });
const detailFrame = blessed.box({ parent: screen, top: 3, bottom: 2, left: "42%", width: "58%", border: "line",
  style: { border: { fg: "gray" } } });
const itemHeader = blessed.box({ parent: detailFrame, top: 0, left: 1, right: 1, height: 2, wrap: false });
const sectionBar = blessed.box({ parent: detailFrame, top: 2, left: 1, right: 1, height: 1 });
const detail = blessed.box({ parent: detailFrame, top: 4, bottom: 0, left: 0, right: 0,
  scrollable: true, alwaysScroll: true, keys: true, vi: true, mouse: true, scrollbar: { ch: "│" },
  padding: { left: 1, right: 1 }, style: { fg: "white", scrollbar: { fg: "gray" } } });
const detailGeometry = detail as typeof detail & { iright: number; ibottom: number };
const listItems = list as typeof list & { items: blessed.Widgets.BoxElement[]; enterSelected(): void };
const footer = blessed.box({ parent: screen, bottom: 0, left: 1, right: 1, height: 2, wrap: false, style: { fg: "gray" } });
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
// Blessed's SGR parser labels button-held motion as another press on xterm.
screen.program.prependListener("mouse", (data: Mouse) => {
  if (data.type === "sgr" && data.raw && (data.raw[0] & 32) && !(data.raw[0] & 64)) data.action = "mousemove";
});
const mouseParser = screen.program as typeof screen.program & { _bindMouse(text: string, data: Buffer): void };
const parseMouse = mouseParser._bindMouse.bind(screen.program);
mouseParser._bindMouse = (text, data) => {
  const packets = text.match(/\x1b\[<\d+;\d+;\d+[mM]/g);
  if (packets && packets.length > 1) packets.forEach(packet => parseMouse(packet, Buffer.from(packet)));
  else parseMouse(text, data);
};
let sections: Section[] = [];
let sectionIndex = 0;
let selectedRow = 0;
let rebuilding = false;
const sectionButtons: blessed.Widgets.ButtonElement[] = [];
let selection: { anchor: { row: number; column: number }; end: { row: number; column: number } } | undefined;
let dragging = false;
let lastClick = { row: -1, time: 0 };
const gray = (text: unknown) => `\x1b[90m${clean(text)}\x1b[39m`;
const accent = (text: unknown) => `\x1b[36m${clean(text)}\x1b[39m`;
const warning = (text: unknown) => `\x1b[33m${clean(text)}\x1b[39m`;
const strip = (text: string) => text.replace(/\x1b\[[\d;]*m/g, "").replace(/\x03/g, "");
const clip = (text: string, width: number, tail = false): string => {
  const chars = Array.from(clean(text));
  if (chars.length <= width) return chars.join("");
  return width < 2 ? "" : tail ? "…" + chars.slice(-(width - 1)).join("") : chars.slice(0, width - 1).join("") + "…";
};
const mainButtons = views.map((name, index) => {
  const button = blessed.button({ parent: navigation, mouse: true, height: 1, content: `${index + 1} ${name}` });
  button.on("press", () => switchView(index));
  return button;
});

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
  header.setContent(`${accent("RepoLens")}  ${clean(basename(root))}  ${gray(revision?.slice(0, 12) || "working tree")}`);
  let left = 0;
  const available = Number(screen.width) - 2;
  const compact = ["Overview", "Files", "Symbols", "Issues", "History", "Graph", "Compare"];
  mainButtons.forEach((button, index) => {
    const label = `${index + 1} ${compact[index]}`;
    button.left = left; button.width = label.length + 2; button.setContent(` ${label} `);
    button.style.fg = index === view ? "cyan" : "gray";
    button.style.bold = index === view;
    button.style.underline = index === view;
    left += label.length + (available < 85 ? 2 : 3);
  });
  statusLine.style.fg = status.startsWith("Error") ? "yellow" : "gray";
  statusLine.setContent(clip(status, available));
  footer.setContent("Click select · double-click open · drag text · Ctrl+C / right-click copy\n/ search · f filter · s sort · [ ] detail tabs · ? commands · q quit");
  screen.render();
}

function overview(index = 0): string {
  if (!report) return "Analysis is running. Progress appears above.";
  const summary = report.summary;
  if (index === 1) return Object.entries(summary.languages as Record<string, number>).sort((a, b) => b[1] - a[1])
    .map(([language, count]) => `${language.padEnd(18)} ${String(count).padStart(6)} files`).join("\n");
  const ranking = [...report.files].sort((a, b) => Number(b.metrics.hotspot) - Number(a.metrics.hotspot)).slice(0, 10);
  if (index === 2) return ranking.filter(f => Number(f.metrics.hotspot) > 0).map(f =>
    `${accent(f.metrics.hotspot)}  ${clean(f.path)}\n${gray(`    ${f.churn.commits} commits · complexity ${f.metrics.cyclomatic || 0}`)}`).join("\n\n") || "No churn hotspots in the selected history window.";
  if (index === 3) return report.dependencies.map(d => `${accent(d.name)} ${clean(d.version)}\n${gray(`${d.ecosystem} · ${d.path}`)}`).join("\n\n") || "No declared dependencies found.";
  if (index === 4) return [pairs(Object.entries(summary.coverage as Record<string, number>)), "",
    gray("Parsed describes syntax coverage; metadata-only files can be documentation or assets."), "",
    ...report.files.filter(f => f.status === "partial" || (f.status === "unsupported" && f.category === "source"))
      .map(f => `${warning(f.status)}  ${clean(f.path)}\n${f.diagnostics.map(clean).join("\n")}`)].join("\n");
  if (index === 5) return report.diagnostics.map(clean).join("\n\n") || "No repository scan diagnostics.";
  if (index === 6) return report.limitations.map(clean).join("\n\n");
  return [pairs([["Files", summary.files], ["Source files", summary.source_files], ["Lines", summary.lines],
    ["Symbols", summary.symbols], ["Module edges", summary.module_edges], ["Call edges", summary.symbol_edges],
    ["Circular components", summary.cycles], ["Warnings", summary.warnings]]), "", accent("Last scan"),
    `${report.incremental.analyzed} analyzed · ${report.incremental.cached} cached`, "", gray(root)].join("\n");
}

function pairs(entries: [string, unknown][]): string {
  return entries.filter(([, value]) => value !== null && value !== undefined).map(([name, value]) =>
    `${gray(name.padEnd(21))} ${typeof value === "number" ? value.toLocaleString("en-US") : clean(value)}`).join("\n");
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

function rebuild(selectedDirectory?: string, preserveIndex?: number): void {
  generation++;
  lastClick = { row: -1, time: 0 };
  layout();
  if (!report) { rows = []; list.setItems([]); setSections("Repository", "Analysis running", [{ name: "Summary", text: overview() }]); renderHeader(); return; }
  const label = `${views[view]}${view === 2 ? " · CC" : ""}${query ? " / " + clean(query) : ""}${filter ? " · " + clean(filter) : ""}`;
  list.setLabel(` ${clip(label, Number(list.width) - 4)} `);
  let items: Row[] = [];
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  if (view === 0) items = ["Summary", "Languages", "Hotspots", "Dependencies", "Coverage", "Diagnostics", "Boundaries"].map(section => ({ label: section, section }));
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
  rebuilding = true;
  list.setItems(rows.map(renderRow));
  wireRows();
  const selected = selectedDirectory ? Math.max(0, rows.findIndex(row => row.directory === selectedDirectory))
    : Math.min(preserveIndex || 0, Math.max(0, rows.length - 1));
  list.select(selected);
  rebuilding = false;
  void show(selected);
  renderHeader();
}

function layout(): void {
  if (view === 6) {
    list.hide(); detailFrame.left = 0; detailFrame.width = "100%";
  } else {
    list.show();
    const width = Number(screen.width) < 100 ? "38%" : "42%";
    list.width = width; detailFrame.left = width; detailFrame.width = Number(screen.width) < 100 ? "62%" : "58%";
  }
}

function renderRow(row: Row): string {
  const width = Math.max(8, Number(list.width) - 4);
  const columns = (name: string, metadata: string) => {
    const remaining = Math.max(1, width - metadata.length - 1);
    return clip(name, remaining).padEnd(remaining) + " " + metadata;
  };
  if (row.symbol) return columns(row.symbol.name, String(row.symbol.metrics?.cyclomatic ?? "—").padStart(3));
  if (row.finding) return columns(`${row.finding.severity === "warning" ? "!" : "·"} ${basename(row.finding.path)}:${row.finding.line}`, row.finding.type.slice(0, 4));
  if (row.commit) return clip(`${row.commit.revision.slice(0, 7)} ${row.commit.subject}`, width);
  if (row.node) return clip(row.node, width, true);
  if (row.file && (query || filter || sorted)) return clip(row.file.path, width, true);
  if (row.directory || row.file) {
    const path = row.directory || row.file!.path;
    const indentation = " ".repeat(Math.min(2 * (path.split("/").length - 1), Math.floor(width / 3)));
    const marker = row.directory ? expanded.has(path) ? "▾ " : "▸ " : "  ";
    return indentation + marker + clip(basename(path) + (row.directory ? "/" : ""), width - indentation.length - marker.length, true);
  }
  return clip(row.label, width);
}

function setSections(title: string, subtitle: string, next: Section[]): void {
  sections = next; sectionIndex = 0; selection = undefined; dragging = false;
  itemHeader.setContent(`${accent(clip(title, Number(detailFrame.width) - 4, true))}\n${gray(clip(subtitle, Number(detailFrame.width) - 4, true))}`);
  sectionButtons.forEach(button => button.destroy()); sectionButtons.length = 0;
  let left = 0;
  sections.forEach((section, index) => {
    const button = blessed.button({ parent: sectionBar, mouse: true, height: 1, left, width: section.name.length + 2, content: ` ${section.name} ` });
    button.on("press", () => { sectionIndex = index; void renderSection(); detail.focus(); });
    sectionButtons.push(button); left += section.name.length + 2;
  });
  sectionBar.hidden = sections.length < 2;
  detail.top = sections.length < 2 ? 2 : 4;
  void renderSection();
}

async function renderSection(): Promise<void> {
  const version = ++generation;
  const section = sections[sectionIndex];
  selection = undefined; dragging = false;
  detail.setScroll(0);
  sectionButtons.forEach((button, index) => {
    button.style.fg = index === sectionIndex ? "cyan" : "gray";
    button.style.underline = index === sectionIndex;
  });
  detail.setContent(section?.text || "No entries."); screen.render();
  if (!section?.source) return;
  try {
    await new Promise(accept => setTimeout(accept, 100));
    if (version !== generation) return;
    const preview = await run<string>("source", ["--path", section.source.path, "--line", String(section.source.line), "--count", "100"]);
    if (version !== generation) return;
    detail.setContent(clean(preview).split("\n").map(line => line.replace(/^(\s*\d+  )/, number => gray(number))).join("\n"));
    screen.render();
  } catch (error) {
    if (version === generation) { detail.setContent(`Preview unavailable: ${clean(error)}`); screen.render(); }
  }
}

async function show(index: number): Promise<void> {
  const row = rows[index];
  selectedRow = index;
  if (view === 0) { setSections(row?.section || "Overview", basename(root), [{ name: "Summary", text: overview(index) }]); return; }
  if (view === 6) { setSections("Revision comparison", comparison ? `${comparison.before.revision.slice(0, 12)} → ${comparison.after.revision.slice(0, 12)}` : "Press c to choose a base revision", [{ name: "Comparison", text: comparisonText() }]); return; }
  if (!row || !report) { setSections("No matching entries", "Clear the search or filter", [{ name: "Empty", text: "" }]); return; }
  if (row.directory) {
    const files = report.files.filter(f => f.path.startsWith(row.directory + "/"));
    setSections(row.directory + "/", "Enter or double-click to expand", [{ name: "Info", text: pairs([
      ["Files", files.length], ["Source files", files.filter(f => f.category === "source").length],
      ["Lines", files.reduce((sum, f) => sum + f.lines, 0)]]) }]);
  }
  if (row.file) {
    const f = row.file;
    setSections(f.path, `${f.language} · ${f.category} · ${f.status}`, [
      { name: "Info", text: pairs([["Lines", f.lines], ["Functions", f.metrics.functions || 0], ["Classes", f.metrics.classes || 0],
        ["Cyclomatic", f.metrics.cyclomatic || 0], ["Fan-in / fan-out", `${f.metrics.fan_in} / ${f.metrics.fan_out}`],
        ["Dependency depth", f.metrics.dependency_depth], ["Internal-call ratio", f.metrics.cohesion], ["Hotspot score", f.metrics.hotspot]]) },
      { name: "Source", text: "Loading source…", source: { path: f.path, line: 1 } },
      { name: "Symbols", text: f.symbols.map(s => `${accent(s.line)}  ${clean(s.name)}\n${gray(s.signature)}`).join("\n\n") || "No extracted symbols." },
      { name: "Imports", text: f.imports.map(i => `${gray(String(i.line).padStart(5))}  ${clean(i.target)}`).join("\n") || "No parsed imports." },
      { name: "Churn", text: pairs([["Commits in window", f.churn.commits], ["Lines added", f.churn.added], ["Lines removed", f.churn.removed]]) },
    ]);
  }
  if (row.symbol) {
    const s = row.symbol;
    const incoming = report.symbol_edges.filter(e => e.target === s.id);
    const outgoing = report.symbol_edges.filter(e => e.source === s.id);
    setSections(s.name, `${s.path}:${s.line} · ${s.confidence} confidence`, [
      { name: "Info", text: clean(s.signature) + "\n\n" + pairs([["Kind", s.kind], ["Lines", s.metrics?.lines],
        ["Cyclomatic", s.metrics?.cyclomatic], ["Cognitive", s.metrics?.cognitive], ["Nesting", s.metrics?.nesting],
        ["Fan-in / fan-out", `${s.structural.fan_in} / ${s.structural.fan_out}`]]) },
      { name: "Source", text: "Loading source…", source: { path: s.path, line: s.line } },
      { name: "Calls", text: `${accent("Called by")}\n${incoming.map(e => `${clean(e.source)} ${gray(e.confidence)}`).join("\n") || "None resolved"}\n\n${accent("Calls")}\n${outgoing.map(e => `${clean(e.target)} ${gray(e.confidence)}`).join("\n") || "None resolved"}` },
    ]);
  }
  if (row.finding) {
    const f = row.finding;
    setSections(f.path + ":" + f.line, `${f.severity} · ${f.type} · ${f.confidence} confidence`, [
      { name: "Evidence", text: `${f.severity === "warning" ? warning(f.message) : clean(f.message)}\n\n${f.evidence.map(clean).join("\n")}` },
      { name: "Source", text: "Loading source…", source: { path: f.path, line: f.line } },
    ]);
  }
  if (row.commit) setSections(row.commit.subject, row.commit.date.slice(0, 10), [
    { name: "Commit", text: clean(row.commit.revision) + "\n\n" + gray("Enter or double-click to compare with the current revision.") },
    { name: "Branches", text: report.history.branches.map(clean).join("\n") || "No branches." },
  ]);
  if (row.node) {
    const graph = report.graphs[graphLevel];
    const links = [accent("Depends on"), ...(graph.edges || []).filter(e => e[0] === row.node).map(e => clean(e[1])), "", accent("Used by"), ...(graph.edges || []).filter(e => e[1] === row.node).map(e => clean(e[0]))].join("\n");
    setSections(row.node, graphLevel + " relationships · l changes level", [{ name: "Links", text: links },
      ...(graphLevel === "module" ? [{ name: "Source", text: "Loading source…", source: { path: row.node, line: 1 } }] : [])]);
  }
}

function selectionRange() {
  if (!selection) return undefined;
  const { anchor, end } = selection;
  if (anchor.row === end.row && anchor.column === end.column) return undefined;
  return anchor.row < end.row || (anchor.row === end.row && anchor.column < end.column)
    ? { start: anchor, end } : { start: end, end: anchor };
}

function textAtColumns(text: string, from: number, to: number): string {
  let column = 0;
  let result = "";
  let included = false;
  for (const character of strip(text)) {
    const width = Number(detail.strWidth(character));
    included = width === 0 ? included : column + width > from && column < to;
    if (included) result += character;
    column += width;
  }
  return result;
}

function selectedText(): string {
  const range = selectionRange();
  if (!range) return "";
  const lines = detail.getScreenLines();
  // Blessed maps wrapped screen rows to the original logical lines.
  const mapping = (detail as typeof detail & { _clines: { rtof: number[] } })._clines.rtof;
  let text = "";
  for (let row = range.start.row; row <= range.end.row; row++) {
    const from = row === range.start.row ? range.start.column : 0;
    const to = row === range.end.row ? range.end.column + 1 : Infinity;
    text += textAtColumns(lines[row] || "", from, to);
    if (row < range.end.row && mapping[row] !== mapping[row + 1]) text += "\n";
  }
  return text;
}

function point(data: Mouse) {
  const position = detail.lpos;
  if (!position) return { row: 0, column: 0 };
  return {
    row: Math.min(detail.getScreenLines().length - 1, Math.max(0, data.y - position.yi - Number(detail.itop) + detail.getScroll())),
    column: Math.max(0, Math.min(position.xl - position.xi - Number(detail.ileft) - detailGeometry.iright - 2,
      data.x - position.xi - Number(detail.ileft))),
  };
}

detail.on("mousedown", (data: Mouse) => {
  if (data.button === "right") { detail.focus(); void copyCurrent(); return; }
  if (data.button !== "left") return;
  const pos = detail.lpos;
  if (!pos || data.x >= pos.xl - detailGeometry.iright - 1) return;
  detail.focus(); dragging = true;
  selection = { anchor: point(data), end: point(data) }; screen.render();
});
screen.program.on("mouse", (data: Mouse) => {
  if (!dragging || prompt.visible) return;
  if (data.action === "mousemove" || data.action === "mouseup") {
    if (selection) selection.end = point(data);
    if (data.action === "mouseup") dragging = false;
    screen.render();
  }
});
detail.on("render", () => {
  const range = selectionRange();
  const pos = detail.lpos;
  if (!range || !pos || prompt.visible) return;
  const buffer = (screen as typeof screen & { lines: (Array<[number, string]> & { dirty: boolean })[] }).lines;
  const scroll = detail.getScroll();
  for (let y = pos.yi + Number(detail.itop); y < pos.yl - detailGeometry.ibottom; y++) {
    const row = y - pos.yi - Number(detail.itop) + scroll;
    if (row < range.start.row || row > range.end.row) continue;
    const left = pos.xi + Number(detail.ileft);
    const start = left + (row === range.start.row ? range.start.column : 0);
    const end = row === range.end.row ? left + range.end.column + 1 : pos.xl - detailGeometry.iright - 1;
    for (let x = start; x < Math.min(end, pos.xl - detailGeometry.iright - 1); x++) {
      const cell = buffer[y]?.[x];
      if (cell) { cell[0] |= 8 << 18; buffer[y].dirty = true; }
    }
  }
});

async function clipboard(text: string): Promise<void> {
  const commands: [string, string[]][] = process.platform === "win32"
    ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); Set-Clipboard -Value ([Console]::In.ReadToEnd())"]]]
    : process.platform === "darwin" ? [["pbcopy", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  let failure = "Clipboard is unavailable";
  for (const [command, args] of commands) {
    try {
      await new Promise<void>((accept, reject) => {
        const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
        children.add(child);
        let error = "";
        child.stderr.on("data", data => { error += data.toString(); });
        child.on("error", reject);
        child.on("close", code => { children.delete(child); code === 0 ? accept() : reject(new Error(error || "Clipboard command failed")); });
        child.stdin.on("error", reject);
        child.stdin.end(text, "utf8");
      });
      return;
    } catch (error) { failure = clean(error); }
  }
  throw new Error(failure);
}

async function copyCurrent(row?: Row): Promise<void> {
  const item = row || rows[selectedRow];
  const picked = selectedText();
  const text = !row && picked ? picked : !row && screen.focused === detail
    ? strip(detail.getContent()) : item?.symbol?.signature || item?.file?.path || item?.finding?.message
      || item?.commit?.revision || item?.node || item?.directory || item?.label || strip(detail.getContent());
  if (!text) { status = "Nothing to copy"; renderHeader(); return; }
  try {
    await clipboard(text);
    status = `Copied ${Array.from(text).length} characters${picked && !row ? " from selection" : ""}`;
  } catch (error) { status = `Error copying: ${clean(error)}`; }
  renderHeader();
}

function switchView(index: number): void {
  if (prompt.visible) return;
  view = index; query = ""; filter = "";
  rebuild(); view === 6 ? detail.focus() : list.focus();
}

function wireRows(): void {
  for (const item of listItems.items) {
  item.removeAllListeners("click"); item.removeAllListeners("mousedown");
  item.on("mousedown", (data: Mouse) => {
    if (data.button !== "right") return;
    const index = listItems.items.indexOf(item); list.select(index); list.focus();
    void copyCurrent(rows[index]);
  });
  item.on("click", (data: Mouse) => {
    if (data.button !== "left") return;
    const index = listItems.items.indexOf(item);
    const same = selectedRow === index;
    list.select(index); list.focus(); selection = undefined; dragging = false;
    if (same) void show(index);
    const now = Date.now();
    if (lastClick.row === index && now - lastClick.time < 350) listItems.enterSelected();
    lastClick = { row: index, time: now }; screen.render();
  });
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

list.on("select item", (_item, index) => { if (!rebuilding && typeof index === "number") void show(index); });
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
screen.key("q", () => { for (const child of children) stopChild(child); screen.destroy(); process.exit(0); });
screen.key("C-c", () => { void copyCurrent(); });
screen.key("escape", () => { selection = undefined; dragging = false; list.focus(); screen.render(); });
screen.key(["tab"], () => { view === 6 || screen.focused === list ? detail.focus() : list.focus(); });
for (let i = 0; i < views.length; i++) screen.key(String(i + 1), () => switchView(i));
screen.key(["[", "]"], (_character, key) => {
  if (sections.length < 2) return;
  sectionIndex = (sectionIndex + (key.name === "[" ? -1 : 1) + sections.length) % sections.length;
  void renderSection();
});
screen.key("v", () => { const index = sections.findIndex(section => section.source); if (index >= 0) { sectionIndex = index; detail.focus(); void renderSection(); } });
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
screen.key("?", () => { setSections("Commands", "Mouse and keyboard", [{ name: "Help", text:
  pairs([["1–7 / click tab", "Switch view"], ["↑↓ / j k / click row", "Select item"], ["Enter / double-click", "Open item or directory"],
    ["Tab", "Focus list or detail"], ["[ ] / click detail tab", "Choose detail section"], ["v", "Source preview"], ["Drag text", "Select text in detail"],
    ["Ctrl+C / right-click", "Copy selected text, detail, or row"], ["Esc", "Clear selection and focus list"],
    ["/ · f · s", "Search · filter · sort"], ["l", "Change graph level"], ["b · c · r", "Revision · comparison · rescan"],
    ["e · g", "Export JSON · managed README"], ["q", "Quit"]]) }]); detail.focus(); screen.render(); });
screen.on("resize", () => {
  const index = selectedRow;
  const name = sections[sectionIndex]?.name;
  selection = undefined; dragging = false;
  rebuild(undefined, index);
  const next = sections.findIndex(section => section.name === name);
  if (next > 0) { sectionIndex = next; void renderSection(); }
});
screen.program.setMouse({ sgrMouse: true, allMotion: true }, true);
list.focus(); rebuild();
process.stdin.resume();
void action(refresh);
