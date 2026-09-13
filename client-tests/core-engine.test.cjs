const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalCloud } = require('../yigui-miniapp/utils/localcloud');

function storage(owner = 'owner', collections = {}) {
  const values = { cpos_openid: owner };
  for (const [name, rows] of Object.entries(collections)) values['__lcloud_' + name] = structuredClone(rows);
  return {
    getStorageSync(key) { return structuredClone(values[key]); },
    setStorageSync(key, value) { values[key] = structuredClone(value); },
    getStorageInfoSync() { return { keys: Object.keys(values) }; },
    rows(name) { return this.getStorageSync('__lcloud_' + name) || []; }
  };
}
function fixture(collections = {}) {
  const store = storage('owner', collections);
  global.wx = store;
  const cloud = createLocalCloud(store);
  return { store, cloud, call: async (name, data) => (await cloud.callFunction({ name, data })).result };
}
const goods = (extra = {}) => ({ _id: 'g', openid: 'owner', name: '商品', status: 'on', stock: 10, totalStock: 10, price: 100, costPrice: 20, ...extra });
const order = (extra = {}) => ({ _id: 'o', openid: 'owner', type: 'sale', status: 'completed', paymentMethod: 'credit', amountDue: 100, received: 0, debt: 100, customerId: 'c', createdAt: '2026-09-10T04:00:00.000Z', lines: [{ goodsId: 'g', qty: 1, price: 100 }], ...extra });
const range = { startMs: Date.parse('2026-09-10T00:00:00Z'), endMs: Date.parse('2026-09-11T00:00:00Z') };

