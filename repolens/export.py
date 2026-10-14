import json
from pathlib import Path

import networkx as nx


START = "<!-- repolens:start -->"
END = "<!-- repolens:end -->"


def mermaid(report, level="module", limit=100):
    graph = report["graphs"][level]
    nodes = graph["nodes"][:limit]
    ids = {node: f"n{i}" for i, node in enumerate(nodes)}
    symbols = {s["id"]: s["name"] for file in report["files"] for s in file["symbols"]}
    lines = ["flowchart LR"]
    for node, identifier in ids.items():
        label = symbols.get(node, node).replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
        lines.append(f'  {identifier}["{label}"]')
    for a, b in graph.get("edges", []):
        if a in ids and b in ids:
            lines.append(f"  {ids[a]} --> {ids[b]}")
    if len(graph["nodes"]) > limit:
        lines.append(f"  %% Showing {limit} of {len(graph['nodes'])} nodes")
    return "\n".join(lines)


def export_report(report, path, format="json", level="module"):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if format == "json":
        if target.suffix.lower() != ".json":
            raise ValueError("JSON exports require a .json filename")
        target.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    elif format == "graphml":
        if target.suffix.lower() != ".graphml":
            raise ValueError("Graph exports require a .graphml filename")
        graph = nx.DiGraph()
        graph.add_nodes_from(report["graphs"][level]["nodes"])
        graph.add_edges_from(report["graphs"][level].get("edges", []))
        nx.write_graphml(graph, target)
    return str(target.resolve())


def escape(text):
    return str(text).replace("|", "\\|").replace("\n", " ").replace("`", "\\`")


def readme_section(report):
    summary = report["summary"]
    lines = [START, "## Repository analysis", "", f"Revision: `{report['revision']}`. These facts come from syntax analysis; descriptions are not AI-generated.", "",
             f"{summary['files']} files · {summary['symbols']} symbols · {summary['module_edges']} module relationships · {summary['cycles']} circular components.", "",
             "### Architecture", "", "```mermaid", mermaid(report), "```", "",
             "### Modules", "", "| Source | Language | Functions | Complexity | Fan-in / out |", "| --- | --- | ---: | ---: | ---: |"]
    for file in report["files"]:
        if file["category"] == "source":
            metrics = file["metrics"]
            path = file["path"]
            lines.append(f"| [{escape(path)}]({Path(path).as_posix().replace(' ', '%20')}) | {file['language']} ({file['status']}) | {metrics.get('functions', 0)} | {metrics.get('cyclomatic', 0)} | {metrics['fan_in']} / {metrics['fan_out']} |")
    lines.extend(["", "### Dependency inventory", "", "| Manifest | Ecosystem | Requirement | Scope |", "| --- | --- | --- | --- |"])
    for dependency in report["dependencies"]:
        lines.append(f"| {escape(dependency['path'])} | {dependency['ecosystem']} | {escape(dependency['name'])} {escape(dependency['version'])} | {escape(dependency['scope'])} |")
    lines.extend(["", "### Symbol reference", "", "| Symbol / declaration | Kind | Source | Confidence |", "| --- | --- | --- | --- |"])
    for file in report["files"]:
        for symbol in file["symbols"]:
            lines.append(f"| {escape(symbol['name'])}: {escape(symbol['signature'])} | {symbol['kind']} | {escape(symbol['path'])}:{symbol['line']} | {symbol['confidence']} |")
    lines.extend(["", "### Findings", ""])
    if not report["findings"]:
        lines.append("No findings within the analyzer's supported coverage.")
    for finding in report["findings"]:
        lines.append(f"- {escape(finding['path'])}:{finding['line']} — {escape(finding['message'])} ({finding['confidence']} confidence). Evidence: {escape(', '.join(finding['evidence']))}")
    lines.extend(["", "### Analysis boundaries", "", *[f"- {item}" for item in report["limitations"]], "", END])
    return "\n".join(lines)


def generate_readme(report, path):
    target = Path(path).resolve()
    if target.name != "README.md":
        raise ValueError("Documentation output is restricted to README.md")
    if target.parent != Path(report["root"]).resolve():
        raise ValueError("README.md must be in the analyzed root so source links stay valid")
    section = readme_section(report)
    existing = target.read_text(encoding="utf-8") if target.exists() else ""
    if START in existing or END in existing:
        if existing.count(START) != 1 or existing.count(END) != 1 or existing.index(START) > existing.index(END):
            raise ValueError("Malformed RepoLens markers; existing README preserved")
        start = existing.index(START)
        end = existing.index(END) + len(END)
        updated = existing[:start] + section + existing[end:]
    else:
        updated = existing.rstrip() + ("\n\n" if existing else "") + section + "\n"
    if updated != existing:
        target.write_text(updated, encoding="utf-8")
    return str(target)
