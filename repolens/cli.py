import argparse
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from .analysis import compare, scan
from .cache import Cache
from .export import export_report, generate_readme, mermaid
from .repository import history, resolve_revision, source


def parser():
    app = argparse.ArgumentParser(prog="repolens", description="Local multilingual repository intelligence")
    commands = app.add_subparsers(dest="command", required=True)
    for name in ("scan", "compare", "history", "trends", "export", "readme", "source", "tui"):
        command = commands.add_parser(name)
        command.add_argument("root", nargs="?", default=".")
        command.add_argument("--revision", help="Analyze a commit or branch without modifying its checkout")
        command.add_argument("--cache", help="SQLite cache path (defaults outside the analyzed repository)")
        command.add_argument("--json", action="store_true", help="Machine-readable output")
        command.add_argument("--history-limit", type=int, default=100)
        command.add_argument("--include", action="append", default=[], help="Include a path glob; repeat for multiple patterns")
        command.add_argument("--language", action="append", default=[], metavar="SUFFIX=GRAMMAR", help="Register an additional extension/Tree-sitter grammar")
        if name == "compare":
            command.add_argument("--base", required=True)
            command.add_argument("--other-root", help="Compare another repository instead of a revision")
        elif name == "trends":
            command.add_argument("--revisions", nargs="*", help="Analyze these revisions in order; otherwise list cached snapshots")
        elif name == "export":
            command.add_argument("--format", choices=["json", "graphml", "mermaid"], default="json")
            command.add_argument("--level", choices=["repository", "directory", "module", "class", "function"], default="module")
            command.add_argument("--output")
        elif name == "readme":
            command.add_argument("--output", help="Root README.md path")
        elif name == "source":
            command.add_argument("--path", required=True)
            command.add_argument("--line", type=int, default=1)
            command.add_argument("--count", type=int, default=40)
            command.add_argument("--highlight", action="store_true", help="Return raw source lines and syntax-color spans")
    return app


def scan_args(args):
    overrides = {}
    for entry in args.language:
        suffix, separator, grammar = entry.partition("=")
        if not separator or not suffix.startswith(".") or not grammar:
            raise ValueError("Language registration must be .extension=grammar")
        overrides[suffix.lower()] = grammar
    return {"cache_path": args.cache, "overrides": overrides, "includes": args.include,
            "history_limit": args.history_limit, "progress": lambda message: print(message, file=sys.stderr)}


def print_summary(report):
    summary = report["summary"]
    print(f"RepoLens · {report['root']} · {report['revision']}")
    print(f"{summary['files']} files / {summary['lines']} lines / {summary['symbols']} symbols")
    print(f"{summary['module_edges']} module edges / {summary['cycles']} circular components / {summary['warnings']} warnings")
    print(f"Coverage: {summary['coverage']}")
    print(f"Incremental: {report['incremental']['analyzed']} analyzed / {report['incremental']['cached']} cached")
    for finding in report["findings"][:20]:
        print(f"  {finding['severity'].upper()} {finding['path']}:{finding['line']} {finding['message']} [{finding['confidence']}]")
    print("Run scan --json or launch tui for full evidence, diagnostics, and coverage boundaries.")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    args = parser().parse_args()
    try:
        if args.history_limit < 1 or args.history_limit > 10000:
            raise ValueError("History limit must be between 1 and 10000")
        options = scan_args(args)
        if args.command == "tui":
            entry = Path(__file__).resolve().parent.parent / "tui" / "dist" / "index.js"
            if not entry.exists():
                raise ValueError("TUI is not built; run npm ci and npm run build in tui/, or scripts/setup.ps1")
            env = dict(os.environ, REPOLENS_PYTHON=sys.executable)
            command = ["node", str(entry), str(Path(args.root).resolve())]
            if args.revision:
                command.extend(["--revision", args.revision])
            if args.cache:
                command.extend(["--cache", str(Path(args.cache).resolve())])
            raise SystemExit(subprocess.call(command, env=env))
        if args.command == "source":
            if args.line < 1 or not 1 <= args.count <= 500:
                raise ValueError("Source line must be positive; count must be between 1 and 500")
            result = source(args.root, args.path, args.revision, args.line, args.count, args.highlight)
        elif args.command == "history":
            result = history(Path(args.root).resolve(), args.history_limit, args.revision)
        elif args.command == "trends":
            if args.revisions:
                result = [{"revision": report["revision"], "summary": report["summary"]}
                          for report in (scan(args.root, revision, **options) for revision in args.revisions)]
            else:
                cache = Cache(args.cache)
                try:
                    result = cache.snapshots(args.root)
                finally:
                    cache.close()
        elif args.command == "compare":
            before = scan(args.root, args.base, **options)
            after = scan(args.other_root or args.root, args.revision, **options)
            result = compare(before, after)
        else:
            report = scan(args.root, args.revision, **options)
            if args.command == "export":
                if args.format == "mermaid":
                    if args.output:
                        raise ValueError("Mermaid is emitted to stdout; README generation embeds the diagram")
                    result = mermaid(report, args.level)
                else:
                    if not args.output:
                        raise ValueError("Export requires --output")
                    result = {"output": export_report(report, args.output, args.format, args.level)}
            elif args.command == "readme":
                result = {"output": generate_readme(report, args.output or str(Path(args.root) / "README.md"))}
            elif not args.json:
                print_summary(report)
                return
            else:
                result = report
        if args.json:
            print(json.dumps(result, ensure_ascii=True))
        elif isinstance(result, str):
            print(result)
        else:
            print(json.dumps(result, indent=2, ensure_ascii=True))
    except (ValueError, OSError, sqlite3.Error, subprocess.TimeoutExpired) as error:
        if args.json:
            print(json.dumps({"error": str(error)}), file=sys.stderr)
        else:
            print(f"RepoLens: {error}", file=sys.stderr)
        raise SystemExit(1)