test('injected instances keep identities and writes isolated without replacing global wx', async () => {
  const sentinel = storage('global'); global.wx = sentinel;
  const left = storage('left'), right = storage('right');
  const a = createLocalCloud(left), b = createLocalCloud(right);
  assert.equal((await a.callFunction({ name: 'login' })).result.openid, 'left');
  assert.equal((await b.callFunction({ name: 'login' })).result.openid, 'right');
  await a.database().collection('goods').add({ data: { name: 'Left only' } });
  assert.equal(left.rows('goods').length, 1);
  assert.equal(right.rows('goods').length, 0);
  assert.equal(sentinel.rows('goods').length, 0);
  assert.equal(global.wx, sentinel);
});
test('no-argument factory retains wx storage behavior', async () => {
  global.wx = storage('legacy');
  assert.equal((await createLocalCloud().callFunction({ name: 'login' })).result.openid, 'legacy');
});
test('Date patches remain timestamps and returned orders enter daily statistics', async () => {
  const { cloud, call, store } = fixture({ goods: [goods()], sales_orders: [order()] });
  await cloud.database().collection('goods').doc('g').update({ data: { updatedAt: new Date('2026-09-10T05:00:00Z') } });
  assert.equal(new Date(store.rows('goods')[0].updatedAt).toISOString(), '2026-09-10T05:00:00.000Z');
  assert.equal((await call('returnSale', { orderId: 'o' })).success, true);
  assert.ok(Number.isFinite(new Date(store.rows('sales_orders')[0].returnedAt).getTime()));
  const summary = await call('stats', { startMs: Date.now() - 60000, endMs: Date.now() + 60000 });
  assert.equal(summary.data.returnedCount, 1);
});
test('Date range and equality queries match serialized ISO timestamps', async () => {
  const { cloud } = fixture({ sales_orders: [order(), order({ _id: 'outside', createdAt: '2026-09-11T00:00:00Z' })] });
  const db = cloud.database(), cmd = db.command;
  assert.deepEqual((await db.collection('sales_orders').where({ createdAt: cmd.gte(new Date(range.startMs)).and(cmd.lt(new Date(range.endMs))) }).get()).data.map(x => x._id), ['o']);
  assert.equal((await db.collection('sales_orders').where({ createdAt: cmd.eq(new Date('2026-09-10T04:00:00Z')) }).count()).total, 1);
});
test('query in and exists distinguish absent fields from present null', async () => {
  const { cloud } = fixture({ goods: [{ _id: 'a', status: 'on', note: null }, { _id: 'b', status: 'off' }] });
  const db = cloud.database(), cmd = db.command;
  assert.equal((await db.collection('goods').where({ status: cmd.in(['on']) }).count()).total, 1);
  assert.deepEqual((await db.collection('goods').where({ note: cmd.exists(false) }).get()).data.map(x => x._id), ['b']);
  assert.deepEqual((await db.collection('goods').where({ note: cmd.exists(true) }).get()).data.map(x => x._id), ['a']);
});
test('off-sale goods cannot be sold from an existing cart', async () => {
  const { call, store } = fixture({ goods: [goods({ status: 'off' })] });
  const result = await call('submitSale', { lines: [{ goodsId: 'g', qty: 1, price: 100 }] });
  assert.equal(result.success, false);
  assert.equal(store.rows('goods')[0].stock, 10);
  assert.equal(store.rows('sales_orders').length, 0);
});
test('return with a missing SKU rejects without declaring inventory restored', async () => {
  const { call, store } = fixture({ goods: [goods({ skus: [{ key: '蓝-M', color: '蓝', size: 'M', stock: 10 }] })], sales_orders: [order({ lines: [{ goodsId: 'g', qty: 1, skuKey: '红-M', color: '红', size: 'M' }] })] });
  assert.equal((await call('returnSale', { orderId: 'o' })).success, false);
  assert.equal(store.rows('sales_orders')[0].status, 'completed');
  assert.equal(store.rows('inventory_logs').length, 0);
});
test('return cannot silently restore SKU stock into a goods record with all SKUs removed', async () => {
  const { call, store } = fixture({ goods: [goods({ skus: [] })], sales_orders: [order({ lines: [{ goodsId: 'g', qty: 1, skuKey: '红-M', color: '红', size: 'M' }] })] });
  assert.equal((await call('returnSale', { orderId: 'o' })).success, false);
  assert.equal(store.rows('goods')[0].stock, 10);
  assert.equal(store.rows('sales_orders')[0].status, 'completed');
});
test('debt ledger includes partial cash payments', async () => {
  const { call } = fixture({ sales_orders: [order({ paymentMethod: 'cash', received: 40, debt: 60 })] });
  const result = await call('stats', { action: 'debts', ...range });
  assert.equal(result.data.totalDebt, 60);
  assert.equal(result.data.rangeDebt, 60);
  assert.equal(result.data.list.length, 1);
});
test('settled credit orders retain original classification and cleared ledger visibility', async () => {
  const { call, store } = fixture({ sales_orders: [order()] });
  assert.equal((await call('settleDebt', { orderId: 'o', amount: 100, paymentMethod: 'wechat' })).success, true);
  assert.equal(store.rows('sales_orders')[0].originalPaymentMethod, 'credit');
  const result = await call('stats', { action: 'debts', ...range });
  assert.equal(result.data.totalDebt, 0);
  assert.equal(result.data.clearedList.length, 1);
});
test('legacy cleared orders with settlement history stay in the ledger', async () => {
  const { call } = fixture({ sales_orders: [order({ paymentMethod: 'wechat', received: 100, debt: 0, settleHistory: [{ amount: 100 }] }), order({ _id: 'paid-at-sale', paymentMethod: 'cash', received: 100, debt: 0 })] });
  assert.deepEqual((await call('stats', { action: 'debts', ...range })).data.clearedList.map(x => x._id), ['o']);
});
test('customer sync clears aggregates when no completed orders remain and respects ownership', async () => {
  const { call, store } = fixture({ sales_orders: [order({ status: 'returned' })], customers: [{ _id: 'c', openid: 'owner', totalSpent: 100, totalDebt: 100, totalOrders: 1, lastOrderAt: '2026-09-10T04:00:00Z' }, { _id: 'foreign', openid: 'other', totalDebt: 5 }] });
  assert.equal((await call('stats', { action: 'syncCustomers' })).success, true);
  const [customer, foreign] = store.rows('customers');
  assert.equal(customer.totalSpent, 0); assert.equal(customer.totalDebt, 0); assert.equal(customer.totalOrders, 0); assert.equal(customer.lastOrderAt, null);
  assert.equal(foreign.totalDebt, 5);
});
test('statement excludes returned amounts once for mixed and returned-only customers', async () => {
  const { call } = fixture({ sales_orders: [order({ _id: 'active', received: 40, debt: 60 }), order({ status: 'returned' }), order({ _id: 'other', customerId: 'returned-only', status: 'returned' })] });
  const mixed = (await call('statement', { customerId: 'c', ...range })).data.summary;
  assert.equal(mixed.netSales, 100); assert.equal(mixed.totalReceived, 40); assert.equal(mixed.outstandingDebt, 60);
  const returned = (await call('statement', { customerId: 'returned-only', ...range })).data.summary;
  assert.equal(returned.netSales, 0); assert.equal(returned.outstandingDebt, 0);
});
test('debt customer grand total includes customers outside the top 200', async () => {
  const { call } = fixture({ sales_orders: Array.from({ length: 201 }, (_, i) => order({ _id: 'o' + i, customerId: 'c' + i })) });
  const result = await call('stats', { action: 'debtCustomers' });
  assert.equal(result.data.list.length, 200); assert.equal(result.data.totalDebt, 20100);
});
test('migration advances through unmigrated goods across successive batches', async () => {
  const { call, store } = fixture({ goods: [goods({ _id: 'a' }), goods({ _id: 'b' }), goods({ _id: 'c' })] });
  assert.equal((await call('migrateSku', { limit: 2 })).migrated, 2);
  const second = await call('migrateSku', { limit: 2 });
  assert.equal(second.migrated, 1); assert.equal(second.remaining, 0);
  assert.equal(store.rows('goods')[2].skus[0].stock, 10);
});

