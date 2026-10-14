from collections import Counter
from hashlib import sha256
from pathlib import PurePosixPath

from tree_sitter_language_pack import get_parser


LANGUAGES = {
    ".py": "python", ".pyi": "python", ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "tsx",
    ".java": "java", ".go": "go", ".rs": "rust", ".c": "c", ".h": "c",
    ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".cs": "csharp", ".rb": "ruby",
    ".php": "php", ".swift": "swift", ".kt": "kotlin", ".kts": "kotlin",
    ".sh": "bash", ".ps1": "powershell", ".psm1": "powershell", ".lua": "lua", ".scala": "scala", ".ex": "elixir",
    ".exs": "elixir", ".dart": "dart", ".r": "r", ".sql": "sql",
    ".html": "html", ".css": "css", ".scss": "scss", ".vue": "vue",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
}
FUNCTIONS = {
    "function_definition", "function_declaration", "method_definition", "method_declaration",
    "function_item", "arrow_function", "function_expression", "generator_function_declaration",
    "constructor_declaration", "local_function_statement", "singleton_method", "method",
    "function", "lambda", "lambda_expression", "anonymous_function", "function_literal", "function_statement", "generator_function",
}
CLASSES = {"class_definition", "class_declaration", "class", "struct_item", "struct_specifier",
           "interface_declaration", "enum_declaration", "trait_item", "impl_item", "object_declaration"}
IMPORTS = {"import_statement", "import_from_statement", "import_declaration", "use_declaration",
           "preproc_include", "using_directive", "namespace_use_declaration", "use_directive"}
BRANCHES = {"if_statement", "elif_clause", "for_statement", "for_in_statement", "while_statement",
            "do_statement", "except_clause", "catch_clause", "case_statement", "switch_case",
            "match_arm", "conditional_expression", "ternary_expression", "if_expression",
            "for_expression", "while_expression", "rescue", "when", "case_clause"}
CALLS = {"call", "call_expression", "method_invocation", "invocation_expression", "object_creation_expression"}
IDENTIFIERS = {"identifier", "type_identifier", "field_identifier", "property_identifier", "constant"}
LOGICAL = {"and", "or", "&&", "||", "??"}
CONFIG_NAMES = {"Dockerfile", "Makefile", "CMakeLists.txt", "Cargo.toml", "go.mod", "Gemfile",
                "package.json", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle"}
CONFIG_SUFFIXES = {".json", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".xml", ".lock"}


def walk(node):
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(current.children))


def value(node, data):
    return data[node.start_byte:node.end_byte].decode("utf-8", "replace") if node else ""


def field(node, *names):
    for name in names:
        child = node.child_by_field_name(name)
        if child is not None:
            return child
    return None


def symbol_name(node, data):
    name = field(node, "name")
    if name:
        return value(name, data)
    declarator = field(node, "declarator")
    if declarator:
        names = [n for n in walk(declarator) if n.type in IDENTIFIERS]
        if names:
            return value(names[0], data)
    if node.parent and node.parent.type in {"variable_declarator", "assignment", "pair", "assignment_expression"}:
        return value(field(node.parent, "name", "left", "key"), data)
    return f"<anonymous@{node.start_point.row + 1}>"


def body_nodes(body):
    stack = [(body, 0)]
    while stack:
        node, nesting = stack.pop()
        if node != body and node.type in FUNCTIONS | CLASSES:
            continue
        yield node, nesting
        stack.extend((child, nesting + int(node.type in BRANCHES)) for child in reversed(node.children))


def function_metrics(body, data):
    nodes = list(body_nodes(body))
    branches = [(node, depth) for node, depth in nodes if node.type in BRANCHES]
    logical = sum(node.type in LOGICAL for node, _ in nodes)
    tokens = []
    for node, _ in nodes:
        if node.type == "comment":
            continue
        if not node.children:
            token = node.type
            if node.type not in IDENTIFIERS and not any(t in node.type for t in ("string", "integer", "float", "number")):
                token += ":" + value(node, data)
            tokens.append(token)
    structure = " ".join(tokens)
    return {
        "cyclomatic": 1 + len(branches) + logical,
        "cognitive": sum(1 + depth for _, depth in branches) + logical,
        "nesting": max((depth + 1 for _, depth in branches), default=0),
        "lines": body.end_point.row - body.start_point.row + 1,
        "tokens": len(tokens), "fingerprint": sha256(structure.encode()).hexdigest(),
        "shingles": sorted({sha256(" ".join(tokens[i:i + 5]).encode()).hexdigest()[:16]
                            for i in range(max(0, len(tokens) - 4))}),
    }


def imports_for(node, data, language):
    result = []
    if language == "python":
        if node.type == "import_from_statement":
            target = value(field(node, "module_name"), data)
            names = [value(c, data) for c in node.children_by_field_name("name")]
            bindings = []
            for child in node.children_by_field_name("name"):
                imported = value(field(child, "name") or child, data)
                local = value(field(child, "alias"), data) or imported
                bindings.append({"local": local, "imported": imported, "kind": "named"})
            result.append({"target": target, "names": names, "bindings": bindings})
        else:
            for child in node.children_by_field_name("name"):
                target = value(field(child, "name") or child, data)
                local = value(field(child, "alias"), data) or target
                result.append({"target": target, "names": [], "bindings": [{"local": local, "imported": "*", "kind": "namespace"}]})
    elif language == "csharp":
        if node.named_children:
            result.append({"target": value(node.named_children[-1], data), "names": [], "bindings": []})
    else:
        source = field(node, "source", "path")
        strings = [n for n in walk(source or node) if n.type in {
            "string", "string_literal", "interpreted_string_literal", "raw_string_literal", "system_lib_string"}]
        if strings:
            bindings = []
            if language in {"javascript", "typescript", "tsx"}:
                for child in walk(node):
                    if child.type == "import_specifier":
                        imported = value(field(child, "name"), data)
                        bindings.append({"local": value(field(child, "alias"), data) or imported,
                                         "imported": imported, "kind": "named"})
                    elif child.type == "namespace_import" and child.named_children:
                        bindings.append({"local": value(child.named_children[-1], data), "imported": "*", "kind": "namespace"})
            result.extend({"target": value(n, data).strip("\"'`<>"), "names": [], "bindings": bindings} for n in strings)
        else:
            target = field(node, "argument", "name", "path")
            if target is None:
                target = next((n for n in node.named_children if n.type in {
                    "scoped_identifier", "scoped_use_list", "use_wildcard", "qualified_name",
                    "scoped_type_identifier", "identifier"}), None)
            if target:
                result.append({"target": value(target, data), "names": []})
    return result


