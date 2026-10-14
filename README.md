# RepoLens

Local repository intelligence for multilingual projects. A Python engine uses Tree-sitter syntax trees, a shared JSON representation, NetworkX graphs, Git history, and a SQLite content-hash cache. A TypeScript terminal interface provides a repository explorer, source previews, structural metrics, findings, dependency navigation, and revision comparisons. No cloud service or AI model is required.

## Install and run

Requires Python 3.11+, Git, and Node.js 22+ for the TUI. The pinned grammar pack ships compiled parsers so scans do not download grammars or execute repository code.

```powershell
./scripts/setup.ps1
./.venv/Scripts/repolens.exe tui C:/path/to/repository
./.venv/Scripts/repolens.exe scan C:/path/to/repository
```

On Linux/macOS, run `python3 -m venv .venv`, `.venv/bin/python -m pip install -e .`, then `npm ci` and `npm run build` inside `tui/`. Launch `.venv/bin/repolens tui /path/to/repository`. Python-only usage does not need Node.

## Commands

```powershell
repolens scan . --json
repolens scan . --revision main --include '*.py'
repolens scan . --language .custom=python
repolens compare . --base HEAD~1 --revision HEAD --json
repolens compare . --base main --other-root C:/another/repository --json
repolens history . --history-limit 50
repolens trends . --revisions HEAD~2 HEAD~1 HEAD --json
repolens trends . --json
repolens source . --path src/main.py --line 20 --count 40
repolens export . --format json --output report.json
repolens export . --format graphml --level function --output functions.graphml
repolens export . --format mermaid --level directory
repolens readme .
```

`readme` appends or replaces only the section between `<!-- repolens:start -->` and `<!-- repolens:end -->` in the analyzed root's README.md. All other text is preserved; malformed markers fail safely. Repeated generation leaves an identical section untouched. Generated content includes module metrics, dependency inventories, source references, symbols, findings, Mermaid diagrams, and analysis boundaries. Documentation output is restricted to README.md.

Cache and historical snapshots live at `%LOCALAPPDATA%/RepoLens/analysis.sqlite3` on Windows, or `~/.cache/RepoLens/analysis.sqlite3` elsewhere. Override with `--cache path.sqlite3`. Unchanged files reuse syntax analysis; relationships are rebuilt to reflect additions and deletions. Snapshots retain summary trends independently of Git commits. Revision analysis reads Git objects without altering the checkout. `--history-limit` controls the commit window for churn and hotspot scores.

## Terminal controls

| Key | Action |
| --- | --- |
| 1–7 / click tab | Overview, files, symbols, findings, history, graph, comparison |
| ↑↓ / j k | Navigate |
| Enter | Expand directory, drill into file symbols, compare commit, follow graph edge |
| Tab | Focus list or scrollable source/detail pane |
| [ / ] / click detail tab | Choose metrics, source, imports, calls, or churn for the selected item |
| v | Open source preview |
| Click / double-click row | Select / open item or expand directory |
| Drag text, Ctrl+C / right-click | Select and copy detail text; without a selection, copy the focused detail or row |
| Esc | Clear text selection and focus the list |
| /, f, s | Search, filter, sort by complexity |
| l | Cycle graph level |
| b, c, r | Select revision, compare revision, incremental rescan |
| e, g | Export JSON, generate managed README section |
| ?, q | Help, exit |

Filters accept language, category, parser status, symbol kind, finding type, severity, or confidence depending on the view. Graphs support repository, directory, module, class, and function views; resolved relationships can be followed interactively. The comparison view shows base/current totals, changed files, and added/removed dependency edges.

## Coverage and interpretation

Built-in grammar selection covers Python, JavaScript/JSX, TypeScript/TSX, Java, Go, Rust, C/C++, C#, Ruby, PHP, Swift, Kotlin, Bash, PowerShell, Lua, Scala, Elixir, Dart, R, SQL, HTML, CSS/SCSS, Vue, JSON, YAML, and TOML. Additional suffixes can select grammars through `--language`; extraction quality depends on grammar node conventions. Unsupported files receive metadata without invented symbol facts. Syntax recovery reports partial coverage and source locations.

Symbol and call extraction uses grammar nodes, not textual function-name searches. Import resolution supports relative paths, common index/package conventions, Python modules, C includes, Rust paths, Java file paths, Go module paths, local npm workspaces, and explicitly configured TypeScript path aliases. External dependencies and unresolved aliases remain explicitly unresolved. Manifest inventory supports npm, Python project/requirements/Poetry, Cargo, Go, and Maven declarations; it is not a lockfile audit or vulnerability scanner.

Cyclomatic scores count structural branches and logical operators; cognitive scores additionally weight nesting. These are explainable structural estimates, not compiler-equivalent control-flow analysis or a certified implementation of another tool's cognitive-complexity rules. Function size, nesting, fan-in/out, condensed dependency depth, internal resolved-call cohesion, churn, and complexity/churn hotspot rankings help prioritize review. Circular components describe strongly connected modules, not every individual cycle.

Duplication compares normalized syntax tokens and syntax shingles within a language. Renamed identifiers and literals can match; findings are review candidates. Similarity uses bounded candidate lists to control cost. Calls are conservatively resolved and carry confidence; dynamic dispatch, type inference, callbacks, and complete runtime reachability are outside current coverage. Unreachable-code findings identify sequential statements after unconditional exits in syntax blocks. RepoLens does not claim that unreferenced public APIs are dead code or that static metrics predict runtime performance. Cross-language edges are only reported where a path establishes a relationship.

Git-aware discovery respects ignored untracked files. Generated directories, symlinks, binaries, and files above 2 MiB are excluded and applicable skips are reported. Git churn covers the selected recent commit window; rename-only records are not attributed. Large histories should use a bounded window. JSON reports expose diagnostics, unresolved relationships, metric evidence, and coverage boundaries alongside the findings.

MIT licensed. See LICENSE.
