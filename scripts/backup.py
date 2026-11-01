#!/usr/bin/env python3
"""Create a consistent, integrity-checked SQLite backup."""

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


DATABASE_PATH = Path(
    os.environ.get("BREWCLUB_DATABASE", Path.home() / ".brewclub" / "customers.sqlite3")
).resolve()


def create_backup(database_path: Path, backup_directory: Path) -> Path:
    if not database_path.is_file():
        raise FileNotFoundError(f"Database tidak ditemukan: {database_path}")
    backup_directory.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    destination = backup_directory / f"brewclub-{timestamp}.sqlite3"
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=".brewclub-backup-", suffix=".tmp", dir=backup_directory
    )
    os.close(file_descriptor)
    temporary_path = Path(temporary_name)

    try:
        source = sqlite3.connect(database_path, timeout=10)
        target = sqlite3.connect(temporary_path, timeout=10)
        try:
            source.backup(target)
            result = target.execute("PRAGMA quick_check").fetchone()
            if not result or result[0] != "ok":
                raise RuntimeError(f"Pemeriksaan integritas backup gagal: {result}")
        finally:
            target.close()
            source.close()
        temporary_path.replace(destination)
        return destination
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def main() -> int:
    backup_directory = Path(sys.argv[1] if len(sys.argv) > 1 else "./backups").resolve()
    destination = create_backup(DATABASE_PATH, backup_directory)
    print(f"Backup berhasil dibuat: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
