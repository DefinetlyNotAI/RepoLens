import blessed from "blessed";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inputDialog } from "./input-dialog.js";
import { sizeTree } from "./size-tree.js";

type Metrics = Record<string, number | string | null>;
interface SymbolInfo {
  id: string; name: string; short_name: string; kind: string; path: string; line: number;
  end_line: number; parent: string | null; confidence: string; signature: string; metrics?: Metrics; structural: Metrics;
}
interface FileInfo {
  path: string; language: string; category: string; lines: number; status: string;
  symbols: SymbolInfo[]; metrics: Metrics; diagnostics: string[];
  imports: { target: string; line: number }[]; churn: { added: number; removed: number; commits: number };
  recovery_lines?: number[];
}
interface SourceLine { number: number; text: string; spans: { start: number; end: number; kind: string }[] }
interface SourcePreview { path: string; language: string; lines: SourceLine[] }
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
type Row = { label: string; file?: FileInfo; symbol?: SymbolInfo; finding?: Finding; commit?: Commit; directory?: string; section?: string; depth?: number; branch?: boolean; hit?: { line: number; text: string }; group?: { key: string; name: string; findings: Finding[] }; sizeLines?: number; symbolCount?: number };
type Section = { name: string; text: string; source?: { path: string; line: number }; verbatim?: string[] };
type Mouse = Omit<blessed.Widgets.Events.IMouseEventArg, "action"> & {
  action: string; button?: string; type?: string; raw?: [number, ...unknown[]]; shift?: boolean; ctrl?: boolean;
};
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
const list = blessed.list({ parent: screen, top: 3, bottom: 1, left: 0, width: "42%", keys: false, vi: false,
  mouse: true, border: "line", label: " Explorer ", wrap: false, padding: { bottom: 1, right: 1 },
  style: { fg: "white", border: { fg: "gray" }, selected: { bg: "blue", fg: "white", bold: true } } });
const detailFrame = blessed.box({ parent: screen, top: 3, bottom: 1, left: "42%", width: "58%", border: "line",
  style: { border: { fg: "gray" } } });
const itemHeader = blessed.box({ parent: detailFrame, top: 0, left: 1, right: 1, height: 2, wrap: false });
const sectionBar = blessed.box({ parent: detailFrame, top: 2, left: 1, right: 1, height: 1 });
const detail = blessed.box({ parent: detailFrame, top: 4, bottom: 1, left: 0, right: 0, wrap: false,
  keys: false, vi: false, mouse: true,
  padding: { left: 1, right: 1 }, style: { fg: "white", scrollbar: { fg: "gray" } } });
