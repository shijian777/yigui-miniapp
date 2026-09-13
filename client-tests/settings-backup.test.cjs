const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../yigui-miniapp');
function page(overrides = {}) {
  const notices = [], saved = [], imported = [];
  const util = { exportAllData: async () => ({ json: '{"backup":true}', counts: { goods: 3 } }), buildBackupFilename: () => 'backup.json', importAllData: async (json, mode) => imported.push({ json, mode }), wxP: (fn, opt) => new Promise((resolve, reject) => fn({ ...opt, success: resolve, fail: reject })) };
  const wx = { env: { USER_DATA_PATH: '/data' }, getFileSystemManager: () => ({ writeFile: o => { saved.push(o); o.success({}); }, readFile: o => o.success({ data: '{"backup":true}' }) }), showToast: o => notices.push(o.title), shareFileMessage: o => o.success({}), chooseMessageFile: o => o.success({ tempFiles: [{ path: '/backup.json' }] }), showActionSheet: o => o.success({ tapIndex: 0 }), showModal: o => o.success({ confirm: true }), ...overrides };
  let p;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/settings/settings.js'), 'utf8'), { require: s => s.includes('data-backup') ? { validateBackup: () => ({ data: { goods: [] } }) } : util, wx, Page: x => p = x, getApp: () => ({ globalData: {} }), console });
  p.setData = x => Object.assign(p.data, x); p.load = async () => {};
  return { p, notices, saved, imported };
}
test('settings awaits backup counts and export writes a shareable JSON file', async () => {
  const f = page(); await f.p.refreshBackupStats(); assert.equal(f.p.data.backupStats.goods, 3);
  await f.p.doExport(); assert.equal(f.saved[0].filePath, '/data/backup.json'); assert.equal(f.saved[0].data, '{"backup":true}');
});
test('import button chooses file and restores only after confirmation', async () => {
  const f = page(); await f.p.doImport(); assert.equal(f.imported.length, 1); assert.equal(f.imported[0].mode, 'merge');
  const cancelled = page({ showModal: o => o.success({ confirm: false }) }); await cancelled.p.doImport(); assert.equal(cancelled.imported.length, 0);
});
test('export storage failure surfaces an error and releases busy state', async () => {
  const f = page({ getFileSystemManager: () => ({ writeFile: o => o.fail({ errMsg: '空间不足' }) }) });
  await f.p.doExport(); assert.ok(f.notices.some(x => x.includes('空间不足'))); assert.equal(f.p.data.backupBusy, false);
});
