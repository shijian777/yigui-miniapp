// pages/receipt/receipt.js —— 电子小票
// 画布 384px 宽（= 58mm 热敏纸 @203dpi 打印宽度），所见即所得；
// 保存相册时放大到 2 倍分辨率输出更清晰。
const util = require('../../utils/util.js');
const receipt = require('../../utils/receipt.js');

const DRAW_W = receipt.DRAW_WIDTH; // 384

Page({
  data: {
    id: '',
    order: null,
    loading: true,
    errText: ''
  },

  onLoad(query) {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    this.setData({ id: query.id || '' });
    this.load();
  },

  async load() {
    try {
      await util.ensureOpenid();
      const [order, settings] = await Promise.all([
        util.getDocById('sales_orders', this.data.id),
        util.fetchSettings()
      ]);
      if (!order) {
        this.setData({ loading: false, errText: '订单不存在' });
        return;
      }
      if (order.type !== 'sale') {
        this.setData({ loading: false, errText: '只有销售单有小票' });
        return;
      }
      // 已退货的单也允许预览（原单红冲信息由老板口头说明，小票上不特殊标注）
      this.order = order;
      this.settings = settings;
      this.setData({ order: order, loading: false });
      this.scheduleRender();
    } catch (e) {
      this.setData({ loading: false, errText: (e && e.message) || '加载失败' });
    }
  },

  /* ---------- canvas 渲染 ---------- */
  onReady() {
    const query = wx.createSelectorQuery().in(this);
    query.select('#receiptCanvas').fields({ node: true, size: true }).exec((res) => {
      if (res && res[0] && res[0].node) {
        this.canvasNode = res[0].node;
        this.ctx = this.canvasNode.getContext('2d');
        this.canvasNode.width = DRAW_W;
        this.scheduleRender();
      } else {
        wx.showToast({ title: 'canvas 初始化失败，请升级基础库', icon: 'none' });
      }
    });
  },
  scheduleRender() {
    if (this.order && this.canvasNode) this.renderReceipt();
  },
  renderReceipt() {
    const ctx = this.ctx;
    const order = this.order;
    const settings = this.settings || {};
    // 第一遍只测量（measureText 与画布尺寸无关）
    const h = receipt.drawReceipt(ctx, DRAW_W, order, settings, { dryRun: true });
    this.canvasNode.height = Math.max(120, Math.ceil(h));
    // 画布尺寸重置会清空内容，第二遍正式绘制
    receipt.drawReceipt(ctx, DRAW_W, order, settings, {});
    this.tempFilePath = '';
  },

  /* ---------- 保存到相册 ---------- */
  saveImage() {
    const self = this;
    this.ensureAlbumAuth().then(() => {
      return util.wxP(wx.canvasToTempFilePath, {
        canvas: self.canvasNode,
        x: 0, y: 0,
        width: self.canvasNode.width,
        height: self.canvasNode.height,
        destWidth: self.canvasNode.width * 2,   // 放大 2x 更清晰
        destHeight: self.canvasNode.height * 2,
        fileType: 'png'
      });
    }).then((res) => {
      self.tempFilePath = res.tempFilePath;
      return util.wxP(wx.saveImageToPhotosAlbum, { filePath: res.tempFilePath });
    }).then(() => {
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    }).catch((e) => {
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
    });
  },
  // 相册权限：先查设置，被拒绝则引导去设置页打开
  ensureAlbumAuth() {
    return util.wxP(wx.getSetting).then((res) => {
      const auth = res.authSetting['scope.writePhotosAlbum'];
      if (auth === true || auth === undefined) {
        return util.wxP(wx.authorize, { scope: 'scope.writePhotosAlbum' })
          .catch(() => Promise.resolve()); // 已授权则 authorize 会直接成功；失败交给后续 save 报错
      }
      return new Promise((resolve, reject) => {
        wx.showModal({
          title: '需要相册权限',
          content: '保存小票图片到相册需要授权，请在设置中打开「添加到相册」。',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm) {
              wx.openSetting({
                success: (s) => {
                  if (s.authSetting['scope.writePhotosAlbum']) resolve();
                  else reject(new Error('未授权相册权限'));
                },
                fail: () => reject(new Error('无法打开设置'))
              });
            } else {
              reject(new Error('已取消保存'));
            }
          }
        });
      });
    });
  },

  /* ---------- 转发给顾客 ---------- */
  shareImage() {
    const self = this;
    const doShare = () => {
      // 官方接口：把本地图片直接分享到聊天（基础库 2.14.3+；开发者工具不支持，需真机）
      if (wx.showShareImageMenu && typeof wx.showShareImageMenu === 'function') {
        wx.showShareImageMenu({
          path: self.tempFilePath,
          fail: (err) => {
            console.warn('showShareImageMenu fail', err);
            wx.showToast({ title: '分享未完成，可先保存到相册再从聊天发送', icon: 'none' });
          }
        });
      } else {
        wx.showToast({ title: '当前版本不支持直接转发，请先保存到相册再发送', icon: 'none' });
      }
    };
    if (self.tempFilePath) {
      doShare();
    } else {
      this.ensureAlbumAuth().then(() => {
        return util.wxP(wx.canvasToTempFilePath, {
          canvas: self.canvasNode,
          x: 0, y: 0,
          width: self.canvasNode.width,
          height: self.canvasNode.height,
          destWidth: self.canvasNode.width * 2,
          destHeight: self.canvasNode.height * 2,
          fileType: 'png'
        });
      }).then((res) => {
        self.tempFilePath = res.tempFilePath;
        doShare();
      }).catch((e) => {
        wx.showToast({ title: (e && e.message) || '生成图片失败', icon: 'none' });
      });
    }
  },

  goPrinter() {
    wx.navigateTo({ url: '/pages/printer/printer?id=' + this.data.id });
  },
  goBack() {
    wx.navigateBack();
  }
});