test('public database operations and functions serialize through injected transactions', async () => {
  const store = storage('owner', { goods: [goods()] });
  let releaseFirst, firstEntered;
  const started = new Promise(resolve => { firstEntered = resolve; });
  const held = new Promise(resolve => { releaseFirst = resolve; });
  let calls = 0, active = 0, maxActive = 0;
  const outcomes = [];
  store.transaction = async (run) => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    if (calls === 1) { firstEntered(); await held; }
    try { const result = await run(); outcomes.push(result); return result; }
    finally { active--; }
  };
  const cloud = createLocalCloud(store);
  const first = cloud.database().collection('goods').doc('g').update({ data: { name: 'Changed' } });
  // Old engines execute immediately and never enter the transaction provider.
  await Promise.race([started, new Promise(resolve => setTimeout(resolve, 10))]);
  assert.equal(calls, 1);
  const read = cloud.database().collection('goods').get();
  const fail = cloud.callFunction({ name: 'submitSale', data: { lines: [] } });
  await Promise.resolve();
  assert.equal(calls, 1);
  releaseFirst(); await first;
  assert.equal((await read).data[0].name, 'Changed');
  assert.equal((await fail).result.success, false);
  assert.equal(calls, 3); assert.equal(maxActive, 1);
  assert.equal(outcomes[2].success, false);
});
test('storage write failures reject database writes and fail business commands', async () => {
  const store = storage('owner', { goods: [goods()] });
  const originalSet = store.setStorageSync;
  store.setStorageSync = function (key, value) {
    if (key === '__lcloud_goods') throw new Error('存储空间不足');
    return originalSet.call(this, key, value);
  };
  const cloud = createLocalCloud(store);
  await assert.rejects(cloud.database().collection('goods').doc('g').update({ data: { stock: 8 } }), /存储空间不足/);
  const result = (await cloud.callFunction({ name: 'submitSale', data: { lines: [{ goodsId: 'g', qty: 1, price: 100 }] } })).result;
  assert.equal(result.success, false);
  assert.equal(store.rows('goods')[0].stock, 10);
});

