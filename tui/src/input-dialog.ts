import blessed from "blessed";

export function inputDialog(screen: blessed.Widgets.Screen, readClipboard: () => Promise<string>, writeClipboard: (text: string) => Promise<void>) {
  const box = blessed.box({ parent: screen, top: "center", left: "center", height: 8, width: "80%", hidden: true,
    border: "line", style: { fg: "white", bg: "black", border: { fg: "blue" } } });
  const label = blessed.box({ parent: box, top: 0, left: 1, right: 1, height: 2, style: { fg: "cyan" } });
  const input = blessed.box({ parent: box, top: 2, left: 1, right: 1, height: 1, mouse: true, keys: true, wrap: false,
    style: { fg: "white", bg: "gray" } });
  const hint = blessed.box({ parent: box, top: 3, left: 1, right: 1, height: 1,
    content: "← → move · Ctrl+A select all · Ctrl+V paste · Tab options", style: { fg: "gray" } });
  const okay = blessed.button({ parent: box, top: 5, left: 1, width: 8, height: 1, content: "  Okay  ", mouse: true, keys: true });
  const cancel = blessed.button({ parent: box, top: 5, left: 11, width: 10, height: 1, content: "  Cancel  ", mouse: true, keys: true });
  let text: string[] = [], cursor = 0, offset = 0, anchor: number | undefined;
  let done: ((answer?: string) => void) | undefined;
  let previous: blessed.Widgets.BlessedElement | undefined;
  let pastePending = false;
  let bracketed: string | undefined;
  const range = () => anchor === undefined ? [cursor, cursor] : [Math.min(anchor, cursor), Math.max(anchor, cursor)];
  function render() {
    const width = Math.max(1, Number(input.width) - 1);
    if (cursor < offset) offset = cursor;
    while (Number(input.strWidth(text.slice(offset, cursor).join(""))) >= width) offset++;
    const [first, last] = range();
    let content = "", column = 0;
    for (let i = offset; i <= text.length && column < width; i++) {
      const character = text[i] || " ";
      const selected = i >= first && i < last;
      const caret = i === cursor && screen.focused === input;
      content += (selected || caret ? "\x1b[7m" : "") + character + (selected || caret ? "\x1b[27m" : "");
      column += Number(input.strWidth(character));
    }
    input.setContent(content);
    for (const button of [okay, cancel]) {
      button.style.bg = screen.focused === button ? "blue" : "black";
      button.style.fg = screen.focused === button ? "white" : "cyan";
      button.style.bold = screen.focused === button;
    }
    hint.style.fg = screen.focused === input ? "gray" : "cyan";
    screen.render();
  }
  function finish(answer?: string) {
    const callback = done;
    done = undefined; pastePending = false;
    box.hide(); bracketed = undefined; screen.program.write("\x1b[?2004l"); screen.grabKeys = false; previous?.focus();
    screen.render(); callback?.(answer);
  }
  function insert(value: string) {
    const [first, last] = range();
    const addition = Array.from(value.replace(/[\x00-\x1f\x7f]/g, " "));
    text.splice(first, last - first, ...addition); cursor = first + addition.length; anchor = undefined; render();
  }
  async function paste() {
    if (pastePending) return;
    pastePending = true;
    const current = done;
    try { const value = await readClipboard(); if (box.visible && done === current) insert(value); }
    catch (error) { if (box.visible) { hint.setContent(String(error)); screen.render(); } }
    finally { pastePending = false; }
  }
  function keypress(character: string, key: blessed.Widgets.Events.IKeyEventArg) {
    if (!box.visible) return;
    if (key.sequence === "\x1b[200~") { bracketed = ""; return; }
    if (key.sequence === "\x1b[201~") { const value = bracketed; bracketed = undefined; if (value !== undefined) insert(value); return; }
    if (bracketed !== undefined) { if (key.name !== "return") bracketed += character || key.sequence || ""; return; }
    if (key.name === "escape") { finish(); return; }
    if (key.name === "enter") { finish(screen.focused === cancel ? undefined : text.join("")); return; }
    if (key.name === "tab") {
      const controls = [input, okay, cancel];
      controls[(controls.indexOf(screen.focused as typeof input) + (key.shift ? 2 : 1)) % 3].focus(); render(); return;
    }
    if (screen.focused !== input) {
      if (key.name === "left" || key.name === "right") { (screen.focused === okay ? cancel : okay).focus(); render(); }
      return;
    }
    if (key.ctrl && key.name === "v" || key.shift && key.name === "insert") { void paste(); return; }
    if (key.ctrl && (key.name === "c" || key.name === "x")) {
      const [first, last] = range(); const value = text.slice(first, last).join("");
      const before = text.join(""), owner = done;
      if (value) void writeClipboard(value).then(() => {
        const current = range();
        if (key.name === "x" && box.visible && done === owner && text.join("") === before && current[0] === first && current[1] === last) insert("");
      }).catch(error => { if (box.visible) { hint.setContent(String(error)); screen.render(); } });
      return;
    }
    if (key.ctrl && key.name === "a") { anchor = 0; cursor = text.length; render(); return; }
    if (["left", "right", "home", "end"].includes(key.name)) {
      const [first, last] = range();
      if (key.shift && anchor === undefined) anchor = cursor;
      if (!key.shift && anchor !== undefined && (key.name === "left" || key.name === "right")) cursor = key.name === "left" ? first : last;
      else if (key.name === "home") cursor = 0;
      else if (key.name === "end") cursor = text.length;
      else {
        const direction = key.name === "left" ? -1 : 1;
        cursor = Math.max(0, Math.min(text.length, cursor + direction));
        if (key.ctrl) {
          while (cursor > 0 && cursor < text.length && /\s/.test(text[direction < 0 ? cursor - 1 : cursor])) cursor += direction;
          while (cursor > 0 && cursor < text.length && !/\s/.test(text[direction < 0 ? cursor - 1 : cursor])) cursor += direction;
        }
      }
      if (!key.shift) anchor = undefined;
      render(); return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      const [first, last] = range();
      if (first !== last) { text.splice(first, last - first); cursor = first; }
      else if (key.name === "backspace" && cursor) text.splice(--cursor, 1);
      else if (key.name === "delete") text.splice(cursor, 1);
      anchor = undefined; render(); return;
    }
    if (character && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(character)) insert(character);
  }
  for (const control of [input, okay, cancel]) { control.on("keypress", keypress); control.on("focus", render); }
  okay.on("press", () => finish(text.join(""))); cancel.on("press", () => finish());
  input.on("mousedown", (data: blessed.Widgets.Events.IMouseEventArg & { button?: string }) => {
    if (data.button === "right") { void paste(); return; }
    input.focus();
    let column = 0; cursor = offset;
    const target = Math.max(0, data.x - (input.lpos?.xi || 0));
    while (cursor < text.length && column < target) column += Number(input.strWidth(text[cursor++]));
    anchor = undefined; render();
  });
  return { box, ask(title: string, initial: string, callback: (answer?: string) => void) {
    if (box.visible) return;
    previous = screen.focused; done = callback; text = Array.from(initial); cursor = text.length; offset = 0; anchor = undefined;
    label.setContent(title); hint.setContent("← → move · Ctrl+A select all · Ctrl+V paste · Tab options");
    box.show(); box.setFront(); screen.grabKeys = true; screen.program.write("\x1b[?2004h"); input.focus(); render();
  } };
}
