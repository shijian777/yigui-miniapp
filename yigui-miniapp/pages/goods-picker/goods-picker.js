// pages/goods-picker/goods-picker.js —— 商品选择器（通过 eventChannel 把选中的商品回传）
const util = require('../../utils/util.js');

Page({
  data: {
    keyword: '',
    list: [],
    skip: 0,
    hasMore: true,
    loading: false
  },

  onLoad() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    this.reload();
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
      const where = { status: 'on' };
      if (this.data.keyword) {
        const reg = db.RegExp({ regexp: util.escReg(this.data.keyword), options: 'i' });
        where.name = reg;
      }
      const rows = await util.listColl('goods', { where: where, orderBy: 'updatedAt', order: 'desc', skip: this.data.skip, limit: 20 });
      // 库存展示自愈：有 skus 以 skus 合计为准；无 skus 以 stock 为准（旧数据 totalStock 可能是脏值）
      const items = rows.map((g) => {
        const skus = Array.isArray(g.skus) ? g.skus : [];
        const shown = skus.length ? util.skuTotalStock(skus) : (Number(g.stock) || 0);
        return Object.assign({}, g, { totalStock: shown, stock: shown });
      });
      this.setData({
        list: this.data.list.concat(items),
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

  // 点选后通过 eventChannel 回传并返回（单个商品 + SKU 全量快照）
  onPick(e) {
    const g = this.data.list[e.currentTarget.dataset.index];
    if (!g) return;
    const channel = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (channel && channel.emit) {
      channel.emit('pick', {
        goodsId: g._id,
        name: g.name,
        unit: g.unit || '件',
        price: Number(g.price) || 0,
        costPrice: Number(g.costPrice) || 0,
        stock: Number(g.stock) || 0,
        // 新增：传递色码快照给 sku-picker 使用
        colors: Array.isArray(g.colors) ? g.colors : [],
        sizes: Array.isArray(g.sizes) ? g.sizes : [],
        skus: Array.isArray(g.skus) ? g.skus.map((s) => ({
          key: s.key || '',
          color: s.color || '',
          size: s.size || '',
          stock: Number(s.stock) || 0,
          costPrice: Number(s.costPrice) || 0,
          price: Number(s.price) || 0
        })) : []
      });
    }
    wx.navigateBack();
  }
});