const gutter = blessed.box({ parent: detailFrame, top: 4, bottom: 1, left: 1, width: 6, wrap: false, style: { fg: "gray" }, hidden: true });
const detailBar = blessed.box({ parent: detailFrame, bottom: 0, left: 1, right: 1, height: 1, mouse: true, style: { fg: "gray" } });
const listBar = blessed.box({ parent: screen, bottom: 2, left: 1, width: "40%", height: 1, mouse: true, style: { fg: "gray" } });
const listVertical = blessed.box({ parent: list, top: 0, bottom: 1, right: 0, width: 1, mouse: true });
const detailVertical = blessed.box({ parent: detailFrame, top: 4, bottom: 1, right: 0, width: 1, mouse: true });
const detailGeometry = detail as typeof detail & { iright: number; ibottom: number };
const listItems = list as typeof list & { items: blessed.Widgets.BoxElement[]; enterSelected(): void };
const footer = blessed.box({ parent: screen, bottom: 0, left: 1, right: 1, height: 1, wrap: false, style: { fg: "gray" } });
const dialog = inputDialog(screen, readClipboard, clipboard);
const prompt = dialog.box;
const chart = sizeTree(detailFrame, basename(root), (path, lines, files) => {
  itemHeader.setContent(`${accent(clean(path))}\n${gray(`${lines.toLocaleString()} lines · ${files} files · click to inspect`)}`);
}, (path, directory) => {
  if (directory) { chart.setPath(path); rebuild(); chart.box.focus(); }
  else { view = 1; query = path; rebuild(); detail.focus(); }
}, () => prompt.visible);
const views = ["Overview", "Files", "Symbols", "Findings", "History", "Size", "Compare"];
let view = 0;
let report: Report | undefined;
let comparison: Comparison | undefined;
let rows: Row[] = [];
let renderedRows: string[] = [];
let query = "";
let filter = "";
let sorted = false;
let busy = false;
let status = "Starting analysis…";
let listBase = 0, listExtent = 0, detailExtent = 0;
let detailBase = 0;
let historyLoading = false, historyDone = false, historyHead: string | undefined;
let rgAvailable = false, searchVersion = 0;
let sourceHits = new Map<string, { line: number; text: string }[]>();
let fileMap = new Map<string, FileInfo>();
let symbolChildren = new Map<string, SymbolInfo[]>();
let pathPattern: RegExp | undefined;
const symbolExpanded = new Set<string>();
const issueExpanded = new Set<string>();
const closedFolders = new Set<string>();
let verbatim = new Set<string>();
let generation = 0;
const expanded = new Set<string>(["."]);
const children = new Set<ChildProcess>();
let previewChild: ChildProcess | undefined;
// Blessed's SGR parser labels button-held motion as another press on xterm.
screen.program.prependListener("mouse", (data: Mouse) => {
  if (data.type === "sgr" && data.raw && (data.raw[0] & 32) && !(data.raw[0] & 64)) data.action = "mousemove";
  if (data.raw && (data.raw[0] & 64) && (data.raw[0] & 2)) data.action = data.raw[0] & 1 ? "wheelright" : "wheelleft";
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
let logicalLines: string[] = [];
let styledLines: string[] = [];
let visualRows: { logical: number; start: number; text: string; banner?: boolean; severity?: string }[] = [];
let detailLinks: { row: number; start: number; end: number; path: string }[] = [];
let hoverLink: { row: number; start: number; end: number; path: string } | undefined;
let sourceNotes = new Map<number, { severity: string; message: string }[]>();
let sourceNumbers: number[] | undefined;
let listX = 0;
let detailX = 0;
let activeFile: string | undefined;
let scrollDrag: { area: "list" | "detail"; horizontal: boolean; grab?: number } | undefined;
let lastPointer: Mouse | undefined;
let dragTimer: ReturnType<typeof setInterval> | undefined;
const gray = (text: unknown) => `\x1b[90m${clean(text)}\x1b[39m`;
const accent = (text: unknown) => `\x1b[36m${clean(text)}\x1b[39m`;
const warning = (text: unknown) => `\x1b[33m${clean(text)}\x1b[39m`;
const danger = (text: unknown) => `\x1b[91m${clean(text)}\x1b[39m`;
const terminalColors = new Map<string, number>();
function color(text: unknown, hex: string): string {
  let index = terminalColors.get(hex);
  if (index === undefined) {
    // Blessed's green-weighted RGB conversion turns subdued purples into gray.
    const rgb = [0, 2, 4].map(start => parseInt(hex.slice(start, start + 2), 16));
    const cube = [0, 95, 135, 175, 215, 255];
    const positions = rgb.map(channel => cube.reduce((best, value, i) => Math.abs(channel - value) < Math.abs(channel - cube[best]) ? i : best, 0));
    const grayIndex = Math.max(0, Math.min(23, Math.round((rgb.reduce((sum, channel) => sum + channel, 0) / 3 - 8) / 10)));
    const grayValue = 8 + grayIndex * 10;
    const cubeDistance = rgb.reduce((sum, channel, i) => sum + (channel - cube[positions[i]]) ** 2, 0);
    const grayDistance = rgb.reduce((sum, channel) => sum + (channel - grayValue) ** 2, 0);
    index = grayDistance < cubeDistance ? 232 + grayIndex : 16 + 36 * positions[0] + 6 * positions[1] + positions[2];
    terminalColors.set(hex, index);
  }
  return `\x1b[38;5;${index}m${clean(text)}\x1b[39m`;
}
const codeColors: Record<string, string> = { keyword: "cc7832", string: "6a8759", number: "6897bb", comment: "808080", declaration: "ffc66d", property: "9876aa", builtin: "8888c6", decorator: "bbb529", tag: "e8bf6a", attribute: "bababa", selector: "ffc66d", parameter: "a9b7c6", type: "a9b7c6", constant: "9876aa", escape: "cc7832", self: "94558d", predefined: "b200b2", keyword_argument: "aa4926", bytes: "a5c261" };
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
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
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
  const compact = ["Overview", "Files", "Symbols", "Issues", "History", "Size", "Compare"];
  mainButtons.forEach((button, index) => {
    const label = `${index + 1} ${compact[index]}`;
    button.left = left; button.width = label.length + 2; button.setContent(` ${label} `);
    button.style.fg = index === view ? "cyan" : "gray";
    button.style.bold = index === view;
    button.style.underline = index === view;
    left += label.length + (available < 85 ? 2 : 3);
  });
  statusLine.style.fg = status.startsWith("Error") ? "red" : "gray";
  statusLine.setContent(clip(status, available));
  footer.setContent("q quit · ? commands");
  screen.render();
}

function overview(index = 0): string {
  if (!report) return "Analysis is running. Progress appears above.";
  const summary = report.summary;
  if (index === 1) return alignRows(Object.entries(summary.languages as Record<string, number>).sort((a, b) => b[1] - a[1])
    .map(([language, count]) => [color(language, "6897bb"), accent(count), gray("files")])).join("\n");
  const ranking = [...report.files].sort((a, b) => Number(b.metrics.hotspot) - Number(a.metrics.hotspot));
  if (index === 2) {
    const hotspots = ranking.filter(f => Number(f.metrics.hotspot) > 0);
    return alignRows(hotspots.map(f => [accent(f.metrics.hotspot), clean(f.path)]))
      .map((line, i) => `${line}\n${gray(`    ${hotspots[i].churn.commits} commits · complexity ${hotspots[i].metrics.cyclomatic || 0}`)}`).join("\n\n") || "No churn hotspots in the selected history window.";
  }
  if (index === 3) {
    const dependencies = report.dependencies;
    return alignRows(dependencies.map(d => [accent(d.name), clean(d.version)]))
      .map((line, i) => `${line}\n${gray(`${dependencies[i].ecosystem} · ${dependencies[i].path}`)}`).join("\n\n") || "No declared dependencies found.";
  }
  if (index === 4) {
    const coverage = report.files.filter(f => f.status === "partial" || (f.status === "unsupported" && f.category === "source"));
    return [pairs(Object.entries(summary.coverage as Record<string, number>)), "",
    gray("Grammar recovery is partial parser coverage, not a confirmed compiler error."), "",
    ...alignRows(coverage.map(f => [warning(f.status), clean(f.path)]))
      .map((line, i) => { const f = coverage[i]; return `${line}\n${gray(f.language + " · " + (f.recovery_lines?.length ? `${f.recovery_lines.length} recovery locations · lines ${f.recovery_lines.slice(0, 8).join(", ")}${f.recovery_lines.length > 8 ? ", …" : ""}` : "metadata only"))}`; })].join("\n\n");
  }
  if (index === 5) return report.diagnostics.map(warning).join("\n\n") || gray("No repository scan diagnostics.");
  if (index === 6) return report.limitations.map(gray).join("\n\n");
  return [pairs([["Files", summary.files], ["Source files", summary.source_files], ["Lines", summary.lines],
    ["Symbols", summary.symbols], ["Module edges", summary.module_edges], ["Call edges", summary.symbol_edges],
    ["Circular components", summary.cycles], ["Warnings", summary.warnings]]), "", accent("Last scan"),
    `${report.incremental.analyzed} analyzed · ${report.incremental.cached} cached`, "", gray(root)].join("\n");
}

function pairs(entries: [string, unknown][]): string {
  return alignRows(entries.filter(([, value]) => value !== null && value !== undefined).map(([name, value]) =>
    [gray(name), typeof value === "number" ? accent(value.toLocaleString("en-US")) : color(value, "a9b7c6")])).join("\n");
}

function alignRows(entries: string[][]): string[] {
  const widths: number[] = [];
  for (const row of entries) row.forEach((cell, index) => { widths[index] = Math.max(widths[index] || 0, displayWidth(cell)); });
  return entries.map(row => row.map((cell, index) => cell + (index < row.length - 1 ? " ".repeat(widths[index] - displayWidth(cell) + 2) : "")).join(""));
}

function comparisonText(): string {
  const current = comparison;
  if (!current) return "Press c and enter a Git revision to compare it with the current analysis.\nPress b to analyze another commit or branch. Leave b empty for the working tree.";
  const delta = (number: number) => (number < 0 ? warning : accent)((number >= 0 ? "+" : "") + number);
  return [...alignRows([[accent("BASE"), accent("CURRENT")],
    [color(current.before.revision, "ffc66d"), color(current.after.revision, "ffc66d")]]), "",
    ...alignRows(Object.keys(current.delta).map(key => [gray(key), String(current.before.summary[key]), "→", String(current.after.summary[key]), `(${delta(current.delta[key])})`])),
    "", accent("ADDED FILES"), ...current.added_files.map(fileLink), "", warning("REMOVED FILES"), ...current.removed_files.map(fileLink),
    "", accent("CHANGED FILES"), ...alignRows(current.changed_files.map(f => [fileLink(f.path), gray("complexity"), delta(f.complexity_delta), gray("lines"), delta(f.lines_delta)])),
    "", accent("ADDED DEPENDENCIES"), ...current.added_edges.map(e => e.map(reference).join(" → ")),
    "", warning("REMOVED DEPENDENCIES"), ...current.removed_edges.map(e => e.map(reference).join(" → "))].join("\n");
}

function folderOpen(key: string, opened: Set<string>, automatic = false): boolean {
  return !closedFolders.has(key) && (opened.has(key.startsWith("dir:") ? key.slice(4) : key) || automatic);
}
function toggleFolder(key: string, opened: Set<string>, automatic = false): void {
  if (folderOpen(key, opened, automatic)) { opened.delete(key); closedFolders.add(key); }
  else { opened.add(key); closedFolders.delete(key); }
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
    const files = report.files.filter(f => (matches(f.path) || sourceHits.has(f.path)) && (!filter || f.language === filter || f.category === filter || f.status === filter));
    if (query || filter || sorted) items = files.flatMap(file => {
      const hits = sourceHits.get(file.path);
      return hits?.length ? hits.map(hit => ({ label: `${file.path}:${hit.line} ${hit.text}`, file, hit })) : [{ label: file.path, file }];
    });
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
  if (view === 2) {
    const eligible = new Map<FileInfo, Set<string>>();
    for (const file of report.files) {
      const included = new Set(file.symbols.filter(s => matches(`${s.name} ${s.path}`) && (!filter || s.kind === filter || s.confidence === filter)).map(s => s.id));
      if (query || filter) {
        const byId = new Map(file.symbols.map(s => [s.id, s]));
        for (const id of [...included]) { let owner = byId.get(id)?.parent; while (owner) { included.add(owner); owner = byId.get(owner)?.parent; } }
      }
      if (included.size) eligible.set(file, included);
    }
    const directories = new Set<string>();
    for (const file of eligible.keys()) {
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
    }
    const visible = (path: string) => path.split("/").slice(0, -1).every((_, i, parents) => folderOpen("dir:" + parents.slice(0, i + 1).join("/"), expanded, !!(query || filter)));
    const entries = [...[...directories].filter(visible).map<Row>(directory => ({ label: directory, directory })),
      ...[...eligible.keys()].filter(file => visible(file.path)).map<Row>(file => ({ label: file.path, file, branch: true, symbolCount: eligible.get(file)!.size }))]
      .sort((a, b) => (a.directory || a.file!.path).localeCompare(b.directory || b.file!.path));
    for (const entry of entries) {
      items.push(entry);
      if (!entry.file || !folderOpen("file:" + entry.file.path, symbolExpanded, !!(query || filter))) continue;
      const file = entry.file, included = eligible.get(file)!;
      const order = (symbols: SymbolInfo[]) => sorted ? [...symbols].sort((a, b) => Number(b.metrics?.cyclomatic || 0) - Number(a.metrics?.cyclomatic || 0) || a.short_name.localeCompare(b.short_name)) : symbols;
      const visit = (symbol: SymbolInfo, depth: number) => {
        if (!included.has(symbol.id)) return;
        const children = (symbolChildren.get(symbol.id) || []).filter(s => included.has(s.id));
        items.push({ label: `${symbol.name} ${symbol.path}:${symbol.line}`, symbol, depth, branch: children.length > 0 });
        if (folderOpen(symbol.id, symbolExpanded, !!(query || filter))) order(children).forEach(child => visit(child, depth + 1));
      };
      order(file.symbols.filter(s => !s.parent)).forEach(s => visit(s, file.path.split("/").length));
    }
  }
  if (view === 3) {
    const findings = report.findings.filter(f => matches(`${f.path} ${f.message}`) && (!filter || f.type === filter || f.severity === filter || f.confidence === filter));
    const severities = [...new Set(findings.map(f => f.severity))].sort((a, b) => ["error", "warning", "info"].indexOf(a) - ["error", "warning", "info"].indexOf(b));
    for (const severity of severities) {
      const severityFindings = findings.filter(f => f.severity === severity);
      const key = "issues:" + severity;
      items.push({ label: severity, group: { key, name: severity === "warning" ? "Warnings" : severity === "error" ? "Errors" : "Information", findings: severityFindings }, branch: true, depth: 0 });
      if (!folderOpen(key, issueExpanded, !!(query || filter))) continue;
      for (const type of [...new Set(severityFindings.map(f => f.type))].sort()) {
        const typeFindings = severityFindings.filter(f => f.type === type), typeKey = key + ":" + type;
        items.push({ label: type, group: { key: typeKey, name: type.replace(/_/g, " "), findings: typeFindings }, branch: true, depth: 1 });
        if (folderOpen(typeKey, issueExpanded, !!(query || filter))) items.push(...typeFindings.map<Row>(finding => ({ label: `${finding.path}:${finding.line} ${finding.message}`, finding, depth: 2 })));
      }
    }
  }
  if (view === 4) items = report.history.commits.filter(c => matches(c.subject + c.revision)).map(commit => ({ label: `${commit.revision.slice(0, 8)} ${commit.date.slice(0, 10)} ${commit.subject}`, commit }));
  if (view === 5) items = chart.children().map(node => ({ label: node.path, sizeLines: node.lines, ...(node.children.length ? { directory: node.path } : { file: fileMap.get(node.path) }) }));
  if (view === 6) items = [{ label: comparison ? "Revision comparison" : "Press c to compare" }];
  if (sorted && view !== 2 && view !== 3 && view !== 5) items.sort((a, b) => Number(b.symbol?.metrics?.cyclomatic || b.file?.metrics.cyclomatic || 0) - Number(a.symbol?.metrics?.cyclomatic || a.file?.metrics.cyclomatic || 0) || a.label.localeCompare(b.label));
  rows = items;
  renderedRows = alignRows(rows.map(renderRow));
  listExtent = renderedRows.reduce((width, text) => Math.max(width, displayWidth(text)), 0);
  const selected = selectedDirectory ? Math.max(0, rows.findIndex(row => row.directory === selectedDirectory))
    : Math.min(preserveIndex || 0, Math.max(0, rows.length - 1));
  selectedRow = selected; listBase = Math.min(listBase, Math.max(0, rows.length - listHeight()));
  if (selected < listBase || selected >= listBase + listHeight()) listBase = selected;
  void show(selected);
  paintList();
  renderHeader();
}

function layout(): void {
  chart.box.hidden = view !== 5;
  detail.hidden = view === 5; detailBar.hidden = view === 5; detailVertical.hidden = view === 5;
  if (view === 5) { gutter.hide(); sectionBar.hide(); }
  if (view === 6) {
    list.hide(); listBar.hide(); listVertical.hide(); detailFrame.left = 0; detailFrame.width = "100%";
  } else {
    list.show(); listBar.show(); listVertical.show();
    const width = Number(screen.width) < 100 ? "38%" : "42%";
    list.width = width; detailFrame.left = width; detailFrame.width = Number(screen.width) < 100 ? "62%" : "58%";
    listBar.width = Number(list.width) - 2;
  }
}

function renderRow(row: Row): string[] {
  const columns = (name: string, metadata: string) => [name, metadata];
  if (row.group) {
    const severity = row.group.findings[0]?.severity;
    const paint = severity === "error" ? danger : severity === "warning" ? warning : accent;
    return columns(`${"  ".repeat(row.depth || 0)}${accent(folderOpen(row.group.key, issueExpanded, !!(query || filter)) ? "▾ " : "▸ ")}${paint(row.group.name)}`, gray(row.group.findings.length));
  }
  if (view === 2 && row.file) return columns(`${"  ".repeat(row.file.path.split("/").length - 1)}${accent(folderOpen("file:" + row.file.path, symbolExpanded, !!(query || filter)) ? "▾ " : "▸ ")}${fileLink(basename(row.file.path))}`, gray(`${row.symbolCount} symbols`));
  if (row.symbol) return columns(`${"  ".repeat(row.depth || 0)}${row.branch ? accent(folderOpen(row.symbol.id, symbolExpanded, !!(query || filter)) ? "▾ " : "▸ ") : "  "}${color(row.symbol.kind === "class" ? "C" : "ƒ", row.symbol.kind === "class" ? "6897bb" : "ffc66d")} ${clean(row.symbol.short_name)}`, Number(row.symbol.metrics?.cyclomatic) >= 10 ? warning(row.symbol.metrics?.cyclomatic) : gray(row.symbol.metrics?.cyclomatic ?? "—"));
  if (row.finding) return columns(`${"  ".repeat(row.depth || 0)}${row.finding.severity === "error" ? danger("!") : row.finding.severity === "warning" ? warning("!") : accent("·")} ${fileLink(row.finding.path)}:${accent(row.finding.line)}`, gray(row.finding.confidence));
  if (row.commit) return [color("*", "6a8759"), color(row.commit.revision.slice(0, 7), "ffc66d"), gray(row.commit.date.slice(0, 10)), clean(row.commit.subject)];
  if (row.hit) return [fileLink(row.file!.path) + ":" + accent(row.hit.line), gray(row.hit.text.trim())];
  if (view === 5) return columns(`${row.directory ? accent("● ") : color("· ", "6897bb")}${fileLink(basename(row.directory || row.file!.path))}`, color(row.sizeLines?.toLocaleString(), "6a8759"));
  if (row.file && (query || filter || sorted)) return [fileLink(row.file.path)];
  if (row.directory || row.file) {
    const path = row.directory || row.file!.path;
    const indentation = "  ".repeat(path.split("/").length - 1);
    const marker = row.directory ? folderOpen("dir:" + path, expanded, view === 2 && !!(query || filter)) ? "▾ " : "▸ " : "  ";
    return [indentation + (row.directory ? accent(marker) : marker) + (row.directory ? accent(basename(path)) : color(basename(path), "a9b7c6")) + (row.directory ? "/" : "")];
  }
  return [accent(row.label)];
}

function setSections(title: string, subtitle: string, next: Section[]): void {
  sections = next; sectionIndex = 0; selection = undefined; dragging = false;
  endDrag();
  itemHeader.setContent(`${accent(clip(title, Number(detailFrame.width) - 4))}\n${sliceStyled(strip(subtitle) === subtitle ? gray(subtitle) : subtitle, 0, Number(detailFrame.width) - 4)}`);
  sectionButtons.forEach(button => button.destroy()); sectionButtons.length = 0;
  let left = 0;
  sections.forEach((section, index) => {
    const button = blessed.button({ parent: sectionBar, mouse: true, height: 1, left, width: section.name.length + 2, content: ` ${section.name} ` });
    button.on("press", () => { if (prompt.visible) return; sectionIndex = index; void renderSection(); detail.focus(); });
    sectionButtons.push(button); left += section.name.length + 2;
  });
  sectionBar.hidden = sections.length < 2;
  detail.top = sections.length < 2 ? 2 : 4;
  void renderSection();
}

async function renderSection(): Promise<void> {
  if (view === 5) return;
  const version = ++generation;
  const section = sections[sectionIndex];
  verbatim = new Set(section?.verbatim || []);
  selection = undefined; endDrag();
  detailX = 0; sourceNumbers = undefined; sourceNotes.clear(); hoverLink = undefined;
  gutter.hide(); detail.left = 0;
  gutter.top = sections.length < 2 ? 2 : 4;
  detailVertical.top = sections.length < 2 ? 2 : 4;
  detailBase = 0;
  sectionButtons.forEach((button, index) => {
    button.style.fg = index === sectionIndex ? "cyan" : "gray";
    button.style.underline = index === sectionIndex;
  });
  setDetail(section?.text || "No entries.");
  if (!section?.source) return;
  try {
    await new Promise(accept => setTimeout(accept, 100));
    if (version !== generation) return;
    const preview = await run<SourcePreview>("source", ["--path", section.source.path, "--highlight"]);
    if (version !== generation) return;
    sourceNumbers = preview.lines.map(line => line.number);
    gutter.width = String(sourceNumbers.at(-1) || 1).length + 1;
    gutter.top = sections.length < 2 ? 2 : 4; gutter.show(); detail.left = Number(gutter.width) + 1;
    logicalLines = preview.lines.map(line => clean(line.text));
    styledLines = preview.lines.map(highlightSource);
    for (const finding of report?.findings || []) {
      if (finding.path !== section.source.path || !["warning", "error"].includes(finding.severity)) continue;
      const notes = sourceNotes.get(finding.line) || [];
      if (!notes.some(note => note.message === finding.message)) notes.push({ severity: finding.severity, message: finding.message });
      sourceNotes.set(finding.line, notes);
    }
    prepareDetail();
    const target = Math.max(0, section.source.line - 1);
    detailBase = Math.min(Math.max(0, visualRows.length - detailHeight()), Math.max(0, visualRows.findIndex(row => row.logical === target)));
    paintDetail(); screen.render();
  } catch (error) {
    if (version === generation) { setDetail(danger(`Preview unavailable: ${clean(error)}`)); }
  }
}

function displayWidth(text: string): number {
  let width = 0;
  for (const character of strip(text)) width += character === "\t" ? 4 - width % 4 : Number(detail.strWidth(character));
  return width;
}

function sliceStyled(text: string, left: number, width: number): string {
  let column = 0;
  let style = "";
  let output = "";
  let begun = false;
  for (const token of text.match(/\x1b\[[\d;]*m|[^\x1b]/gu) || []) {
    if (token.startsWith("\x1b")) {
      style += token;
      if (begun) output += token;
      continue;
    }
    const size = token === "\t" ? 4 - column % 4 : Number(detail.strWidth(token));
    if (column + size > left && column < left + width) {
      if (!begun) { output += style; begun = true; }
      output += token === "\t" ? " ".repeat(Math.min(column + size, left + width) - Math.max(column, left)) : token;
    }
    column += size;
    if (column >= left + width) break;
  }
  return (output || " ") + "\x1b[0m";
}

function highlightSource(line: SourceLine): string {
  const characters = Array.from(clean(line.text));
  const spans = [...line.spans].sort((a, b) => a.start - b.start);
  let index = 0;
  let previous = "";
  let text = "";
  for (let i = 0; i < characters.length; i++) {
    while (index < spans.length && spans[index].end <= i) index++;
    const kind = index < spans.length && spans[index].start <= i ? spans[index].kind : "plain";
    if (kind !== previous) {
      const hex = codeColors[kind] || "a9b7c6";
      text += color("", hex).replace(/\x1b\[39m$/, ""); previous = kind;
    }
    text += characters[i];
  }
  return text + "\x1b[39m";
}

function detailWidth(): number {
  return Math.max(1, Number(detail.width) - Number(detail.ileft) - detailGeometry.iright - 1);
}

function horizontalLimit(area: "list" | "detail"): number {
  const width = area === "detail" ? detailWidth() : Math.max(1, Number(list.width) - 4);
  return Math.max(0, (area === "detail" ? detailExtent : listExtent) - width);
}

function paintBar(bar: blessed.Widgets.BoxElement, offset: number, maximum: number, viewport: number, vertical = false): void {
  const length = Math.max(1, Number(vertical ? bar.height : bar.width));
  const thumb = Math.max(1, Math.floor(length * viewport / Math.max(1, maximum + viewport)));
  const start = maximum ? Math.round((length - thumb) * offset / maximum) : 0;
  const cells = Array.from({ length }, (_, i) => i >= start && i < start + thumb ? accent(vertical ? "█" : "━") : gray(vertical ? "│" : "─"));
  bar.setContent(cells.join(vertical ? "\n" : ""));
}

function prepareDetail(): void {
  visualRows = []; detailLinks = []; detailExtent = 0;
  const width = detailWidth();
  logicalLines.forEach((line, row) => {
    if (!sourceNumbers && pathPattern) {
      pathPattern.lastIndex = 0;
      for (const match of line.matchAll(pathPattern)) {
        const start = displayWidth(line.slice(0, match.index));
        detailLinks.push({ row, start, end: start + displayWidth(match[0]), path: match[0] });
      }
    }
    const notes = sourceNumbers ? sourceNotes.get(sourceNumbers[row]) : undefined;
    if (notes?.length) {
      const message = notes.map(note => note.message).join(" · ");
      const shade = notes.some(note => note.severity === "error") ? "41;37" : "43;30";
      const words = Array.from(clean(message));
      for (let first = 0; first < words.length; first += Math.max(1, width - 2)) {
        visualRows.push({ logical: row, start: 0, banner: true, severity: notes.some(note => note.severity === "error") ? "error" : "warning",
          text: `\x1b[${shade};1m ${words.slice(first, first + Math.max(1, width - 2)).join("").padEnd(width - 1)}\x1b[0m` });
      }
    }
    const styled = notes?.length ? `\x1b[4m${notes.some(note => note.severity === "error") ? color(line, "ff6b68") : warning(line)}\x1b[24m` : styledLines[row];
    const sensitive = !!sourceNumbers || verbatim.has(line) || detailLinks.some(link => link.row === row) || /\s{2,}\S|[A-Za-z]:[\\/]|(?:^|\s)[.@]?[\w-]+[\\/][^\s]+|^(?:\s*(?:(?:async\s+)?function |class |def |import |\{|\[|Recovery lines:))/.test(line);
    const total = displayWidth(line);
    if (sensitive || total <= width) {
      visualRows.push({ logical: row, start: 0, text: styled }); detailExtent = Math.max(detailExtent, total); return;
    }
    let start = 0;
    while (start < total) {
      const part = textAtColumns(line, start, start + width);
      const lastSpace = part.lastIndexOf(" ");
      const length = lastSpace > width / 2 ? displayWidth(part.slice(0, lastSpace + 1)) : Math.min(width, total - start);
      visualRows.push({ logical: row, start, text: sliceStyled(styled, start, length) });
      start += Math.max(1, length);
    }
    detailExtent = Math.max(detailExtent, width);
  });
}

function paintDetail(): void {
  detailX = Math.min(detailX, horizontalLimit("detail"));
  detail.setContent(visualRows.slice(detailBase, detailBase + detailHeight()).map(line => sliceStyled(line.text, line.banner ? 0 : detailX, detailWidth())).join("\n"));
  paintGutter();
  paintBar(detailBar, detailX, horizontalLimit("detail"), detailWidth());
  paintBar(detailVertical, detailBase, Math.max(0, visualRows.length - detailHeight()), detailHeight(), true);
}

function setDetail(text: string): void {
  styledLines = text.split("\n"); logicalLines = styledLines.map(strip);
  prepareDetail();
  paintDetail(); screen.render();
}

function paintGutter(): void {
  paintBar(detailVertical, detailBase, Math.max(0, visualRows.length - detailHeight()), detailHeight(), true);
  if (!sourceNumbers) return;
  gutter.setContent(visualRows.slice(detailBase, detailBase + detailHeight()).map(row => row.banner ? " " : String(sourceNumbers![row.logical]).padStart(Number(gutter.width) - 1)).join("\n"));
}

function listHeight(): number { return Math.max(1, Number(list.height) - Number(list.iheight)); }
function detailHeight(): number { return Math.max(1, Number(detail.height) - Number(detail.iheight)); }

function paintList(): void {
  listX = Math.min(listX, horizontalLimit("list"));
  const visible = listHeight();
  rebuilding = true;
  list.setItems(renderedRows.slice(listBase, listBase + visible).map(line => sliceStyled(line, listX, Math.max(1, Number(list.width) - 4))));
  list.childBase = 0; list.childOffset = 0; list.select(selectedRow - listBase);
  wireRows(); rebuilding = false;
  listVertical.setFront();
  paintBar(listBar, listX, horizontalLimit("list"), Number(list.width) - 4);
  paintBar(listVertical, listBase, Math.max(0, rows.length - visible), visible, true);
  if (view === 4 && rows.length && listBase + visible >= rows.length) void moreHistory();
}

function selectRow(index: number): void {
  const next = Math.max(0, Math.min(rows.length - 1, index));
  if (next < listBase) listBase = next;
  else if (next >= listBase + listHeight()) listBase = next - listHeight() + 1;
  if (next !== selectedRow) { selection = undefined; endDrag(); void show(next); }
  selectedRow = next; paintList();
  if (view === 4 && next >= rows.length - 1) void moreHistory();
  screen.render();
}

function pan(area: "list" | "detail", delta: number): void {
  if (area === "detail") { detailX = Math.max(0, Math.min(horizontalLimit(area), detailX + delta)); paintDetail(); }
  else { listX = Math.max(0, Math.min(horizontalLimit(area), listX + delta)); paintList(); }
  screen.render();
}

async function show(index: number): Promise<void> {
  const row = rows[index];
  selectedRow = index;
  activeFile = row?.file?.path || row?.symbol?.path || row?.finding?.path;
  if (view === 5) {
    itemHeader.setContent(`${accent(chart.path || basename(root))}\n${gray("● folders · files colored by language · lines / %")}`);
    chart.render(); return;
  }
  if (view === 0) { setSections(row?.section || "Overview", basename(root), [{ name: "Summary", text: overview(index) }]); return; }
  if (view === 6) { setSections("Revision comparison", comparison ? `${comparison.before.revision.slice(0, 12)} → ${comparison.after.revision.slice(0, 12)}` : "Press c to choose a base revision", [{ name: "Comparison", text: comparisonText() }]); return; }
  if (!row || !report) { setSections("No matching entries", "Clear the search or filter", [{ name: "Empty", text: "" }]); return; }
  if (row.group) {
    const findings = row.group.findings;
    const counts = new Map<string, number>();
    findings.forEach(finding => counts.set(finding.type, (counts.get(finding.type) || 0) + 1));
    setSections(row.group.name, "Enter or double-click to expand", [{ name: "Summary", text: pairs([
      ["Findings", findings.length], ["Files", new Set(findings.map(finding => finding.path)).size],
      ...[...counts].map<[string, unknown]>(([type, count]) => [type, count])]) }]);
    return;
  }
  if (row.directory) {
    const files = report.files.filter(f => f.path.startsWith(row.directory + "/") && (view !== 2 || f.symbols.length));
    setSections(row.directory + "/", "Enter or double-click to expand", [{ name: "Info", text: pairs([
      ["Files", files.length], ["Source files", files.filter(f => f.category === "source").length],
      ["Lines", files.reduce((sum, f) => sum + f.lines, 0)]]) }]);
  }
  if (row.file) {
    const f = row.file;
    const stateColor = f.status === "partial" ? warning : f.status === "parsed" ? (text: unknown) => color(text, "6a8759") : gray;
    setSections(f.path, `${color(f.language, "6897bb")} ${gray("· " + f.category + " ·")} ${stateColor(f.status)}`, [
      { name: "Info", text: fileLink(f.path) + "\n\n" + pairs([["Lines", f.lines], ["Functions", f.metrics.functions || 0], ["Classes", f.metrics.classes || 0],
        ["Cyclomatic", f.metrics.cyclomatic || 0], ["Fan-in / fan-out", `${f.metrics.fan_in} / ${f.metrics.fan_out}`],
        ["Dependency depth", f.metrics.dependency_depth], ["Internal-call ratio", f.metrics.cohesion], ["Hotspot score", f.metrics.hotspot]]) },
      { name: "Source", text: "Loading source…", source: { path: f.path, line: row.hit?.line || 1 } },
      { name: "Symbols", text: alignRows(f.symbols.map(s => [accent(s.line), clean(s.name)]))
        .map((line, i) => `${line}\n${gray(f.symbols[i].signature)}`).join("\n\n") || "No extracted symbols.", verbatim: f.symbols.map(s => clean(s.signature)) },
      { name: "Imports", text: alignRows(f.imports.map(i => [gray(i.line), color(i.target, "6a8759")])).join("\n") || gray("No parsed imports.") },
      { name: "Churn", text: pairs([["Commits in window", f.churn.commits], ["Lines added", f.churn.added], ["Lines removed", f.churn.removed]]) },
    ]);
  }
  if (row.symbol) {
    const s = row.symbol;
    const incoming = report.symbol_edges.filter(e => e.target === s.id);
    const outgoing = report.symbol_edges.filter(e => e.source === s.id);
    setSections(s.name, `${s.path}:${s.line} · ${s.confidence} confidence`, [
      { name: "Info", text: fileLink(s.path) + "\n\n" + color(s.signature, "ffc66d") + "\n\n" + pairs([["Kind", s.kind], ["Lines", s.metrics?.lines],
        ["Cyclomatic", s.metrics?.cyclomatic], ["Cognitive", s.metrics?.cognitive], ["Nesting", s.metrics?.nesting],
        ["Fan-in / fan-out", `${s.structural.fan_in} / ${s.structural.fan_out}`]]), verbatim: [clean(s.signature)] },
      { name: "Source", text: "Loading source…", source: { path: s.path, line: s.line } },
      { name: "Calls", text: `${accent("Called by")}\n${incoming.map(e => `${reference(e.source)} ${gray(e.confidence)}`).join("\n") || "None resolved"}\n\n${accent("Calls")}\n${outgoing.map(e => `${reference(e.target)} ${gray(e.confidence)}`).join("\n") || "None resolved"}` },
    ]);
  }
  if (row.finding) {
    const f = row.finding;
    const severityColor = f.severity === "error" ? danger : f.severity === "warning" ? warning : accent;
    setSections(f.path + ":" + f.line, `${severityColor(f.severity)} ${gray("· " + f.type + " · " + f.confidence + " confidence")}`, [
      { name: "Evidence", text: `${fileLink(f.path)}\n\n${severityColor(f.message)}\n\n${f.evidence.map(reference).join("\n")}` },
      { name: "Source", text: "Loading source…", source: { path: f.path, line: f.line } },
    ]);
  }
  if (row.commit) setSections(row.commit.subject, row.commit.date.slice(0, 10), [
    { name: "Commit", text: color(row.commit.revision, "ffc66d") + "\n\n" + color(row.commit.subject, "a9b7c6") + "\n\n" + gray("Enter or double-click to compare with the current revision."), verbatim: [row.commit.revision] },
    { name: "Branches", text: report.history.branches.map(accent).join("\n") || gray("No branches.") },
  ]);
}

function fileLink(path: string): string {
  return color(path, "6897bb");
}

function reference(value: string): string {
  const location = /^(.*):(\d+):\d+$/.exec(value);
  const path = location?.[1] || value;
  return fileMap.has(path) ? fileLink(path) + (location ? gray(":" + location[2]) : "") : color(value, "a9b7c6");
}

async function openFile(path: string): Promise<void> {
  const uri = pathToFileURL(resolve(root, path)).href;
  const script = `Start-Process -FilePath '${fileURLToPath(uri).replace(/'/g, "''")}'`;
  const command = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] : [uri];
  try {
    await new Promise<void>((accept, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
      children.add(child); child.on("error", reject);
      child.on("close", code => { children.delete(child); code === 0 ? accept() : reject(new Error(`File opener exited with status ${code}`)); });
    });
    status = `Opened ${path}`;
  } catch (error) { status = `Error opening file: ${clean(error)}`; }
  renderHeader();
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
    const width = character === "\t" ? 4 - column % 4 : Number(detail.strWidth(character));
    included = width === 0 ? included : column + width > from && column < to;
    if (included) result += character;
    column += width;
  }
  return result;
}

function selectedText(): string {
  const range = selectionRange();
  if (!range) return "";
  let text = "";
  for (let row = range.start.row; row <= range.end.row; row++) {
    const from = row === range.start.row ? range.start.column : 0;
    const to = row === range.end.row ? range.end.column + 1 : Infinity;
    text += textAtColumns(logicalLines[row] || "", from, to);
    if (row < range.end.row) text += "\n";
  }
  return text;
}

function point(data: Mouse) {
  const position = detail.lpos;
  if (!position) return { row: 0, column: 0 };
  const y = Math.max(position.yi + Number(detail.itop), Math.min(position.yl - detailGeometry.ibottom - 1, data.y));
  const visual = visualRows[Math.max(0, y - position.yi - Number(detail.itop) + detailBase)];
  if (visual?.banner) return { row: visual.logical, column: 0 };
  return { row: visual?.logical || 0,
    column: Math.max(0, (visual?.start || 0) + detailX + Math.min(detailWidth() - 1, Math.max(0, data.x - position.xi - Number(detail.ileft)))) };
}

function linkAt(data: Mouse) {
  if (sourceNumbers || !inside(data, detail)) return undefined;
  const position = point(data);
  return detailLinks.find(link => link.row === position.row && position.column >= link.start && position.column < link.end);
}

detail.removeAllListeners("mousedown");
detail.on("mousedown", (data: Mouse) => {
  if (prompt.visible) return;
  if (data.button === "right") { detail.focus(); void copyCurrent(); return; }
  if (data.button !== "left") return;
  if (data.ctrl && linkAt(data)) return;
  const pos = detail.lpos;
  if (!pos || data.x >= pos.xl - detailGeometry.iright - 1) return;
  const visual = visualRows[Math.max(0, data.y - pos.yi - Number(detail.itop) + detailBase)];
  if (visual?.banner) { selection = undefined; endDrag(); detail.focus(); screen.render(); return; }
  detail.focus(); dragging = true;
  endDrag(); dragging = true;
  lastPointer = data;
  selection = { anchor: point(data), end: point(data) }; screen.render();
  dragTimer = setInterval(() => {
    if (!dragging || !lastPointer || !detail.lpos) return;
    const pos = detail.lpos;
    if (lastPointer.y < pos.yi + Number(detail.itop)) setVertical("detail", detailBase - 1);
    else if (lastPointer.y >= pos.yl - detailGeometry.ibottom) setVertical("detail", detailBase + 1);
    if (lastPointer.x < pos.xi + Number(detail.ileft)) pan("detail", -1);
    else if (lastPointer.x >= pos.xi + Number(detail.ileft) + detailWidth()) pan("detail", 1);
    if (selection) selection.end = point(lastPointer);
    screen.render();
  }, 100);
});
screen.program.on("mouse", (data: Mouse) => {
  if (prompt.visible) return;
  if (data.action === "mousemove" && !dragging && !scrollDrag) {
    const link = linkAt(data);
    if (link !== hoverLink) { hoverLink = link; screen.render(); }
  }
  if (scrollDrag) {
    if (data.action === "mousemove" || data.action === "mouseup") {
      dragScrollbar(data);
      if (data.action === "mouseup") scrollDrag = undefined;
    }
    return;
  }
  if (data.action === "mousedown" && data.button === "left") {
    for (const area of ["list", "detail"] as const) {
      const widget = area === "list" ? list : detail;
      for (const horizontal of [true, false]) {
        const bar = horizontal ? area === "list" ? listBar : detailBar : area === "list" ? listVertical : detailVertical;
        if (!bar.visible || !inside(data, bar) || !bar.lpos) continue;
        const viewport = horizontal ? area === "detail" ? detailWidth() : Number(list.width) - 4 : area === "detail" ? detailHeight() : listHeight();
        const maximum = horizontal ? horizontalLimit(area) : Math.max(0, (area === "detail" ? visualRows.length : rows.length) - viewport);
        const length = horizontal ? bar.lpos.xl - bar.lpos.xi : bar.lpos.yl - bar.lpos.yi;
        const thumb = Math.max(1, Math.floor(length * viewport / Math.max(1, maximum + viewport)));
        const offset = horizontal ? area === "detail" ? detailX : listX : area === "detail" ? detailBase : listBase;
        const start = maximum ? Math.round((length - thumb) * offset / maximum) : 0;
        const position = horizontal ? data.x - bar.lpos.xi : data.y - bar.lpos.yi;
        const grab = position >= start && position < start + thumb ? position - start : thumb / 2;
        endDrag(); scrollDrag = { area, horizontal, grab }; dragScrollbar(data); return;
      }
    }
  }
  if (data.action.startsWith("wheel")) {
    const area = inside(data, list) ? "list" : inside(data, detailFrame) ? "detail" : undefined;
    if (!area || (view === 5 && area === "detail")) return;
    const forward = data.action === "wheeldown" || data.action === "wheelright";
    if (data.shift || data.action === "wheelright" || data.action === "wheelleft") pan(area, forward ? 1 : -1);
    else if (area === "list") selectRow(selectedRow + (forward ? 1 : -1));
    else { setVertical(area, detailBase + (forward ? 1 : -1)); screen.render(); }
    if (dragging && selection) { selection.end = point(lastPointer || data); screen.render(); }
    return;
  }
  if (!dragging) return;
  if (data.action === "mousemove" || data.action === "mouseup") {
    lastPointer = data;
    if (selection) selection.end = point(data);
    if (data.action === "mouseup") endDrag();
    screen.render();
  }
});
detail.on("render", () => {
  const range = selectionRange();
  const pos = detail.lpos;
  if (!range || !pos || prompt.visible) return;
  const buffer = (screen as typeof screen & { lines: (Array<[number, string]> & { dirty: boolean })[] }).lines;
  const scroll = detailBase;
  for (let y = pos.yi + Number(detail.itop); y < pos.yl - detailGeometry.ibottom; y++) {
    const visual = visualRows[y - pos.yi - Number(detail.itop) + scroll];
    if (!visual || visual.banner) continue;
    const row = visual.logical;
    if (row < range.start.row || row > range.end.row) continue;
    const left = pos.xi + Number(detail.ileft);
    const start = Math.max(left, left + (row === range.start.row ? range.start.column : 0) - visual.start - detailX);
    const end = row === range.end.row ? left + range.end.column + 1 - visual.start - detailX : pos.xl - detailGeometry.iright - 1;
    for (let x = start; x < Math.min(end, left + displayWidth(visual.text) - detailX, pos.xl - detailGeometry.iright - 1); x++) {
      const cell = buffer[y]?.[x];
      if (cell) { cell[0] = (cell[0] & ~((8 << 18) | 0x3ffff)) | (7 << 9) | 4; buffer[y].dirty = true; }
    }
  }
});
detail.on("render", () => {
  if (!hoverLink || !detail.lpos) return;
  const pos = detail.lpos;
  const buffer = (screen as typeof screen & { lines: (Array<[number, string]> & { dirty: boolean })[] }).lines;
  visualRows.slice(detailBase, detailBase + detailHeight()).forEach((row, index) => {
    if (row.logical !== hoverLink!.row || row.banner) return;
    const left = pos.xi + Number(detail.ileft);
    const y = pos.yi + Number(detail.itop) + index;
    for (let x = Math.max(left, left + hoverLink!.start - row.start - detailX); x < Math.min(left + detailWidth(), left + hoverLink!.end - row.start - detailX); x++) {
      const cell = buffer[y]?.[x]; if (cell) { cell[0] |= 2 << 18; buffer[y].dirty = true; }
    }
  });
});
detail.on("render", () => {
  if (!detail.lpos) return;
  const pos = detail.lpos;
  const buffer = (screen as typeof screen & { lines: (Array<[number, string]> & { dirty: boolean })[] }).lines;
  visualRows.slice(detailBase, detailBase + detailHeight()).forEach((row, index) => {
    if (!row.banner) return;
    const y = pos.yi + Number(detail.itop) + index;
    const attribute = (1 << 18) | (row.severity === "error" ? (7 << 9) | 1 : 3);
    for (let x = pos.xi + Number(detail.ileft); x < pos.xi + Number(detail.ileft) + detailWidth(); x++) {
      const cell = buffer[y]?.[x]; if (cell) { cell[0] = attribute; buffer[y].dirty = true; }
    }
  });
});

function endDrag(): void {
  dragging = false;
  if (dragTimer) { clearInterval(dragTimer); dragTimer = undefined; }
}

function inside(data: Mouse, widget: blessed.Widgets.BoxElement): boolean {
  const pos = widget.lpos;
  return !!pos && widget.visible && data.x >= pos.xi && data.x < pos.xl && data.y >= pos.yi && data.y < pos.yl;
}

function setVertical(area: "list" | "detail", offset: number): void {
  const widget = area === "list" ? list : detail;
  const visible = area === "list" ? listHeight() : detailHeight();
  const count = area === "list" ? rows.length : visualRows.length;
  const next = Math.max(0, Math.min(Math.max(0, count - visible), offset));
  if (area === "list") { listBase = next; selectRow(next); }
  else { detailBase = next; paintDetail(); }
}

function dragScrollbar(data: Mouse): void {
  if (!scrollDrag) return;
  const { area, horizontal } = scrollDrag;
  const widget = area === "list" ? list : detail;
  const bar = horizontal ? area === "list" ? listBar : detailBar : area === "list" ? listVertical : detailVertical;
  const pos = bar.lpos;
  if (!pos) return;
  if (horizontal) {
    const maximum = horizontalLimit(area);
    const viewport = area === "detail" ? detailWidth() : Number(list.width) - 4;
    const width = pos.xl - pos.xi;
    const thumb = Math.max(1, Math.floor(width * viewport / Math.max(1, maximum + viewport)));
    const fraction = Math.max(0, Math.min(1, (data.x - pos.xi - (scrollDrag.grab || 0)) / Math.max(1, width - thumb)));
    const next = Math.round(fraction * horizontalLimit(area));
    pan(area, next - (area === "list" ? listX : detailX));
  } else {
    const visible = area === "list" ? listHeight() : detailHeight();
    const count = area === "list" ? rows.length : visualRows.length;
    const length = pos.yl - pos.yi;
    const thumb = Math.max(1, Math.floor(length * visible / Math.max(1, count)));
    const fraction = Math.max(0, Math.min(1, (data.y - pos.yi - (scrollDrag.grab || 0)) / Math.max(1, length - thumb)));
    setVertical(area, Math.round(fraction * Math.max(0, count - visible))); screen.render();
  }
}

for (const widget of [list, detail]) {
  widget.removeAllListeners("wheelup"); widget.removeAllListeners("wheeldown");
  widget.removeAllListeners("element wheelup"); widget.removeAllListeners("element wheeldown");
}
list.removeAllListeners("mousedown");

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

async function readClipboard(): Promise<string> {
  const commands: [string, string[]][] = process.platform === "win32"
    ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $value = Get-Clipboard -Raw; [Console]::Write($value)"]]]
    : process.platform === "darwin" ? [["pbpaste", []]] : [["wl-paste", ["--no-newline"]], ["xclip", ["-selection", "clipboard", "-o"]]];
  let failure: unknown;
  for (const [command, args] of commands) {
    try {
      return await new Promise<string>((accept, reject) => {
        const child = spawn(command, args, { windowsHide: true }); children.add(child);
        let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", data => output += data);
        child.on("error", reject); child.on("close", code => { children.delete(child); code === 0 ? accept(output) : reject(new Error("Clipboard paste unavailable")); });
      });
    } catch (error) { failure = error; }
  }
  throw failure;
}

async function moreHistory(): Promise<void> {
  if (!report || historyLoading || historyDone || !historyHead) return;
  const owner = report, offset = owner.history.commits.length;
  historyLoading = true; status = `Loading history after ${offset} commits…`; renderHeader();
  try {
    const page = await run<{ commits: Commit[] }>("history", ["--offset", String(offset), "--history-limit", "100"], historyHead);
    if (report !== owner) return;
    const seen = new Set(owner.history.commits.map(commit => commit.revision));
    owner.history.commits.push(...page.commits.filter(commit => !seen.has(commit.revision)));
    historyDone = page.commits.length < 100;
    if (view === 4) { status = `${owner.history.commits.length} commits loaded${historyDone ? " · end of history" : ""}`; rebuild(undefined, selectedRow); }
  } catch (error) { if (view === 4) status = `Error loading history: ${clean(error)}`; }
  finally { historyLoading = false; renderHeader(); }
}

async function search(answer: string): Promise<void> {
  const version = ++searchVersion;
  query = answer; sourceHits.clear(); closedFolders.clear();
  if (!rgAvailable || revision || !answer) { rebuild(); return; }
  status = "Searching source with ripgrep…"; renderHeader();
  try {
    const hits = await new Promise<Map<string, { line: number; text: string }[]>>((accept, reject) => {
      const matches = new Map<string, { line: number; text: string }[]>();
      const child = spawn("rg", ["--json", "--fixed-strings", "--ignore-case", "--", answer, "."], { cwd: root, windowsHide: true });
      child.stdout.setEncoding("utf8");
      children.add(child); let pending = "", errors = "";
      child.stdout.on("data", data => {
        pending += data.toString(); const lines = pending.split("\n"); pending = lines.pop() || "";
        for (const line of lines) {
          const event = JSON.parse(line);
          if (event.type !== "match" || !event.data.path.text) continue;
          const path = event.data.path.text.replace(/\\/g, "/").replace(/^\.\//, "");
          if (!fileMap.has(path)) continue;
          const fileHits = matches.get(path) || [];
          fileHits.push({ line: event.data.line_number, text: clean(event.data.lines.text).trimEnd() }); matches.set(path, fileHits);
        }
      });
      child.stderr.on("data", data => errors += data.toString());
      child.on("error", reject); child.on("close", code => {
        children.delete(child);
        if (code === 0 || code === 1) accept(matches); else reject(new Error(errors || "ripgrep search failed"));
      });
    });
    if (version !== searchVersion) return;
    sourceHits = hits; view = 1; listBase = 0;
    const count = [...hits.values()].reduce((sum, values) => sum + values.length, 0);
    status = `${count} source matches · ripgrep`;
    rebuild(); list.focus();
  } catch (error) { if (version === searchVersion) { status = `Error searching: ${clean(error)}`; rebuild(); } }
}

async function copyCurrent(row?: Row): Promise<void> {
  const item = row || rows[selectedRow];
  const copiedSelection = selection;
  const hasSelection = !!selectionRange();
  const picked = selectedText();
  const text = !row && screen.focused === chart.box ? chart.copyText() : !row && hasSelection ? picked : !row && screen.focused === detail
    ? logicalLines.join("\n") : item?.symbol?.signature || item?.file?.path || item?.finding?.message
      || item?.commit?.revision || item?.directory || item?.label || logicalLines.join("\n");
  if (!text) { status = "Nothing to copy"; renderHeader(); return; }
  try {
    await clipboard(text);
    if (selection === copiedSelection) { selection = undefined; endDrag(); }
    status = `Copied ${Array.from(text).length} characters${picked && !row ? " from selection" : ""}`;
  } catch (error) { status = `Error copying: ${clean(error)}`; }
  renderHeader();
}

function switchView(index: number): void {
  if (prompt.visible) return;
  view = index; query = ""; filter = ""; sourceHits.clear(); searchVersion++; listBase = 0; listX = 0; selection = undefined; endDrag();
  rebuild(); view === 6 ? detail.focus() : list.focus();
}

function wireRows(): void {
  for (const item of listItems.items) {
  item.removeAllListeners("click"); item.removeAllListeners("mousedown");
  item.on("mousedown", (data: Mouse) => {
    if (data.button !== "right" || prompt.visible) return;
    const index = listBase + listItems.items.indexOf(item); selectRow(index); list.focus();
    void copyCurrent(rows[index]);
  });
  item.on("click", (data: Mouse) => {
    if (data.button !== "left") return;
    if (prompt.visible) return;
    const index = listBase + listItems.items.indexOf(item);
    selectRow(index); list.focus(); selection = undefined; endDrag();
    const now = Date.now();
    if (lastClick.row === index && now - lastClick.time < 350) activateRow();
    lastClick = { row: index, time: now }; screen.render();
  });
  }
}

let fileClick = { location: "", time: 0 };
detail.on("click", (data: Mouse) => {
  if (data.button !== "left" || prompt.visible) return;
  const link = linkAt(data);
  if (!link) return;
  const now = Date.now();
  if (data.ctrl || (fileClick.location === link.path && now - fileClick.time < 350)) { selection = undefined; endDrag(); void openFile(link.path); }
  fileClick = { location: link.path, time: now };
});

async function action(operation: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try { await operation(); }
  catch (error) { status = `Error: ${clean(error instanceof Error ? error.message : error)}`; }
  finally { busy = false; renderHeader(); }
}

async function refresh(): Promise<void> {
  searchVersion++;
  status = "Analyzing…"; renderHeader();
  const next = await run<Report>("scan");
  report = next;
  fileMap = new Map(next.files.map(file => [file.path, file]));
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  pathPattern = fileMap.size ? new RegExp([...fileMap.keys()].sort((a, b) => b.length - a.length).map(escape).join("|"), "g") : undefined;
  symbolChildren = new Map();
  for (const symbol of next.files.flatMap(file => file.symbols)) {
    if (!symbol.parent) continue;
    const children = symbolChildren.get(symbol.parent) || []; children.push(symbol); symbolChildren.set(symbol.parent, children);
  }
  chart.setFiles(next.files); sourceHits.clear(); historyDone = false;
  historyHead = next.history.commits[0]?.revision;
  status = `${next.files.length} files · ${next.incremental.analyzed} analyzed · ${next.incremental.cached} cached · ${next.revision.slice(0, 12)}`;
  comparison = undefined;
  rebuild();
}

function ask(label: string, initial: string, callback: (answer: string) => void): void {
  if (busy) return;
  endDrag(); scrollDrag = undefined;
  dialog.ask(label, initial, answer => {
    if (typeof answer === "string") callback(answer.trim());
    screen.render();
  });
}

async function compareWith(base: string): Promise<void> {
  status = `Comparing ${clean(base)}…`; renderHeader();
  comparison = await run<Comparison>("compare", ["--base", base]);
  view = 6; status = "Comparison complete"; rebuild();
}

function activateRow(): void {
  const row = rows[selectedRow];
  if (!row || !report) return;
  if (view === 5) { if (row.directory) { chart.setPath(row.directory); rebuild(); } else if (row.file) { view = 1; query = row.file.path; rebuild(); } }
  else if (row.group) { toggleFolder(row.group.key, issueExpanded, !!(query || filter)); rebuild(undefined, selectedRow); }
  else if (view === 2 && row.file) { toggleFolder("file:" + row.file.path, symbolExpanded, !!(query || filter)); rebuild(undefined, selectedRow); }
  else if (row.branch && row.symbol) { toggleFolder(row.symbol.id, symbolExpanded, !!(query || filter)); rebuild(undefined, selectedRow); }
  else if (row.directory) { const key = "dir:" + row.directory; const open = folderOpen(key, expanded, view === 2 && !!(query || filter)); if (open) { expanded.delete(row.directory); closedFolders.add(key); } else { expanded.add(row.directory); closedFolders.delete(key); } rebuild(row.directory); }
  else if (row.commit) void action(() => compareWith(row.commit!.revision));
  else if (row.file) { if (!row.file.symbols.length) { detail.focus(); return; } query = row.file.path; filter = ""; closedFolders.clear(); view = 2; rebuild(); const index = rows.findIndex(item => item.file?.path === row.file!.path); if (index >= 0) selectRow(index); }
  else detail.focus();
}

list.removeAllListeners("select item"); list.removeAllListeners("select");
function clearStatus(): void {
  if (!status || busy) return;
  status = ""; renderHeader();
}
screen.on("keypress", () => { if (!prompt.visible) clearStatus(); });
screen.program.on("mouse", (data: Mouse) => {
  if (!prompt.visible && (data.action === "mousedown" || data.action.startsWith("wheel"))) clearStatus();
});
for (const pane of [list, detail, chart.box]) pane.on("focus", () => {
  list.style.border.fg = screen.focused === list ? "blue" : "gray";
  detailFrame.style.border.fg = screen.focused === detail || screen.focused === chart.box ? "blue" : "gray";
  screen.render();
});
screen.key(["up", "down", "j", "k", "pageup", "pagedown", "home", "end"], (_character, key) => {
  if (screen.focused === chart.box) return;
  const direction = ["up", "k", "pageup", "home"].includes(key.name) ? -1 : 1;
  const amount = key.name.startsWith("page") ? screen.focused === list || screen.focused === chart.box ? listHeight() : detailHeight() : 1;
  if (screen.focused === list || screen.focused === chart.box) selectRow(key.name === "home" ? 0 : key.name === "end" ? rows.length - 1 : selectedRow + direction * amount);
  else { setVertical("detail", key.name === "home" ? 0 : key.name === "end" ? visualRows.length : detailBase + direction * amount); screen.render(); }
});
screen.key("enter", () => { if (screen.focused === list) activateRow(); });
screen.key("q", () => { for (const child of children) stopChild(child); screen.destroy(); process.exit(0); });
screen.key("C-c", () => { void copyCurrent(); });
screen.key("escape", () => { selection = undefined; endDrag(); scrollDrag = undefined; (view === 6 ? detail : list).focus(); screen.render(); });
screen.key(["tab"], () => { view === 6 ? detail.focus() : screen.focused === list ? (view === 5 ? chart.box : detail).focus() : list.focus(); });
for (let i = 0; i < views.length; i++) screen.key(String(i + 1), () => switchView(i));
screen.key(["left", "right", "S-left", "S-right"], (_character, key) => { if (screen.focused !== chart.box) pan(screen.focused === list ? "list" : "detail", (key.name === "left" ? -1 : 1) * (key.shift ? 10 : 1)); });
screen.key("o", () => { if (activeFile) void openFile(activeFile); });
screen.on("keypress", (character, key) => {
  if (prompt.visible || key.ctrl || key.meta || !["[", "]"].includes(character || key.full)) return;
  if (view === 5) return;
  const direction = character === "[" || key.full === "[" ? -1 : 1;
  if (sections.length < 2) { if (rows.length) selectRow((selectedRow + direction + rows.length) % rows.length); return; }
  sectionIndex = (sectionIndex + direction + sections.length) % sections.length;
  void renderSection();
});
screen.key("v", () => { if (view === 5) return; const index = sections.findIndex(section => section.source); if (index >= 0) { sectionIndex = index; detail.focus(); void renderSection(); } });
screen.key("/", () => ask(rgAvailable && !revision ? "Search names, paths and source (ripgrep)" : "Search names and paths", query, answer => { void search(answer); }));
screen.key("f", () => ask("Filter: language/category/status, symbol kind, finding type/severity (empty clears)", filter, answer => { filter = answer; closedFolders.clear(); rebuild(); }));
screen.key("s", () => { sorted = !sorted; rebuild(); });
screen.key("l", () => { if (view === 5) { chart.setPath(""); rebuild(); } });
screen.key("backspace", () => { if (view === 5) { chart.setPath(chart.path.split("/").slice(0, -1).join("/")); rebuild(); } });
screen.key("r", () => { void action(refresh); });
screen.key("b", () => ask("Commit or branch (empty = working tree)", revision || "", answer => { void action(async () => {
  const previous = revision; revision = answer || undefined;
  try { await refresh(); } catch (error) { revision = previous; throw error; }
}); }));
screen.key("c", () => ask("Compare base commit/branch with current analysis", "HEAD", answer => { if (answer) void action(() => compareWith(answer)); }));
screen.key("e", () => {
  if (busy) return;
  endDrag(); scrollDrag = undefined;
  dialog.choose("Export JSON layout", [{ label: "Single JSON", value: "json" }, { label: "Grouped folder", value: "json-folder" }], format => {
    if (!format) return;
    ask(format === "json" ? "Export JSON report to file" : "Export grouped JSON files to folder", resolve(root, format === "json" ? ".repolens/report.json" : ".repolens/report"), answer => {
      if (answer) void action(async () => {
        const result = await run<{ output: string }>("export", ["--format", format, "--output", resolve(answer)]); status = `Exported ${result.output}`;
      });
    });
  });
});
screen.key("g", () => ask("Generate managed architecture section in root README.md? Type yes", "", answer => { if (answer === "yes") void action(async () => {
  const result = await run<{ output: string }>("readme"); status = `Updated ${result.output}`;
}); }));
screen.key("?", () => { if (view === 5) switchView(0); setSections("Commands", "Mouse and keyboard", [{ name: "Help", text:
  pairs([["1–7 / click tab", "Switch view"], ["↑↓ / j k / click row", "Select item"], ["Enter", "Expand symbols/folders, inspect item"],
    ["Tab", "Focus list or detail"], ["← → / Shift+wheel", "Scroll horizontally"], ["Drag scrollbar", "Scroll vertically or horizontally"],
    ["[ ] / click detail tab", "Choose section; [ ] also move between entries with one section"], ["v", "Source preview"], ["Ctrl+click / double-click path", "Open local file"], ["Drag + wheel", "Select through scrollable content"],
    ["Ctrl+C / right-click", "Copy selected text, detail, or row"], ["Esc", "Clear selection and focus list"],
    ["/ · f · s", "Search · filter · sort"], ["Size: l / Backspace", "Root / parent directory"], ["History: End / scroll to last", "Load next 100 commits"], ["b · c · r", "Revision · comparison · rescan"],
    ["e · g", "Export JSON · managed README"], ["q", "Quit"]]) }]); detail.focus(); screen.render(); });
screen.on("resize", () => {
  const index = selectedRow;
  const name = sections[sectionIndex]?.name;
  selection = undefined; endDrag(); scrollDrag = undefined;
  rebuild(undefined, index);
  const next = sections.findIndex(section => section.name === name);
  if (next > 0) { sectionIndex = next; void renderSection(); }
});
screen.program.setMouse({ sgrMouse: true, allMotion: true }, true);
list.focus(); rebuild();
process.stdin.resume();
const rg = spawn("rg", ["--version"], { windowsHide: true, stdio: "ignore" });
rg.on("error", () => {}); rg.on("close", code => rgAvailable = code === 0);
void action(refresh);
