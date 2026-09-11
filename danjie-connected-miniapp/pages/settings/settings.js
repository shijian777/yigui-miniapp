// pages/settings/settings.js —— 设置（settings 集合单文档；首次打开自动建默认文档）
const util = require('../../utils/util.js');

Page({
  onLoad() {
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
  },
  data: {
    backupBusy: false,
    backupStats: {},
    backupError: '',
    saving: false,
    docId: '',
    theme: 'light',
    themeRaw: 'auto',
    form: {
      storeName: '', phone: '', address: '', receiptNote: '',
      defaultPayment: 'cash',
      lowStockThresholdStr: '5',
      showQrPlaceholder: false
    }
  },

  onShow() {
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
    this.load();
    this.refreshBackupStats();
  },

  async refreshBackupStats() {
    try {
      const r = await util.exportAllData();
      this.setData({ backupStats: r.counts || {}, backupError: '' });
    } catch (e) {
      this.setData({ backupError: (e && e.message) || '读取账本失败，请保留数据' });
    }
  },

  async doExport() {
    if (this.data.backupBusy) return;
    this.setData({ backupBusy: true });
    try {
      const backup = await util.exportAllData();
      const fileName = util.buildBackupFilename();
      const filePath = wx.env.USER_DATA_PATH + '/' + fileName;
      const fs = wx.getFileSystemManager();
      await util.wxP(fs.writeFile.bind(fs), { filePath, data: backup.json, encoding: 'utf8' });
      this.setData({ lastBackupPath: filePath });
      if (typeof wx.shareFileMessage === 'function') {
        await util.wxP(wx.shareFileMessage.bind(wx), { filePath, fileName });
      } else {
        await util.wxP(wx.showModal.bind(wx), { title: '备份文件已生成', content: '文件位置：' + filePath + '\n当前微信不支持分享文件，请更新微信后再导出。', showCancel: false });
      }
    } catch (e) {
      const message = (e && (e.message || e.errMsg)) || '导出失败';
      if (!/cancel/.test(message)) wx.showToast({ title: message, icon: 'none' });
    } finally { this.setData({ backupBusy: false }); }
  },

  async confirmImport(json, mode) {
    const parsed = require('../../utils/data-backup').validateBackup(json);
    const count = Object.keys(parsed.data).reduce((sum, key) => sum + (Array.isArray(parsed.data[key]) ? parsed.data[key].length : 0), 0);
    const result = await util.wxP(wx.showModal.bind(wx), {
      title: mode === 'merge' ? '确认合并备份' : '确认覆盖恢复',
      content: '备份包含 ' + count + ' 条记录。' + (mode === 'merge' ? '保留当前数据和设置；相同编号内容不同会停止合并。' : '当前账本将由这份备份替换，未包含的集合将清空。') + '恢复前会自动保存当前账本。换设备的备份将归属当前账号。',
      confirmText: '确认恢复'
    });
    if (!result.confirm) return;
    await util.importAllData(json, mode);
    await this.load();
    await this.refreshBackupStats();
    wx.showToast({ title: '恢复成功', icon: 'success' });
  },

  async doImport() {
    if (this.data.backupBusy) return;
    this.setData({ backupBusy: true });
    try {
      const chosen = await util.wxP(wx.chooseMessageFile.bind(wx), { count: 1, type: 'file', extension: ['json'] });
      if (!chosen.tempFiles || !chosen.tempFiles.length) return;
      const fs = wx.getFileSystemManager();
      const file = await util.wxP(fs.readFile.bind(fs), { filePath: chosen.tempFiles[0].path, encoding: 'utf8' });
      require('../../utils/data-backup').validateBackup(file.data);
      const choice = await util.wxP(wx.showActionSheet.bind(wx), { itemList: ['合并（保留当前数据）', '覆盖（替换整个账本）'] });
      if (choice.tapIndex !== 0 && choice.tapIndex !== 1) return;
      await this.confirmImport(file.data, choice.tapIndex === 0 ? 'merge' : 'overwrite');
    } catch (e) {
      const message = (e && (e.message || e.errMsg)) || '恢复失败，原数据未修改';
      if (!/cancel/.test(message)) wx.showToast({ title: message, icon: 'none' });
    } finally { this.setData({ backupBusy: false }); }
  },

  async undoImport() {
    if (this.data.backupBusy) return;
    this.setData({ backupBusy: true });
    try { await this.confirmImport(await util.exportBeforeRestore(), 'overwrite'); }
    catch (e) { wx.showToast({ title: (e && e.message) || '恢复前备份读取失败', icon: 'none' }); }
    finally { this.setData({ backupBusy: false }); }
  },

  setTheme(e) {
    const mode = e.currentTarget.dataset.t;
    getApp().setTheme(mode);
    this.setData({ theme: getApp()._resolveTheme(mode), themeRaw: mode });
  },

  async load() {
    try {
      await util.ensureOpenid();
      const s = await util.fetchSettings(true);
      this.setData({
        docId: s._id || '',
        form: {
          storeName: s.storeName || '',
          phone: s.phone || '',
          address: s.address || '',
          receiptNote: s.receiptNote || '',
          defaultPayment: s.defaultPayment || 'cash',
          lowStockThresholdStr: String(s.lowStockThreshold === undefined || s.lowStockThreshold === null ? 5 : s.lowStockThreshold),
          showQrPlaceholder: !!s.showQrPlaceholder
        }
      });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '设置加载失败（请确认已开通云开发并创建 settings 集合）', icon: 'none' });
    }
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.f]: e.detail.value });
  },
  setPayment(e) {
    this.setData({ 'form.defaultPayment': e.currentTarget.dataset.p });
  },
  onQrSwitch(e) {
    this.setData({ 'form.showQrPlaceholder': e.detail.value });
  },
  goPrinter() {
    wx.navigateTo({ url: '/pages/printer/printer' });
  },

  async save() {
    if (this.data.saving) return;
    const f = this.data.form;
    const threshold = Math.floor(util.toNum(f.lowStockThresholdStr, 5));
    if (threshold < 0) {
      wx.showToast({ title: '低库存阈值不能为负', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const payload = {
      storeName: (f.storeName || '').trim(),
      phone: (f.phone || '').trim(),
      address: (f.address || '').trim(),
      receiptNote: (f.receiptNote || '').trim(),
      defaultPayment: f.defaultPayment,
      lowStockThreshold: threshold,
      showQrPlaceholder: f.showQrPlaceholder
    };
    try {
      if (!this.data.docId) {
        // 理论上 load() 已保证存在；双保险：再读一次或新建
        const s = await util.fetchSettings(true);
        payload._id = s._id;
        this.setData({ docId: s._id });
      }
      await util.updateDocById('settings', this.data.docId, payload);
      // 刷新全局缓存
      getApp().globalData.settings = null;
      await util.fetchSettings(true);
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  }
});
