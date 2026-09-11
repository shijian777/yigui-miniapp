import concurrent.futures
import http.client
import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest

SOURCE = pathlib.Path(__file__).with_name('storage_server.py')
spec = importlib.util.spec_from_file_location('storage_server', SOURCE) if SOURCE.exists() else None
engine = importlib.util.module_from_spec(spec) if spec else None
if spec:
    spec.loader.exec_module(engine)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(engine, 'The isolated storage server has not been implemented')
        self.tmp = tempfile.TemporaryDirectory(prefix='danjie-storage-test-')
        self.addCleanup(self.tmp.cleanup)
        self.db = pathlib.Path(self.tmp.name) / 'ledger.sqlite3'
        self.token = 'test-only-token-' + 'a' * 48
        self.start_server()
        self.addCleanup(self.stop_server)

    def start_server(self):
        self.server = engine.create_server(self.db, self.token, port=0, history_limit=3, max_bytes=4096)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop_server(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(5)
            self.server = None

    def request(self, method='GET', url='/v1/state', payload=None, auth=True, revision=None, key=None, raw=None):
        headers = {}
        if auth:
            headers['Authorization'] = 'Bearer ' + self.token
        if revision is not None:
            headers['If-Match'] = str(revision)
        if key:
            headers['Idempotency-Key'] = key
        body = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
        if body is not None:
            headers['Content-Type'] = 'application/json'
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            conn.request(method, url, body=body, headers=headers)
            res = conn.getresponse()
            return res.status, json.loads(res.read())
        finally:
            conn.close()

    def write(self, goods, revision=0, key='request-0001'):
        return self.request('PUT', payload={'collections': {'goods': goods}}, revision=revision, key=key)

    def test_health_and_authentication(self):
        self.assertEqual(self.request(url='/healthz', auth=False)[0], 200)
        self.assertEqual(self.request(auth=False)[0], 401)
        self.assertEqual(self.request()[1]['revision'], 0)

    def test_roundtrip_persistence_across_restart(self):
        self.assertEqual(self.write([{'_id': 'g1', 'name': '测试', 'stock': 10}])[0], 200)
        self.stop_server()
        self.start_server()
        code, data = self.request()
        self.assertEqual(code, 200)
        self.assertEqual(data['revision'], 1)
        self.assertEqual(data['collections']['goods'][0]['stock'], 10)

    def test_stale_version_does_not_overwrite(self):
        self.write([{'_id': 'g1', 'stock': 10}])
        self.assertEqual(self.write([{'_id': 'g1', 'stock': 5}], key='request-0002')[0], 409)
        self.assertEqual(self.request()[1]['collections']['goods'][0]['stock'], 10)

    def test_network_replay_commits_only_once(self):
        a = self.write([{'_id': 'g1'}])
        b = self.write([{'_id': 'g1'}])
        self.assertEqual(a, b)
        self.assertEqual(self.request()[1]['revision'], 1)

    def test_key_reuse_with_different_payload_rejected(self):
        self.write([{'_id': 'g1'}])
        self.assertEqual(self.write([{'_id': 'g2'}])[0], 409)

    def test_two_simultaneous_writes_do_not_lose_updates(self):
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            jobs = [pool.submit(self.write, [{'_id': 'g' + str(i)}], 0, 'request-race-' + str(i)) for i in range(2)]
            codes = sorted(job.result()[0] for job in jobs)
        self.assertEqual(codes, [200, 409])
        self.assertEqual(self.request()[1]['revision'], 1)

    def test_invalid_payload_never_changes_state(self):
        for payload in [{'collections': {'unknown': []}}, {'collections': {'goods': [{'_id': 'x'}, {'_id': 'x'}]}}, {'collections': {'goods': {}}}]:
            self.assertEqual(self.request('PUT', payload=payload, revision=0, key='request-bad-1')[0], 400)
        self.assertEqual(self.request()[1]['revision'], 0)

    def test_missing_version_or_idempotency_key_rejected(self):
        self.assertEqual(self.request('PUT', payload={'collections': {}}, key='request-missing')[0], 428)
        self.assertEqual(self.request('PUT', payload={'collections': {}}, revision=0)[0], 400)

    def test_malformed_or_oversized_json_rejected(self):
        self.assertEqual(self.request('PUT', raw=b'{', revision=0, key='request-invalid')[0], 400)
        self.assertEqual(self.request('PUT', raw=b'x' * 5000, revision=0, key='request-large')[0], 413)
        self.assertEqual(self.request()[1]['revision'], 0)

    def test_atomic_whole_ledger_save_and_rollback_export(self):
        initial = {'collections': {'goods': [{'_id': 'g1', 'stock': 10}], 'sales_orders': []}}
        self.assertEqual(self.request('PUT', payload=initial, revision=0, key='request-ledger1')[0], 200)
        sold = {'collections': {'goods': [{'_id': 'g1', 'stock': 9}], 'sales_orders': [{'_id': 'o1'}]}}
        self.assertEqual(self.request('PUT', payload=sold, revision=1, key='request-ledger2')[0], 200)
        old = self.request(url='/v1/history/1')[1]
        self.assertEqual(old['collections'], initial['collections'])
        restored = self.request('PUT', payload={'collections': old['collections']}, revision=2, key='request-restore')
        self.assertEqual(restored[0], 200)
        self.assertEqual(self.request()[1]['collections'], initial['collections'])

    def test_history_retention_does_not_remove_current_state(self):
        for i in range(5):
            self.assertEqual(self.write([{'_id': 'g1', 'stock': i}], i, 'request-history-' + str(i))[0], 200)
        history = self.request(url='/v1/history')[1]['history']
        self.assertEqual([x['revision'] for x in history], [5, 4, 3])
        self.assertEqual(self.request(url='/v1/history/1')[0], 404)
        self.assertEqual(self.request()[1]['revision'], 5)

    def test_unknown_endpoint_rejected(self):
        self.assertEqual(self.request(url='/../../etc/passwd')[0], 404)

    def test_backup_file_recovers_current_ledger(self):
        import sqlite3
        import backup
        self.write([{'_id': 'g1', 'stock': 12}])
        path = backup.create_backup(self.db, self.tmp.name)
        db = sqlite3.connect(path)
        try:
            self.assertEqual(db.execute('PRAGMA quick_check').fetchone()[0], 'ok')
            data = json.loads(db.execute('SELECT payload FROM ledger WHERE id=1').fetchone()[0])
            self.assertEqual(data['collections']['goods'][0]['stock'], 12)
        finally:
            db.close()

    def test_sqlite_failure_rolls_back_whole_transaction(self):
        import sqlite3
        db = sqlite3.connect(self.db)
        try:
            db.execute("CREATE TRIGGER reject_history BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'injected disk write failure'); END")
            db.commit()
        finally:
            db.close()
        with self.assertLogs(level='ERROR'):
            code, response = self.write([{'_id': 'g1', 'stock': 10}])
        self.assertEqual(code, 500)
        self.assertEqual(self.request()[1]['revision'], 0)
        self.assertEqual(self.request()[1]['collections'], {})

    def test_backup_rotation_leaves_unrelated_files_untouched(self):
        import backup
        unrelated = pathlib.Path(self.tmp.name) / 'other-application.sqlite3'
        unrelated.write_bytes(b'unrelated-data')
        backup.create_backup(self.db, self.tmp.name, keep=1)
        newest = backup.create_backup(self.db, self.tmp.name, keep=1)
        self.assertEqual(unrelated.read_bytes(), b'unrelated-data')
        self.assertTrue(newest.exists())
        self.assertEqual(len(list(pathlib.Path(self.tmp.name).glob('ledger-*.sqlite3'))), 1)

    def test_failed_backup_does_not_leave_partial_files(self):
        from unittest.mock import patch
        import backup
        import sqlite3
        connect = sqlite3.connect

        class FailedSource:
            def backup(self, destination):
                raise sqlite3.OperationalError('injected backup failure')
            def close(self):
                pass

        def controlled_connect(filename, *args, **kwargs):
            return FailedSource() if kwargs.get('uri') else connect(filename, *args, **kwargs)

        with patch.object(backup.sqlite3, 'connect', side_effect=controlled_connect):
            with self.assertRaises(sqlite3.OperationalError):
                backup.create_backup(self.db, self.tmp.name)
        self.assertEqual(list(pathlib.Path(self.tmp.name).glob('*.partial')), [])

    def test_old_interrupted_backup_is_cleaned_but_fresh_partial_is_kept(self):
        import backup
        import os
        import time
        stale = pathlib.Path(self.tmp.name) / 'ledger-20200101T000000Z-aaaaaaaaaaaa.sqlite3.partial'
        fresh = pathlib.Path(self.tmp.name) / 'ledger-20200101T000000Z-bbbbbbbbbbbb.sqlite3.partial'
        for p in [stale, fresh]:
            p.write_bytes(b'partial')
        old_time = time.time() - 72 * 3600
        os.utime(stale, (old_time, old_time))
        backup.create_backup(self.db, self.tmp.name)
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
