const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalCloud } = require('../danjie-connected-miniapp/utils/localcloud.js');
const { createAtomicStorage } = require('../danjie-connected-miniapp/utils/atomic-storage.js');
const util = require('../danjie-connected-miniapp/utils/util.js');
const good = (id = 'g', extra = {}) => ({ _id: id, openid: 'owner', name: id, stock: 10, totalStock: 10, price: 100, costPrice: 20, status: 'on', ...extra });
const line = (id = 'g', qty = 1) => ({ goodsId: id, qty, price: 100, unitCost: 20 });
function fixture(collections = {}) {
  const data = { cpos_openid: 'owner' };
  Object.entries(collections).forEach(([key, value]) => data['__lcloud_' + key] = structuredClone(value));
  global.wx = { getStorageSync: k => structuredClone(data[k]), setStorageSync: (k,v) => { data[k] = structuredClone(v); }, removeStorageSync: k => { delete data[k]; } };
  const app = { globalData: { openid: 'owner', settings: null } }; global.getApp = () => app;
  wx.cloud = createLocalCloud();
  const api = createAtomicStorage(wx);
  return { data, app, rows: key => api.getStorageSync('__lcloud_' + key), call: async (name, payload) => (await wx.cloud.callFunction({ name, data: payload })).result };
}
test('sale → partial debt receipt → return keeps stock, balances and statement consistent', async () => {
  const f = fixture({ goods: [good()], customers: [{ _id: 'c', openid: 'owner', name: '客户' }] });
  const sale = await util.submitSale({ lines: [line()], received: 20, paymentMethod: 'cash', customerId: 'c', requestId: 'workflow_sale' });
  assert.equal(sale.debt, 80); assert.equal(f.rows('goods')[0].stock, 9);
  assert.equal((await util.fetchDebts()).data.totalDebt, 80);
  await util.settleDebt({ orderId: sale.orderId, amount: 30, paymentMethod: 'wechat', requestId: 'workflow_settle' });
  assert.equal((await util.fetchDebts()).data.totalDebt, 50);
  await util.returnSale({ orderId: sale.orderId });
  assert.equal(f.rows('goods')[0].stock, 10);
  assert.equal((await util.fetchDebts()).data.totalDebt, 0);
  const statement = await util.callFn('statement', { customerId: 'c' });
  assert.equal(statement.data.summary.netSales, 0); assert.equal(statement.data.summary.outstandingDebt, 0);
  assert.equal(f.rows('customers')[0].totalDebt, 0);
});
test('invalid quantities, too many lines, ownership and overpayment leave data unchanged', async () => {
  const f = fixture({ goods: [good(), good('other', { openid: 'someone-else' })] });
  for (const lines of [[], [line('g', 0)], [line('g', -1)], Array.from({ length: 31 }, () => line()), [line('other')]]) {
    assert.equal((await f.call('submitSale', { lines })).success, false);
    assert.equal(f.rows('goods')[0].stock, 10); assert.equal(f.rows('sales_orders').length, 0);
  }
  const sale = await util.submitSale({ lines: [line()], paymentMethod: 'credit', received: 50 });
  await assert.rejects(util.settleDebt({ orderId: sale.orderId, amount: 51 }));
  assert.equal(f.rows('sales_orders')[0].debt, 50);
});
test('2,001 records are returned through the actual shared list utility', async () => {
  fixture({ goods: Array.from({ length: 2001 }, (_, i) => good('g' + i)) });
  assert.equal((await util.listCollAll('goods')).length, 2001);
});
test('backup from one device restores records visible through the real client queries', async () => {
  fixture({ goods: [good()] }); const backup = await util.exportAllData();
  const f = fixture(); f.app.globalData.openid = 'new-owner'; f.data.cpos_openid = 'new-owner';
  await util.importAllData(backup.json, 'overwrite');
  const rows = await util.listColl('goods'); assert.equal(rows.length, 1); assert.equal(rows[0].openid, 'new-owner');
});
test('legacy SKU delimiter and explicit discount rounding remain valid', async () => {
  const f = fixture({ goods: [good('g', { skus: [{ key: '黑·M', color: '黑', size: 'M', stock: 10, price: 100, costPrice: 20 }] })] });
  const r = await util.submitSale({ lines: [{ ...line(), skuKey: '黑-M', color: '黑', size: 'M', price: 99.99 }], discountPct: 90, erase: true, received: 89 });
  assert.equal(r.amountDue, 89); assert.equal(r.debt, 0); assert.equal(f.rows('goods')[0].skus[0].stock, 9);
});
test('request helper preserves retry IDs and rotates on changed payload or completed operation', () => {
  const page = {}, payload = { amount: 10 };
  const first = util.operationRequestId(page, 'sale', payload);
  assert.equal(util.operationRequestId(page, 'sale', payload), first);
  assert.notEqual(util.operationRequestId(page, 'sale', { amount: 20 }), first);
  util.clearOperationRequest(page, 'sale'); assert.notEqual(util.operationRequestId(page, 'sale', payload), first);
});
