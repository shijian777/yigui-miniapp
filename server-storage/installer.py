#!/usr/bin/env python3
"""First install only. Abort on collisions; never touch another application's files."""
import grp
import http.client
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import socket
import subprocess
import sys
import time

HOSTNAME = 'instance-20260830-154059'
PORT = 18473
USER = 'danjie-miniapp'
APP = Path('/opt/danjie-miniapp')
DATA = Path('/var/lib/danjie-miniapp')
CONFIG = Path('/etc/danjie-miniapp')
BACKUPS = Path('/var/backups/danjie-miniapp')
UNITS = Path('/etc/systemd/system')
UNIT_NAMES = ['danjie-miniapp.service', 'danjie-miniapp-backup.service', 'danjie-miniapp-backup.timer']


def run(*args):
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(args) + '\n' + result.stderr.strip())
    return result.stdout


def listeners():
    return {row.split()[3] for row in run('ss', '-H', '-lnt').splitlines() if len(row.split()) >= 4}


def exclusive_write(path, content, mode=0o644):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(content)
    path.chmod(mode)


def preflight():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('Run with sudo on the designated Linux server.')
    if socket.gethostname().split('.')[0] != HOSTNAME:
        raise RuntimeError('Host mismatch: refusing to install on an unverified server.')
    if sys.version_info < (3, 10):
        raise RuntimeError('Python 3.10+ is required. No system packages were changed.')
    if not Path('/run/systemd/system').is_dir():
        raise RuntimeError('systemd is required.')
    for tool in ['ss', 'systemctl', 'useradd']:
        if not shutil.which(tool):
            raise RuntimeError('Missing required tool: ' + tool)
    for path in [APP, DATA, CONFIG, BACKUPS] + [UNITS / name for name in UNIT_NAMES]:
        if path.exists() or path.is_symlink():
            raise RuntimeError('Existing path: ' + str(path) + '. No overwrite performed.')
    try:
        pwd.getpwnam(USER)
    except KeyError:
        pass
    else:
        raise RuntimeError('Application user already exists; review its purpose first.')
    try:
        grp.getgrnam(USER)
    except KeyError:
        pass
    else:
        raise RuntimeError('Application group already exists; review its purpose first.')
    for unit in UNIT_NAMES:
        probe = subprocess.run(['systemctl', 'show', unit, '--property=LoadState', '--value'], text=True, capture_output=True)
        state = probe.stdout.strip()
        if state != 'not-found':
            raise RuntimeError('Service name is not confirmed unused: ' + unit + '\n' + probe.stderr.strip())
    if any(address.rsplit(':', 1)[-1] == str(PORT) for address in listeners()):
        raise RuntimeError('Candidate TCP port is already listening.')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', PORT))
    for directory in ['/etc/systemd/system', '/usr/lib/systemd/system', '/etc/caddy', '/etc/nginx']:
        base = Path(directory)
        if base.is_dir():
            for path in base.rglob('*'):
                if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
                    continue
                if str(PORT) in path.read_text(errors='ignore'):
                    raise RuntimeError('Candidate port mentioned in existing configuration: ' + str(path))
    if shutil.disk_usage('/var/lib').free < 5 * 1024**3:
        raise RuntimeError('Less than 5 GB free disk space for the ledger and retained backups.')
    return listeners()


def units(python):
    service = f'''[Unit]
Description=Danjie miniapp isolated ledger storage
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User={USER}
Group={USER}
WorkingDirectory={APP}
ExecStart={python} -B {APP}/storage_server.py --config {CONFIG}/storage.json
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={DATA}
RestrictAddressFamilies=AF_INET AF_UNIX
MemoryMax=256M
CPUQuota=25%
TasksMax=32
LogRateLimitIntervalSec=30s
LogRateLimitBurst=30

[Install]
WantedBy=multi-user.target
'''
    backup = f'''[Unit]
Description=Daily online backup for Danjie ledger only

[Service]
Type=oneshot
User={USER}
Group={USER}
ExecStart={python} -B {APP}/backup.py
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={DATA} {BACKUPS}
MemoryMax=256M
CPUQuota=25%
'''
    timer = '''[Unit]
Description=Daily backup schedule for Danjie miniapp

[Timer]
OnCalendar=*-*-* 03:20:00 UTC
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
'''
    return [service, backup, timer]


