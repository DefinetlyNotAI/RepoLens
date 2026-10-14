import os
import subprocess
from pathlib import Path, PurePosixPath


EXCLUDED = {".git", ".venv", "venv", "node_modules", "__pycache__", ".next", "dist", "build",
            "target", "vendor", ".repolens", ".idea", ".vscode", "coverage", "graphify-out"}
MAX_BYTES = 2 * 1024 * 1024


def git(root, *args, binary=False):
    completed = subprocess.run(["git", "-C", str(root), *args], capture_output=True, timeout=120)
    if completed.returncode:
        raise ValueError(completed.stderr.decode("utf-8", "replace").strip() or "Git command failed")
    return completed.stdout if binary else completed.stdout.decode("utf-8", "replace").strip()


def is_git(root):
    try:
        return git(root, "rev-parse", "--is-inside-work-tree") == "true"
    except (ValueError, FileNotFoundError):
        return False


def resolve_revision(root, revision):
    return git(root, "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}")


def git_prefix(root):
    return git(root, "rev-parse", "--show-prefix")


def discover(root, revision=None, includes=()):
    root = Path(root).resolve()
    diagnostics = []
    blobs = {}
    if revision:
        prefix = git_prefix(root)
        listing = git(root, "ls-tree", "--full-tree", "-r", "-l", "-z", revision, binary=True)
        paths = []
        for entry in listing.split(b"\0"):
            if not entry:
                continue
            metadata, name = entry.split(b"\t", 1)
            mode, kind, object_id, size = metadata.split()
            if mode not in {b"100644", b"100755"} or kind != b"blob":
                continue
            path = name.decode("utf-8", "surrogateescape")
            if prefix and not path.startswith(prefix):
                continue
            path = path[len(prefix):]
            paths.append(path)
            blobs[path] = (object_id, int(size))
    elif is_git(root):
        paths = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", binary=True).decode("utf-8", "surrogateescape").split("\0")
    else:
        paths = []
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in EXCLUDED and not d.endswith(".egg-info")
                             and not (Path(directory) / d).is_symlink())
            paths.extend((Path(directory) / f).relative_to(root).as_posix() for f in files)
    batch = subprocess.Popen(["git", "-C", str(root), "cat-file", "--batch"], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE) if revision else None
    try:
        for name in sorted(set(paths)):
            if not name or any(p in EXCLUDED or p.endswith(".egg-info") for p in PurePosixPath(name).parts):
                continue
            if includes and not any(PurePosixPath(name).match(pattern) for pattern in includes):
                continue
            try:
                if batch:
                    object_id, size = blobs[name]
                    if size > MAX_BYTES:
                        diagnostics.append(f"Skipped oversized file: {name}")
                        continue
                    batch.stdin.write(object_id + b"\n")
                    batch.stdin.flush()
                    header = batch.stdout.readline().split()
                    if len(header) != 3 or header[1] != b"blob":
                        raise ValueError("Git object is not available as a blob")
                    data = batch.stdout.read(int(header[2]))
                    batch.stdout.read(1)
                else:
                    path = root / name
                    if path.is_symlink() or not path.is_file():
                        continue
                    if not path.resolve().is_relative_to(root):
                        continue
                    if path.stat().st_size > MAX_BYTES:
                        diagnostics.append(f"Skipped oversized file: {name}")
                        continue
                    data = path.read_bytes()
                if b"\0" in data[:8192]:
                    diagnostics.append(f"Skipped binary file: {name}")
                    continue
                yield name, data, diagnostics
            except (OSError, ValueError) as error:
                diagnostics.append(f"Could not read {name}: {error}")
    finally:
        if batch:
            batch.stdin.close()
            try:
                batch.wait(timeout=10)
            except subprocess.TimeoutExpired:
                batch.kill()
                batch.wait()
            batch.stdout.close()
            batch.stderr.close()
    yield None, None, diagnostics


def history(root, limit=100, revision=None, offset=0):
    if not is_git(root):
        return {"commits": [], "branches": [], "churn": {}, "diagnostics": ["No Git repository."]}
    try:
        head = resolve_revision(root, revision or "HEAD")
    except ValueError:
        return {"commits": [], "branches": [], "churn": {}, "diagnostics": ["No commits available."]}
    log = git(root, "log", f"-{limit}", f"--skip={offset}", "--format=%H%x09%aI%x09%s", head)
    commits = []
    for line in log.splitlines():
        commit, date, subject = line.split("\t", 2)
        commits.append({"revision": commit, "date": date, "subject": subject})
    if offset:
        return {"commits": commits, "branches": [], "churn": {}, "diagnostics": []}
    raw = git(root, "log", f"-{limit}", "--format=COMMIT:%H", "--numstat", "-z", head, binary=True)
    prefix = git_prefix(root)
    churn = {}
    seen = set()
    for entry in raw.decode("utf-8", "replace").split("\0"):
        entry = entry.lstrip("\n")
        if entry.startswith("COMMIT:"):
            seen.clear()
            continue
        parts = entry.split("\t", 2)
        if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
            continue
        added, removed, name = parts
        if not name:
            # Git represents renames as three NUL records; counts are not attributed incorrectly.
            continue
        if prefix and not name.startswith(prefix):
            continue
        name = name[len(prefix):]
        item = churn.setdefault(name, {"added": 0, "removed": 0, "commits": 0})
        item["added"] += int(added)
        item["removed"] += int(removed)
        if name not in seen:
            item["commits"] += 1
            seen.add(name)
    branches = git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes").splitlines()
    return {"commits": commits, "branches": branches, "churn": churn,
            "diagnostics": ["Churn covers the selected commit window; rename-only paths are omitted."]}


def source(root, path, revision=None, start=1, count=40, highlight=False):
    root = Path(root).resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root):
        raise ValueError("Source path must stay inside the repository")
    relative = target.relative_to(root).as_posix()
    data = git(root, "show", f"{resolve_revision(root, revision)}:{git_prefix(root)}{relative}", binary=True) if revision else target.read_bytes()
    if len(data) > MAX_BYTES:
        raise ValueError("Source exceeds the 2 MiB preview limit")
    if highlight:
        from .parser import highlight_lines
        return highlight_lines(relative, data, start, count)
    lines = data.decode("utf-8", "replace").splitlines()
    return "\n".join(f"{i + 1:5}  {line}" for i, line in enumerate(lines) if start - 1 <= i < start - 1 + count)
