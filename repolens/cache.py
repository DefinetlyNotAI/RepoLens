import json
import os
import sqlite3
from pathlib import Path


ENGINE_VERSION = "9"


class Cache:
    def __init__(self, path=None):
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache")) / "RepoLens"
        target = Path(path) if path else base / "analysis.sqlite3"
        target.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(target, timeout=30, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, root TEXT NOT NULL, revision TEXT NOT NULL, created TEXT NOT NULL, payload TEXT NOT NULL)")

    def file(self, key):
        row = self.db.execute("SELECT payload FROM files WHERE key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def put_file(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO files VALUES (?, ?)", (key, json.dumps(value)))

    def save(self, report):
        self.db.execute("INSERT INTO snapshots (root, revision, created, payload) VALUES (?, ?, ?, ?)",
                        (report["root"], report["revision"], report["created"], json.dumps(report)))
        self.db.commit()

    def snapshots(self, root):
        rows = self.db.execute("SELECT id, revision, created, payload FROM snapshots WHERE root = ? ORDER BY id DESC LIMIT 100", (str(Path(root).resolve()),)).fetchall()
        return [{"id": i, "revision": revision, "created": created, "summary": json.loads(payload)["summary"]}
                for i, revision, created, payload in rows]

    def close(self):
        self.db.close()
