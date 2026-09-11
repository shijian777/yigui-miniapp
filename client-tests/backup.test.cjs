const test = require('node:test');
const assert = require('node:assert/strict');
const { createAtomicStorage, SNAPSHOT_KEY } = require('../danjie-connected-miniapp/utils/atomic-storage.js');
const { exportData, importData, RESTORE_BACKUP_KEY } = require('../danjie-connected-miniapp/utils/data-backup.js');
function fixture() {
  const data = { cpos_openid: 'new-owner', __lcloud_goods: [{ _id: 'old', openid: 'new-owner', stock: 5 }], __lcloud___seq: 30 };
  let failKey;
  const wx = { getStorageSync: k => structuredClone(data[k]), setStorageSync(k,v) { if (k === failKey) throw Error('write failed'); data[k] = structuredClone(v); } };
  return { data, wx, api: createAtomicStorage(wx), fail: key => { failKey = key; } };
}
const backup = data => JSON.stringify({ app: 'clothing-pos-miniapp', version: 1, data });
test('merge preserves unrelated data and does not lower sequence', async () => {
  const f = fixture(); await importData(f.wx, backup({ goods: [{ _id: 'new', openid: 'old-owner', stock: 2 }], __seq: 1 }), 'merge');
  assert.deepEqual(f.api.getStorageSync('__lcloud_goods').map(x => x._id), ['old', 'new']);
  assert.equal(f.api.getStorageSync('__lcloud___seq'), 30); assert.ok(f.api.getStorageSync(RESTORE_BACKUP_KEY));
});
test('same-ID different rows abort the whole merge', async () => {
  const f = fixture(); await assert.rejects(importData(f.wx, backup({ goods: [{ _id: 'old', openid: 'new-owner', stock: 99 }] }), 'merge'), /冲突/);
  assert.equal(f.api.getStorageSync('__lcloud_goods')[0].stock, 5);
});
test('cross-device restore binds all records to current local identity', async () => {
  const f = fixture(); await importData(f.wx, backup({ goods: [{ _id: 'new', openid: 'old-owner' }] }), 'overwrite');
  assert.equal(f.api.getStorageSync('__lcloud_goods')[0].openid, 'new-owner');
  assert.equal(f.api.getStorageSync('cpos_openid'), 'new-owner');
});
test('failed restore commit leaves ledger untouched', async () => {
  for (const key of [SNAPSHOT_KEY]) {
    const f = fixture(); f.fail(key);
    await assert.rejects(importData(f.wx, backup({ goods: [{ _id: 'new', openid: 'old-owner' }] }), 'overwrite'), /write failed/);
    assert.equal(f.api.getStorageSync('__lcloud_goods')[0]._id, 'old');
  }
});
test('a failed later restore preserves the last successful pre-restore backup', async () => {
  const f = fixture();
  await importData(f.wx, backup({ goods: [{ _id: 'B', openid: 'new-owner' }] }), 'overwrite');
  f.fail(SNAPSHOT_KEY);
  await assert.rejects(importData(f.wx, backup({ goods: [{ _id: 'C', openid: 'new-owner' }] }), 'overwrite'));
  assert.equal(f.api.getStorageSync('__lcloud_goods')[0]._id, 'B');
  assert.equal(f.api.getStorageSync(RESTORE_BACKUP_KEY).data.goods[0]._id, 'old');
});
test('malformed, duplicate, unknown collection, multiple owner, and invalid modes rejected', async () => {
  const cases = [{ goods: [{}] }, { goods: [{ _id: 'a' }, { _id: 'a' }] }, { strange: [] }, { goods: [{ _id: 'a', openid: 'a' }, { _id: 'b', openid: 'b' }] }, { __seq: -1 }];
  for (const data of cases) { const f = fixture(); await assert.rejects(importData(f.wx, backup(data), 'overwrite')); assert.equal(f.api.getStorageSync('__lcloud_goods')[0]._id, 'old'); }
  await assert.rejects(importData(fixture().wx, backup({}), 'typo'));
});
test('export observes a complete committed transaction and can round-trip', async () => {
  const f = fixture();
  const commit = f.api.transaction(async () => { f.api.setStorageSync('__lcloud_goods', []); await Promise.resolve(); f.api.setStorageSync('__lcloud_customers', [{ _id: 'c', openid: 'new-owner' }]); });
  const exported = exportData(f.wx); await commit;
  const b = await exported; assert.equal(b.counts.goods, 0); assert.equal(b.counts.customers, 1);
  await importData(f.wx, b.json, 'overwrite'); assert.equal(f.api.getStorageSync('__lcloud_customers').length, 1);
});
test('partial historical orders cannot merge into existing goods and inflate future returns', async () => {
  const f = fixture();
  const data = { sales_orders: [{ _id: 'o', openid: 'new-owner', status: 'completed', lines: [{ goodsId: 'old', qty: 2 }] }] };
  await assert.rejects(importData(f.wx, backup(data), 'merge'), /库存|流水|完整/);
  assert.equal(f.api.getStorageSync('__lcloud_goods')[0].stock, 5); assert.equal(f.api.getStorageSync('__lcloud_sales_orders').length, 0);
});
test('overwrite rejects historical orders when the entire goods collection is omitted', async () => {
  const f = fixture();
  await assert.rejects(importData(f.wx, backup({ sales_orders: [{ _id: 'o', lines: [{ goodsId: 'missing', qty: 1 }] }] }), 'overwrite'), /商品|完整/);
  assert.equal(f.api.getStorageSync('__lcloud_goods')[0]._id, 'old');
});
test('complete backups can restore historical records of intentionally deleted goods', async () => {
  const f = fixture();
  await importData(f.wx, backup({ goods: [], sales_orders: [{ _id: 'history', lines: [{ goodsId: 'deleted', qty: 1 }] }], inventory_logs: [] }), 'overwrite');
  assert.equal(f.api.getStorageSync('__lcloud_goods').length, 0); assert.equal(f.api.getStorageSync('__lcloud_sales_orders')[0]._id, 'history');
  await importData(f.wx, backup({ customers: [{ _id: 'new-customer' }] }), 'merge');
  assert.equal(f.api.getStorageSync('__lcloud_customers').length, 1);
});