def analyze_file(path, data, overrides=None):
    suffix = PurePosixPath(path).suffix.lower()
    language = (overrides or {}).get(suffix, LANGUAGES.get(suffix))
    category = "config" if suffix in CONFIG_SUFFIXES or PurePosixPath(path).name in CONFIG_NAMES else "source" if language else "other"
    result = {"path": path, "language": language or "unknown", "category": category,
              "bytes": len(data), "lines": len(data.splitlines()), "hash": sha256(data).hexdigest(),
              "symbols": [], "imports": [], "references": [], "namespaces": [], "unreachable": [], "diagnostics": [], "status": "unsupported"}
    if not language:
        result["diagnostics"].append("No grammar selected; only file metadata is available.")
        return result
    try:
        tree = get_parser(language).parse(data)
        root = tree.root_node
    except (LookupError, ValueError, RuntimeError) as error:
        result["diagnostics"].append(f"Grammar unavailable: {error}")
        return result
    result["status"] = "partial" if root.has_error else "parsed"
    if root.has_error:
        errors = [n for n in walk(root) if n.type == "ERROR" or n.is_missing]
        result["diagnostics"].extend(f"Syntax recovery at line {n.start_point.row + 1}: {n.type}" for n in errors[:20])
    symbols_by_node = {}
    for node in walk(root):
        if language == "csharp" and node.type in {"namespace_declaration", "file_scoped_namespace_declaration"}:
            namespace = value(field(node, "name"), data)
            parent = node.parent
            while parent:
                if parent.type == "namespace_declaration":
                    namespace = value(field(parent, "name"), data) + "." + namespace
                parent = parent.parent
            result["namespaces"].append(namespace)
        if node.is_named and node.named_children and node.type in FUNCTIONS | CLASSES:
            kind = "function" if node.type in FUNCTIONS else "class"
            name = symbol_name(node, data)
            parent = node.parent
            owner = None
            while parent:
                if parent.id in symbols_by_node:
                    owner = symbols_by_node[parent.id]
                    break
                parent = parent.parent
            qualified = f"{owner['name']}.{name}" if owner else name
            body = field(node, "body")
            declaration_end = body.start_byte if body else node.end_byte
            signature = " ".join(data[node.start_byte:declaration_end].decode("utf-8", "replace").split())[:500]
            symbol = {"id": f"{path}:{node.start_point.row + 1}:{node.start_point.column + 1}",
                      "name": qualified, "short_name": name, "kind": kind, "path": path,
                      "signature": signature,
                      "line": node.start_point.row + 1, "end_line": node.end_point.row + 1,
                      "parent": owner["id"] if owner else None,
                      "confidence": "medium" if node.has_error else "high"}
            if kind == "function":
                symbol["metrics"] = function_metrics(body or node, data)
            symbols_by_node[node.id] = symbol
            result["symbols"].append(symbol)
        if node.type in IMPORTS:
            result["imports"].extend(dict(item, line=node.start_point.row + 1) for item in imports_for(node, data, language))
        if node.type in {"block", "statement_block", "compound_statement"} and not node.has_error:
            terminated = False
            for statement in node.named_children:
                if statement.type == "comment":
                    continue
                if terminated and statement.type not in FUNCTIONS | CLASSES | {"labeled_statement", "case_statement"}:
                    result["unreachable"].append({"line": statement.start_point.row + 1,
                                                  "evidence": "Statement follows an unconditional control-flow exit in the same block."})
                if statement.type in {"return_statement", "raise_statement", "throw_statement", "break_statement", "continue_statement"}:
                    terminated = True
        if node.type in CALLS:
            callee = field(node, "function", "name", "expression")
            if callee is None:
                continue
            target = value(callee, data)
            # CommonJS and dynamic imports are recognized as syntax-level calls.
            if language in {"javascript", "typescript", "tsx"} and target in {"require", "import"}:
                arguments = field(node, "arguments")
                if arguments:
                    strings = [n for n in arguments.named_children if n.type == "string"]
                    result["imports"].extend({"target": value(n, data).strip("\"'"), "names": [],
                                              "line": node.start_point.row + 1} for n in strings)
            parent = node.parent
            owner = None
            while parent:
                if parent.id in symbols_by_node:
                    owner = symbols_by_node[parent.id]["id"]
                    break
                parent = parent.parent
            result["references"].append({"target": target, "caller": owner, "line": node.start_point.row + 1,
                                         "kind": "call"})
    counts = Counter(s["kind"] for s in result["symbols"])
    result["metrics"] = {"functions": counts["function"], "classes": counts["class"],
                         "cyclomatic": sum(s.get("metrics", {}).get("cyclomatic", 0) for s in result["symbols"])}
    return result
