#!/usr/bin/env python3
"""Single-shop, loopback-only, revisioned ledger storage. Python standard library only."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import threading
import uuid

COLLECTIONS = {'goods', 'customers', 'suppliers', 'sales_orders', 'purchase_orders', 'inventory_logs', 'settings'}
MAX_BYTES = 8 * 1024 * 1024


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False).encode('utf-8')


def validate(payload):
    if not isinstance(payload, dict) or set(payload) - {'collections', 'sequence'}:
        raise APIError(400, 'Expected collections and optional sequence')
    collections = payload.get('collections')
    if not isinstance(collections, dict) or set(collections) - COLLECTIONS:
        raise APIError(400, 'Unknown collection or invalid collections object')
    sequence = payload.get('sequence', 0)
    if type(sequence) is not int or not 0 <= sequence <= 2**53 - 1:
        raise APIError(400, 'Invalid sequence')
    for name, rows in collections.items():
        if not isinstance(rows, list) or len(rows) > 50000:
            raise APIError(400, 'Invalid collection rows: ' + name)
        seen = set()
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get('_id'), str) or not 1 <= len(row['_id']) <= 128:
                raise APIError(400, 'Every row requires a nonempty _id: ' + name)
            if row['_id'] in seen:
                raise APIError(400, 'Duplicate _id: ' + name)
            seen.add(row['_id'])
    return {'collections': collections, 'sequence': sequence}


class Ledger:
    def __init__(self, filename, history_limit=30):
        self.filename = str(filename)
        self.history_limit = history_limit
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS ledger (
                    id INTEGER PRIMARY KEY CHECK(id=1), store_id TEXT NOT NULL,
                    revision INTEGER NOT NULL, payload BLOB NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS history (
                    revision INTEGER PRIMARY KEY, payload BLOB NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS requests (
                    id TEXT PRIMARY KEY, digest TEXT NOT NULL, response BLOB NOT NULL,
                    revision INTEGER NOT NULL
                );
            ''')
            db.execute('INSERT OR IGNORE INTO ledger VALUES (1, ?, 0, ?, ?)',
                       ('danjie-' + uuid.uuid4().hex, encode({'collections': {}, 'sequence': 0}), self.now()))

    @staticmethod
    def now():
        return datetime.now(timezone.utc).isoformat()

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.filename, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA synchronous=FULL')
        try:
            yield db
        finally:
            db.close()

    def get(self):
        with self.connection() as db:
            row = db.execute('SELECT * FROM ledger WHERE id=1').fetchone()
            return dict(json.loads(row['payload']), revision=row['revision'], storeId=row['store_id'], updatedAt=row['updated_at'])

    def history(self, revision=None):
        with self.connection() as db:
            if revision is None:
                return {'history': [dict(row) for row in db.execute('SELECT revision, updated_at AS updatedAt FROM history ORDER BY revision DESC')]}
            row = db.execute('SELECT * FROM history WHERE revision=?', (revision,)).fetchone()
            if row is None:
                raise APIError(404, 'Revision is not retained')
            return dict(json.loads(row['payload']), revision=row['revision'], updatedAt=row['updated_at'])

    def put(self, payload, expected, key):
        data = encode(validate(payload))
        digest = hashlib.sha256(str(expected).encode() + b'\n' + data).hexdigest()
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                previous = db.execute('SELECT * FROM requests WHERE id=?', (key,)).fetchone()
                if previous is not None:
                    if previous['digest'] != digest:
                        raise APIError(409, 'Idempotency key was used for a different request')
                    db.execute('ROLLBACK')
                    return json.loads(previous['response'])
                row = db.execute('SELECT revision FROM ledger WHERE id=1').fetchone()
                if expected != row['revision']:
                    raise APIError(409, 'State changed on another device; reload before saving')
                revision, timestamp = expected + 1, self.now()
                result = {'success': True, 'revision': revision, 'updatedAt': timestamp}
                db.execute('UPDATE ledger SET revision=?, payload=?, updated_at=? WHERE id=1', (revision, data, timestamp))
                db.execute('INSERT INTO history VALUES (?, ?, ?)', (revision, data, timestamp))
                db.execute('INSERT INTO requests VALUES (?, ?, ?, ?)', (key, digest, encode(result), revision))
                db.execute('DELETE FROM history WHERE revision <= ?', (revision - self.history_limit,))
                db.execute('DELETE FROM requests WHERE revision <= ?', (revision - 10000,))
                db.execute('COMMIT')
                return result
            except Exception:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                raise


class LimitedServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address, handler):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, handler)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = 'DanjieStorage/1'

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, fmt, *args):
        # Do not log tokens, query strings, or ledger content.
        pass

    def respond(self, status, data):
        body = encode(data)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def dispatch(self):
        try:
            if self.command == 'GET' and self.path == '/healthz':
                with self.server.ledger.connection() as db:
                    db.execute('SELECT revision FROM ledger WHERE id=1').fetchone()
                return self.respond(200, {'status': 'ok', 'service': 'danjie-miniapp-storage'})
            supplied = self.headers.get('Authorization', '').encode('utf-8')
            expected = ('Bearer ' + self.server.token).encode('utf-8')
            if not hmac.compare_digest(supplied, expected):
                raise APIError(401, 'Authentication required')
            if self.command == 'GET' and self.path == '/v1/state':
                return self.respond(200, self.server.ledger.get())
            if self.command == 'GET' and self.path == '/v1/history':
                return self.respond(200, self.server.ledger.history())
            match = re.fullmatch(r'/v1/history/(\d{1,12})', self.path)
            if self.command == 'GET' and match:
                return self.respond(200, self.server.ledger.history(int(match.group(1))))
            if self.command != 'PUT' or self.path != '/v1/state':
                raise APIError(404, 'Unknown endpoint')
            version = self.headers.get('If-Match')
            if version is None:
                raise APIError(428, 'If-Match revision is required')
            if not re.fullmatch(r'\d{1,12}', version):
                raise APIError(400, 'Invalid revision')
            key = self.headers.get('Idempotency-Key', '')
            if not re.fullmatch(r'[a-zA-Z0-9_-]{8,128}', key):
                raise APIError(400, 'A unique Idempotency-Key is required')
            length = self.headers.get('Content-Length', '')
            if not length.isdigit() or self.headers.get('Transfer-Encoding'):
                raise APIError(411, 'Content-Length is required')
            length = int(length)
            if not 0 < length <= self.server.max_bytes:
                raise APIError(413, 'Request exceeds ledger size limit')
            if self.headers.get_content_type() != 'application/json':
                raise APIError(415, 'Expected application/json')
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise APIError(400, 'Incomplete request')
            try:
                def invalid_constant(value):
                    raise ValueError('Invalid number')
                payload = json.loads(raw, parse_constant=invalid_constant)
            except (ValueError, UnicodeError, RecursionError):
                raise APIError(400, 'Invalid JSON')
            return self.respond(200, self.server.ledger.put(payload, int(version), key))
        except APIError as error:
            self.respond(error.status, {'error': error.message})
        except (ConnectionError, TimeoutError):
            self.close_connection = True
        except Exception:
            logging.exception('Ledger operation failed')
            self.respond(500, {'error': 'Storage operation failed; no success has been confirmed'})

    do_GET = dispatch
    do_PUT = dispatch


def create_server(filename, token, port=18473, history_limit=30, max_bytes=MAX_BYTES):
    if not isinstance(token, str) or len(token) < 32 or not token.isascii():
        raise ValueError('Token must be at least 32 ASCII characters')
    if not 1 <= history_limit <= 100:
        raise ValueError('Invalid history limit')
    server = LimitedServer(('127.0.0.1', port), Handler)
    try:
        server.ledger = Ledger(filename, history_limit)
        server.token = token
        server.max_bytes = max_bytes
        return server
    except BaseException:
        server.server_close()
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='/etc/danjie-miniapp/storage.json')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding='utf-8'))
    os.umask(0o077)
    server = create_server(config['database'], config['token'], port=config.get('port', 18473))
    logging.info('Danjie storage is listening on loopback port %s', server.server_address[1])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    main()
