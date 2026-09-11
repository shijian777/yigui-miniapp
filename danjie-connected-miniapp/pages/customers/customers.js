// pages/customers/customers.js —— 客户档案列表（搜索/标签筛选 + 累计统计）
const util = require('../../utils/util.js');

Page({
  onLoad(query) {
    this._asPicker = !!(query && query.from === 'picker');
    this.setData({ _asPicker: this._asPicker });
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
  },
  data: {
    _asPicker: false,
    keyword: '',
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
    if (this._asPicker) {
      wx.setNavigationBarTitle({ title: '选择客户' });
    }
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
      const _ = db.command;
      const where = { openid: getApp().globalData.openid };
      if (this.data.keyword) {
        const reg = db.RegExp({ regexp: util.escReg(this.data.keyword), options: 'i' });
        where.name = reg;
      }
      const rows = await util.listColl('customers', { where: where, orderBy: 'lastOrderAt', order: 'desc', skip: this.data.skip, limit: 20 });
      const mapped = rows.map((c) => Object.assign({}, c, {
        totalSpentText: util.fmtMoney(c.totalSpent || 0),
        totalDebtText: util.fmtMoney(c.totalDebt || 0)
      }));
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

  goEdit(e) {
    const id = e.currentTarget.dataset.id || '';
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit?id=' + id });
  },
  goAdd() {
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit' });
  },
  // 销售页通过 from=picker 显式启用选择模式。
  goPickForCaller() {
    // 默认就是受 pickCustomer 调用，由 caller 监听 picked 事件
  },
  onTapRow(e) {
    const id = e.currentTarget.dataset.id;
    const c = (this.data.list || []).find((x) => x._id === id);
    if (!c) return;
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (this._asPicker && ch) {
      // picker 模式下回传给 caller；否则交给 goEdit
      try {
        if (ch.emit) {
          ch.emit('picked', c);
          wx.navigateBack();
          return;
        }
      } catch (err) { /* 不报错，给调用方机会兜底 */ }
    }
    // 否则当作普通点击：编辑
    this.goEdit({ currentTarget: { dataset: { id: id } } });
  },
  goDetail(e) {
    if (this._asPicker) {
      this.onTapRow(e);
      return;
    }
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ['查看订单流水', '编辑资料', '删除客户'],
      success: (res) => {
        if (res.tapIndex === 0) {
          // 跳到订单列表并按客户筛选（order-detail 单个）
          wx.showToast({ title: '请到 订单流水 → 客户筛选', icon: 'none' });
        } else if (res.tapIndex === 1) {
          wx.navigateTo({ url: '/pages/customer-edit/customer-edit?id=' + id });
        } else if (res.tapIndex === 2) {
          this.confirmDelete(id);
        }
      }
    });
  },
  async confirmDelete(id) {
    const c = (this.data.list || []).find((x) => x._id === id);
    if (!c) return;
    if ((c.totalSpent || 0) > 0 || (c.totalDebt || 0) > 0) {
      wx.showToast({ title: '客户有交易/欠款记录，不能删除', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '删除客户',
      content: '确认删除「' + (c.name || '') + '」？此操作不可撤销。',
      confirmColor: '#e64340',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await util.removeDocById('customers', id);
          wx.showToast({ title: '已删除', icon: 'success' });
          this.reload();
        } catch (e) {
          wx.showToast({ title: e.message || '删除失败', icon: 'none' });
        }
      }
    });
  }
});
