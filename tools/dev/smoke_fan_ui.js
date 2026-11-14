// 风扇卡片的界面冒烟测试（dev 工具，不进分发包）：真起一次 server.js，
// 用**无头 Edge** 打开 ?selftest=1，让页面自己把结论回传（data/selftest.log），
// 再挑出风扇那几条断言看。
//
// 为什么要有它：风扇这条链路的改动横跨 server.js / fan_collector.py / app.js / index.html，
// 而"页面真的渲染出来了没"是 node --check 和离线回归都看不出来的（脚本一抛错，
// 后面所有渲染就停在那儿，字面上一片正常）。这里全程在**临时数据目录**里跑，不碰用户的 data\。
//
//   node tools\dev\smoke_fan_ui.js
//
// 判据：页面把自测报告交回来了、报告里没有 FAIL、风扇那几条断言都在。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;
const DATA = path.join(os.tmpdir(), 'cuk_fan_ui_' + Date.now());

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('PASS  ' + label + (extra ? '   — ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + label + (extra ? '   — ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  for (const p of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

(async () => {
  const edge = findEdge();
  if (!edge) { console.log('没找到 msedge，跳过界面冒烟'); process.exit(0); }

  fs.mkdirSync(DATA, { recursive: true });
  // 温度计关掉：临时目录里没有 env.json 时会拿默认地址去连**真的**那台温湿度计，
  // 和用户正在跑的应用抢蓝牙（BLE 一个中心独占）。这里明确禁用。
  fs.writeFileSync(path.join(DATA, 'env.json'),
    JSON.stringify({ address: '', interval: 90, enabled: false }));

  console.log('临时数据目录: ' + DATA);
  const child = spawn(NODE, [path.join(APP, 'server.js'), '--no-window'], {
    cwd: APP,
    env: Object.assign({}, process.env, {
      CUKTECH_DATA: DATA, CUKTECH_NO_WINDOW: '1', CUKTECH_NO_TRAY: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  let port = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DATA, 'ready.json'), 'utf8'));
      if (r && r.port) { port = r.port; break; }
    } catch (_) {}
    if (child.exitCode != null) break;
  }
  ok(port > 0, '服务在 30 秒内就绪', 'port=' + port);
  if (!port) {
    console.log(logs.join('').slice(-2000));
    try { child.kill(); } catch (_) {}
    process.exit(1);
  }

  const logFile = path.join(DATA, 'selftest.log');
  // ⚠️ 故意**不加** --screenshot / --virtual-time-budget：这台机器上无头 Edge 对
  //    常驻 SSE + rAF 的页面会吊在 virtual-time 上（永远等不到"加载完成"），
  //    结果既不写截图也不返回 —— 项目里为此专门记过一条坑。
  //    这里只要页面**跑起来**并且把报告 POST 回来；Edge 由我们自己按时间掐掉。
  const edgeArgs = ['--headless=new', '--disable-gpu', '--no-first-run',
    '--window-size=1400,1040',
    '--user-data-dir=' + path.join(DATA, 'edge-profile'),
    'http://127.0.0.1:' + port + '/?selftest=1'];
  const ed = spawn(edge, edgeArgs, { stdio: 'ignore' });
  // 页面自测在 1.5 秒后启动，内部还要切两次区间（各 1.2 秒）+ 等 2.6 秒 ≈ 8 秒，
  // 所以按**真实时间**给足 45 秒，不靠 virtual-time 加速。
  for (let i = 0; i < 45 && !fs.existsSync(logFile); i++) await sleep(1000);
  try { ed.kill(); } catch (_) {}
  await sleep(500);

  ok(fs.existsSync(logFile), '页面把自测报告交回来了（脚本没崩在早期）');
  if (!fs.existsSync(logFile)) {
    console.log('--- 服务日志尾部 ---');
    console.log(logs.join('').slice(-2000));
    try { child.kill(); } catch (_) {}
    process.exit(1);
  }

  const lines = fs.readFileSync(logFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const fails = lines.filter((l) => l.startsWith('FAIL'));
  for (const l of lines) console.log('   ' + l);
  // 临时目录里没有充电头的历史数据（也不会去连它的蓝牙），所以"曲线有没有点"那几条
  // 必然 rows=0 —— 那是环境，不是回归。只认除此之外的 FAIL。
  const ENV_ONLY = [/首屏拿到状态/, /切区间后曲线有数据/, /30 分钟区间曲线有数据/, /数据在持续更新/];
  const real = fails.filter((l) => !ENV_ONLY.some((re) => re.test(l)));
  ok(real.length === 0, '界面自测没有 FAIL 项（rows=0 那几条是临时目录没数据，忽略）',
    real.join(' | ') || '无');

  // 风扇那几条必须在报告里（否则等于"这段断言被谁删了没人发现"）
  // 2026-10-11 起风扇不做功率/电量/曲线了，所以断言换成了「大数字位是状态」
  // + 「功率/电量/曲线的 DOM 已全部移除」+「不再出现推算」这几条。
  const fanNames = ['风扇卡片在', '风扇链路状态是中文说法', '大数字位是开关状态而不是瓦数',
    '功率/电量/曲线的 DOM 已全部移除', '不再出现「推算」字样'];
  const miss = fanNames.filter((n) => !lines.some((l) => l.includes(n)));
  ok(miss.length === 0, '风扇那几条界面断言都在报告里', miss.join(' | ') || '全在');

  try { child.kill(); } catch (_) {}
  console.log('\n============================================================');
  console.log(`风扇界面冒烟：${pass} PASS / ${fail} FAIL`);
  console.log('（临时目录 ' + DATA + ' 可以随时删掉）');
  process.exit(fail ? 1 : 0);
})();
