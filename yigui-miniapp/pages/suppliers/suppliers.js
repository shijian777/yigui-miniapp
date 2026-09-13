// pages/suppliers/suppliers.js —— 供应商列表
const util = require('../../utils/util.js');

Page({
  onLoad() {
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
  },
  data: { list: [], loading: true },
  onShow() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
 this.load(); },
  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const list = await util.listCollAll('suppliers', { orderBy: 'createdAt', order: 'desc' });
      this.setData({ list: list, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/supplier-edit/supplier-edit?id=' + e.currentTarget.dataset.id });
  },
  goAdd() {
    wx.navigateTo({ url: '/pages/supplier-edit/supplier-edit' });
  }
});
