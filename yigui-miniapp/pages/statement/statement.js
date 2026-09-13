// pages/statement/statement.js —— 客户对账单
const util = require('../../utils/util.js');

Page({
  data: {
    customerId: '',
    customerName: '',
    customerLabel: '未选',
    startDate: '',
    endDate: '',
    quick: 'month',
    summary: null,
    list: [],
    loading: false
  },

  onLoad(query) {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    const today = util.todayStr();
    this.setData({
      startDate: util.addDays(today, -29),
      endDate: today,
      customerId: (query && query.customerId) || '',
      customerName: (query && query.customerName) || ''
    });
    if (this.data.customerId) {
      this.setData({ customerLabel: this.data.customerName || '已选客户' });
    }
    this.reload();
  },

  pickCustomer() {
    wx.navigateTo({
      url: '/pages/customers/customers?from=picker',
      events: {
        picked: (c) => {
          if (!c) return;
          this.setData({
            customerId: c._id,
            customerName: c.name || '',
            customerLabel: c.name + (c.phone ? ' · ' + c.phone : '')
          });
          this.reload();
        }
      }
    });
  },
  clearCustomer() {
    this.setData({ customerId: '', customerName: '', customerLabel: '未选' });
    this.reload();
  },

  setQuick(e) {
    const q = e.currentTarget.dataset.q;
    const today = util.todayStr();
    let start = today;
    if (q === 'today') start = today;
    else if (q === 'week') start = util.addDays(today, -6);
    else if (q === 'month') start = util.addDays(today, -29);
    else if (q === 'all') {
      this.setData({ quick: q, startDate: '2020-01-01', endDate: today });
      this.reload();
      return;
    }
    this.setData({ quick: q, startDate: start, endDate: today });
    this.reload();
  },
  onStartChange(e) {
    this.setData({ startDate: e.detail.value, quick: '' });
  },
  onEndChange(e) {
    this.setData({ endDate: e.detail.value, quick: '' });
    // 选完结束日期自动刷新（与 stats 一致），无需点查询按钮
    this.reload();
  },
  doQuery() { this.reload(); },

  async reload() {
    if (!this.data.customerId && !this.data.customerName) {
      this.setData({ summary: null, list: [] });
      return;
    }
    this.setData({ loading: true });
    try {
      const { startMs, endMs } = util.rangeMs(this.data.startDate, this.data.endDate);
      const r = await util.callFn('statement', {
        customerId: this.data.customerId,
        customerName: this.data.customerName,
        startMs: startMs,
        endMs: endMs
      });
      const d = (r && r.data) || {};
      const summary = d.summary || null;
      const list = (d.list || []).map((it) => Object.assign({}, it, {
        amountText: util.fmtMoney(it.amount),
        receivedText: util.fmtMoney(it.received),
        debtText: util.fmtMoney(it.debt)
      }));
      this.setData({ summary: summary, list: list, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '查询失败', icon: 'none' });
    }
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + id + '&type=sale' });
  }
});
