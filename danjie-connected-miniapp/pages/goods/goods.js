// pages/goods/goods.js —— 商品管理：搜索/列表/状态切换/上下架（色码版）
const util = require('../../utils/util.js');

Page({
  onLoad() {
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
  },
  data: {
    keyword: '',
    status: '',           // '' 全部 | on 在售 | off 停售
    list: [],
    skip: 0,
    hasMore: true,
    loading: false
  },

  onShow() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    this.reload();
  },
  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.fetchMore();
  },

  reload() {
    this.setData({ list: [], skip: 0, hasMore: true });
    return this.fetchMore();
  },

  async fetchMore() {
    this.setData({ loading: true });
    try {
      await util.ensureOpenid();
      const db = wx.cloud.database();
      const where = {};
      if (this.data.status) where.status = this.data.status;
      if (this.data.keyword) {
        const reg = db.RegExp({ regexp: util.escReg(this.data.keyword), options: 'i' });
        where.name = reg;
      }
      const rows = await util.listColl('goods', { where: where, orderBy: 'createdAt', order: 'desc', skip: this.data.skip, limit: 20 });
      // 低库存标记（阈值读设置，读不到用 5）
      const settings = getApp().globalData.settings;
      const limit = settings && settings.lowStockThreshold ? Number(settings.lowStockThreshold) : 5;
      const mapped = rows.map((g) => {
        const skus = Array.isArray(g.skus) ? g.skus : [];
        const totalStock = skus.length ? util.skuTotalStock(skus) : (Number(g.stock) || 0);
        const hasSku = skus.length > 1 || (skus.length === 1 && (skus[0].color || skus[0].size));
        const colorCount = Array.isArray(g.colors) ? g.colors.length : 0;
        const sizeCount = Array.isArray(g.sizes) ? g.sizes.length : 0;
        // 价格范围
        let priceLabel = util.fmtMoney(g.price || 0);
        if (skus.length > 0) {
          const prices = skus.map((s) => Number(s.price) || 0).filter((p) => p > 0);
          if (prices.length) {
            const min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
            priceLabel = min === max ? util.fmtMoney(min) : (util.fmtMoney(min) + '~' + util.fmtMoney(max));
          }
        }
        return Object.assign({}, g, {
          totalStock: totalStock,
          totalStockText: totalStock >= 1000 ? (Math.round(totalStock / 100) / 10 + 'k') : ('' + totalStock),
          stockLow: totalStock <= limit,
          hasSku: hasSku,
          colorCount: colorCount,
          sizeCount: sizeCount,
          skuTotal: skus.length || 1,
          priceLabel: priceLabel
        });
      });
      this.setData({
        list: this.data.list.concat(mapped),
        skip: this.data.skip + rows.length,
        hasMore: rows.length === 20,
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
    if (this._t) clearTimeout(this._t);
    this._t = setTimeout(() => this.reload(), 300);
  },
  clearKeyword() {
    this.setData({ keyword: '' });
    this.reload();
  },
  setStatus(e) {
    this.setData({ status: e.currentTarget.dataset.s });
    this.reload();
  },
  noop() {},

  // 快捷上/下架（不改库存，无流水产生，安全）
  onToggle(e) {
    const id = e.currentTarget.dataset.id;
    const status = e.detail.value ? 'on' : 'off';
    util.updateDocById('goods', id, { status: status }).then(() => {
      const list = this.data.list.map((g) => (g._id === id ? Object.assign({}, g, { status: status }) : g));
      this.setData({ list: list });
    }).catch((err) => {
      wx.showToast({ title: '操作失败：' + (err.message || ''), icon: 'none' });
      this.reload();
    });
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/goods-edit/goods-edit?id=' + e.currentTarget.dataset.id });
  },
  goAdd() {
    wx.navigateTo({ url: '/pages/goods-edit/goods-edit' });
  }
});