for (const scenario of [
  { name: 'submitSale', data: { lines: [{ goodsId: 'g', qty: 1, price: 100 }, { goodsId: 'missing', qty: 1, price: 100 }] } },
  { name: 'submitPurchase', data: { lines: [{ goodsId: 'g', qty: 1, unitCost: 20 }, { goodsId: 'missing', qty: 1, unitCost: 20 }] } },
  { name: 'returnSale', data: { orderId: 'o' } }
]) {
  test('atomic provider rolls back every collection after failed multi-line ' + scenario.name, async () => {
    const { createAtomicStorage } = require('../yigui-miniapp/utils/atomic-storage');
    const device = storage('owner', {
      goods: [goods()],
      sales_orders: [order({ lines: [{ goodsId: 'g', qty: 1 }, { goodsId: 'missing', qty: 1 }] })]
    });
    const provider = createAtomicStorage(device), cloud = createLocalCloud(provider);
    const beforeGoods = structuredClone(provider.getStorageSync('__lcloud_goods'));
    const beforeOrders = structuredClone(provider.getStorageSync('__lcloud_sales_orders'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = (await cloud.callFunction(scenario)).result;
      assert.equal(result.success, false);
      assert.deepEqual(provider.getStorageSync('__lcloud_goods'), beforeGoods);
      assert.deepEqual(provider.getStorageSync('__lcloud_sales_orders'), beforeOrders);
      assert.equal((provider.getStorageSync('__lcloud_inventory_logs') || []).length, 0);
      assert.equal((provider.getStorageSync('__lcloud_purchase_orders') || []).length, 0);
    }
  });
}

test('purchase, legacy SKU sale, partial settlements, and return preserve stock and debt', async () => {
  const { call, store } = fixture({ goods: [goods({ skus: [{ key: '红·M', color: '红', size: 'M', stock: 10, costPrice: 20, price: 100 }] })] });
  const item = { goodsId: 'g', skuKey: '红-M', color: '红', size: 'M', qty: 2, price: 100, unitCost: 20 };
  assert.equal((await call('submitPurchase', { lines: [item] })).success, true);
  assert.equal(store.rows('goods')[0].stock, 12);
  const sale = await call('submitSale', { lines: [item], paymentMethod: 'credit', received: 40 });
  assert.equal(sale.success, true); assert.equal(sale.debt, 160);
  assert.equal(store.rows('goods')[0].stock, 10);
  assert.equal((await call('settleDebt', { orderId: sale.orderId, amount: 60, paymentMethod: 'wechat' })).debt, 100);
  assert.equal((await call('settleDebt', { orderId: sale.orderId, amount: 100, paymentMethod: 'alipay' })).fullyCleared, true);
  assert.equal(store.rows('sales_orders')[0].settleHistory.length, 2);
  assert.equal((await call('returnSale', { orderId: sale.orderId })).success, true);
  assert.equal((await call('returnSale', { orderId: sale.orderId })).success, false);
  assert.equal(store.rows('goods')[0].stock, 12);
  assert.equal((await call('stats', { action: 'debts' })).data.totalDebt, 0);
});

test('storage read failures cannot appear as an empty ledger', async () => {
  const store = storage('owner');
  const get = store.getStorageSync;
  store.getStorageSync = function (key) {
    if (key === '__lcloud_sales_orders') throw new Error('读取数据失败');
    return get.call(this, key);
  };
  const cloud = createLocalCloud(store);
  await assert.rejects(cloud.database().collection('sales_orders').get(), /读取数据失败/);
  await assert.rejects(cloud.callFunction({ name: 'stats', data: { action: 'debts' } }), /读取数据失败/);
});
test('sale settlement and return refresh customer aggregates without a manual sync', async () => {
  const { call, store } = fixture({ goods: [goods()], customers: [{ _id: 'c', openid: 'owner', name: '客户' }] });
  const sale = await call('submitSale', { lines: [{ goodsId: 'g', qty: 1, price: 100 }], customerId: 'c', paymentMethod: 'credit', received: 20 });
  assert.equal(sale.success, true);
  assert.equal(store.rows('customers')[0].totalSpent, 100);
  assert.equal(store.rows('customers')[0].totalDebt, 80);
  assert.equal((await call('settleDebt', { orderId: sale.orderId, amount: 30 })).success, true);
  assert.equal(store.rows('customers')[0].totalDebt, 50);
  assert.equal((await call('returnSale', { orderId: sale.orderId })).success, true);
  assert.equal(store.rows('customers')[0].totalDebt, 0);
  assert.equal(store.rows('customers')[0].totalSpent, 0);
  assert.equal(store.rows('customers')[0].totalOrders, 0);
});

for (const name of ['submitSale', 'submitPurchase']) {
  test(name + ' request retries reuse one order and reject changed payloads', async () => {
    const { call, store } = fixture({ goods: [goods()] });
    const data = { requestId: 'stable-request', lines: [{ goodsId: 'g', qty: 1, price: 100, unitCost: 20 }], received: 40 };
    const first = await call(name, data);
    assert.equal(first.success, true);
    assert.deepEqual(await call(name, data), first);
    assert.equal(store.rows(name === 'submitSale' ? 'sales_orders' : 'purchase_orders').length, 1);
    assert.equal(store.rows('goods')[0].stock, name === 'submitSale' ? 9 : 11);
    assert.equal((await call(name, { ...data, lines: [{ ...data.lines[0], qty: 2 }] })).success, false);
    assert.equal(store.rows('inventory_logs').length, 1);
  });
}
test('partial and full settlement retries return the original result and reject changed amounts', async () => {
  const { call, store } = fixture({ sales_orders: [order()] });
  const partial = { orderId: 'o', requestId: 'partial', amount: 30, paymentMethod: 'wechat' };
  const first = await call('settleDebt', partial);
  assert.equal(first.debt, 70);
  assert.deepEqual(await call('settleDebt', partial), first);
  assert.equal((await call('settleDebt', { ...partial, amount: 20 })).success, false);
  const full = { orderId: 'o', requestId: 'full', amount: 70, paymentMethod: 'cash' };
  const last = await call('settleDebt', full);
  assert.equal(last.fullyCleared, true);
  assert.deepEqual(await call('settleDebt', full), last);
  assert.deepEqual(await call('settleDebt', partial), first);
  assert.equal(store.rows('sales_orders')[0].settleHistory.length, 2);
  assert.equal(store.rows('sales_orders')[0].received, 100);
});
test('login storage errors reject without generating a misleading replacement identity', async () => {
  const store = storage('owner');
  store.getStorageSync = () => { throw new Error('身份读取失败'); };
  await assert.rejects(createLocalCloud(store).callFunction({ name: 'login' }), /身份读取失败/);
});

const goodsPayload = () => ({ name: '新商品', unit: '件', status: 'on', colors: ['红'], sizes: ['M'], costPrice: 20, price: 100, skus: [{ key: '红-M', color: '红', size: 'M', stock: 5, costPrice: 20, price: 100 }] });
test('saveGoods creates goods and every initial stock log as one business operation', async () => {
  const { call, store } = fixture();
  const payload = goodsPayload();
  payload.skus.push({ key: '红-L', color: '红', size: 'L', stock: 3, costPrice: 0, price: 100 }, { key: '红-S', color: '红', size: 'S', stock: 0, costPrice: 20, price: 100 });
  const result = await call('saveGoods', { goods: payload });
  assert.equal(result.success, true);
  const saved = store.rows('goods')[0], log = store.rows('inventory_logs')[0];
  assert.equal(saved.stock, 8); assert.equal(saved.totalStock, 8);
  assert.equal(saved.openid, 'owner'); assert.equal(log.goodsId, saved._id);
  assert.equal(log.qty, 5); assert.equal(log.type, 'initial');
  assert.equal(store.rows('inventory_logs').length, 2);
  assert.equal(store.rows('inventory_logs')[1].unitPrice, 0);
});
test('saveGoods rolls back goods creation when writing initial logs fails', async () => {
  const { createAtomicStorage } = require('../yigui-miniapp/utils/atomic-storage');
  const provider = createAtomicStorage(storage('owner'));
  let logWrites = 0;
  const failing = {
    getStorageSync: provider.getStorageSync,
    setStorageSync(key, value) { if (key === '__lcloud_inventory_logs' && ++logWrites === 2) throw new Error('期初流水写入失败'); provider.setStorageSync(key, value); },
    transaction: provider.transaction
  };
  const payload = goodsPayload();
  payload.skus.push({ key: '红-L', color: '红', size: 'L', stock: 3, costPrice: 20, price: 100 });
  const result = (await createLocalCloud(failing).callFunction({ name: 'saveGoods', data: { goods: payload } })).result;
  assert.equal(result.success, false); assert.match(result.message, /期初流水写入失败/);
  assert.equal(provider.getStorageSync('__lcloud_goods').length, 0);
  assert.equal(provider.getStorageSync('__lcloud_inventory_logs').length, 0);
});
test('saveGoods rejects stale inventory snapshots instead of overwriting newer sales stock', async () => {
  const payload = goodsPayload(), original = structuredClone(payload.skus);
  const current = goods({ ...payload, stock: 4, totalStock: 4, skus: [{ ...payload.skus[0], stock: 4 }] });
  const { call, store } = fixture({ goods: [current] });
  const result = await call('saveGoods', { goodsId: 'g', goods: payload, expectedOriginalSkus: original, expectedOriginalStock: 5 });
  assert.equal(result.success, false); assert.match(result.message, /已变更|库存/);
  assert.equal(store.rows('goods')[0].stock, 4);
});
test('saveGoods allows a current price edit while retaining stock and rejecting direct stock changes', async () => {
  const payload = goodsPayload();
  const { call, store } = fixture({ goods: [goods({ ...payload, stock: 5, totalStock: 5 })] });
  const data = { goodsId: 'g', goods: { ...payload, price: 120, skus: [{ ...payload.skus[0], price: 120 }] }, expectedOriginalSkus: payload.skus, expectedOriginalStock: 5 };
  assert.equal((await call('saveGoods', data)).success, true);
  assert.equal(store.rows('goods')[0].skus[0].price, 120); assert.equal(store.rows('goods')[0].stock, 5);
  const changed = { ...data, expectedOriginalSkus: store.rows('goods')[0].skus, goods: { ...data.goods, skus: [{ ...data.goods.skus[0], stock: 3 }] } };
  assert.equal((await call('saveGoods', changed)).success, false);
  assert.equal(store.rows('goods')[0].stock, 5);
});

test('sales preserve an explicit zero SKU cost instead of using the goods fallback cost', async () => {
  const { call, store } = fixture({ goods: [goods({ skus: [{ key: '红-M', color: '红', size: 'M', stock: 2, costPrice: 0, price: 100 }] })] });
  assert.equal((await call('submitSale', { lines: [{ goodsId: 'g', skuKey: '红-M', qty: 1, price: 100 }] })).success, true);
  assert.equal(store.rows('sales_orders')[0].lines[0].cost, 0);
});
test('purchases average an explicit zero SKU cost with new stock without adding fallback cost', async () => {
  const { call, store } = fixture({ goods: [goods({ skus: [{ key: '红-M', color: '红', size: 'M', stock: 1, costPrice: 0, price: 100 }] })] });
  assert.equal((await call('submitPurchase', { lines: [{ goodsId: 'g', skuKey: '红-M', qty: 1, unitCost: 10 }] })).success, true);
  assert.equal(store.rows('goods')[0].skus[0].costPrice, 5);
  assert.equal(store.rows('purchase_orders')[0].lines[0].avgCost, 5);
});
