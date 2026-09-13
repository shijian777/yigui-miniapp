// 衣柜服装记账修复版。当前为本地模式，库存、订单与流水统一提交。
// Google服务器连接尚未启用；本轮修复不代表旧CloudBase云函数已经同步更新。
const CONFIG = {
  // ⚠️ 当前 useLocal=true 时此字段被忽略（数据走本地模拟层）。
  // 此修复版保持本地模式。切换其他后端需要对应接口适配和回归测试。
  // 注：微信 AppID ≠ 云开发 envId。下面这个值是用户的 AppID 占位，切真实云前一定要改。
  envId: '',
  // 本地模式：当前 AppID 为测试号（无法开通云开发）。置 true 时用本地模拟层，
  // wx.cloud.database()/callFunction 全部落设备本地 storage，无需云开发即可使用；
  // 旧 cloudfunctions 目录仅保留原包内容，尚未适配本轮新增的原子商品保存接口。
  useLocal: true
};

// 若开启本地模式，注入本地云开发模拟层（不改任何页面代码，页面仍写 wx.cloud.xxx）
if (CONFIG.useLocal) {
  try {
    const { createLocalCloud } = require('./utils/localcloud.js');
    // 覆盖 wx.cloud：database() / callFunction() / init() / command 均走本地实现
    wx.cloud = createLocalCloud();
    console.log('[app] 已启用本地数据层（LocalCloud），可在模拟器/真机离线使用');
  } catch (e) {
    console.error('[app] 注入本地数据层失败：', e && e.message);
  }
}

App({
  globalData: {
    openid: '',        // 由 login 云函数返回，所有数据按它隔离
    settings: null,    // 设置文档缓存（店名/电话/小票备注…）
    envId: CONFIG.envId,
    theme: 'auto'      // 主题：'light' / 'dark' / 'auto'
  },

  /**
   * 切换主题：light / dark / auto
   * 通过 page.setData 通知所有页面刷新 theme 变量，WXML 的 class 绑定 theme-{{theme}} 立刻生效
   */
  setTheme(mode) {
    this.globalData.theme = mode;
    try { wx.setStorageSync('__theme__', mode); } catch (e) {}
    const resolved = this._resolveTheme(mode);
    const pages = getCurrentPages();
    pages.forEach(p => {
      if (p && typeof p.setData === 'function') {
        p.setData({ theme: resolved, themeRaw: mode });
      }
    });
  },

  /**
   * 把 'auto' 解析为 'light' / 'dark'（读系统主题 wx.getSystemInfoSync.theme）
   */
  _resolveTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
      const sys = wx.getSystemInfoSync();
      return sys && sys.theme === 'dark' ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  },

  onLaunch() {
    // 恢复主题偏好
    try {
      const saved = wx.getStorageSync('__theme__');
      if (saved === 'light' || saved === 'dark' || saved === 'auto') {
        this.globalData.theme = saved;
      }
    } catch (e) {}

    if (!wx.cloud) {
      console.error('当前环境不支持云开发，请检查基础库版本');
      return;
    }
    const opt = { traceUser: true };
    if (CONFIG.envId && CONFIG.envId.indexOf('REPLACE') < 0) {
      opt.env = CONFIG.envId;
    }
    try {
      // 不显式传 env 时 wx.cloud.init 使用账号默认环境
      wx.cloud.init(opt);
      console.log('[app] cloud init done, env =', CONFIG.envId || '(默认环境)');
    } catch (e) {
      console.log('[app] cloud init skip（本地模式）：', e && e.message);
    }
  }
});
