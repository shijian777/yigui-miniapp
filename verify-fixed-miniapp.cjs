const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), cp = require('node:child_process');
const root = path.join(__dirname, 'danjie-connected-miniapp');
const errors = [];
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? e.name === 'h5' ? [] : walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
let js = 0, json = 0, bindings = 0;
for (const file of walk(root)) {
  if (file.endsWith('.js')) { js++; const r = cp.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); if (r.status !== 0) errors.push({ file, error: r.stderr }); }
  if (file.endsWith('.json')) { json++; try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { errors.push({ file, error: e.message }); } }
}
global.wx = {}; global.getApp = () => ({ globalData: {} });
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
for (const page of app.pages) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) if (!fs.existsSync(path.join(root, page + '.' + ext))) errors.push({ missing: page + '.' + ext });
  const file = path.join(root, page + '.js'); let config;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: x => config = x, require: s => require(path.resolve(path.dirname(file), s)), getApp, wx, console, setTimeout, clearTimeout, Date });
  const markup = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8');
  for (const match of markup.matchAll(/(?:bind|catch)(?::?[\w-]+)\s*=\s*["']([\w$]+)["']/g)) {
    bindings++; if (typeof config[match[1]] !== 'function') errors.push({ page, missingHandler: match[1] });
  }
}
const tests = fs.readdirSync(path.join(__dirname, 'client-tests')).filter(x => x.endsWith('.test.cjs')).map(x => path.join(__dirname, 'client-tests', x));
const result = cp.spawnSync(process.execPath, ['--test', ...tests], { encoding: 'utf8' });
const output = result.stdout + result.stderr;
fs.writeFileSync(path.join(__dirname, '修复回归测试日志.txt'), output);
if (result.status !== 0) errors.push({ testsFailed: true });
const passed = Number((output.match(/(?:ℹ|#) pass (\d+)/) || [])[1] || 0);
const report = { testedAt: new Date().toISOString(), source: root, mode: 'local', jsChecked: js, jsonChecked: json, pagesChecked: app.pages.length, bindingsChecked: bindings, testsPassed: passed, errors, boundaries: ['Node.js runs real business modules with isolated wx storage and Page API stubs.', 'No WeChat compiler, real phone, Bluetooth printer, or server integration pass is claimed.'] };
fs.writeFileSync(path.join(__dirname, '修复验证结果.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = errors.length || !passed ? 1 : 0;
