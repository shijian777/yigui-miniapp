// pages/printer/printer.js —— 蓝牙热敏打印（微信官方 BLE API + ESC/POS 位图）
//
// 链路说明：
//   wx.openBluetoothAdapter -> startBluetoothDevicesDiscovery -> createBLEConnection
//   -> getBLEDeviceServices / getBLEDeviceCharacteristics（找可写特征）
//   -> writeBLECharacteristicValue 分包写入 ESC/POS 指令
// 打印数据：把小票用 canvas 2d 画成 384px 宽位图，getImageData 转 1bpp，
//   按 GS v 0 (raster bit-image) 每 8 点一行打包发送。中文不经过文本编码，天然无乱码。
// 分包大小：iOS 约 180B；安卓优先 setBLEMTU 到 512（≈480B 可用），失败退回 20B。
const util = require('../../utils/util.js');
const receipt = require('../../utils/receipt.js');
const escpos = require('../../utils/escpos.js');

const DRAW_W = receipt.DRAW_WIDTH; // 384
const SAVED_KEY = 'cpos_printer';
const DIR_KEY = 'cpos_printer_direction';  // 位图编码方向（standard/mirrorX/mirrorY/rot180）
const NO_RESP_DELAY = 25;  // write-no-response 模式：无应答节流，需稍慢防丢包
const RESP_DELAY = 10;     // write 模式：有应答天然节流，可快一些

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

