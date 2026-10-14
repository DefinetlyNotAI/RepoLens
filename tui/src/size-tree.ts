import blessed from "blessed";

interface SizeNode { path: string; lines: number; files: number; children: SizeNode[] }
interface DiagramRow { node: SizeNode; text: string }
const strip = (text: string) => text.replace(/\x1b\[[\d;]*m/g, "");
const tint = (text: unknown, index: number) => `\x1b[38;5;${index}m${String(text).replace(/[\x00-\x1f\x7f]/g, "")}\x1b[39m`;
const fileColors: Record<string, number> = { ts: 67, tsx: 67, js: 221, jsx: 221, py: 65, css: 103, scss: 103, json: 179, yaml: 109, yml: 109, html: 173, sql: 139 };

export function sizeTree(parent: blessed.Widgets.BoxElement, rootName: string,
  hover: (path: string, lines: number, files: number) => void, choose: (path: string, directory: boolean) => void, blocked: () => boolean) {
  const box = blessed.box({ parent, top: 2, bottom: 1, left: 1, right: 1, mouse: true, keys: true, hidden: true, wrap: false });
  const vertical = blessed.box({ parent: box, top: 0, bottom: 1, right: 0, width: 1, mouse: true });
  const horizontal = blessed.box({ parent: box, bottom: 0, left: 0, right: 1, height: 1, mouse: true });
  let root: SizeNode, current: SizeNode, nodes = new Map<string, SizeNode>(), rows: DiagramRow[] = [];
  let base = 0, left = 0, selected = 0, extent = 0, hovered: number | undefined;
  let drag: { horizontal: boolean; grab: number } | undefined;
  const height = () => Math.max(1, Number(box.height) - 1);
  const width = () => Math.max(1, Number(box.width) - 1);
  const strWidth = (text: string) => Number(box.strWidth(strip(text)));
  function rebuild() {
    if (!current) return;
    rows = []; base = 0; left = 0; selected = 0; hovered = undefined;
    const cells: { node: SizeNode; name: string; count: string; share: string }[] = [];
    const visit = (node: SizeNode, prefix: string, connector: string) => {
      const directory = node.children.length > 0;
      const name = node.path.split("/").at(-1) || rootName;
      const shade = directory ? 67 : fileColors[name.split(".").at(-1) || ""] || 146;
      const share = current.lines ? 100 * node.lines / current.lines : 0;
      cells.push({ node, name: `${tint(prefix + connector, 244)}${tint(directory ? "● " : "· ", shade)}${tint(name, shade)}`, count: tint(node.lines.toLocaleString(), 65), share: tint(share.toFixed(1) + "%", 179) });
      node.children.forEach((child, index) => {
        const last = index === node.children.length - 1;
        visit(child, prefix + (connector ? connector.startsWith("└") ? "   " : "│  " : ""), last ? "└─ " : "├─ ");
      });
    };
    visit(current, "", "");
    const nameWidth = cells.reduce((maximum, row) => Math.max(maximum, strWidth(row.name)), 0);
    const countWidth = cells.reduce((maximum, row) => Math.max(maximum, strWidth(row.count)), 0);
    rows = cells.map(row => ({ node: row.node, text: row.name + " ".repeat(nameWidth - strWidth(row.name) + 2) + row.count + " ".repeat(countWidth - strWidth(row.count) + 2) + tint("lines", 244) + "  " + row.share }));
    extent = rows.reduce((maximum, row) => Math.max(maximum, strWidth(row.text)), 0); render();
  }
  function clipped(text: string) {
    let column = 0, output = "", style = "", started = false;
    for (const token of text.match(/\x1b\[[\d;]*m|[^\x1b]/gu) || []) {
      if (token.startsWith("\x1b")) { style += token; if (started) output += token; continue; }
      const size = strWidth(token);
      if (column + size > left && column < left + width()) { if (!started) { output += style; started = true; } output += token; }
      column += size; if (column >= left + width()) break;
    }
    return (output || " ") + "\x1b[0m";
  }
  function bar(target: blessed.Widgets.BoxElement, offset: number, count: number, viewport: number, upright: boolean) {
    const length = Math.max(1, Number(upright ? target.height : target.width));
    const thumb = Math.max(1, Math.floor(length * viewport / Math.max(viewport, count)));
    const start = count > viewport ? Math.round((length - thumb) * offset / (count - viewport)) : 0;
    target.setContent(Array.from({ length }, (_, i) => tint(i >= start && i < start + thumb ? upright ? "█" : "━" : upright ? "│" : "─", i >= start && i < start + thumb ? 6 : 244)).join(upright ? "\n" : ""));
  }
  function render() {
    if (!current || !box.visible) return;
    base = Math.max(0, Math.min(base, Math.max(0, rows.length - height())));
    left = Math.max(0, Math.min(left, Math.max(0, extent - width())));
    box.setContent(rows.slice(base, base + height()).map((row, index) => {
      const active = hovered === base + index || box.screen.focused === box && selected === base + index;
      return (active ? "\x1b[4m" : "") + clipped(row.text);
    }).join("\n"));
    bar(vertical, base, rows.length, height(), true); bar(horizontal, left, extent, width(), false);
  }
  function hit(data: { x: number; y: number }) {
    if (!box.lpos || data.x >= box.lpos.xl - 1 || data.y >= box.lpos.yl - 1) return undefined;
    const index = base + data.y - box.lpos.yi; return index >= 0 && index < rows.length ? index : undefined;
  }
  function describe(index: number) { const node = rows[index]?.node; if (node) hover(node.path || rootName, node.lines, node.files); }
  function activate(index: number) {
    const node = rows[index]?.node; if (!node) return;
    if (node === current && node.path) choose(node.path.split("/").slice(0, -1).join("/"), true);
    else choose(node.path, node.children.length > 0);
  }
  box.on("mousemove", (data: blessed.Widgets.Events.IMouseEventArg) => {
    if (blocked() || drag) return; const index = hit(data);
    if (index === hovered) return; hovered = index;
    describe(index ?? selected); render(); box.screen.render();
  });
  box.on("mouseout", () => { if (blocked()) return; hovered = undefined; describe(selected); render(); box.screen.render(); });
  box.on("click", (data: blessed.Widgets.Events.IMouseEventArg & { button?: string }) => {
    if (blocked() || data.button !== "left" || drag) return;
    const index = hit(data); if (index === undefined) return; selected = index; box.focus(); activate(index);
  });
  for (const [event, direction] of [["wheelup", -1], ["wheeldown", 1]] as const) box.on(event, () => { if (blocked()) return; base += direction; render(); box.screen.render(); });
  box.on("keypress", (_character: string, key: blessed.Widgets.Events.IKeyEventArg) => {
    if (blocked()) return;
    if (key.name === "left" || key.name === "right") left += (key.name === "left" ? -1 : 1) * (key.shift ? 10 : 1);
    else if (key.name === "enter") { activate(selected); return; }
    else if (["up", "down", "j", "k", "pageup", "pagedown", "home", "end"].includes(key.name)) {
      const direction = ["up", "k", "pageup"].includes(key.name) ? -1 : 1;
      selected = key.name === "home" ? 0 : key.name === "end" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, selected + direction * (key.name.startsWith("page") ? height() : 1)));
      if (selected < base) base = selected; else if (selected >= base + height()) base = selected - height() + 1;
      hovered = undefined; describe(selected);
    }
    render(); box.screen.render();
  });
  function move(data: { x: number; y: number }) {
    if (!drag) return;
    const target = drag.horizontal ? horizontal : vertical, pos = target.lpos; if (!pos) return;
    const viewport = drag.horizontal ? width() : height(), count = drag.horizontal ? extent : rows.length;
    const length = drag.horizontal ? pos.xl - pos.xi : pos.yl - pos.yi;
    const thumb = Math.max(1, Math.floor(length * viewport / Math.max(viewport, count)));
    const fraction = Math.max(0, Math.min(1, ((drag.horizontal ? data.x - pos.xi : data.y - pos.yi) - drag.grab) / Math.max(1, length - thumb)));
    const offset = Math.round(fraction * Math.max(0, count - viewport));
    if (drag.horizontal) left = offset; else base = offset; render(); box.screen.render();
  }
  for (const [target, across] of [[horizontal, true], [vertical, false]] as const) target.on("mousedown", (data: blessed.Widgets.Events.IMouseEventArg & { button?: string }) => {
    if (blocked() || data.button !== "left" || !target.lpos) return;
    const viewport = across ? width() : height(), count = across ? extent : rows.length;
    const length = across ? Number(target.width) : Number(target.height);
    const thumb = Math.max(1, Math.floor(length * viewport / Math.max(viewport, count)));
    const start = count > viewport ? Math.round((length - thumb) * (across ? left : base) / (count - viewport)) : 0;
    const position = across ? data.x - target.lpos.xi : data.y - target.lpos.yi;
    drag = { horizontal: across, grab: position >= start && position < start + thumb ? position - start : thumb / 2 }; move(data);
  });
  box.screen.program.on("mouse", (data: blessed.Widgets.Events.IMouseEventArg) => {
    if (!drag) return;
    if (!box.visible || blocked()) { drag = undefined; return; }
    if (data.action === "mousemove" || data.action === "mouseup") { move(data); if (data.action === "mouseup") drag = undefined; }
  });
  return { box, render,
    copyText() { const node = rows[hovered ?? selected]?.node || current; return `${node.path || rootName}\n${node.lines} lines\n${node.files} files`; },
    get path() { return current?.path || ""; }, children() { return current?.children || []; },
    setPath(path: string) { current = nodes.get(path) || root; rebuild(); },
    setFiles(files: { path: string; lines: number }[]) {
      const make = (path: string): SizeNode => ({ path, lines: 0, files: 0, children: [] });
      root = make(""); nodes = new Map([["", root]]);
      for (const file of files) {
        const parts = file.path.split("/"); let parentNode = root;
        for (let i = 1; i <= parts.length; i++) {
          const path = parts.slice(0, i).join("/"); let node = nodes.get(path);
          if (!node) { node = make(path); nodes.set(path, node); parentNode.children.push(node); } parentNode = node;
        }
        parentNode.lines = file.lines; parentNode.files = 1;
      }
      function totals(node: SizeNode) {
        for (const child of node.children) { totals(child); node.lines += child.lines; node.files += child.files; }
        node.children.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
      }
      totals(root); current = root; rebuild();
    }
  };
}
