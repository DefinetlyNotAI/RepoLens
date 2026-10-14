import json
import math
import posixpath
import tomllib
from collections import Counter, defaultdict
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

import networkx as nx

from .cache import Cache, ENGINE_VERSION
from .parser import LANGUAGES, analyze_file
from .repository import discover, history, is_git, resolve_revision


def dependency_inventory(path, data):
    name = PurePosixPath(path).name
    result = []
    try:
        if name == "package.json":
            manifest = json.loads(data)
            for group in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
                result.extend({"name": key, "version": str(version), "ecosystem": "npm", "scope": group, "path": path}
                              for key, version in manifest.get(group, {}).items())
        elif name in {"pyproject.toml", "Cargo.toml"}:
            manifest = tomllib.loads(data.decode("utf-8"))
            if name == "pyproject.toml":
                for item in manifest.get("project", {}).get("dependencies", []):
                    result.append({"name": item, "version": "declared requirement", "ecosystem": "python", "scope": "runtime", "path": path})
                for group, items in manifest.get("project", {}).get("optional-dependencies", {}).items():
                    result.extend({"name": item, "version": "declared requirement", "ecosystem": "python", "scope": group, "path": path} for item in items)
                poetry = manifest.get("tool", {}).get("poetry", {}).get("dependencies", {})
                result.extend({"name": key, "version": str(version), "ecosystem": "python", "scope": "poetry", "path": path} for key, version in poetry.items())
            else:
                for group in ("dependencies", "dev-dependencies", "build-dependencies"):
                    result.extend({"name": key, "version": str(version), "ecosystem": "cargo", "scope": group, "path": path}
                                  for key, version in manifest.get(group, {}).items())
        elif name.startswith("requirements") and name.endswith(".txt"):
            for line in data.decode("utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith(("#", "-")):
                    result.append({"name": line, "version": "declared requirement", "ecosystem": "python", "scope": "runtime", "path": path})
        elif name == "go.mod":
            in_require = False
            for line in data.decode("utf-8").splitlines():
                parts = line.split()
                if parts == ["require", "("]:
                    in_require = True
                elif parts == [")"]:
                    in_require = False
                elif parts and (in_require or parts[0] == "require"):
                    pair = parts if in_require else parts[1:]
                    if len(pair) >= 2 and not pair[0].startswith("//"):
                        result.append({"name": pair[0], "version": pair[1], "ecosystem": "go", "scope": "runtime", "path": path})
        elif name == "pom.xml":
            tree = ElementTree.fromstring(data)
            for dependency in tree.findall(".//{*}dependency"):
                result.append({"name": f"{dependency.findtext('{*}groupId')}:{dependency.findtext('{*}artifactId')}",
                               "version": dependency.findtext("{*}version", "inherited"), "ecosystem": "maven",
                               "scope": dependency.findtext("{*}scope", "compile"), "path": path})
    except (ValueError, TypeError, AttributeError, ElementTree.ParseError, UnicodeError) as error:
        return [], f"Dependency manifest {path}: {error}"
    return result, None


def resolve_import(item, file, files, contexts=None):
    target = item["target"]
    language = file["language"]
    directory = posixpath.dirname(file["path"])
    candidates = set()
    bases = []
    contexts = contexts or {}
    if language == "python":
        dots = len(target) - len(target.lstrip("."))
        module = target[dots:].replace(".", "/")
        if dots:
            parent = directory
            for _ in range(dots - 1):
                parent = posixpath.dirname(parent)
            bases.append(posixpath.join(parent, module))
        else:
            bases.extend([module, posixpath.join("src", module)])
        for base in list(bases):
            for name in item["names"]:
                bases.append(posixpath.join(base, name.split(" as ")[0].replace(".", "/")))
    elif target.startswith(".") or language in {"c", "cpp"}:
        bases.extend([posixpath.normpath(posixpath.join(directory, target)), target])
    elif language == "rust":
        parts = target.split("::")
        if parts[0] == "crate":
            bases.append(posixpath.join("src", *parts[1:]))
        elif parts[0] == "self":
            bases.append(posixpath.join(directory, *parts[1:]))
        elif parts[0] == "super":
            bases.append(posixpath.join(posixpath.dirname(directory), *parts[1:]))
    elif language == "java":
        module = target.replace(".", "/")
        candidates.update(path for path in files if path.endswith("/" + module + ".java") or path == module + ".java")
    elif language == "csharp":
        for path, destination in files.items():
            if destination["language"] != "csharp":
                continue
            namespaces = destination.get("namespaces", [])
            if target in namespaces or any(target == namespace + "." + symbol["short_name"]
                                           for namespace in namespaces for symbol in destination["symbols"] if symbol["kind"] == "class"):
                candidates.add(path)
    elif language == "go":
        for module_root, module_name in contexts.get("go", []):
            if target == module_name or target.startswith(module_name + "/"):
                folder = posixpath.join(module_root, target[len(module_name):].lstrip("/"))
                candidates.update(path for path in files if posixpath.dirname(path) == folder and path.endswith(".go") and not path.endswith("_test.go"))
    elif language in {"javascript", "typescript", "tsx"}:
        applicable = [context for context in contexts.get("typescript", []) if not context["directory"] or file["path"].startswith(context["directory"] + "/")]
        if applicable:
            context = max(applicable, key=lambda c: len(c["directory"]))
            for alias, destinations in context["paths"].items():
                prefix, star, suffix = alias.partition("*")
                if (star and target.startswith(prefix) and target.endswith(suffix)) or (not star and target == alias):
                    middle = target[len(prefix):len(target) - len(suffix) if suffix else None] if star else ""
                    bases.extend(posixpath.normpath(posixpath.join(context["base"], destination.replace("*", middle))) for destination in destinations)
        for package, directory, entries in contexts.get("workspaces", []):
            if target == package:
                bases.extend(posixpath.join(directory, entry) for entry in entries)
            elif target.startswith(package + "/"):
                bases.append(posixpath.join(directory, target[len(package) + 1:]))
    for base in bases:
        base = posixpath.normpath(base)
        if base in files:
            candidates.add(base)
        for extension in LANGUAGES:
            for path in (base + extension, base + "/index" + extension, base + "/__init__" + extension, base + "/mod" + extension):
                if path in files:
                    candidates.add(path)
        if base.endswith((".js", ".mjs")):
            stem = base.rsplit(".", 1)[0]
            candidates.update(path for path in (stem + ".ts", stem + ".tsx") if path in files)
    return sorted(candidates)


def import_context(path, data, contexts, diagnostics):
    name = PurePosixPath(path).name
    directory = posixpath.dirname(path)
    try:
        if name in {"tsconfig.json", "jsconfig.json"}:
            options = json.loads(data).get("compilerOptions", {})
            contexts["typescript"].append({"directory": directory,
                                            "base": posixpath.normpath(posixpath.join(directory, options.get("baseUrl", "."))),
                                            "paths": options.get("paths", {})})
        elif name == "package.json":
            package = json.loads(data)
            if package.get("name"):
                entries = [package[key] for key in ("source", "module", "main", "types") if isinstance(package.get(key), str)] or ["index"]
                contexts["workspaces"].append((package["name"], directory, entries))
        elif name == "go.mod":
            for line in data.decode("utf-8").splitlines():
                if line.split()[:1] == ["module"] and len(line.split()) == 2:
                    contexts["go"].append((directory, line.split()[1]))
    except (ValueError, TypeError, AttributeError) as error:
        diagnostics.append(f"Import configuration {path} unavailable: {error}")


def graph_metrics(graph):
    components = list(nx.strongly_connected_components(graph))
    condensed = nx.condensation(graph, components)
    depth = {}
    for node in reversed(list(nx.topological_sort(condensed))):
        depth[node] = max((1 + depth[child] for child in condensed.successors(node)), default=0)
    result = {}
    for node in graph:
        result[node] = {"fan_in": graph.in_degree(node), "fan_out": graph.out_degree(node),
                        "dependency_depth": depth[condensed.graph["mapping"][node]]}
    cycles = [sorted(component) for component in components if len(component) > 1
              or (len(component) == 1 and graph.has_edge(next(iter(component)), next(iter(component))))]
    return result, sorted(cycles, key=lambda c: (-len(c), c))


def duplicate_findings(symbols, languages):
    functions = [s for s in symbols if s.get("metrics", {}).get("tokens", 0) >= 40 and s["confidence"] == "high"]
    groups = defaultdict(list)
    for symbol in functions:
        groups[(languages[symbol["path"]], symbol["metrics"]["fingerprint"])].append(symbol)
    findings = []
    for group in groups.values():
        if len(group) > 1:
            findings.append({"type": "duplication", "severity": "info", "confidence": "medium",
                             "path": group[0]["path"], "line": group[0]["line"],
                             "message": f"{len(group)} functions share the same normalized syntax structure.",
                             "evidence": [s["id"] for s in group]})
    # An inverted shingle index bounds comparison to functions sharing syntax fragments.
    index = defaultdict(list)
    comparisons = 0
    for position, symbol in enumerate(functions):
        shingles = set(symbol["metrics"]["shingles"])
        candidates = Counter()
        for shingle in shingles:
            candidates.update(index[(languages[symbol["path"]], shingle)])
        for candidate_id, overlap in candidates.most_common(20):
            other = functions[candidate_id]
            if symbol["metrics"]["fingerprint"] == other["metrics"]["fingerprint"]:
                continue
            other_shingles = set(other["metrics"]["shingles"])
            similarity = overlap / len(shingles | other_shingles) if shingles or other_shingles else 0
            comparisons += 1
            if similarity >= 0.85:
                findings.append({"type": "similarity", "severity": "info", "confidence": "medium",
                                 "path": symbol["path"], "line": symbol["line"],
                                 "message": f"Functions have {similarity:.0%} normalized syntax-shingle similarity.",
                                 "evidence": [symbol["id"], other["id"]]})
        for shingle in shingles:
            bucket = index[(languages[symbol["path"]], shingle)]
            if len(bucket) < 100:
                bucket.append(position)
    return findings, comparisons


def scan(root, revision=None, cache_path=None, overrides=None, includes=(), history_limit=100, progress=None):
    root = Path(root).resolve()
    if not root.is_dir():
        raise ValueError(f"Repository directory does not exist: {root}")
    if revision:
        revision = resolve_revision(root, revision)
    cache = Cache(cache_path)
    files = []
    dependencies = []
    diagnostics = []
    contexts = {"typescript": [], "workspaces": [], "go": []}
    parsed = cached = 0
    try:
        for path, data, discovery_diagnostics in discover(root, revision, includes):
            if path is None:
                diagnostics.extend(discovery_diagnostics)
                break
            key = sha256(json.dumps([ENGINE_VERSION, path, sha256(data).hexdigest(), overrides or {}], sort_keys=True).encode()).hexdigest()
            file = cache.file(key)
            if file is None:
                file = analyze_file(path, data, overrides)
                cache.put_file(key, file)
                parsed += 1
            else:
                cached += 1
            files.append(file)
            import_context(path, data, contexts, diagnostics)
            items, error = dependency_inventory(path, data)
            dependencies.extend(items)
            if error:
                diagnostics.append(error)
            if progress and (len(files) % 25 == 0):
                progress(f"{len(files)} files · {parsed} analyzed · {cached} cached")
        report = build_report(root, revision, files, dependencies, diagnostics, history_limit, contexts)
        report["incremental"] = {"analyzed": parsed, "cached": cached, "cache_version": ENGINE_VERSION}
        cache.save(report)
        return report
    finally:
        cache.close()


def build_report(root, revision, files, dependencies, diagnostics, history_limit, contexts=None):
    by_path = {f["path"]: f for f in files}
    symbols = [s for f in files for s in f["symbols"]]
    by_symbol = {s["id"]: s for s in symbols}
    symbols_by_file = defaultdict(list)
    for symbol in symbols:
        symbols_by_file[symbol["path"]].append(symbol)
    graph = nx.DiGraph()
    graph.add_nodes_from(f["path"] for f in files if f["category"] == "source")
    edges = []
    unresolved = []
    for file in files:
        for item in file["imports"]:
            targets = resolve_import(item, file, by_path, contexts)
            # A package __init__ and from-import children are both meaningful dependencies.
            if targets:
                for target in targets:
                    if target != file["path"]:
                        graph.add_edge(file["path"], target)
                        edges.append({"source": file["path"], "target": target, "kind": "import",
                                      "line": item["line"], "confidence": "high" if len(targets) == 1 else "medium",
                                      "evidence": item["target"]})
            else:
                unresolved.append({"path": file["path"], **item, "status": "external-or-unresolved"})
    symbol_graph = nx.DiGraph()
    symbol_graph.add_nodes_from(by_symbol)
    symbol_edges = []
    unresolved_calls = 0
    for file in files:
        imported = []
        for item in file["imports"]:
            paths = resolve_import(item, file, by_path, contexts)
            for binding in item.get("bindings", []):
                for path in paths:
                    for symbol in symbols_by_file[path]:
                        if symbol["parent"] is not None:
                            continue
                        if binding["kind"] == "named" and symbol["short_name"] == binding["imported"]:
                            imported.append((binding["local"], symbol))
                        elif binding["kind"] == "namespace":
                            imported.append((binding["local"] + "." + symbol["short_name"], symbol))
        for reference in file["references"]:
            target = reference["target"]
            local = [s for s in symbols_by_file[file["path"]] if s["short_name"] == target or s["name"] == target]
            if target.startswith(("self.", "this.")):
                caller = by_symbol.get(reference["caller"])
                while caller and caller["kind"] != "class":
                    caller = by_symbol.get(caller["parent"])
                if caller:
                    local = [s for s in symbols_by_file[file["path"]] if s["name"] == caller["name"] + "." + target.split(".", 1)[1]]
            matches = local or [s for name, s in imported if name == target]
            matches = list({s["id"]: s for s in matches}.values())
            confidence = "medium"
            if len(matches) == 1:
                caller = reference["caller"]
                destination = matches[0]["id"]
                if caller:
                    symbol_graph.add_edge(caller, destination)
                symbol_edges.append({"source": caller or file["path"], "target": destination, "kind": "call",
                                     "line": reference["line"], "confidence": confidence, "evidence": target})
            else:
                unresolved_calls += 1
    module_metrics, cycles = graph_metrics(graph)
    symbol_metrics, _ = graph_metrics(symbol_graph)
    findings = []
    for file in files:
        metrics = module_metrics.get(file["path"], {"fan_in": 0, "fan_out": 0, "dependency_depth": 0})
        functions = [s for s in file["symbols"] if s["kind"] == "function"]
        local_calls = [e for e in symbol_edges if e["source"] in {s["id"] for s in functions}]
        internal_calls = sum(by_symbol[e["target"]]["path"] == file["path"] for e in local_calls)
        metrics["cohesion"] = round(internal_calls / len(local_calls), 3) if local_calls else None
        metrics["cohesion_basis"] = "fraction of resolved calls staying inside the module"
        metrics["complexity_per_100_lines"] = round(100 * file.get("metrics", {}).get("cyclomatic", 0) / max(file["lines"], 1), 2)
        file.setdefault("metrics", {}).update(metrics)
        for diagnostic in file["diagnostics"]:
            if file["category"] == "source" or file["status"] == "partial":
                findings.append({"type": "coverage", "severity": "info", "confidence": "high", "path": file["path"], "line": 1,
                                 "message": diagnostic, "evidence": [file["status"]]})
        for statement in file.get("unreachable", []):
            findings.append({"type": "unreachable", "severity": "warning", "confidence": "high",
                             "path": file["path"], "line": statement["line"], "message": "Unreachable statement after unconditional exit.",
                             "evidence": [statement["evidence"]]})
        if metrics["fan_in"] + metrics["fan_out"] >= 15:
            findings.append({"type": "coupling", "severity": "warning", "confidence": "high", "path": file["path"], "line": 1,
                             "message": "Highly connected module.", "evidence": [f"fan-in={metrics['fan_in']}", f"fan-out={metrics['fan_out']}"]})
    for symbol in symbols:
        symbol["structural"] = symbol_metrics[symbol["id"]]
        metrics = symbol.get("metrics", {})
        if metrics.get("cyclomatic", 0) >= 10 or metrics.get("nesting", 0) >= 4 or metrics.get("lines", 0) >= 100:
            findings.append({"type": "complexity", "severity": "warning", "confidence": symbol["confidence"],
                             "path": symbol["path"], "line": symbol["line"], "message": f"Complex function: {symbol['name']}",
                             "evidence": [f"{k}={metrics[k]}" for k in ("cyclomatic", "cognitive", "nesting", "lines")]})
    for cycle in cycles:
        findings.append({"type": "cycle", "severity": "warning", "confidence": "high" if all(e["confidence"] == "high" for e in edges if e["source"] in cycle and e["target"] in cycle) else "medium",
                         "path": cycle[0], "line": 1, "message": f"Circular dependency component ({len(cycle)} modules).", "evidence": cycle})
    duplicates, comparisons = duplicate_findings(symbols, {f["path"]: f["language"] for f in files})
    findings.extend(duplicates)
    git_history = history(root, history_limit, revision)
    for file in files:
        churn = git_history["churn"].get(file["path"], {"added": 0, "removed": 0, "commits": 0})
        file["churn"] = churn
        file["metrics"]["hotspot"] = round(math.log1p(churn["commits"]) * file["metrics"].get("cyclomatic", 0), 2)
    directory_graph = nx.DiGraph()
    directory_graph.add_nodes_from(posixpath.dirname(node) or "." for node in graph)
    for a, b in graph.edges:
        a, b = posixpath.dirname(a) or ".", posixpath.dirname(b) or "."
        if a != b:
            directory_graph.add_edge(a, b)
    class_edges = set()
    def class_owner(symbol_id):
        symbol = by_symbol.get(symbol_id)
        while symbol:
            if symbol["kind"] == "class":
                return symbol["id"]
            symbol = by_symbol.get(symbol["parent"])
        return None
    for edge in symbol_edges:
        a, b = class_owner(edge["source"]), class_owner(edge["target"])
        if a and b and a != b:
            class_edges.add((a, b))
    summary = {"files": len(files), "source_files": sum(f["category"] == "source" for f in files),
               "lines": sum(f["lines"] for f in files), "symbols": len(symbols), "dependencies": len(dependencies),
               "module_edges": graph.number_of_edges(), "symbol_edges": len(symbol_edges), "cycles": len(cycles),
               "cyclomatic": sum(f["metrics"].get("cyclomatic", 0) for f in files),
               "cognitive": sum(s.get("metrics", {}).get("cognitive", 0) for s in symbols),
               "warnings": sum(f["severity"] == "warning" for f in findings),
               "languages": dict(Counter(f["language"] for f in files)),
               "coverage": dict(Counter(f["status"] for f in files))}
    head = None
    if is_git(root):
        try:
            head = resolve_revision(root, "HEAD")
        except ValueError:
            pass
    repository_nodes = [str(root)] + sorted({f"{d['ecosystem']}:{d['name']}" for d in dependencies})
    function_ids = {s["id"] for s in symbols if s["kind"] == "function"}
    return {"schema_version": 1, "root": str(root), "revision": revision or "working-tree", "head": head,
            "created": datetime.now(timezone.utc).isoformat(), "summary": summary, "files": files,
            "dependencies": dependencies, "edges": edges, "symbol_edges": symbol_edges, "cycles": cycles,
            "graphs": {"repository": {"nodes": repository_nodes, "edges": [[str(root), dependency] for dependency in repository_nodes[1:]],
                                      "metrics": {"modules": graph.number_of_nodes(), "edges": graph.number_of_edges()}},
                       "directory": {"nodes": sorted(directory_graph.nodes), "edges": [list(e) for e in directory_graph.edges]},
                       "module": {"nodes": sorted(graph.nodes), "edges": [list(e) for e in graph.edges]},
                       "class": {"nodes": [s["id"] for s in symbols if s["kind"] == "class"], "edges": [list(e) for e in sorted(class_edges)]},
                       "function": {"nodes": sorted(function_ids), "edges": [list(e) for e in symbol_graph.edges if e[0] in function_ids and e[1] in function_ids]}},
            "findings": findings, "history": git_history, "unresolved_imports": unresolved,
            "diagnostics": diagnostics,
            "limitations": ["Call resolution is conservative and does not implement type inference, dynamic dispatch, or runtime reachability.",
                            "Unresolved imports can be external dependencies, aliases, or unsupported import forms.",
                            "Complexity counts grammar branch nodes and logical operators; cognitive scores are structural approximations.",
                            "Duplication normalizes identifier and literal tokens; similarity candidates are bounded to 20 per function and 100 per shingle.",
                            "Cohesion measures resolved internal calls, not semantic cohesion. Unreachable findings cover only sequential statements after unconditional exits.",
                            "Generated directories, binary files, symlinks and files over 2 MiB are excluded."],
            "analysis_stats": {"unresolved_calls": unresolved_calls, "similarity_comparisons": comparisons}}


def compare(before, after):
    old = {f["path"]: f for f in before["files"]}
    new = {f["path"]: f for f in after["files"]}
    old_edges = {(e["source"], e["target"]) for e in before["edges"]}
    new_edges = {(e["source"], e["target"]) for e in after["edges"]}
    return {"before": {"root": before["root"], "revision": before["revision"], "summary": before["summary"]},
            "after": {"root": after["root"], "revision": after["revision"], "summary": after["summary"]},
            "delta": {k: after["summary"][k] - before["summary"][k] for k in before["summary"] if isinstance(before["summary"][k], int)},
            "added_files": sorted(new.keys() - old.keys()), "removed_files": sorted(old.keys() - new.keys()),
            "changed_files": [{"path": path, "complexity_delta": new[path]["metrics"].get("cyclomatic", 0) - old[path]["metrics"].get("cyclomatic", 0),
                               "lines_delta": new[path]["lines"] - old[path]["lines"]} for path in sorted(old.keys() & new.keys()) if old[path]["hash"] != new[path]["hash"]],
            "added_edges": [list(e) for e in sorted(new_edges - old_edges)], "removed_edges": [list(e) for e in sorted(old_edges - new_edges)]}
