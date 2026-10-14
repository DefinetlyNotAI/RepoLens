<div align="center">

# RepoLens

**Understand a repository without leaving your terminal.**

Explore source, trace relationships, find review hotspots, and compare revisions.

Local analysis · Multilingual · Mouse & keyboard · MIT

[Quick start](#quick-start) · [Explore](#explore-your-repository) · [Controls](#terminal-controls) · [Export](#export-your-findings) · [CLI](#command-line)

</div>

---

RepoLens pairs a syntax-aware Python engine with an interactive TypeScript terminal interface. It reads Tree-sitter syntax trees, Git history, and dependency manifests to turn a codebase into browsable files, symbols, metrics, and findings.

**No cloud service or AI model required.** Scans do not execute repository code or download grammars.

## Quick start

**Requirements:** Python 3.11+, Git, and Node.js 22+ for the TUI. Install ripgrep to search source text from the interface. Python-only commands do not need Node.js.

From the RepoLens directory on Windows:

```powershell
.\scripts\setup.ps1
.\.venv\Scripts\repolens.exe tui "C:\path\to\repository"
```

For a command-line report:

```powershell
.\.venv\Scripts\repolens.exe scan "C:\path\to\repository"
```

<details>
<summary><strong>Linux & macOS setup</strong></summary>

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
cd tui
npm ci
npm run build
cd ..
.venv/bin/repolens tui /path/to/repository
```

</details>

## Explore your repository

| View | What you can inspect |
| :--- | :--- |
| **1 · Overview** | Repository totals, languages, hotspots, dependencies, and parser coverage |
| **2 · Files** | Directory structure, file metrics, imports, source, and churn |
| **3 · Symbols** | Directory → file → class/function nesting, complexity, and resolved calls |
| **4 · Issues** | Findings grouped by severity and type, with confidence and source locations |
| **5 · History** | Commit messages, branches, and comparisons; older commits load as you reach the end |
| **6 · Size** | A colored connector tree with line counts, percentages, and folder navigation |
| **7 · Compare** | Base/current totals, changed files, and added or removed dependency edges |

### Source that stays readable

- **Complete files:** no automatic source line or byte cutoff. Only visible rows are drawn, with full content available for scrolling and copying.
- **Darcula-style colors:** syntax styling includes CSS selectors and properties, JSX tags, and language-specific categories. Terminal palettes and IDE semantic analysis can produce different results.
- **Clear findings:** black-on-yellow warning banners, white-on-red error banners, and underlined source locations. Selected code uses white on blue.
- **Predictable layout:** columns align to their longest displayed value. Code, signatures, and paths pan horizontally; ordinary prose wraps.
- **Direct interaction:** drag to select, scroll while selecting, and copy without line numbers. Successful copying clears the selection.

Relative file paths underline on hover. Ctrl+click or double-click a **detail path** to open it through the operating system. Double-clicking an explorer row inspects or expands the item.

Working-tree searches include all source matches when `rg` is installed. Historical searches use analyzed names and paths. Filters accept language, category, parser status, symbol kind, finding type, severity, or confidence, depending on the view.

## Terminal controls

The footer keeps just **`q` to quit** and **`?` for help**. Status messages clear when you start another action.

| Navigate | Action |
| :--- | :--- |
| `1`–`7` / click a tab | Switch view |
| `↑` `↓` / `j` `k` / click a row | Select an item |
| `Enter` / double-click a row | Expand, inspect, or compare a commit |
| `Tab` | Switch focus between the list and detail pane |
| `[` `]` / click a detail tab | Change detail section; brackets move between entries when there is only one section |
| `v` / `o` | Show source / open the selected file |
| `Esc` | Clear selection and focus the list |

| Scroll & select | Action |
| :--- | :--- |
| Wheel / Shift+wheel | Scroll one row / pan horizontally |
| `←` `→` / Shift+`←` `→` | Pan by one / ten columns |
| Drag a scrollbar | Scroll vertically or horizontally |
| Drag text + wheel | Select through scrollable content |
| Ctrl+`C` / right-click | Copy selected text, focused detail, or the selected row |
| `End` / reach the last History row | Load the next page of 100 commits |
| `l` / `Backspace` in Size | Go to the repository root / parent folder |

| Tools | Action |
| :--- | :--- |
| `/` · `f` · `s` | Search · filter · sort by complexity |
| `b` · `c` · `r` | Select revision · compare revision · rescan |
| `e` · `g` | Export JSON · generate a managed README section |
| `?` · `q` | Help · quit |

Text inputs support mouse caret placement, arrows, Home/End, Shift selection, Ctrl+A/C/X/V, right-click paste, and bracketed paste. Use Enter to confirm, Escape to cancel, and Tab to move between controls.

## Export your findings

Press **`e`** to choose a single JSON report or a folder of grouped JSON files. Both formats include repository and revision context.

```text
report/
├─ overview.json        Totals, scan status, diagnostics, boundaries
├─ files.json           Files and their analysis
├─ symbols.json         Symbols grouped by file
├─ issues.json          Findings grouped by severity and type
├─ history.json         Selected Git history window
├─ size.json            Folder totals and file line counts
├─ dependencies.json    Declared dependency inventory
└─ relationships.json   Module edges, symbol edges, and graphs
```

Existing unrelated files in the destination are preserved. GraphML and Mermaid exports are also available through the CLI.

## Command line

Activate the virtual environment to use the short `repolens` command, or substitute its executable path from Quick start.

```powershell
# Scan the working tree or a Git revision
repolens scan . --json
repolens scan . --revision main --include '*.py'

# Compare revisions or repositories
repolens compare . --base HEAD~1 --revision HEAD --json
repolens compare . --base main --other-root C:/another/repository --json

# Read complete source, or request a specific range
repolens source . --path src/main.py
repolens source . --path src/main.py --line 20 --count 40

# Export reports and dependency graphs
repolens export . --format json --output report.json
repolens export . --format json-folder --output report
repolens export . --format graphml --level function --output functions.graphml
repolens export . --format mermaid --level directory
```

<details>
<summary><strong>History, trends, custom grammars, and README generation</strong></summary>

```powershell
repolens history . --history-limit 50
repolens trends . --revisions HEAD~2 HEAD~1 HEAD --json
repolens trends . --json
repolens scan . --language .custom=python
repolens readme .
```

`--history-limit` selects the commit window used for churn and hotspot scores. The TUI can load older commits separately through pagination.

`readme` adds or replaces only the section between `<!-- repolens:start -->` and `<!-- repolens:end -->` in the analyzed repository's README.md. Other text is preserved, malformed markers fail safely, and identical generated content is left untouched. The section includes metrics, dependencies, source references, symbols, findings, diagrams, and analysis boundaries.

</details>

## Languages & analysis

Built-in grammar selection covers **Python, JavaScript/JSX, TypeScript/TSX, Java, Go, Rust, C/C++, C#, Ruby, PHP, Swift, Kotlin, Bash, PowerShell, Lua, Scala, Elixir, Dart, R, SQL, HTML, CSS/SCSS, Vue, JSON, YAML, and TOML**. Use `--language` to associate another suffix with a grammar.

Symbols and calls are extracted from syntax nodes. Symbols nest under their extracted owners; unnamed callbacks and lambdas are excluded from symbol counts. Metrics include structural complexity, function size, nesting, fan-in/out, dependency depth, internal-call cohesion, churn, and review hotspots.

<details>
<summary><strong>Interpretation and coverage boundaries</strong></summary>

| Area | How to interpret it |
| :--- | :--- |
| **Parser coverage** | Unsupported files receive metadata. Grammar recovery indicates partial parsing, with source locations; it does not establish a compiler error. Extraction quality depends on grammar conventions. |
| **Complexity** | Cyclomatic scores count structural branches and logical operators. Cognitive scores also weight nesting. These are structural estimates, not compiler-equivalent control-flow analysis or certified implementations of another tool's rules. |
| **Relationships** | Calls are conservatively resolved and carry confidence. Dynamic dispatch, type inference, callbacks, and complete runtime reachability are outside coverage. Cross-language edges require an established path relationship. Circular components identify strongly connected modules. |
| **Imports** | Resolution supports relative paths, common index/package conventions, Python modules, C includes, Rust paths, Java file paths, Go module paths, local npm workspaces, and explicit TypeScript aliases. External dependencies and unresolved aliases remain unresolved. |
| **Dependencies** | Inventory covers npm, Python project/requirements/Poetry, Cargo, Go, and Maven declarations. It is not a lockfile audit or vulnerability scan. |
| **Duplication** | Normalized syntax tokens and shingles can match renamed identifiers and literals within a language. Findings are review candidates; candidate lists are bounded to control analysis cost. |
| **Reachability** | Unreachable findings identify sequential statements after unconditional syntax exits. An unreferenced public API is not automatically dead code. Static metrics do not predict runtime performance. |
| **Discovery** | Git-aware discovery respects ignored untracked files. Generated directories, symlinks, and binaries are excluded; applicable skips are reported. Text files have no size cutoff. |
| **History** | Churn covers the selected commit window. Rename-only records are not attributed. |

JSON reports include diagnostics, unresolved relationships, metric evidence, and coverage boundaries alongside findings.

</details>

<details>
<summary><strong>Engine & cache</strong></summary>

The Python engine uses Tree-sitter, NetworkX, and SQLite. Unchanged files reuse content-hash-based syntax analysis; relationships are rebuilt to reflect additions and deletions. Cached snapshots retain summary trends independently of Git commits. Revision analysis reads Git objects without changing the checkout.

| Platform | Default cache |
| :--- | :--- |
| Windows | `%LOCALAPPDATA%/RepoLens/analysis.sqlite3` |
| Linux & macOS | `~/.cache/RepoLens/analysis.sqlite3` |

Override the location with `--cache path.sqlite3`. The pinned grammar pack ships compiled parsers.

</details>

---

Licensed under the [MIT License](LICENSE).
