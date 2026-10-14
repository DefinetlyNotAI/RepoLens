import blessed from "blessed";

interface Node { path: string; lines: number; files: number; children: Node[]; start: number; end: number; depth: number; color: number }
const palette = [67, 65, 139, 173, 109, 179, 97, 72];

export function sunburst(parent: blessed.Widgets.BoxElement, rootName: string,
  hover: (path: string, lines: number, files: number) => void, choose: (path: string, directory: boolean) => void, blocked: () => boolean) {
  const box = blessed.box({ parent, top: 2, bottom: 1, left: 1, right: 2, mouse: true, keys: true, hidden: true });
  const coreLabel = blessed.box({ parent: box, top: "center", left: "center", height: 1, width: 5, align: "center", wrap: false, style: { fg: "white", bg: "gray" } });
  let root: Node, current: Node, nodes = new Map<string, Node>(), cells: (Node | undefined)[][] = [];
  let hovered: Node | undefined;
  function render() {
    if (!current || !box.visible) return;
    const width = Number(box.width), height = Number(box.height);
    const radius = Math.max(1, Math.min(width / 4, height / 2));
    const depth = [...nodes.values()].reduce((maximum, node) => node.path.startsWith(current.path ? current.path + "/" : "") ? Math.max(maximum, node.depth - current.depth) : maximum, 0);
    const levels = Math.max(1, Math.min(Math.floor(radius), depth + 1));
    const ring = radius / levels;
    coreLabel.width = Math.max(1, Math.floor(ring * 4) - 1);
    coreLabel.setContent((current.path.split("/").at(-1) || rootName).slice(0, Number(coreLabel.width)));
    const centerX = width / 2, centerY = height / 2;
    const sectors: Node[][] = [[current]];
    function distribute(node: Node, first: number, last: number, level: number, inherited = 0) {
      node.start = first; node.end = last;
      if (!sectors[level]) sectors[level] = [];
      if (level) sectors[level].push(node);
      let start = first;
      const total = node.children.reduce((sum, child) => sum + Math.max(1, child.lines), 0);
      node.children.forEach((child, index) => {
        const end = start + (last - first) * Math.max(1, child.lines) / Math.max(1, total);
        child.color = level === 0 ? palette[index % palette.length] : inherited;
        distribute(child, start, end, level + 1, child.color); start = end;
      });
    }
    distribute(current, 0, Math.PI * 2, 0);
    cells = []; const content: string[] = [];
    for (let y = 0; y < height; y++) {
      let line = "", previous = -1; cells[y] = [];
      for (let x = 0; x < width; x++) {
        const dx = (x + 0.5 - centerX) / 2, dy = y + 0.5 - centerY;
        const distance = Math.hypot(dx, dy);
        const level = Math.floor(distance / ring);
        const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
        const node = distance < radius && level < levels ? sectors[level]?.find(n => angle >= n.start && angle < n.end) : undefined;
        cells[y][x] = node;
        const color = node ? node === current ? 240 : node === hovered ? 255 : node.color : -1;
        if (color !== previous) { line += color < 0 ? "\x1b[39m" : `\x1b[38;5;${color}m`; previous = color; }
        line += node ? "█" : " ";
      }
      content.push(line + "\x1b[39m");
    }
    box.setContent(content.join("\n"));
  }
  function hit(data: { x: number; y: number }) {
    return box.lpos ? cells[data.y - box.lpos.yi]?.[data.x - box.lpos.xi] : undefined;
  }
  box.on("mousemove", (data: blessed.Widgets.Events.IMouseEventArg) => {
    if (blocked()) return;
    const node = hit(data);
    if (node === hovered) return;
    hovered = node;
    const selected = node || current;
    hover(selected.path || rootName, selected.lines, selected.files); render(); box.screen.render();
  });
  box.on("mouseout", () => { if (!blocked() && hovered) { hovered = undefined; hover(current.path || rootName, current.lines, current.files); render(); box.screen.render(); } });
  box.on("click", (data: blessed.Widgets.Events.IMouseEventArg & { button?: string }) => {
    if (data.button !== "left" || blocked()) return;
    const node = hit(data); if (!node) return;
    if (node.children.length) { current = node === current && node.path ? nodes.get(node.path.split("/").slice(0, -1).join("/")) || root : node; hovered = undefined; render(); }
    choose(current === node || node.children.length ? current.path : node.path, node.children.length > 0);
  });
  return { box, render,
    copyText() { const node = hovered || current; return `${node.path || rootName}\n${node.lines} lines\n${node.files} files`; },
    get path() { return current?.path || ""; },
    children() { return current?.children || []; },
    setPath(path: string) { current = nodes.get(path) || root; hovered = undefined; render(); },
    setFiles(files: { path: string; lines: number }[]) {
      const make = (path: string): Node => ({ path, lines: 0, files: 0, children: [], start: 0, end: 0, depth: path ? path.split("/").length : 0, color: 240 });
      root = make(""); nodes = new Map([["", root]]);
      for (const file of files) {
        const parts = file.path.split("/"); let parentNode = root;
        for (let i = 1; i <= parts.length; i++) {
          const path = parts.slice(0, i).join("/"); let node = nodes.get(path);
          if (!node) { node = make(path); nodes.set(path, node); parentNode.children.push(node); }
          parentNode = node;
        }
        parentNode.lines = file.lines; parentNode.files = 1;
      }
      function totals(node: Node) {
        node.children.sort((a, b) => a.path.localeCompare(b.path));
        for (const child of node.children) { totals(child); node.lines += child.lines; node.files += child.files; }
      }
      totals(root); current = root; render();
    }
  };
}
