const test = require('node:test');
const assert = require('node:assert/strict');
const { createAtomicStorage, SNAPSHOT_KEY } = require('../danjie-connected-miniapp/utils/atomic-storage.js');
function fixture() {
  const data = { cpos_openid: 'owner', __lcloud_goods: [{ _id: 'g', stock: 10 }] };
  let fail = false, writes = 0;
  const wx = { getStorageSync: k => structuredClone(data[k]), setStorageSync(k, v) { if (fail) throw Error('disk full'); writes++; data[k] = structuredClone(v); }, getStorageInfoSync: () => ({ keys: Object.keys(data) }) };
  return { wx, data, api: createAtomicStorage(wx), fail: () => { fail = true; }, writes: () => writes };
}
test('legacy reads do not rewrite or remove old storage; related writes commit once', async () => {
  const f = fixture(); assert.equal(f.api.getStorageSync('__lcloud_goods')[0].stock, 10); assert.equal(f.writes(), 0);
  await f.api.transaction(async () => { f.api.setStorageSync('__lcloud_goods', [{ _id: 'g', stock: 9 }]); f.api.setStorageSync('__lcloud_sales_orders', [{ _id: 'o' }]); });
  assert.equal(f.writes(), 1); assert.equal(f.data.__lcloud_goods[0].stock, 10);
  assert.equal(createAtomicStorage(f.wx).getStorageSync('__lcloud_goods')[0].stock, 9);
});
test('failure response and thrown exception roll back all staged changes', async () => {
  const f = fixture();
  await f.api.transaction(async () => { f.api.setStorageSync('__lcloud_goods', []); return { success: false }; });
  await assert.rejects(f.api.transaction(async () => { f.api.setStorageSync('__lcloud_goods', []); throw Error('bad line'); }));
  assert.equal(f.api.getStorageSync('__lcloud_goods').length, 1); assert.equal(f.writes(), 0);
});
test('disk failure preserves committed state and next read reports the old stock', async () => {
  const f = fixture(); await f.api.transaction(async () => f.api.setStorageSync('__lcloud___seq', 2)); f.fail();
  await assert.rejects(f.api.transaction(async () => f.api.setStorageSync('__lcloud_goods', [])), /disk full/);
  assert.equal(f.api.getStorageSync('__lcloud_goods')[0].stock, 10);
});
test('concurrent transactions serialize and failed job does not poison the queue', async () => {
  const f = fixture();
  const jobs = Array.from({ length: 5 }, () => f.api.transaction(async () => { const rows = f.api.getStorageSync('__lcloud_goods'); await Promise.resolve(); rows[0].stock--; f.api.setStorageSync('__lcloud_goods', rows); }));
  await Promise.all(jobs); assert.equal(f.api.getStorageSync('__lcloud_goods')[0].stock, 5);
});
test('malformed snapshot and storage read errors never silently become empty data', () => {
  const f = fixture(); f.data[SNAPSHOT_KEY] = { version: 99 };
  assert.throws(() => f.api.getStorageSync('__lcloud_goods'), /损坏|版本/);
  const bad = createAtomicStorage({ getStorageSync() { throw Error('read failed'); }, setStorageSync() {} });
  assert.throws(() => bad.getStorageSync('__lcloud_goods'), /read failed/);
});
test('large ledger uses bounded chunks and a failed pointer commit preserves the previous ledger', async () => {
  const data = { cpos_openid: 'owner' }; let failCommit = false;
  const raw = { getStorageSync: k => structuredClone(data[k]), setStorageSync(k,v) {
    if (Buffer.byteLength(JSON.stringify(v)) > 1024 * 1024) throw Error('key too large');
    if (failCommit && k === SNAPSHOT_KEY) throw Error('commit failed');
    data[k] = structuredClone(v);
  }, removeStorageSync: k => delete data[k] };
  const api = createAtomicStorage(raw);
  const rows = Array.from({ length: 1500 }, (_, i) => ({ _id: 'g' + i, name: '服装'.repeat(200), stock: 10 }));
  await api.transaction(() => api.setStorageSync('__lcloud_goods', rows));
  assert.equal(api.getStorageSync('__lcloud_goods').length, 1500);
  failCommit = true;
  await assert.rejects(api.transaction(() => api.setStorageSync('__lcloud_goods', rows.slice(0, 1000))), /commit failed/);
  assert.equal(api.getStorageSync('__lcloud_goods').length, 1500);
  failCommit = false;
  await api.transaction(() => api.setStorageSync('__lcloud_goods', []));
  assert.equal(Object.keys(data).filter(k => k.includes('.part.')).length, 0);
});
test('next write reclaims interrupted generations while preserving unrelated storage', async () => {
  const data = { cpos_openid: 'owner', [SNAPSHOT_KEY + '.part.crashed_1.0']: 'incomplete', unrelated: 'keep' };
  const raw = { getStorageSync: k => structuredClone(data[k]), setStorageSync: (k,v) => { data[k] = structuredClone(v); }, getStorageInfoSync: () => ({ keys: Object.keys(data) }), removeStorageSync: k => { delete data[k]; } };
  await createAtomicStorage(raw).transaction(() => createAtomicStorage(raw).setStorageSync('__lcloud_goods', []));
  assert.equal(data[SNAPSHOT_KEY + '.part.crashed_1.0'], undefined); assert.equal(data.unrelated, 'keep');
});