def get_state(token):
    connection = http.client.HTTPConnection('127.0.0.1', PORT, timeout=3)
    try:
        connection.request('GET', '/v1/state', headers={'Authorization': 'Bearer ' + token})
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError('Authenticated health verification failed: ' + str(response.status))
        return json.loads(response.read())
    finally:
        connection.close()


def wait_ready(token):
    for _ in range(20):
        try:
            return get_state(token)
        except (OSError, RuntimeError):
            time.sleep(0.5)
    raise RuntimeError('New storage service did not become ready.')


def main():
    print('Preflight: checking host, paths, services, port, and free space.', flush=True)
    before = preflight()
    source = Path(__file__).resolve().parent
    python = str(Path(sys.executable).resolve())
    print('Testing real HTTP reads/writes and restart persistence on temporary databases.', flush=True)
    subprocess.run([python, '-B', str(source / 'test_storage.py')], check=True, cwd=source)
    # Recheck immediately before any writes, after test servers are closed.
    preflight()
    os.umask(0o077)
    for directory in [APP, CONFIG, DATA, BACKUPS]:
        directory.mkdir(mode=0o700)
    run('useradd', '--system', '--user-group', '--home-dir', str(DATA), '--no-create-home', '--shell', '/usr/sbin/nologin', USER)
    account = pwd.getpwnam(USER)
    for directory in [DATA, BACKUPS]:
        os.chown(directory, account.pw_uid, account.pw_gid)
    APP.chmod(0o755)
    CONFIG.chmod(0o750)
    os.chown(CONFIG, 0, account.pw_gid)
    for filename in ['storage_server.py', 'backup.py', 'README.md']:
        exclusive_write(APP / filename, (source / filename).read_text(encoding='utf-8'))
    token = secrets.token_urlsafe(48)
    config = {'port': PORT, 'database': str(DATA / 'ledger.sqlite3'), 'token': token}
    exclusive_write(CONFIG / 'storage.json', json.dumps(config, indent=2), mode=0o640)
    os.chown(CONFIG / 'storage.json', 0, account.pw_gid)
    for name, content in zip(UNIT_NAMES, units(python)):
        exclusive_write(UNITS / name, content)
    run('systemctl', 'daemon-reload')
    try:
        run('systemctl', 'enable', '--now', UNIT_NAMES[0])
        initial = wait_ready(token)
        run('systemctl', 'restart', UNIT_NAMES[0])
        restarted = wait_ready(token)
        if initial != restarted or restarted['revision'] != 0:
            raise RuntimeError('Fresh service persistence verification failed.')
        run('systemctl', 'start', UNIT_NAMES[1])
        run('systemctl', 'enable', '--now', UNIT_NAMES[2])
        after = listeners()
        missing = sorted(before - after)
        if missing:
            raise RuntimeError('Previously listening ports disappeared; manual review required: ' + repr(missing))
        report = {'host': HOSTNAME, 'port': PORT, 'bind': '127.0.0.1', 'database': str(DATA / 'ledger.sqlite3'),
                  'existingListenersBefore': sorted(before), 'listenersAfter': sorted(after),
                  'temporaryDatabaseTests': 'passed', 'restartPersistence': 'passed', 'backup': 'passed',
                  'productionRevision': restarted['revision'], 'clientConnected': False}
        exclusive_write(APP / 'install-report.json', json.dumps(report, indent=2))
    except BaseException:
        for unit in [UNIT_NAMES[0], UNIT_NAMES[2]]:
            subprocess.run(['systemctl', 'disable', '--now', unit], capture_output=True)
        print('Verification failed. Only new Danjie services were stopped; created files/data are retained.', file=sys.stderr)
        raise
    print('INSTALL_OK: 127.0.0.1:18473; database is empty; restart and backup verified.')
    print('Existing listening addresses remain present. No firewall/Caddy settings were edited.')
    print('Config/token location: /etc/danjie-miniapp/storage.json (do not post this file).')
    print('Report: /opt/danjie-miniapp/install-report.json')
    print('Next: HTTPS/domain and miniapp client integration, then verified data migration.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('INSTALL_STOPPED:', error, file=sys.stderr)
        sys.exit(1)
