#!/usr/bin/env python3
"""Create an online SQLite backup within the service's own directory."""
from datetime import datetime, timezone
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid


def create_backup(database, backup_dir, keep=14):
    database, backup_dir = Path(database).resolve(strict=True), Path(backup_dir).resolve(strict=True)
    if not database.is_file() or not backup_dir.is_dir() or not 1 <= keep <= 365:
        raise ValueError('Invalid backup configuration')
    # Only service-named, non-symlink partials inactive for over 48 hours are stale.
    for old in backup_dir.iterdir():
        if (re.fullmatch(r'ledger-\d{8}T\d{6}Z-[a-f0-9]{12}\.sqlite3\.partial', old.name)
                and not old.is_symlink() and old.is_file() and old.stat().st_mtime < time.time() - 48 * 3600):
            old.unlink()
    name = 'ledger-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:12] + '.sqlite3'
    temporary = backup_dir / (name + '.partial')
    target = backup_dir / name
    temporary.touch(mode=0o600, exist_ok=False)
    try:
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as src:
            with closing(sqlite3.connect(temporary)) as dst:
                src.backup(dst)
                if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Backup integrity verification failed')
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    retained = sorted((p for p in backup_dir.iterdir() if re.fullmatch(r'ledger-\d{8}T\d{6}Z-[a-f0-9]{12}\.sqlite3', p.name)
                       and p.is_file() and not p.is_symlink()), key=lambda p: p.stat().st_mtime_ns, reverse=True)
    for old in retained[keep:]:
        old.unlink()
    return target


if __name__ == '__main__':
    os.umask(0o077)
    config = json.loads(Path('/etc/danjie-miniapp/storage.json').read_text())
    print('Backup verified:', create_backup(config['database'], '/var/backups/danjie-miniapp').name)