Page({
  data: {
    id: '',
    order: null,
    amountText: '',
    timeText: '',
    loading: true,
    errText: '',
    adapterOn: false,
    discovering: false,
    devices: [],
    connectingId: '',
    connected: false,
    deviceName: '',
    serviceId: '',
    charId: '',
    writeMode: '',
    payloadSize: 0,
    savedName: '',
    direction: 'standard',
    printing: false,
    progressPct: 0,
    progressText: ''
  },

  onLoad(query) {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    this._devMap = {};        // deviceId -> device
    this._abort = false;
    let direction = 'standard';
    try {
      const d = wx.getStorageSync(DIR_KEY);
      if (d === 'standard' || d === 'mirrorX' || d === 'mirrorY' || d === 'rot180') direction = d;
    } catch (e) { /* ignore */ }
    try {
      const saved = wx.getStorageSync(SAVED_KEY);
      if (saved && saved.deviceId) this.setData({ savedName: saved.name || saved.deviceId });
    } catch (e) { /* ignore */ }
    this.setData({ id: query.id || '', direction: direction });
    this.loadOrder();
    this.bindBleEvents();
  },
  onUnload() {
    this.unbindBleEvents();
    this.cleanupConnection(true);
  },

  /* ================= 单据加载与画布 ================= */
  async loadOrder() {
    try {
      await util.ensureOpenid();
      if (!this.data.id) {
        this.setData({ loading: false, errText: '没有指定订单 ID。请从小票页面或订单详情进入' });
        return;
      }
      const [order, settings] = await Promise.all([
        util.getDocById('sales_orders', this.data.id),
        util.fetchSettings().catch(() => null)
      ]);
      if (!order || order.type !== 'sale') {
        this.setData({ loading: false, errText: '订单不存在或不是销售单' });
        return;
      }
      this.order = order;
      this.settings = settings || {};
      this.setData({
        order: order,
        loading: false,
        amountText: util.fmtMoney(order.amountDue),
        timeText: util.fmtDateTime(order.createdAt)
      });
      this.scheduleRender();
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  onReady() {
    const query = wx.createSelectorQuery().in(this);
    query.select('#printCanvas').fields({ node: true, size: true }).exec((res) => {
      if (res && res[0] && res[0].node) {
        this.canvasNode = res[0].node;
        this.ctx = this.canvasNode.getContext('2d');
        this.canvasNode.width = DRAW_W;
        this.scheduleRender();
      }
    });
  },
  scheduleRender() {
    if (this.order && this.canvasNode) this.renderReceipt();
  },
  renderReceipt() {
    const ctx = this.ctx;
    const h = receipt.drawReceipt(ctx, DRAW_W, this.order, this.settings, { dryRun: true });
    this.canvasNode.height = Math.max(120, Math.ceil(h));
    receipt.drawReceipt(ctx, DRAW_W, this.order, this.settings, {});
  },
  // 测试页：直接把画布清掉画测试内容（返回时若预览的是订单需重画一次）
  drawTestImage() {
    const ctx = this.ctx;
    const W = DRAW_W;
    const H = 220;
    this.canvasNode.height = H;
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('打印测试', W / 2, 14);
    ctx.font = '20px sans-serif';
    ctx.fillText('连接正常 · ESC/POS 位图模式', W / 2, 62);
    ctx.fillText('时间 ' + util.fmtDateTime(new Date()), W / 2, 96);
    ctx.fillText('宽度 384px（58mm 热敏纸）', W / 2, 130);
    ctx.fillRect(14, 180, W - 28, 4); // 底部黑色测试条
    return { width: W, height: H };
  },

  getCanvasImageData(w, h) {
    // 注意：必须等画布真正渲染完再取像素（onReady 之后、draw 完成之后调用）
    return this.ctx.getImageData(0, 0, w, h);
  },

  /* ================= 蓝牙事件绑定 ================= */
  bindBleEvents() {
    // 蓝牙适配器状态变化
    if (wx.onBluetoothAdapterStateChange) {
      this._adapterHandler = (res) => {
        this.setData({ adapterOn: !!res.available });
        if (!res.available) {
          this.setData({ connected: false, discovering: false });
        }
      };
      wx.onBluetoothAdapterStateChange(this._adapterHandler);
    }
    // 发现设备
    this._foundHandler = (res) => {
      const devs = res.devices || [];
      devs.forEach((d) => {
        if (!d || !d.deviceId) return;
        const old = this._devMap[d.deviceId];
        // 新广播常带更全的名称，做合并
        this._devMap[d.deviceId] = {
          deviceId: d.deviceId,
          name: (d.name || d.localName || (old && old.name) || '').toString()
        };
      });
      const list = [];
      for (const k in this._devMap) {
        if (Object.prototype.hasOwnProperty.call(this._devMap, k)) list.push(this._devMap[k]);
      }
      this.setData({ devices: list });
    };
    if (wx.onBluetoothDeviceFound) wx.onBluetoothDeviceFound(this._foundHandler);
  },
  unbindBleEvents() {
    if (this._adapterHandler && wx.offBluetoothAdapterStateChange) {
      try { wx.offBluetoothAdapterStateChange(this._adapterHandler); } catch (e) { /* ignore */ }
    }
    if (this._foundHandler && wx.offBluetoothDeviceFound) {
      try { wx.offBluetoothDeviceFound(this._foundHandler); } catch (e) { /* ignore */ }
    }
  },

  /* ================= 适配器 / 扫描 / 连接 ================= */
  ensureAdapter() {
    return new Promise((resolve, reject) => {
      wx.openBluetoothAdapter({
        success: () => {
          this.setData({ adapterOn: true });
          resolve();
        },
        fail: (err) => {
          // 10001：系统蓝牙不可用（未开启/无权限）；部分机型需在系统设置开启蓝牙
          const code = err && err.errCode;
          if (code === 10001) {
            this.setData({ adapterOn: false });
            reject(new Error('请先在手机系统设置里打开蓝牙'));
          } else {
            // 重复 open 在部分版本会报 -1/10000，此时查一次状态兜底
            wx.getBluetoothAdapterState({
              success: (s) => {
                if (s.available) { this.setData({ adapterOn: true }); resolve(); }
                else reject(new Error('蓝牙不可用（错误码 ' + code + '），请检查系统蓝牙'));
              },
              fail: () => reject(new Error('蓝牙初始化失败（错误码 ' + code + '）'))
            });
          }
        }
      });
    });
  },

  async startScan() {
    if (this.data.discovering) return;
    try {
      await this.ensureAdapter();
      this._devMap = {};
      this.setData({ discovering: true, devices: [] });
      await util.wxP(wx.startBluetoothDevicesDiscovery, {
        allowDuplicatesKey: false,
        interval: 0 // 尽量快上报，避免列表刷新过慢
      });
      // 12 秒自动停止
      if (this._scanTimer) clearTimeout(this._scanTimer);
      this._scanTimer = setTimeout(() => this.stopScan(), 12000);
    } catch (e) {
      this.setData({ discovering: false });
      wx.showToast({ title: (e && e.message) || '搜索失败', icon: 'none' });
    }
  },
  async stopScan() {
    if (this._scanTimer) { clearTimeout(this._scanTimer); this._scanTimer = null; }
    if (this.data.discovering) {
      this.setData({ discovering: false });
      try { await util.wxP(wx.stopBluetoothDevicesDiscovery); } catch (e) { /* ignore */ }
    }
  },

  reconnectSaved() {
    let saved = null;
    try { saved = wx.getStorageSync(SAVED_KEY); } catch (e) { /* ignore */ }
    if (!saved || !saved.deviceId) {
      wx.showToast({ title: '没有可重连的打印机，请先搜索连接一次', icon: 'none' });
      return;
    }
    this.connectDeviceInternal(saved.deviceId, saved.name || '上次的打印机');
  },
  connectDevice(e) {
    const d = e.currentTarget.dataset;
    this.connectDeviceInternal(d.id, d.name);
  },
  async connectDeviceInternal(deviceId, name) {
    if (this.data.connectingId) return;
    this.setData({ connectingId: deviceId });
    try {
      await this.ensureAdapter();
      await this.stopScan();
      await util.wxP(wx.createBLEConnection, { deviceId: deviceId, timeout: 10000 });
      // 找服务与可写特征
      const chosen = await this.findWritableCharacteristic(deviceId);
      if (!chosen) {
        throw new Error('该设备没有可写入的 BLE 特征；请确认打印机支持 BLE（低功耗蓝牙），老款仅支持经典蓝牙的机型无法用本程序连接');
      }
      // 分包大小
      const payload = await this.calcPayload(deviceId);

      this.conn = { deviceId: deviceId, serviceId: chosen.serviceId, charId: chosen.characteristicId };
      try {
        wx.setStorageSync(SAVED_KEY, { deviceId: deviceId, name: name || deviceId });
      } catch (e) { /* ignore */ }
      this.setData({
        connected: true,
        deviceName: name || deviceId,
        savedName: name || deviceId,
        serviceId: chosen.serviceId,
        charId: chosen.characteristicId,
        writeMode: chosen.mode,
        payloadSize: payload,
        connectingId: ''
      });
    } catch (e) {
      this.setData({ connectingId: '' });
      // 连接失败后主动断开，避免半开连接占用
      try { await util.wxP(wx.closeBLEConnection, { deviceId: deviceId }); } catch (e2) { /* ignore */ }
      wx.showToast({ title: (e && e.message) || '连接失败，请重试', icon: 'none' });
    }
  },

  // 遍历服务/特征，找一个支持 write 或 writeWithoutResponse 的特征
  async findWritableCharacteristic(deviceId) {
    let services = [];
    try {
      const r = await util.wxP(wx.getBLEDeviceServices, { deviceId: deviceId });
      services = r.services || [];
    } catch (e) { return null; }
    const candidates = [];
    for (let i = 0; i < services.length; i++) {
      const svc = services[i];
      let chars = [];
      try {
        const r = await util.wxP(wx.getBLEDeviceCharacteristics, { deviceId: deviceId, serviceId: svc.uuid });
        chars = r.characteristics || [];
      } catch (e) { continue; }
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        const props = ch.properties || 0;
        const noResp = (props & escpos.PROP_WRITE_NO_RESP) > 0;
        const write = (props & escpos.PROP_WRITE) > 0;
        if (noResp || write) {
          candidates.push({
            serviceId: svc.uuid,
            characteristicId: ch.uuid,
            mode: noResp ? 'noresp' : 'resp'
          });
        }
      }
    }
    // 优先 write-no-response（速度快）；都行时倾向 FFE1（佳博/芯烨常见约定）
    candidates.sort((a, b) => {
      const aScore = (a.mode === 'noresp' ? 1 : 0) * 2 + (/ffe1/i.test(a.characteristicId) ? 1 : 0);
      const bScore = (b.mode === 'noresp' ? 1 : 0) * 2 + (/ffe1/i.test(b.characteristicId) ? 1 : 0);
      return bScore - aScore;
    });
    return candidates.length ? candidates[0] : null;
  },

  // 每包长度必须 ≤ 协商 MTU - 3（BLE 数据包有 3 字节 ATT 头）；无法确定时保守用 20。
  async calcPayload(deviceId) {
    const sys = wx.getSystemInfoSync();
    const platform = (sys.platform || '').toLowerCase();
    if (platform === 'ios') {
      // iOS 自动协商 MTU≈185，可用载荷 ≤182，取 180 保险
      return 180;
    }
    if (platform === 'android' || platform === 'devtools') {
      if (wx.setBLEMTU && typeof wx.setBLEMTU === 'function') {
        try {
          await util.wxP(wx.setBLEMTU, { deviceId: deviceId, mtu: 512 });
          // 512-3=509，再留余量取 480；若芯片实际 MTU 更小，首包写失败会自动降级到 20
          return 480;
        } catch (e) { /* 老芯片 MTU 固定 23，走 20 */ }
      }
    }
    // 最保守：ATT 默认 MTU=23，有效载荷 23-3=20
    return 20;
  },

  disconnect() {
    this.cleanupConnection(false);
  },
  async cleanupConnection(closeAdapter) {
    this.setData({ connected: false, discovering: false });
    if (this._scanTimer) { clearTimeout(this._scanTimer); this._scanTimer = null; }
    try { await util.wxP(wx.stopBluetoothDevicesDiscovery); } catch (e) { /* ignore */ }
    if (this.conn && this.conn.deviceId) {
      try { await util.wxP(wx.closeBLEConnection, { deviceId: this.conn.deviceId }); } catch (e) { /* ignore */ }
      this.conn = null;
    }
    if (closeAdapter) {
      try { await util.wxP(wx.closeBluetoothAdapter); } catch (e) { /* ignore */ }
    }
  },

  /* ================= 打印 ================= */
  async printOrder() {
    if (!this.conn || !this.order) return;
    this.renderReceipt(); // 确保画布是最新订单
    const img = this.getCanvasImageData(DRAW_W, this.canvasNode.height);
    await this.runPrint(img, '小票');
  },
  async printTest() {
    if (!this.conn) return;
    const box = this.drawTestImage();
    const img = this.getCanvasImageData(box.width, box.height);
    await this.runPrint(img, '测试页');
    // 测试后恢复订单预览
    if (this.order) this.renderReceipt();
  },
  cancelPrint() {
    this._abort = true;
  },
  // 位图编码参数：真机打印出现镜像/颠倒/错位时切对应档位即可（无需改代码）
  getRasterOpts() {
    switch (this.data.direction) {
      case 'mirrorX': return { bitOrder: 'lsb', reverseRows: false }; // 左右镜像
      case 'mirrorY': return { bitOrder: 'msb', reverseRows: true };  // 上下颠倒
      case 'rot180': return { bitOrder: 'lsb', reverseRows: true };   // 旋转180°
      default: return { bitOrder: 'msb', reverseRows: false };        // 标准
    }
  },
  onDirectionChange(e) {
    const d = e.currentTarget.dataset.d;
    this.setData({ direction: d });
    try { wx.setStorageSync(DIR_KEY, d); } catch (err) { /* ignore */ }
  },

  async runPrint(imgData, label) {
    if (this.data.printing) return;
    if (!this.conn) {
      wx.showToast({ title: '请先连接打印机', icon: 'none' });
      return;
    }
    // 完整指令流：ESC @ + GS v 0(头+光栅数据) + 走纸/切纸，一次拼好再游标顺序写
    const raster = escpos.buildRasterCommand(imgData, this.getRasterOpts());
    const init = escpos.initCmds();
    const finish = escpos.finishCmds();
    const stream = new Uint8Array(init.length + raster.length + finish.length);
    stream.set(init, 0);
    stream.set(raster, init.length);
    stream.set(finish, init.length + raster.length);

    const conn = this.conn;
    let payload = this.data.payloadSize || 20;   // 每包 ≤ MTU-3，默认 20 保守
    const delay = this.data.writeMode === 'noresp' ? NO_RESP_DELAY : RESP_DELAY;
    this._abort = false;
    this.setData({ printing: true, progressPct: 0, progressText: label + ' 0%' });

    let pos = 0;
    try {
      // 游标顺序写：某位置写失败且 payload>20 时只降级 payload、不前进游标重试，
      // 避免把已发送的数据重复发送导致打印错位/花屏（原实现按 item 重发会重复前几包）。
      while (pos < stream.length) {
        if (this._abort) throw new Error('已取消');
        const size = Math.min(payload, stream.length - pos);
        const slice = stream.slice(pos, pos + size);
        try {
          await this.writeOne(conn, escpos.toArrayBuffer(slice));
          pos += size;
        } catch (e) {
          if (payload > 20) {
            payload = 20;   // 降级重试（游标不变，不重复发送）
          } else {
            throw e;
          }
        }
        const pct = Math.floor((pos / stream.length) * 100);
        this.setData({ progressPct: pct, progressText: label + ' ' + pct + '%' });
        if (delay) await sleep(delay);
      }
      this.setData({ progressPct: 100, progressText: label + ' 完成' });
      wx.showToast({ title: '打印完成', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '打印失败，请重试', icon: 'none' });
    } finally {
      this.setData({ printing: false });
    }
  },

  writeOne(conn, buffer) {
    return new Promise((resolve, reject) => {
      wx.writeBLECharacteristicValue({
        deviceId: conn.deviceId,
        serviceId: conn.serviceId,
        characteristicId: conn.charId,
        value: buffer,
        success: () => resolve(),
        fail: (err) => reject(new Error('数据写入失败（' + (err && err.errCode) + '），打印机可能已断开或休眠'))
      });
    });
  }
});
