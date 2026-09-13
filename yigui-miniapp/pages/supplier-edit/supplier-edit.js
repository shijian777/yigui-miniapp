// pages/supplier-edit/supplier-edit.js —— 供应商新增/编辑/删除
const util = require('../../utils/util.js');

Page({
  data: {
    id: '',
    isNew: true,
    saving: false,
    form: { name: '', contact: '', phone: '', remark: '' }
  },

  onLoad(query) {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    if (query.id) {
      this.setData({ id: query.id, isNew: false });
      this.loadDoc(query.id);
    }
  },

  async loadDoc(id) {
    try {
      await util.ensureOpenid();
      const doc = await util.getDocById('suppliers', id);
      if (!doc) {
        wx.showToast({ title: '供应商不存在', icon: 'none' });
        return;
      }
      this.setData({ form: { name: doc.name || '', contact: doc.contact || '', phone: doc.phone || '', remark: doc.remark || '' } });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.f]: e.detail.value });
  },

  doSave() {
    if (this.data.saving) return;
    const f = this.data.form;
    const name = (f.name || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写供应商名称', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const payload = {
      name: name,
      contact: (f.contact || '').trim(),
      phone: (f.phone || '').trim(),
      remark: (f.remark || '').trim()
    };
    const done = () => {
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    };
    (this.data.isNew ? util.addDoc('suppliers', payload) : util.updateDocById('suppliers', this.data.id, payload))
      .then(done)
      .catch((e) => {
        this.setData({ saving: false });
        wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
      });
  },

  doDelete() {
    wx.showModal({
      title: '删除供应商',
      content: '确定删除「' + this.data.form.name + '」？历史进货单不受影响。',
      confirmColor: '#e64340',
      success: (res) => {
        if (!res.confirm) return;
        util.removeDocById('suppliers', this.data.id).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 500);
        }).catch((e) => {
          wx.showToast({ title: (e && e.message) || '删除失败', icon: 'none' });
        });
      }
    });
  }
});
