const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../danjie-connected-miniapp');
const realUtil = require(path.join(root, 'utils/util.js'));
const clone = value => JSON.parse(JSON.stringify(value));
const event = dataset => ({ currentTarget: { dataset } });
const input = (dataset, value) => ({ ...event(dataset), detail: { value } });
function harness(name, overrides = {}, settings = { defaultPayment: 'cash' }) {
  const writes = [], navigation = [], notices = [], emitted = [];
  const app = { globalData: { settings, theme: 'light' }, _resolveTheme: () => 'light' };
  const util = { ...realUtil, ensureOpenid: async () => 'test',
    updateDocById: async (collection, id, value) => writes.push({ collection, id, value: clone(value) }),
    addDoc: async (collection, value) => { writes.push({ collection, value: clone(value) }); return 'new'; },
    callFn: async (action, args) => {
      assert.equal(action, 'saveGoods');
      writes.push({ collection: 'goods', id: args.goodsId, value: clone(args.goods), request: clone(args) });
      return { success: true, goodsId: args.goodsId || 'new' };
    },
    ...overrides };
  const wx = { showToast: o => notices.push(o.title), showModal: o => notices.push(o.title),
    navigateTo: o => navigation.push(o), navigateBack: () => navigation.push({ back: true }),
    setNavigationBarTitle() {}, showActionSheet: o => navigation.push({ actions: o.itemList }) };
  let page;
  vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${name}/${name}.js`), 'utf8'), {
    require: () => util, Page: p => { page = p; }, wx, getApp: () => app, Date, console,
    setTimeout: () => 0, clearTimeout() {}
  });
  page.data = clone(page.data);
  page.setData = function (patch) {
    for (const [key, value] of Object.entries(patch)) {
      const bits = key.split('.'); let target = this.data;
      for (const bit of bits.slice(0, -1)) target = target[bit];
      target[bits.at(-1)] = value;
    }
  };
  page.getOpenerEventChannel = () => ({ emit: (...args) => emitted.push(args) });
  return { page, app, writes, navigation, notices, emitted };
}
const fixture = () => ({ _id: 'g1', name: 'Shirt', colors: ['black', 'blue'], sizes: ['M', 'L'],
  costPrice: 20, price: 40, stock: 7, skus: [
    { key: 'black-M', color: 'black', size: 'M', stock: 7, costPrice: 21, price: 41 },
    { key: 'black-L', color: 'black', size: 'L', stock: 0, costPrice: 22, price: 42 },
    { key: 'blue-M', color: 'blue', size: 'M', stock: 0, costPrice: 23, price: 43 },
    { key: 'blue-L', color: 'blue', size: 'L', stock: 0, costPrice: 24, price: 44 }
  ] });
async function goods() {
  const original = fixture();
  const h = harness('goods-edit', { getDocById: async () => original });
  h.page.setData({ id: 'g1', isNew: false });
  await h.page.loadDoc('g1');
  return { ...h, original };
}
for (const dimension of ['Color', 'Size']) {
  test(`adding ${dimension} preserves SKU inventory and individual prices`, async () => {
    const { page } = await goods();
    page.data.form[dimension.toLowerCase() + 'Input'] = dimension === 'Color' ? 'red' : 'XL';
    page['add' + dimension]();
    for (const sku of fixture().skus) assert.deepEqual(clone(page.data.form.skus.find(s => s.key === sku.key)), sku);
    assert.equal(page.data.totalStock, 7);
    const added = page.data.form.skus.filter(s => dimension === 'Color' ? s.color === 'red' : s.size === 'XL');
    assert.equal(added.length, 2);
    assert.ok(added.every(s => s.stock === 0));
  });
  test(`removing a stocked ${dimension} is blocked`, async () => {
    const { page, notices } = await goods();
    page['remove' + dimension](event({ idx: 0 }));
    assert.deepEqual(clone(page.data.form.skus), fixture().skus);
    assert.ok(notices.length);
  });
  test(`removing empty ${dimension} preserves remaining stock and prices`, async () => {
    const { page } = await goods();
    page['remove' + dimension](event({ idx: 1 }));
    assert.equal(page.data.totalStock, 7);
    assert.deepEqual(clone(page.data.form.skus[0]), fixture().skus[0]);
    assert.equal(page.data.form.skus.length, 2);
  });
}
test('editing inventory is rejected against an independent loaded snapshot', async () => {
  const { page, writes, original } = await goods();
  page.data.form.skus[0].stock = 0;
  assert.equal(original.skus[0].stock, 7, 'form must not mutate loaded document');
  await page.doSaveAfterCheck(page.data.form);
  assert.equal(writes.length, 0);
});
test('removing stocked SKU directly cannot bypass save validation', async () => {
  const { page, writes } = await goods();
  page.data.form.skus.shift();
  await page.doSaveAfterCheck(page.data.form);
  assert.equal(writes.length, 0);
});
test('new specifications on existing goods cannot introduce stock', async () => {
  const { page, writes } = await goods();
  page.data.form.colorInput = 'red'; page.addColor();
  page.data.form.skus.find(s => s.color === 'red').stock = 1;
  await page.doSaveAfterCheck(page.data.form);
  assert.equal(writes.length, 0);
});
for (const value of [-1, Infinity, 'oops']) test(`invalid SKU price ${value} is rejected`, async () => {
  const { page, writes } = await goods();
  page.data.form.skus[0].price = value;
  await page.doSaveAfterCheck(page.data.form);
  assert.equal(writes.length, 0);
});
test('valid specification addition saves original inventory', async () => {
  const { page, writes } = await goods();
  page.data.form.colorInput = 'red'; page.addColor();
  await page.doSaveAfterCheck(page.data.form);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.stock, 7);
  assert.equal(writes[0].value.skus[0].price, 41);
});
test('invalid SKU price stays invalid after blur and cannot become a zero-price save', async () => {
  const { page, writes } = await goods();
  page.onSkuInput(input({ key: 'black-M', f: 'price' }, 'oops'));
  page.onSkuBlur(event({ key: 'black-M', f: 'price' }));
  await page.doSaveAfterCheck(page.data.form);
  assert.equal(writes.length, 0);
});
test('successful save refreshes the independent inventory snapshot', async () => {
  const { page, writes } = harness('goods-edit');
  page.setData({ form: { ...page.data.form, name: 'New', costPriceStr: '2', priceStr: '4', colors: ['red'],
    skus: [{ key: 'red-', color: 'red', size: '', stock: 3, costPrice: 2, price: 4 }] } });
  await page.doSaveAfterCheck(page.data.form);
  page.setData({ saving: false });
  page.data.form.name = 'Renamed';
  await page.doSaveAfterCheck(page.data.form);
  assert.equal(writes.filter(w => w.collection === 'goods').length, 2);
  page.setData({ saving: false });
  page.data.form.skus[0].stock = 2;
  await page.doSaveAfterCheck(page.data.form);
  assert.equal(writes.filter(w => w.collection === 'goods').length, 2);
});
test('legacy stable SKU keys survive specification additions', async () => {
  const original = fixture(); original.skus[0].key = 'black·M';
  const { page } = harness('goods-edit', { getDocById: async () => original });
  page.setData({ id: 'g1', isNew: false }); await page.loadDoc('g1');
  page.data.form.colorInput = 'red'; page.addColor();
  assert.equal(page.data.form.skus[0].key, 'black·M');
  assert.equal(page.data.totalStock, 7);
});
test('adding a dimension cannot discard stock in a default SKU', async () => {
  const { page } = harness('goods-edit', { getDocById: async () => ({ name: 'Legacy', stock: 5, price: 10, costPrice: 2 }) });
  page.setData({ id: 'legacy', isNew: false }); await page.loadDoc('legacy');
  page.data.form.colorInput = 'red'; page.addColor();
  assert.deepEqual(clone(page.data.form.colors), []);
  assert.equal(page.data.totalStock, 5);
});
test('picker return preserves payment selection and manually received amount', () => {
  const { page } = harness('sale');
  page.onShow();
  page.mergeIntoCart({ goodsId: 'g1', qty: 1, price: 40, stock: 7 });
  page.setPayment(event({ pay: 'wechat' }));
  page.onReceivedInput(input({}, '25'));
  page.onShow();
  assert.equal(page.data.payment, 'wechat');
  assert.equal(page.data.receivedStr, '25');
  assert.equal(page.data.totals.debt, 15);
});
test('late settings fetch cannot overwrite user payment or received input', async () => {
  let resolve; const fetched = new Promise(r => { resolve = r; });
  const { page } = harness('sale', { fetchSettings: () => fetched }, null);
  page.onShow();
  page.setPayment(event({ pay: 'alipay' }));
  page.onReceivedInput(input({}, '30'));
  resolve({ defaultPayment: 'credit' });
  await fetched; await Promise.resolve();
  assert.equal(page.data.payment, 'alipay');
  assert.equal(page.data.receivedStr, '30');
});
test('cart reset restores configured default payment immediately', () => {
  const { page } = harness('sale', {}, { defaultPayment: 'wechat' });
  page.onShow(); page.setPayment(event({ pay: 'credit' })); page.resetCart();
  assert.equal(page.data.payment, 'wechat');
  assert.equal(page.data.receivedTouched, false);
});
test('settings from a previous cart cannot overwrite the reset cart', async () => {
  let resolve; const fetched = new Promise(r => { resolve = r; });
  const { page, app } = harness('sale', { fetchSettings: () => fetched }, null);
  page.onShow(); app.globalData.settings = { defaultPayment: 'wechat' }; page.resetCart();
  resolve({ defaultPayment: 'credit' }); await fetched; await Promise.resolve();
  assert.equal(page.data.payment, 'wechat');
});
test('sale opens customer page with explicit picker query', () => {
  const { page, navigation } = harness('sale'); page.pickCustomer();
  assert.match(navigation[0].url, /[?&]from=picker(?:&|$)/);
});
test('normal customer rows edit even when opener event channel exists', () => {
  const { page, navigation, emitted } = harness('customers');
  page.reload = () => {}; page.onLoad({}); page.onShow();
  page.data.list = [{ _id: 'c1', name: 'Customer' }];
  page.onTapRow(event({ id: 'c1' }));
  assert.equal(emitted.length, 0);
  assert.equal(navigation[0].url, '/pages/customer-edit/customer-edit?id=c1');
});
test('explicit customer picker returns selected customer', () => {
  const { page, navigation, emitted } = harness('customers');
  page.reload = () => {}; page.onLoad({ from: 'picker' }); page.onShow();
  page.data.list = [{ _id: 'c1', name: 'Customer' }];
  page.onTapRow(event({ id: 'c1' }));
  assert.equal(emitted[0][0], 'picked'); assert.equal(emitted[0][1]._id, 'c1');
  assert.equal(navigation[0].back, true);
});
test('yesterday shortcut excludes today', () => {
  const { page } = harness('orders', { todayStr: () => '2026-09-11' });
  page.reload = () => {}; page.setQuick(event({ q: 'yesterday' }));
  assert.equal(page.data.startDate, '2026-09-10'); assert.equal(page.data.endDate, '2026-09-10');
});
test('order reload and next page merge both collections without missing or duplicate rows', async () => {
  const rows = type => Array.from({ length: 25 }, (_, i) => ({ _id: type + i, type,
    createdAt: new Date(Date.UTC(2026, 8, 11, 12, 59 - i * 2 - (type === 'purchase' ? 1 : 0))).toISOString(), lines: [] }));
  const { page, notices } = harness('orders', {
    cmd: () => ({ gte: () => ({ and: () => ({}) }), lt: () => ({}) }),
    listColl: async (coll, opts) => rows(coll === 'sales_orders' ? 'sale' : 'purchase').slice(opts.skip, opts.skip + opts.limit)
  });
  page.setData({ startDate: '2026-09-11', endDate: '2026-09-11' });
  await page.reload(); assert.equal(page.data.list.length, 20);
  await page.loadNext(); await page.loadNext();
  assert.equal(page.data.list.length, 50);
  assert.equal(new Set(page.data.list.map(r => r.rowKey)).size, 50);
  assert.deepEqual(clone(page.data.list.slice(0, 4).map(r => r._id)), ['sale0', 'purchase0', 'sale1', 'purchase1']);
  assert.equal(page.data.hasMore, false); assert.equal(notices.length, 0);
  await page.reload(); assert.equal(page.data.list.length, 20);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
for (const caller of ['sale', 'statement']) test(`${caller} customer selection uses the actual customer row binding and returns to caller`, async () => {
  const statementCalls = [];
  const h = harness(caller, { callFn: async (action, data) => { statementCalls.push({ action, data }); return { data: { list: [] } }; } });
  h.page.setData({ startDate: '2026-09-01', endDate: '2026-09-11' });
  h.page.pickCustomer();
  const route = h.navigation[0];
  const picker = harness('customers');
  picker.page.onLoad(Object.fromEntries(new URL('https://miniapp.invalid' + route.url).searchParams));
  picker.page.data.list = [{ _id: 'c7', name: 'Li', phone: '123' }];
  picker.page.getOpenerEventChannel = () => ({ emit: (name, value) => route.events[name](value) });
  const wxml = fs.readFileSync(path.join(root, 'pages/customers/customers.wxml'), 'utf8');
  const tag = wxml.match(/<view\b[^>]*data-id="\{\{item\._id\}\}"[^>]*>/)[0];
  const binding = tag.match(/bindtap="([^"]+)"/)[1];
  const handler = binding.startsWith('{{')
    ? vm.runInNewContext(binding.slice(2, -2), { _asPicker: picker.page.data._asPicker })
    : binding;
  picker.page[handler](event({ id: 'c7' }));
  await flush();
  assert.equal(h.page.data.customerId, 'c7');
  assert.equal(picker.navigation[0].back, true);
  if (caller === 'statement') assert.equal(statementCalls[0].data.customerId, 'c7');
});

for (const kind of ['sale', 'purchase', 'settle']) test(`${kind} retries retain request ID, successful next operation gets a new ID`, async () => {
  const requests = []; let fail = true;
  const method = { sale: 'submitSale', purchase: 'submitPurchase', settle: 'settleDebt' }[kind];
  const { page } = harness(kind === 'settle' ? 'order-detail' : kind, {
    [method]: async payload => { requests.push(clone(payload)); if (fail) throw Error('response lost'); return { fullyCleared: true }; }
  });
  const prepare = () => {
    if (kind === 'sale') { page.mergeIntoCart({ goodsId: 'g1', qty: 1, price: 40, stock: 7 }); }
    else if (kind === 'purchase') page.mergeLine({ goodsId: 'g1', qty: 1, unitCost: 20 });
    else page.setData({ doc: { _id: 'o1', debt: 40 } });
  };
  page.loadDoc = async () => {};
  const submit = () => kind === 'settle' ? page.confirmSettle('cash', 40) : page.doSubmit();
  prepare(); submit(); await flush();
  assert.ok(requests[0].requestId, 'the server needs the page operation ID');
  fail = false; submit(); await flush();
  assert.equal(requests[1].requestId, requests[0].requestId);
  prepare(); submit(); await flush();
  assert.notEqual(requests[2].requestId, requests[1].requestId);
});
test('debt confirmation guards two callbacks while a payment is pending', async () => {
  const requests = []; let resolve;
  const { page } = harness('order-detail', { settleDebt: payload => { requests.push(payload); return new Promise(r => { resolve = r; }); } });
  page.setData({ doc: { _id: 'o1', debt: 40 } }); page.loadDoc = async () => {};
  page.confirmSettle('cash', 40); page.confirmSettle('cash', 40);
  assert.equal(requests.length, 1);
  resolve({ fullyCleared: true }); await flush();
  assert.equal(page.data.settling, false);
});
test('switching order filters while a request is pending starts the new query and ignores stale results', async () => {
  let releaseOld;
  const requested = [];
  const { page, notices } = harness('orders', {
    cmd: () => ({ gte: () => ({ and: () => ({}) }), lt: () => ({}) }),
    listColl: async coll => {
      requested.push(coll);
      if (coll === 'sales_orders') return new Promise(resolve => { releaseOld = resolve; });
      return [{ _id: 'p-new', type: 'purchase', createdAt: '2026-09-11T12:00:00Z', lines: [] }];
    }
  });
  page.setData({ typeFilter: 'sale', startDate: '2026-09-11', endDate: '2026-09-11' });
  const old = page.reload(); await flush();
  page.setType(event({ t: 'purchase' })); await flush();
  assert.ok(requested.includes('purchase_orders'), 'new filter must query even when the old query is pending');
  assert.deepEqual(clone(page.data.list.map(r => r._id)), ['p-new']);
  releaseOld([{ _id: 's-old', type: 'sale', createdAt: '2026-09-11T13:00:00Z', lines: [] }]);
  await old; await flush();
  assert.equal(page.data.typeFilter, 'purchase');
  assert.deepEqual(clone(page.data.list.map(r => r._id)), ['p-new']);
  assert.equal(page.data.loading, false); assert.equal(page.data.hasMore, false);
  assert.equal(notices.length, 0);
});
test('new goods remain unsaved until atomic save succeeds and preserve the form after failure', async () => {
  let rejectSave;
  const { page, notices } = harness('goods-edit', {
    callFn: () => new Promise((resolve, reject) => { rejectSave = reject; })
  });
  page.setData({ form: { ...page.data.form, name: 'New', costPriceStr: '2', priceStr: '4', colors: ['red'],
    skus: [{ key: 'red-', color: 'red', size: '', stock: 3, costPrice: 2, price: 4 }] } });
  const saving = page.doSaveAfterCheck(page.data.form); await flush();
  assert.equal(page.data.isNew, true); assert.equal(page.data.saving, true);
  assert.deepEqual(notices, []);
  rejectSave(Error('atomic save failed')); await saving;
  assert.equal(page.data.isNew, true); assert.equal(page.data.id, ''); assert.equal(page.data.saving, false);
  assert.equal(page.data.form.skus[0].stock, 3);
  assert.deepEqual(notices, ['atomic save failed']);
});
