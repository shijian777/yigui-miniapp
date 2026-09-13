// pages/order-detail/order-detail.js —— 订单详情 + 销售单退货（红冲）
const util = require('../../utils/util.js');

Page({
  data: {
    id: '',
    type: 'sale',
    isSale: true,
    typeText: '销售',
    doc: null,
    lines: [],
    timeText: '',
    returnedAtText: '',
    paymentText: '',
    money: {},
    returning: false,
    settling: false
  },

  onLoad(query) {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    this.setData({
      id: query.id || '',
      type: query.type === 'purchase' ? 'purchase' : 'sale',
      isSale: query.type !== 'purchase',
      typeText: query.type === 'purchase' ? '进货' : '销售'
    });
    this.loadDoc();
  },

  async loadDoc() {
    const coll = this.data.isSale ? 'sales_orders' : 'purchase_orders';
    try {
      await util.ensureOpenid();
      const doc = await util.getDocById(coll, this.data.id);
      if (!doc) {
        wx.showToast({ title: '订单不存在', icon: 'none' });
        return;
      }
      const lines = (doc.lines || []).map((l, i) => ({
        index: i,
        name: l.name || '(无名称)',
        qty: l.qty,
        unit: l.unit || '',
        amountText: util.fmtMoney(l.amount),
        priceText: util.fmtMoney(l.price !== undefined ? l.price : l.unitCost),
        costText: l.cost !== undefined ? util.fmtMoney(l.cost) : ''
      }));
      this.setData({
        doc: doc,
        lines: lines,
        timeText: util.fmtDateTime(doc.createdAt),
        returnedAtText: doc.returnedAt ? util.fmtDateTime(doc.returnedAt) : '',
        paymentText: util.paymentText(doc.paymentMethod),
        money: {
          amountDue: util.fmtMoney(doc.amountDue),
          received: util.fmtMoney(doc.received),
          change: util.fmtMoney(doc.change),
          debt: util.fmtMoney(doc.debt),
          discount: util.fmtMoney(doc.discountAmount),
          erase: util.fmtMoney(doc.eraseAmount),
          totalAmount: util.fmtMoney(doc.totalAmount)
        }
      });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  goReceipt() {
    wx.navigateTo({ url: '/pages/receipt/receipt?id=' + this.data.id });
  },
  goPrinter() {
    wx.navigateTo({ url: '/pages/printer/printer?id=' + this.data.id });
  },

  // 退货 = 整单红冲：库存回补 + 标记已退（云函数事务）
  doReturn() {
    if (this.data.returning) return;
    const doc = this.data.doc;
    wx.showModal({
      title: '整单退货',
      content: '确认退货本单 ¥' + util.fmtMoney(doc.amountDue) + '？库存将自动回补，此操作会标记订单为「已退货」。',
      confirmText: '确认退货',
      confirmColor: '#e64340',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ returning: true });
        util.returnSale({ orderId: this.data.id, reason: '门店退货' }).then(() => {
          this.setData({ returning: false });
          wx.showToast({ title: '退货成功，库存已回补', icon: 'success' });
          this.loadDoc();
        }).catch((e) => {
          this.setData({ returning: false });
          wx.showToast({ title: (e && e.message) || '退货失败', icon: 'none' });
        });
      }
    });
  },

  // 补收余款（欠款结清流程）
  doSettleDebt() {
    if (this.data.settling) return;
    const doc = this.data.doc;
    if (!doc || doc.debt <= 0) return;
    const debt = Number(doc.debt) || 0;
    // 弹出支付方式选择：默认 "现金"；选完直接收款（全额收齐）
    wx.showActionSheet({
      itemList: ['微信', '支付宝', '现金'],
      success: (r) => {
        if (r.tapIndex === undefined) return;
        const method = ['wechat', 'alipay', 'cash'][r.tapIndex];
        this.confirmSettle(method, debt);
      }
    });
  },
  confirmSettle(method, debt) {
    if (this.data.settling) return;
    const payload = { orderId: this.data.doc._id, amount: debt, paymentMethod: method };
    payload.requestId = util.operationRequestId(this, 'settleDebt', payload);
    this.setData({ settling: true });
    util.settleDebt(payload).then((r) => {
      util.clearOperationRequest(this, 'settleDebt');
      this.setData({ settling: false });
      wx.showToast({
        title: r.fullyCleared ? '已结清 ✓' : '已收部分 ¥' + util.fmtMoney(r.added),
        icon: 'success'
      });
      this.loadDoc();
    }).catch((e) => {
      this.setData({ settling: false });
      wx.showToast({ title: (e && e.message) || '补收失败', icon: 'none' });
    });
  }
});
