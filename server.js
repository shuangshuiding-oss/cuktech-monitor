'use strict';

/**
 * 酷态科10号Ultra 监视器 —— 后端服务
 * ------------------------------------------------------------------
 * 职责：
 *   1. 管理 Python BLE 采集器子进程（collector.py），把它输出的 JSON 行
 *      变成内存里的最新状态 + 滚动历史
 *   2. 提供 HTTP API 给界面（功率、四口状态、设置、日志）
 *   3. 代理小米云扫码登录（login.py qr / poll）
 *   4. 静态文件服务 + 空闲自杀 + 防重复启动
 *
 * 只用 Node 内置模块，不需要 npm install。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { launchWindow } = require('./launcher');
// 桌面壁纸探测：透明窗口的"退路背景"用（不依赖 DWM 材质也能透出桌面）。
const { findWallpaper } = require('./wallpaper');

const APP = __dirname;
const WEB = path.join(APP, 'web');
// 数据目录：默认放应用同级 data\。留一个环境变量出口 —— 自动化测试要在一个**临时目录**
// 里验"单实例接管"（往真 data\ 里写 running.lock 会把用户正在跑的实例的锁弄坏）。
const DATA = process.env.CUKTECH_DATA || path.join(APP, 'data');
const READY = path.join(DATA, 'ready.json');
const LOCK = path.join(DATA, 'running.lock');
// 心跳文件（v1.8.22）：运行中的服务每 5 秒刷新一次，退出时删掉。
// 为什么需要它 —— 见 resolveRunningInstance 的说明：光看 "pid 还活着" 会被 Windows 的
// **PID 回收**骗过去（进程早没了、pid 被别人拿去用，process.kill(pid,0) 照样成功）。
// 心跳只有真在跑的那个进程才会写，所以它能证明"这个 pid 确实是我们的服务"。
const ALIVE = path.join(DATA, 'alive.json');
const ALIVE_EVERY_MS = 5000;    // 刷新间隔
const ALIVE_FRESH_MS = 30000;   // 超过这个时长没刷新 = 不算活着（容 6 次漏拍，事件循环短暂卡住不算死）
const CFG = path.join(DATA, 'config.json');
const TOKEN = path.join(DATA, 'cuktech.token');
const ENV_CFG = path.join(DATA, 'env.json');   // 温度计设置（地址 / 轮询间隔 / 开关）
// 温湿度历史：和功率曲线同一套两层结构（原始 + 每分钟降采样），
// 因为温度计本身就是低频设备，原始行数少得多，但结构保持一致更好维护。
const ENV_HIST_DIR = path.join(DATA, 'env-history');       // 原始读数，按天一个文件
const ENV_HIST_MIN = path.join(DATA, 'env-history-min.jsonl');  // 每分钟一行，长期保留
// 小米电风扇（Wi-Fi / miIO）：登录时落盘的是**设备身份**（IP + 16 字节 token），
// fan.json 是**采集器真正读的那份**（多带 interval）—— 两者分开是因为
// token 只在登录那一刻由 login.py 写，而设置随时会改。
// ⚠️ 风扇**没有任何电参量属性**，所以这里**没有**用电量账本、也没有分钟行历史 ——
//    功率/电量/曲线这一套在 2026-10-11 按用户要求整体删除（推算值看着像实测）。
const FAN_TOKEN = path.join(DATA, 'fan.token');
const FAN_CFG = path.join(DATA, 'fan.json');
const ENV_KEEP_DAYS = 30;      // 温度比功率"该留得久一点"（一天才 960 行，占不了多少）
// 设备内置历史读回来之后，温度能追到半年前 —— 这些行必须活得比 30 天长，
// 否则"全部"档位切过去只剩最近一个月，前面的又被当作过期文件删掉了。
const ENV_KEEP_DAYS_DEVICE = 400;   // 留 400 天：盖住设备那 152 小时以上的存量，
                                    // 也让「1 年」档不会因为清理而只剩两百多天
// 设备内置历史每条覆盖的时长（1 小时）。落盘时写在 sp 字段里，前端才知道
// 一条记录该铺多宽（见 app.js drawEnvChart 的"小时带"）。见 mergeEnvHistory 的说明。
const DEV_HIST_SPAN_MS = 3600000;
const HIST = path.join(DATA, 'history.jsonl');          // 旧格式（升级前的遗留，只读）
const HIST_DIR = path.join(DATA, 'history');            // 新的原始采样，按天一个文件
const HIST_MIN = path.join(DATA, 'history-min.jsonl');  // 每分钟降采样，长期保留
const ENERGY = path.join(DATA, 'energy.json');
const APLOG = path.join(DATA, 'app.log');
const VERSION_FILE = path.join(APP, 'version.json');
// 充电头"识别设备"的原始记录：每个新出现的协议码组合记一行，见 trackIdent()。
const IDENT = path.join(DATA, 'ident.log');
// 「异常检查」：每次"有电压没电流"落一行（JSONL，最近 500 条）。
// 和 app.log 分开：这是给人看的明细表，会被界面反复读，混进日志里没法解析。
const AUTO_OFF_LOG = path.join(DATA, 'auto-off.jsonl');
// 界面自测（?selftest=1）的报告落盘处。之所以要它：这台机器上无头 Edge 的
// `--dump-dom` 拿不到 stdout（GUI 子系统），页面把结论 POST 回来最省事，
// 也让"界面是不是又冻住了"随时可查（读这个文件即可）。
const SELFTEST_LOG = path.join(DATA, 'selftest.log');

// 开机自启动：往「启动」文件夹放一个 .lnk（用户看得见、随时能删）。
// 之所以不用注册表 Run，是因为 .lnk 更透明；创建动作由应用自己的进程做。
const STARTUP_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows',
  'Start Menu', 'Programs', 'Startup');
const AUTOSTART_LNK = path.join(STARTUP_DIR, '酷态科10号Ultra.lnk');

// "后台运行"档：这次启动不弹窗口（托盘/网页照常）。只影响本次启动，
// 不影响之后手动点「打开窗口」—— 所以不能用 CUKTECH_NO_WINDOW 那种进程级开关。
const BOOT_NO_WINDOW = process.argv.includes('--no-window');

/** 版本号/名称/型号只有一个来源：根目录 version.json（server / collector / 界面都读它）。 */
function readMeta() {
  try {
    const j = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);
    return {
      version: str(j.version, '0.0.0'),
      name: str(j.name, '酷态科10号Ultra'),
      model: str(j.model, ''),
      bleName: str(j.ble_name, ''),
      productId: str(j.product_id, ''),
    };
  } catch (_) {}
  return { version: '0.0.0', name: '酷态科10号Ultra', model: '', bleName: '', productId: '' };
}
const META = readMeta();
const VERSION = META.version;

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const IDLE_EXIT_MS = 120000;   // 无请求 2 分钟后自杀，避免留下幽灵进程
const SESSION_GAP_MS = 60000;  // 空载持续这么久就算一次充电结束
const ENERGY_SAVE_MS = 15000;
const PORTS = ['c1', 'c2', 'c3', 'a'];
const PORT_LABEL = { c1: 'C1', c2: 'C2', c3: 'C3', a: 'USB-A' };
// 小米电风扇的属性映射：名称 → [siid, piid]。界面/接口只说名字，映射只在这一处。
// ⚠️ 2.4 和 2.6 在官方规格库里都叫 fan-level：2.4 是 1~4 的档位，2.6 是 1~100 的
//    无级调速。滑条走 2.6，快捷档位按钮走 2.4 —— 两个都要保留。
const FAN_PROPS = {
  power: [2, 1],        // 开关
  oscillate: [2, 2],    // 左右摆风
  mode: [2, 3],         // 0 自然风 / 1 直吹风
  level: [2, 4],        // 档位 1~4
  angle: [2, 5],        // 摆风夹角 30/60/90/120/140
  speed: [2, 6],        // 无级调速 1~100
  child_lock: [3, 1],   // 物理控制锁（童锁）
  led: [4, 1],          // 指示灯
  buzzer: [5, 1],       // 提示音
  off_timer: [6, 1],    // 定时 0~480 分钟
};
const FAN_PROP_CN = {
  power: '开关', oscillate: '摆风', mode: '风型', level: '档位', angle: '摆风夹角',
  speed: '风速', child_lock: '童锁', led: '指示灯', buzzer: '提示音', off_timer: '定时',
};
// 电量单位换算用的电芯标称电压，和 web/app.js 的 CELL_V 必须一致：
// mAh = Wh ÷ 3.7 × 1000。服务端只在 CSV 与通知文案里用它。
const CELL_V = 3.7;

const HIST_KEEP_DAYS = 7;      // 原始采样（1.5s）只留最近 7 天，日文件各占一份

// 自动断电（5V 空载）的默认值。⚠️ 必须放在 loadConfig() 之前求值 ——
// 它是在模块顶层被调用的（`let config = loadConfig()`），放后面会撞 const 的 TDZ。
const AUTO_OFF_DEF = {
  enabled: true, vMin: 5, iMax: 0.02, idleSec: 5, restoreMin: 15, skipSmallA: true,
};
const MIN_ROW_MS = 60000;      // 降采样粒度：每分钟一行
const CHART_MAX_POINTS = 400;  // 任何区间都最多回这么多点给前端
// 温度曲线的上限单独一档、宽得多：它是两种粒度混着的（设备历史每小时一条 + 本应用 90 秒一条），
// 400 点的话 7 天档就要抽稀，一抽稀每小时那条就被并掉（实测每天只剩 16 点）。1200 点足够原样画 30 天。
const ENV_MAX_POINTS = 1200;

// 曲线区间 → 秒。≤1h 走内存里的原始点（1.5s 一个点），更长的走 history-min.jsonl。
// 短窗是「看细节」用的：1 分钟 ≈40 点、10 分钟 ≈400 点，正好落在 CHART_MAX_POINTS 内；
// 30 分钟（1800s）算中等窗，在 1.5s 采样下约 1200 点，会被 downsample 压到 400 点
// （≈4.5s 一个点）—— 细节仍在，但又不至于让区间切换时一次下发上千点。
// 2/3/4 小时（v1.6.5 加）走分钟文件：分别是 120/180/240 行，**都在 400 点以内**，
// 等于每分钟一个点不抽稀 —— 看「这一上午的节奏」比 1 小时更完整，又比 6 小时清楚。
// ⚠️ 上面那组数字是**按 1.5s 采样**算的。采样间隔可调（0.2~5s），所以「1 小时」这条
//    区间在 0.5s 采样下会攒到 7200 个点 —— 内存上限和下发点数都必须跟着间隔走，
//    不能写死（写死 3600 点时选「1 小时」只能看到半小时，曲线右半张是空的）。
const HISTORY_RANGES = {
  '1m': 60, '5m': 300, '10m': 600, '30m': 1800,
  '1h': 3600, '2h': 7200, '3h': 10800, '4h': 14400,
  '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000,
  // 温度计设备内置历史能存半年（实测一次读回 156 天），功率曲线到不了这么长。
  // 这几档在界面上平时隐藏，读过设备历史才放出来（见 app.js 的 renderEnvRanges）。
  // 90 天 / 半年 / 1 年：给"想固定看某个跨度"用（半年 ≈ 设备存量上限，1 年等攒够）；
  // 窗口超过 300 天时界面把刻度换成「年-月」。
  '90d': 7776000, '180d': 15552000, '1y': 31536000, 'all': 0,
};

// 首选端口：固定下来网页才能收藏。占用就顺延，全占满再退回系统随机端口。
// ⚠️ 候选端口必须避开 Windows 的「保留/排除端口范围」。
//    本机 `netsh int ipv4 show excludedportrange protocol=tcp` 显示 8000 / 8200 / **8800** /
//    8821 / 8850 都被排除（8800 上是 pid 4 的内核服务）。绑这些端口拿到的是 **EACCES**
//    而不是 EADDRINUSE；老代码只认 EADDRINUSE，于是把"换一个端口"当成了致命错误直接退出。
//    2026-10-08 用户报「桌面快捷方式打不开」正是这条：8799 被已在跑的实例占着 → 顺延到 8800
//    → EACCES → 进程退出 → bat 等不到 ready.json → 报「启动失败」。
const PREFERRED_PORTS = [8799, 8790, 8791, 8792, 8793, 8794];

try { fs.mkdirSync(DATA, { recursive: true }); } catch (_) {}

// ------------------------------------------------------------------ 日志

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(String).join(' ')}`;
  try { fs.appendFileSync(APLOG, line + '\r\n'); } catch (_) {}
  try {
    if (fs.statSync(APLOG).size > 2 * 1024 * 1024) {
      // 轮转保留上一代，别直接清空 —— 之前是 writeFileSync(APLOG, '')，
      // 排查问题时最想看的上下文刚好被抹掉。
      try { fs.renameSync(APLOG, APLOG + '.1'); }
      catch (_) { fs.writeFileSync(APLOG, ''); }
    }
  } catch (_) {}
  if (process.env.CUKTECH_VERBOSE === '1') console.log(line);
}

// ------------------------------------------------------------------ 配置

function loadConfig() {
  // ⚠️ 不再硬编码任何设备地址：便携包要发给别人，对方的充电头 MAC 必然不同。
  // 地址按这个优先级解析：config.json > token 文件里记的地址 > 登录时自动发现。
  const d = { address: '', interval: 1.5, tray: true, trayMode: 'total', notify: true,
    fanInterval: 2 };
  try { Object.assign(d, JSON.parse(fs.readFileSync(CFG, 'utf8'))); } catch (_) {}
  if (![ 'all', 'panel' ].includes(d.trayMode)) d.trayMode = 'total';   // 只允许 total | all | panel
  const fi = Number(d.fanInterval);
  d.fanInterval = (fi >= 0.5 && fi <= 30) ? fi : 2;       // 风扇轮询间隔（秒）
  d.autoOff = normAutoOff(d.autoOff);                     // 自动断电（5V 空载）
  return d;
}
function saveConfig(c) {
  try { fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); } catch (_) {}
}
let config = loadConfig();

// ------------------------------------------------------------------ Python

const PY_CANDIDATES = [
  path.join(APP, 'runtime', 'python', 'python.exe'),        // 便携包自带（可直接复制出去跑）
  path.join(APP, '.venv', 'Scripts', 'python.exe'),          // 本机开发环境
  path.join(APP, 'pyembed', 'python.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Python313', 'python.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Python312', 'python.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
];

let _py = undefined;
function findPython() {
  if (_py !== undefined) return _py;
  _py = null;
  for (const p of PY_CANDIDATES) {
    try { if (p && fs.existsSync(p)) { _py = p; return _py; } } catch (_) {}
  }
  return _py;
}

/** token 文件里记的设备地址（登录时写入）。 */
function tokenAddress() {
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN, 'utf8'));
    const a = String(t.address || '').toUpperCase();
    return MAC_RE.test(a) ? a : null;
  } catch (_) { return null; }
}

/** 实际要用的设备地址：config 优先，其次 token，都没有就是空串（等登录自动发现）。 */
function effectiveAddress() {
  const c = String(config.address || '').trim().toUpperCase();
  if (MAC_RE.test(c)) return c;
  return tokenAddress() || '';
}

// ------------------------------------------------------------------ 状态存储

const state = {
  collector: null,          // 子进程
  collecting: false,
  restarts: 0,
  lastSpawnAt: 0,
  latest: null,             // 最近一次 state 行
  link: { state: 'idle', msg: '尚未启动采集', attempt: 0 },
  history: [],              // [{at, total, w:{c1,c2,c3,a}}]
  logLines: [],
  writable: [],             // 采集器 hello 里声明的可写属性表
  switches: [],             // 协议开关清单（端口 × 协议 × bit），也来自 hello
  sweep: null,              // 最近一次隐藏属性/GATT 扫描结果
  // 环境温度计（外挂传感器，独立进程）。它的死活与充电头链路完全无关：
  // 温度计读不到时只是这张卡灰掉，功率采集不受任何影响。
  env: {
    proc: null,             // env_sensor.py 子进程
    reading: null,          // {temp_c, humidity, battery, source, at, ...}
    history: [],            // 最近的温湿度读数 [{at,t,h,b}]，供「≤1 小时」曲线
    ok: false,
    msg: '',
    since: 0,               // 本进程内最后一次成功读数的时间
    address: '',
    interval: 90,
    enabled: true,
    restarts: 0,
  },
  // 小米电风扇（Wi-Fi / miIO，独立进程 fan_collector.py）。
  // 和温度计一样的原则：这条链路**可失败**，风扇连不上不影响充电头。
  fan: {
    proc: null,
    running: false,
    restarts: 0,
    hello: null,            // 采集器 hello（属性清单 / 可写清单都在这儿）
    link: { state: 'idle', msg: '尚未启动风扇采集', at: 0 },
    latest: null,           // 最近一帧 state（props + raw）
    writable: [],
    pending: new Map(),     // 命令 → ack
    seq: 0,
  },
};

// 内存里保留多少原始点。按当前采样间隔算，保证「1 小时」区间一定有整段的点：
//   1.5s → 2400+120，0.5s → 7200+120，0.2s → 18000+120（上限 24000，约 2MB，无所谓）。
// 原来写死 3600（只有 1.5s 采样时才够 1 小时），用户把间隔调到 0.5s 后
// 「1 小时」区间就只能看到最近 30 分钟，曲线左半张永远空着。
const HISTORY_MAX_MIN = 3600;
const HISTORY_MAX_CAP = 24000;
function historyMax() {
  const iv = Number(config && config.interval) || 1.5;
  const need = Math.ceil(HISTORY_RANGES['1h'] / Math.max(0.2, iv)) + 120;
  return Math.max(HISTORY_MAX_MIN, Math.min(need, HISTORY_MAX_CAP));
}

// ---------------------------------------------------------------- 历史落盘
//
// 旧实现只有一个 history.jsonl，超过 8MB 就**静默截断到最后 2000 行**（≈50 分钟）：
// 那既是“昨天的曲线看不到”的原因，也会连带缩短启动时回填电量断档的窗口。
// 现在分两层：
//   data/history/history-YYYY-MM-DD.jsonl  原始采样，按天滚动，只留 HIST_KEEP_DAYS 天
//   data/history-min.jsonl                 每分钟一行（均值 + 峰值），跟能量账本同寿命
// ----------------------------------------------------------------------------

let histDay = '';
let minBucket = null;

function histDayPath(ts) { return path.join(HIST_DIR, 'history-' + dayKey(ts) + '.jsonl'); }

/** 丢掉太老的日文件（只删我们自己命名的 history-*.jsonl）。 */
function pruneHistDays() {
  try {
    const keep = new Set();
    for (let i = 0; i < HIST_KEEP_DAYS; i++) {
      keep.add('history-' + dayKey(Date.now() - i * 86400000) + '.jsonl');
    }
    for (const f of fs.readdirSync(HIST_DIR)) {
      if (/^history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && !keep.has(f)) {
        try { fs.unlinkSync(path.join(HIST_DIR, f)); log('history roll: 删除过期日文件', f); } catch (_) {}
      }
    }
  } catch (_) {}
}

function appendHistoryRow(row) {
  try {
    fs.mkdirSync(HIST_DIR, { recursive: true });
    const k = dayKey(row.at);
    if (k !== histDay) { histDay = k; pruneHistDays(); }
    fs.appendFileSync(histDayPath(row.at), JSON.stringify(row) + '\n');
  } catch (_) {}
}

/** 把当前那一分钟的桶写进 history-min.jsonl（**同一分钟只允许一行**）。 */
function flushMinute() {
  const b = minBucket;
  minBucket = null;
  if (!b || !b.n) return;
  const out = { at: b.minute, n: b.n, total: round3(b.total / b.n), peak: round3(b.peak), w: {} };
  for (const id of PORTS) out.w[id] = round3(b.ports[id] / b.n);
  try {
    // ⚠️ 这里以前是无条件 appendFileSync，于是同一分钟会出现两行：
    //    rollupMinute 只比较"当前桶的分钟"，而接蓝牙重连/重传时可能来一个时间戳落在
    //    **已经写过**那一分钟的迟到采样 —— 它会把那一分钟重新开一个桶，落盘时就多一行。
    //    实测 2026-09-22 的文件里有 8 个这样的重复分钟（如 17:38 同时存在
    //    {n:24,total:0} 和 {n:49,total:8.656}）。
    //    后果：长区间曲线在同一横坐标上有两个值（画出来是一根竖刺），
    //    /api/history 的 at 不再严格递增，6 小时窗口的点数甚至比 24 小时还多。
    //    现在改成幂等写：已有更完整的就丢掉这条，这条更完整就**就地替换**（不追加）。
    const rows = parseRows(HIST_MIN);
    const idx = rows.findIndex((r) => r.at === b.minute);
    if (idx >= 0) {
      if (Number(rows[idx].n || 0) >= b.n) return;
      rows[idx] = out;
      fs.writeFileSync(HIST_MIN, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return;
    }
    fs.appendFileSync(HIST_MIN, JSON.stringify(out) + '\n');
  } catch (_) {}
}

function rollupMinute(row) {
  const m = Math.floor(row.at / MIN_ROW_MS) * MIN_ROW_MS;
  if (!minBucket || minBucket.minute !== m) {
    flushMinute();
    minBucket = { minute: m, n: 0, total: 0, peak: 0, ports: zeroPorts() };
  }
  const b = minBucket;
  const tot = Number(row.total || 0);
  b.n++;
  b.total += tot;
  b.peak = Math.max(b.peak, tot);
  for (const id of PORTS) b.ports[id] += Number((row.w && row.w[id]) || 0);
}

// ------------------------------------------------------------ 温湿度历史落盘
//
// 结构照抄功率那套，但粒度天然不同：温度计 90 秒才一个读数，一天 ≈960 行原始，
// 所以原始文件留 30 天（功率只留 7 天）。每分钟一行在 90s 间隔下也是"平均 0.67 个
// 读数"，用均值会造出假点 —— 所以这里的 row 只存**实际存在的读数**，不做补零，
// 长区间直接由原始行按区间抽稀（温度不需要"断档补 0"，那是功率的语义）。
// ----------------------------------------------------------------------------

let envHistDay = '';

function envDayPath(ts) { return path.join(ENV_HIST_DIR, 'env-' + dayKey(ts) + '.jsonl'); }

/** 丢掉太老的日文件（只删我们自己命名的 env-*.jsonl）。
 *
 *  ⚠️ 天数用 ENV_KEEP_DAYS_DEVICE 而不是 ENV_KEEP_DAYS：设备内置历史读回来后
 *     温度会追到半年前，那些日文件不能被"30 天以外即过期"的规则删掉，
 *     否则用户切到「全部」再切回「90 天」就发现前面的行凭空少了。
 */
function pruneEnvHistDays() {
  try {
    const keep = new Set();
    for (let i = 0; i < ENV_KEEP_DAYS_DEVICE; i++) keep.add('env-' + dayKey(Date.now() - i * 86400000) + '.jsonl');
    for (const f of fs.readdirSync(ENV_HIST_DIR)) {
      if (/^env-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && !keep.has(f)) {
        try { fs.unlinkSync(path.join(ENV_HIST_DIR, f)); log('env roll: 删除过期日文件', f); } catch (_) {}
      }
    }
  } catch (_) {}
}

/** 一个成功读数 → 一行 {at, t, h, b}（t=温度℃，h=湿度%，b=电量%或 null）。 */
function appendEnvRow(reading) {
  try {
    fs.mkdirSync(ENV_HIST_DIR, { recursive: true });
    const at = reading.at || Date.now();
    const k = dayKey(at);
    if (k !== envHistDay) { envHistDay = k; pruneEnvHistDays(); }
    const row = { at, t: round3(reading.temp_c), h: round1(reading.humidity) };
    if (reading.battery != null) row.b = reading.battery;
    fs.appendFileSync(envDayPath(at), JSON.stringify(row) + '\n');
    // 同一分钟也补一行到 env-history-min.jsonl —— 长时间看（7/30 天）只读这个文件，
    // 不必把 30 天的原始行全读出来。同一分钟只留第一条（温度本来就慢，无需均值）。
    const m = Math.floor(at / MIN_ROW_MS) * MIN_ROW_MS;
    const min = { at: m, t: row.t, h: row.h };
    if (row.b != null) min.b = row.b;
    const rows = parseRows(ENV_HIST_MIN);
    if (!rows.length || rows[rows.length - 1].at !== m) {
      fs.appendFileSync(ENV_HIST_MIN, JSON.stringify(min) + '\n');
    } else {
      rows[rows.length - 1] = min;                 // 同一分钟已有：用更新的那条覆盖（就地）
      fs.writeFileSync(ENV_HIST_MIN, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
  } catch (_) {}
}

/** env-history-min.jsonl 的读缓存（按 mtime，理由同 readMinRows）。 */
let envMinCache = { mtime: 0, rows: [] };
function readEnvMinRows() {
  try {
    const st = fs.statSync(ENV_HIST_MIN);
    if (st.mtimeMs !== envMinCache.mtime) envMinCache = { mtime: st.mtimeMs, rows: parseRows(ENV_HIST_MIN) };
  } catch (_) { envMinCache = { mtime: 0, rows: [] }; }
  return envMinCache.rows;
}

/**
 * 取温湿度曲线点。
 *
 * ⚠️ 和功率曲线一个关键区别：温湿度**不做"断档补 0"**。功率的 0 有意义
 *   （"这里确实没在充电"），而温度没有"0℃ 等于没数据"这种语义 ——
 *   补 0 会画出一条掉到冰点的假线。所以这里只回实际存在的点，
 *   前端遇空档直接断开连线（见 app.js 的 drawEnvChart）。
 *
 * ≤1h 用内存里的读数；更长的区间按天读原始文件（30 天也就 ≈2.9 万行，
 * 一次性读 + 抽稀到 CHART_MAX_POINTS 完全够快）。
 */
/**
 * 把温湿度读数按「本地自然日」聚合成一天一个点。
 *
 * 长区间上每小时一个点太密（156 天 ≈ 3800 个点），而且看不出"哪几天热"。
 * 按天压成「日均 + 当日最高/最低」后，一张图就能读完一个季度：
 * 均值线看趋势，最高/最低的阴影带看昼夜温差和"那天开没开空调"。
 *
 * ⚠️ 按本地日期分组（dayKey），不用 UTC —— 用户说的"每天"是他自己的每天。
 * ⚠️「今天」是**还没过完**的一天，均值只代表已经过去的那些小时，
 *    所以每个点都带上采样点数 n，让表格能自证这一天是不是只有半天数据。
 * ⚠️ at 取**当天正午**而不是零点：画出来正好落在那一天的中段，
 *    不会让最后一个点贴在图的最左边（零点的话今天那个点看着像昨天的）。
 */
function aggregateEnvDaily(rows) {
  // ⚠️ 必须用这个而不是 Number()：Number(null) === 0，缺字段的坏行会被当成 0℃，
  //    混进"当日最低/最高"里就画出一条从 0℃ 起的假阴影带。
  const num = envNum;      // 判空统一走模块级的 envNum（Number(null)===0 的坑）
  const g = new Map();
  for (const r of rows) {
    if (!r || !Number.isFinite(r.at)) continue;
    const k = dayKey(r.at);
    let d = g.get(k);
    if (!d) {
      d = {
        day: k, at0: new Date(r.at).setHours(0, 0, 0, 0), n: 0,
        tSum: 0, tN: 0, tMin: Infinity, tMax: -Infinity,
        hSum: 0, hN: 0, hMin: Infinity, hMax: -Infinity,
      };
      g.set(k, d);
    }
    const t = num(r.t), h = num(r.h);
    // 行里自带区间（设备小时记录 / 将来的其它聚合）就直接用 —— 比"由均值再求最小最大"
    // 准得多：按天视图的"当日最低~最高"从此是设备实测的极值，不再被均值抹平。
    const tlo = num(r.tmin), thi = num(r.tmax);
    const hlo = num(r.hmin), hhi = num(r.hmax);
    if (Number.isFinite(t)) {
      d.tSum += t; d.tN += 1;
      if (t < d.tMin) d.tMin = t;
      if (t > d.tMax) d.tMax = t;
    }
    if (Number.isFinite(tlo) && tlo < d.tMin) d.tMin = tlo;
    if (Number.isFinite(thi) && thi > d.tMax) d.tMax = thi;
    if (Number.isFinite(h)) {
      d.hSum += h; d.hN += 1;
      if (h < d.hMin) d.hMin = h;
      if (h > d.hMax) d.hMax = h;
    }
    if (Number.isFinite(hlo) && hlo < d.hMin) d.hMin = hlo;
    if (Number.isFinite(hhi) && hhi > d.hMax) d.hMax = hhi;
    d.n += 1;
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  const out = [];
  for (const d of g.values()) {
    out.push({
      at: d.at0 + 43200000,              // 当天正午
      day: d.day,
      t: d.tN ? r1(d.tSum / d.tN) : null,
      h: d.hN ? r1(d.hSum / d.hN) : null,
      tmin: d.tN ? r1(d.tMin) : null,
      tmax: d.tN ? r1(d.tMax) : null,
      hmin: d.hN ? r1(d.hMin) : null,
      hmax: d.hN ? r1(d.hMax) : null,
      n: d.n,
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** 温湿度字段的"数字或 null"读取。
 *  ⚠️ 必须显式判空：Number(null) === 0，缺字段的行会被当成 0℃，污染"当日最低/最高"。 */
function envNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  return Number(v);
}

/**
 * 把多来源的温湿度行合成一条时间轴：**按 at 去重，同一时刻留"信息更全"的那行**。
 *
 * ⚠️ 为什么必须去重：覆盖写（mergeEnvHistory）会把同一批设备行**同时写进日文件和分钟文件**，
 *    取数时两条来源都读（长区间缺一条就只看得到一个月），于是同一时刻出现两行完全相同的记录。
 *    后面抽稀是"按行分组取均值"的，等于每个采样点被算两次 —— 结果每天的点被吃掉一半：
 *    实测 7 天档 10-02~10-06 每天只剩 **16 个点、相邻两点差 2 小时**，曲线上出现一段段空白，
 *    用户看到的就是"温度还是没覆盖"（2026-10-08 报的）。
 */
function mergeEnvSources(list) {
  const byAt = new Map();
  const score = (r) => (Number(r.sp) > 0 ? 4 : 0) + (r.tmin != null ? 2 : 0) + (r.b != null ? 1 : 0);
  for (const r of list) {
    if (!r || !Number.isFinite(r.at)) continue;
    const old = byAt.get(r.at);
    if (!old || score(r) > score(old)) byAt.set(r.at, r);
  }
  return [...byAt.values()].sort((a, b) => a.at - b.at);
}

function queryEnvHistory(seconds, opts) {
  const sec = (Number.isFinite(seconds) && seconds > 0) ? seconds : 3600;
  const daily = !!(opts && opts.daily);
  const since = Date.now() - sec * 1000;
  let src;
  if (sec <= HISTORY_RANGES['1h']) {
    src = state.env.history || [];               // 内存里的最近读数
  } else {
    src = [];
    // ⚠️ 按天文件只覆盖"本应用自己采过的那些天"（受 ENV_KEEP_DAYS_DEVICE 限制），
    //    而设备内置历史（半年）落盘时只保证进了 ENV_HIST_MIN 这个**单文件**。
    //    所以长区间必须**同时**读两条来源，缺一条就会只看到最近一个月：
    //      · 按天文件   —— 细粒度（本应用的 90 秒采样）
    //      · 分钟文件   —— 粗粒度（每小时一条历史），但它是最全的那一份
    //    ⚠️ 曾经的 bug：只读按天文件 ⇒ 「90 天」「全部」切过去仍然只到 09-06。
    const days = Math.min(ENV_KEEP_DAYS_DEVICE, Math.ceil(sec / 86400) + 1);
    for (let i = 0; i < days; i++) {
      const p = envDayPath(Date.now() - i * 86400000);
      try { if (fs.existsSync(p)) src.push(...parseRows(p)); } catch (_) {}
    }
    // 长区间（> 30 天）时按天文件已经不够了，必须把分钟文件全带上；
    // 短区间也带上没坏处（它覆盖同样的时段，只是粒度粗）。
    try { src.push(...readEnvMinRows()); } catch (_) {}
    // 内存里比磁盘更新的那几条也并进来（当前那一分钟还没落盘到日文件的边界情况）
    src.push(...(state.env.history || []));
    src = mergeEnvSources(src);                  // ⚠️ 必须去重，理由见函数注释
  }
  const inWin = src.filter((r) => r.at >= since);
  // 按天视图不抽稀：一年也就 365 个点，抽稀反而会把"最高/最低"抹平。
  const rows = daily ? aggregateEnvDaily(inWin) : downsampleEnv(inWin, ENV_MAX_POINTS);
  const E = state.env.reading;
  return {
    seconds: sec,
    daily,
    rows,
    latest: E ? { at: E.at, t: E.temp_c, h: E.humidity, b: E.battery } : null,
  };
}

/**
 * 温湿度抽稀：**按时间分桶**取均值 —— 不是"每 N 行分一组"。
 *
 * ⚠️ 为什么必须按时间分桶：这份数据是两种粒度混着的 —— 设备历史每小时一条、本应用自己采的
 *    90 秒一条。按"每 N 行一组"分组时，一组里到底是几条小时行、几条秒级行完全看运气，
 *    抽出来的点会跳到没有规律的时刻上；实测 7 天档因此每天只剩 16 个点、相邻两点差 2 小时，
 *    曲线上出现一段段空白（用户 2026-10-08 报"温度还是没覆盖"）。
 *    按时间分桶就没有这个问题：每个桶代表时间轴上等宽的一段，画出来连续、不掉点。
 *
 * 抽稀后的行不带 sp/最低最高：桶宽已经远大于一小时（长窗口那一档），
 * "该小时一段"的带子在这个尺度上只有一两个像素，留着反而会画成台阶。
 */
function downsampleEnv(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const t0 = rows[0].at, t1 = rows[rows.length - 1].at;
  const bucket = Math.max(60000, Math.ceil((t1 - t0) / maxPoints));   // 至少 1 分钟
  const out = [];
  let cur = null;
  for (const r of rows) {
    const b = Math.floor(r.at / bucket);
    if (!cur || cur.b !== b) {
      if (cur) out.push(envBucketRow(cur));
      cur = { b, at: r.at, tSum: 0, tN: 0, hSum: 0, hN: 0, bSum: 0, bN: 0, n: 0 };
    }
    const t = envNum(r.t), h = envNum(r.h);
    if (Number.isFinite(t)) { cur.tSum += t; cur.tN += 1; }
    if (Number.isFinite(h)) { cur.hSum += h; cur.hN += 1; }
    if (r.b != null) { cur.bSum += Number(r.b); cur.bN += 1; }
    cur.n += 1;
    cur.at = r.at;                        // 用桶内最后一条的时间（与旧行为一致）
  }
  if (cur) out.push(envBucketRow(cur));
  return out;
}

function envBucketRow(c) {
  const row = { at: c.at, n: c.n };
  row.t = c.tN ? round3(c.tSum / c.tN) : null;    // ⚠️ 一条都没有就写 null，别写 0
  row.h = c.hN ? round1(c.hSum / c.hN) : null;
  if (c.bN) row.b = Math.round(c.bSum / c.bN);
  return row;
}

function round1(v) { return Math.round(Number(v) * 10) / 10; }

function pushHistory(s) {
  let total = 0;
  const w = {};
  for (const p of s.ports || []) { w[p.id] = p.w; total += p.w; }
  const row = { at: s.at, total: Math.round(total * 100) / 100, w };
  state.history.push(row);
  const hm = historyMax();
  if (state.history.length > hm) state.history.splice(0, state.history.length - hm);
  integrateEnergy(sampleFrom(row));
  touchEnergy();
  appendHistoryRow(row);
  rollupMinute(row);
  trackPortCharge(row);
  trackPlug(s, row);
  // 落盘之后立刻推给界面 —— 曲线"跟手"靠的就是这一句。
  // 只推「最新一点 + 这一行」，不推整份状态：采样 0.5 秒一次，全量会把带宽和
  // 前端解析都撑起来（整份 ~4KB，增量 ~0.5KB）。
  if (sseClients.size) sseBroadcast('sample', { latest: state.latest, link: state.link, row });
}

/**
 * 启动时给内存里的原始采样"预热"：从今天的日文件读回最近 1 小时的采样。
 *
 * 不预热的话，每次启动「1 分钟 ~ 1 小时」这几个区间都要从空的重新攒 —— 重启一次
 * 曲线右半张就是空白（开机自启动那个场景尤其明显，开机后一小时内都是残图）。
 * >1 小时的区间本来就读磁盘上的降采样文件，不受影响。
 * 只填 state.history，不碰电量账本（那是 backfillEnergy 的活，重复做会把电量算重）。
 */
function seedHistory() {
  const need = historyMax();
  const since = Date.now() - HISTORY_RANGES['1h'] * 1000;
  const rows = [];
  try {
    // 今天 + 昨天（跨零点那一下今天的文件还是空的），不把 7 天全读一遍
    for (let i = 0; i < 2; i++) {
      const f = histDayPath(Date.now() - i * 86400000);
      if (!fs.existsSync(f)) continue;
      rows.push(...parseRows(f));
      if (rows.length >= need) break;
    }
  } catch (_) {}
  if (!rows.length) return 0;
  rows.sort((a, b) => a.at - b.at);
  const keep = [];
  for (const r of rows) {
    if (!r || !Number.isFinite(r.at) || r.at < since) continue;
    keep.push({ at: r.at, total: Number(r.total) || 0, w: r.w || zeroPorts() });
  }
  const tail = keep.slice(-need);
  if (!tail.length) return 0;
  state.history = tail;
  return tail.length;
}

/**
 * 温度曲线的"预热"：和 seedHistory 同理，但温度落盘粒度是 90s，量小得多，
 * 直接把最近 1 小时的读数从日文件读回来即可（1 小时也就 40 行）。
 *
 * ⚠️ 只回填**最近 1 小时**（对应内存 history 的用途）；更长的区间走盘上查询，
 *   不需要预热 —— 温度曲线和其它功率区间一样按需现读。
 */
function seedEnvHistory() {
  const since = Date.now() - HISTORY_RANGES['1h'] * 1000;
  const rows = [];
  try {
    for (let i = 0; i < 2; i++) {
      const p = envDayPath(Date.now() - i * 86400000);
      if (!fs.existsSync(p)) continue;
      rows.push(...parseRows(p));
    }
  } catch (_) {}
  if (!rows.length) return 0;
  rows.sort((a, b) => a.at - b.at);
  // ⚠️ 逐字段搬运，别只挑 at/t/h/b —— 设备小时记录带的 sp/tmin/tmax 掉了的话，
  //    前端就画不出"该小时那一段"（短窗口看着又是一片空白）。见 mergeEnvHistory。
  const keep = rows.filter((r) => r && Number.isFinite(r.at) && r.at >= since)
    .map((r) => {
      const o = { at: r.at, t: r.t, h: r.h, b: r.b };
      if (r.sp != null) o.sp = r.sp;
      if (r.tmin != null) { o.tmin = r.tmin; o.tmax = r.tmax; }
      if (r.hmin != null) { o.hmin = r.hmin; o.hmax = r.hmax; }
      return o;
    });
  if (!keep.length) return 0;
  state.env.history = keep.slice(-2000);
  state.env.reading = Object.assign({}, state.env.reading, {
    temp_c: keep[keep.length - 1].t,
    humidity: keep[keep.length - 1].h,
    at: keep[keep.length - 1].at,
    stale: true,
  });
  return state.env.history.length;
}

/**
 * 启动时读一次温度历史的**覆盖区间**，不加载数据本体。
 *
 * 只解析 env-history-min.jsonl 的首尾两行就够（文件很小，几万行也就几十 KB）。
 * 目的是让界面在重启后立刻知道"设备历史读过、有 N 天"，从而放出 90天/全部 两档，
 * 而不是要用户再点一次「读取设备历史」按钮。
 */
function scanEnvHistRange() {
  try {
    const rows = parseRows(ENV_HIST_MIN);
    if (!rows.length) return 0;
    state.env.histFromAt = rows[0].at;
    state.env.histToAt = rows[rows.length - 1].at;
    state.env.histDays = Math.max(1, Math.round((state.env.histToAt - state.env.histFromAt) / 86400000));
    log(`温度历史覆盖 ${state.env.histDays} 天（${new Date(state.env.histFromAt).toLocaleDateString()} 起，共 ${rows.length} 点）`);
    backfillEnvDays(rows);          // 补齐按天文件，否则长区间只能看到最近 30 天
    return rows.length;
  } catch (_) { return 0; }
}

/**
 * 按 ENV_HIST_MIN 补齐缺失的按天文件。
 *
 * 为什么需要：长区间（> 30 天）走的是**按天文件**那条路。而设备历史落盘时曾经
 * 有个 bug —— `mergeEnvHistory` 在循环里调 `pruneEnvHistDays()`，把刚写进去的
 * 历史日文件当过期删掉了（实测：读回 156 天，data\env-history\ 只剩 30 个文件）。
 * 那个 bug 已修，但已经丢掉的日文件得从分钟文件补回来，否则用户切「90 天」「全部」
 * 仍然只看到最近一个月 —— 数据其实在 ENV_HIST_MIN 里，只是没摊到日文件。
 *
 * 幂等：只写**不存在**的日文件，已有的一律不动（避免重复追加同一批点）。
 */
function backfillEnvDays(minRows) {
  try {
    if (!minRows || !minRows.length) return 0;
    fs.mkdirSync(ENV_HIST_DIR, { recursive: true });
    const byDay = new Map();
    for (const r of minRows) {
      if (!r || !Number.isFinite(r.at)) continue;
      const k = dayKey(r.at);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(r);        // 整行搬运（sp/tmin/tmax 要留着，见 mergeEnvHistory）
    }
    let wrote = 0;
    for (const [k, list] of byDay) {
      const p = path.join(ENV_HIST_DIR, 'env-' + k + '.jsonl');
      if (fs.existsSync(p)) continue;
      fs.writeFileSync(p, list.map((r) => JSON.stringify(r)).join('\n') + '\n');
      wrote++;
    }
    if (wrote) log(`温度历史按天文件补齐 ${wrote} 个（长区间才看得到这几段）`);
    return wrote;
  } catch (e) {
    log('按天文件补齐失败：', e && e.message);
    return 0;
  }
}

/**
 * 给"只有 at/t/h"的老设备行补 `sp`（2026-10-06 之前落盘的设备历史没存这个字段）。
 *
 * 为什么要补：设备记录是**每小时一条**，画图时该铺满它覆盖的那一小时；没有 sp 就只能画成
 * 一个孤点，在 30 分钟这种短窗口里看着像"只有一两个点、其余全是空白"（用户报的就是这个）。
 *
 * 判据（两条都要满足，免得把"刚好在 xx:42 采到"的本机读数误认成设备记录）：
 *   ① 相邻两行正好差 1 小时（±1.5 秒）；② 落在**同一分钟偏移**上（设备自己的整点）。
 *   还要求连成 ≥ 4 条（3 段）才算一条链 —— 偶然两行相隔一小时不会成链。
 * 只补 sp，补不回每小时的最低/最高（当时没存）—— 想要那条带子，再点一次「读取设备历史」。
 *
 * 幂等：已经有 sp 的行不动。启动时跑一次，内存那批（seedEnvHistory）在它之后读，就能带上。
 */
function healEnvSpans() {
  try {
    const files = [];
    try {
      for (const f of fs.readdirSync(ENV_HIST_DIR)) {
        if (/^env-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) files.push(path.join(ENV_HIST_DIR, f));
      }
    } catch (_) {}
    files.push(ENV_HIST_MIN);
    let marked = 0, touched = 0;
    for (const p of files) {
      if (!fs.existsSync(p)) continue;
      const rows = parseRows(p);
      if (rows.length < 4) continue;
      rows.sort((a, b) => a.at - b.at);
      const isDev = new Array(rows.length).fill(false);
      let i = 0;
      while (i < rows.length) {
        let j = i;
        while (j + 1 < rows.length
          && Math.abs((rows[j + 1].at - rows[j].at) - DEV_HIST_SPAN_MS) <= 1500
          && (rows[j + 1].at % 60000) === (rows[j].at % 60000)) j += 1;
        if (j - i >= 3) for (let k = i; k <= j; k += 1) isDev[k] = true;
        i = j + 1;
      }
      let changed = false;
      for (let k = 0; k < rows.length; k += 1) {
        if (isDev[k] && rows[k].sp == null) { rows[k].sp = DEV_HIST_SPAN_MS; changed = true; marked += 1; }
      }
      if (changed) {
        fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        touched += 1;
      }
    }
    if (marked) log(`温度历史自愈：给 ${marked} 条设备小时记录补上 sp（涉及 ${touched} 个文件）`);
    return marked;
  } catch (e) {
    log('补 sp 自愈失败：', e && e.message);
    return 0;
  }
}

function pushLog(line) {
  state.logLines.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
  if (state.logLines.length > 400) state.logLines.splice(0, state.logLines.length - 400);
}

// ------------------------------------------------------------------ 事件通知
//
// 界面上的状态文字只对“正在看屏幕的人”有用，而“充满了 / 掉线了”这类事件恰恰发生在
// 你不在电脑前的时候。所以服务端只负责**判定与排队**，弹窗交给托盘
// （tray.ps1 本来就每秒轮询 /api/state，拿到新通知就弹气泡）。

const notices = { seq: 0, list: [] };
const NOTICE_KEEP = 20;
let intentionalLinkBreak = 0;   // stopCollector() 会刷新它

// 充满判定：某口升到 >5W 并持续累计 ≥5Wh，然后掉到 <0.8W 且保持 20 秒
// —— 那基本就是充饱了（涓流结束），而不是中途拔线。
const CHG_W_HI = 5;
const CHG_W_LO = 0.8;
const CHG_IDLE_MS = 20000;
const CHG_MIN_WH = 5;
const chgState = {};

function addNotice(kind, text) {
  if (config.notify === false) return null;
  const n = { id: ++notices.seq, at: Date.now(), kind, text };
  notices.list.push(n);
  if (notices.list.length > NOTICE_KEEP) notices.list.splice(0, notices.list.length - NOTICE_KEEP);
  pushLog('通知：' + text);
  log('notice', kind, text);
  return n;
}

function trackPortCharge(row) {
  const now = row.at;
  for (const id of PORTS) {
    const w = Number((row.w && row.w[id]) || 0);
    const st = chgState[id]
      || (chgState[id] = { lastAt: 0, lastW: 0, lastHiAt: 0, wh: 0, peak: 0, done: false });
    if (w >= CHG_W_HI) {
      if (!st.lastHiAt) { st.wh = 0; st.peak = 0; st.done = false; }
      // 口级梯形积分；间隔过大（>60s，比如休眠过）就跳过那一段，宁可少算
      if (st.lastAt && now > st.lastAt && now - st.lastAt <= 60000) {
        st.wh += ((st.lastW + w) / 2) * ((now - st.lastAt) / 3600000);
      }
      st.lastHiAt = now;
      st.peak = Math.max(st.peak, w);
    } else if (st.lastHiAt && w <= CHG_W_LO && !st.done) {
      if (now - st.lastHiAt >= CHG_IDLE_MS) {
        st.lastHiAt = 0;
        st.done = true;
        if (st.wh >= CHG_MIN_WH) {
          addNotice('full', `${PORT_LABEL[id]} 充满了：本次 ${round3(st.wh)} Wh，峰值 ${round3(st.peak)} W`);
        }
      }
    }
    st.lastAt = now;
    st.lastW = w;
  }
}

// ------------------------------------------------------------ 每口插拔记账
//
// 「这次插上充了多少」和「这口一共充了多少」是两个问题：后者是累计账（energy.ports），
// 前者必须按**插拔**切开。端口字的 b0 就是在用位，用它判插拔比看功率阈值准 ——
// 充饱后功率掉到 0 但设备还插着，那不算拔出。
//
// ⚠️ 拔出要**去抖**：接触不良会闪断一两帧，直接结算会把一次充电切成一堆碎记录，
//    而且每碎一次都从新的 whAtStart 起算，电量会被越切越少。所以连续 PLUG_IDLE_MS
//    都没看到"在用"才算真拔出（这段空窗功率≈0，不影响电量）。
// ⚠️ 起点是**本进程第一次看见它插着**的时刻，不一定是真插入时刻（那次插入没人看见）。
//    所以重启后拔出的第一条记录 ms 会偏小，但 wh 是准的（whAtStart 同期取的）。
const PLUG_KEEP = 300;        // 最多留多少条
const PLUG_IDLE_MS = 5000;    // 连续 5 秒不在用 → 认定拔出
const PLUG_MIN_MS = 3000;     // 短于 3 秒的接触不记账（插歪了碰一下那种）
const plugLive = {};          // id -> 进行中的那次插入

/**
 * 插拔记账的一步（**纯函数**，整套状态机在 tools/test_plug.js 离线单测）。
 * open 进行中的记录或 null；inUse 该口此刻是否有设备；wh 该口累计电量；at 时刻；
 * port 该口这一帧的协议/协商信息（插入后会升档，所以每帧都更新）。
 * 返回 { open: 新的进行中记录, closed: 结算出来的记录或 null }。
 */
function plugStep(open, inUse, wh, at, port) {
  if (inUse) {
    if (!open) {
      return {
        open: {
          since: at, idleAt: 0, whAtStart: wh, peak: Number(port.w) || 0,
          proto: port.proto_text || '', cap: port.cap == null ? null : port.cap,
        },
        closed: null,
      };
    }
    open.idleAt = 0;                                  // 又活过来了，取消待结算
    open.peak = Math.max(open.peak || 0, Number(port.w) || 0);
    if (port.proto_text) open.proto = port.proto_text;
    if (port.cap != null) open.cap = port.cap;
    return { open, closed: null };
  }
  if (!open) return { open: null, closed: null };
  if (!open.idleAt) { open.idleAt = at; return { open, closed: null }; }
  if (at - open.idleAt < PLUG_IDLE_MS) return { open, closed: null };
  const end = open.idleAt;                            // 结束时刻取"第一次看到不在用"
  return {
    open: null,
    closed: {
      start: open.since, end, ms: end - open.since,
      wh: Math.max(0, wh - open.whAtStart),
      peak: open.peak || 0, proto: open.proto || '', cap: open.cap == null ? null : open.cap,
    },
  };
}

/** 把一帧状态喂给每一口；够长的那次插拔结算进 energy.plugs。 */
function trackPlug(s, row) {
  for (const p of s.ports || []) {
    const id = p.id;
    if (!PORT_LABEL[id]) continue;                    // 没登记过的口不记，免得脏数据撑大文件
    const r = plugStep(plugLive[id] || null, !!p.in_use, Number(energy.ports[id] || 0), row.at, p);
    if (r.open) { r.open.id = id; plugLive[id] = r.open; } else { delete plugLive[id]; }
    if (!r.closed || r.closed.ms < PLUG_MIN_MS) continue;
    energy.plugs.push(Object.assign({ id, label: PORT_LABEL[id] }, r.closed));
    if (energy.plugs.length > PLUG_KEEP) energy.plugs = energy.plugs.slice(-PLUG_KEEP);
    energyDirty = true;
    touchEnergy();
    pushLog(`拔出 ${PORT_LABEL[id]}：本次 ${round3(r.closed.wh)} Wh，`
      + `${Math.max(1, Math.round(r.closed.ms / 60000))} 分钟，峰值 ${round3(r.closed.peak)} W`);
    addNotice('plug', `${PORT_LABEL[id]} 拔出：本次 ${round3(r.closed.wh)} Wh`
      + `（${round3(r.closed.wh / 1000)} 度 / ${Math.round((r.closed.wh / CELL_V) * 1000)} mAh）`);
  }
}

/** 链路只在“从 connected 掉下来”时提醒一次，5 分钟内不重复。
 *
 * 自己主动断的（改采样间隔重启采集器、让位、退出）不算故障 —— 那类动作都会先走
 * stopCollector() 打个时间戳，这里用 60 秒窗口把它排除掉。
 */
let lastLinkNoticeAt = 0;
function noticeLinkProblem(prevState, next) {
  if (prevState !== 'connected') return;
  if (Date.now() - intentionalLinkBreak < 60000) return;
  if (Date.now() - lastLinkNoticeAt < 5 * 60000) return;
  lastLinkNoticeAt = Date.now();
  const t = (next && next.msg) ? String(next.msg) : '蓝牙连接中断，正在重连';
  addNotice('link', '充电头连接中断：' + t.slice(0, 80));
}

// ------------------------------------------------------------------ 用电量统计
//
// 充电头没有任何"累计电量"属性可读（只有瞬时 V/A/W），所以电量只能由本应用
// 对功率做时间积分得到 —— 这也正是米家 App 的做法：它只在连接期间记录曲线，
// 断开就没有数据。这里把积分结果按天分桶存盘，重启后从 history.jsonl 回填
// 断档，所以只要应用在跑就不会丢。

const DAYS_KEEP = 400;

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const zeroPorts = () => ({ c1: 0, c2: 0, c3: 0, a: 0 });
function mapPorts(p) {
  const out = zeroPorts();
  for (const id of PORTS) out[id] = round3(p && p[id]);
  return out;
}

function emptyEnergy() {
  return {
    version: 1,
    totalWh: 0,
    ports: zeroPorts(),
    days: {},
    lastAt: 0,
    firstAt: 0,
    lastSample: null,
    current: null,
    sessions: [],
    plugs: [],
  };
}

let energy = emptyEnergy();
let energyDirty = false;
let energyTimer = null;

function loadEnergy() {
  try {
    const raw = JSON.parse(fs.readFileSync(ENERGY, 'utf8'));
    energy = Object.assign(emptyEnergy(), raw);
    energy.ports = Object.assign(zeroPorts(), raw.ports || {});
    energy.days = raw.days && typeof raw.days === 'object' ? raw.days : {};
    energy.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    energy.plugs = Array.isArray(raw.plugs) ? raw.plugs : [];
  } catch (_) {
    energy = emptyEnergy();
  }
}

function saveEnergy() {
  if (!energyDirty) return;
  energyDirty = false;
  try {
    // 只保留最近 400 天，避免文件无限增长
    const keys = Object.keys(energy.days).sort();
    if (keys.length > DAYS_KEEP) {
      for (const k of keys.slice(0, keys.length - DAYS_KEEP)) delete energy.days[k];
    }
    if (energy.sessions.length > 50) energy.sessions = energy.sessions.slice(-50);
    if (energy.plugs.length > PLUG_KEEP) energy.plugs = energy.plugs.slice(-PLUG_KEEP);
    fs.writeFileSync(ENERGY, JSON.stringify(energy));
  } catch (e) {
    log('save energy failed: ' + e.message);
  }
}

function touchEnergy() {
  energyDirty = true;
  if (energyTimer) return;
  energyTimer = setTimeout(() => { energyTimer = null; saveEnergy(); }, ENERGY_SAVE_MS);
}

function sampleFrom(row) {
  const w = zeroPorts();
  for (const id of PORTS) w[id] = Number((row.w && row.w[id]) || 0);
  return { at: row.at, total: Number(row.total || 0), w };
}

/**
 * 用梯形法把功率积分成电量（Wh）。
 * 两次采样间隔超过 60 秒就整段丢弃 —— 中间发生了什么没人知道，宁可少算也不要瞎算。
 */
function integrateEnergy(s) {
  const prev = energy.lastSample;
  if (prev && s.at > prev.at) {
    const gap = s.at - prev.at;
    if (gap <= 60000) {
      const dtH = gap / 3600000;
      const avg = (a, b) => (Math.max(0, a || 0) + Math.max(0, b || 0)) / 2;
      const dTotal = avg(prev.total, s.total) * dtH;
      const ports = zeroPorts();
      for (const id of PORTS) ports[id] = avg(prev.w[id], s.w[id]) * dtH;

      energy.totalWh += dTotal;
      const k = dayKey(s.at);
      const bucket = energy.days[k] || (energy.days[k] = { total: 0, ports: zeroPorts() });
      bucket.total += dTotal;
      bucket.ports = Object.assign(zeroPorts(), bucket.ports);
      for (const id of PORTS) {
        energy.ports[id] += ports[id];
        bucket.ports[id] += ports[id];
      }
      if (energy.current) {
        energy.current.wh += dTotal;
        energy.current.ports = Object.assign(zeroPorts(), energy.current.ports);
        for (const id of PORTS) energy.current.ports[id] += ports[id];
      }
      energyDirty = true;
    }
  }
  if (!energy.firstAt) energy.firstAt = s.at;
  energy.lastSample = s;
  energy.lastAt = s.at;
  trackSession(s);
}

const SESSION_MIN_W = 0.5;   // 低于这个功率视为没有在充电，避免空载噪声起会话

function trackSession(s) {
  const active = s.total > SESSION_MIN_W;
  if (active) {
    if (!energy.current) {
      energy.current = {
        start: s.at, wh: 0, peak: 0, ports: zeroPorts(), lastActiveAt: s.at,
      };
    }
    const c = energy.current;
    c.peak = Math.max(c.peak, s.total);
    c.lastActiveAt = s.at;
    energyDirty = true;
  } else if (energy.current && s.at - energy.current.lastActiveAt > SESSION_GAP_MS) {
    const c = energy.current;
    energy.sessions.push({
      start: c.start, end: c.lastActiveAt,
      ms: c.lastActiveAt - c.start,
      wh: round3(c.wh), peak: round3(c.peak), ports: mapPorts(c.ports),
    });
    energy.current = null;
    energyDirty = true;
    pushLog(`一次充电结束：${round3(c.wh)} Wh，峰值 ${round3(c.peak)} W`);
  }
}

/** 把一个 jsonl 文件读成对象数组（壞行直接跳过）。 */
function parseRows(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter((r) => r && typeof r.at === 'number');
  } catch (_) { return []; }
}

/**
 * 启动时把上次退出到这次启动之间、磁盘上仍留存的采样搬回来。
 * 优先用按天分片的**原始**采样（最精确），没有才退到每分钟降采样。
 */
function backfillEnergy() {
  const rows = [];
  try {
    for (const f of fs.readdirSync(HIST_DIR)) {
      if (/^history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) rows.push(...parseRows(path.join(HIST_DIR, f)));
    }
  } catch (_) {}
  rows.push(...parseRows(HIST));            // 升级前的遗留文件，只读
  if (!rows.length) rows.push(...parseRows(HIST_MIN));
  if (!rows.length) return 0;
  rows.sort((a, b) => a.at - b.at);
  const cut = energy.lastAt || 0;
  let used = 0;
  for (const r of rows) {
    const s = sampleFrom(r);
    if (s.at <= cut) { energy.lastSample = s; if (!energy.firstAt) energy.firstAt = s.at; continue; }
    integrateEnergy(s);
    used++;
  }
  return used;
}

function energySnapshot(days) {
  const n = Math.max(1, Math.min(90, days || 7));
  const now = Date.now();
  const list = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const k = dayKey(d.getTime());
    const b = energy.days[k];
    list.push({ day: k, wh: b ? round3(b.total) : 0, ports: b ? mapPorts(b.ports) : zeroPorts() });
  }
  const cur = energy.current;
  return {
    ok: true,
    today: list[list.length - 1] || { day: dayKey(now), wh: 0, ports: zeroPorts() },
    totalWh: round3(energy.totalWh),
    ports: mapPorts(energy.ports),
    days: list,
    current: cur ? {
      start: cur.start, lastActiveAt: cur.lastActiveAt,
      ms: cur.lastActiveAt - cur.start,
      wh: round3(cur.wh), peak: round3(cur.peak), ports: mapPorts(cur.ports),
    } : null,
    sessions: energy.sessions.slice(-20).reverse(),
    // 插拔记录（新的在前）+ 正在充的那几次（还没结算，界面上给一行"进行中"）
    plugs: energy.plugs.slice(-40).reverse(),
    plugsLive: PORTS.filter((id) => plugLive[id]).map((id) => {
      const o = plugLive[id];
      return {
        id, label: PORT_LABEL[id], start: o.since,
        ms: Math.max(0, (energy.lastAt || o.since) - o.since),
        wh: Math.max(0, Number(energy.ports[id] || 0) - o.whAtStart),
        peak: o.peak || 0, proto: o.proto || '', cap: o.cap == null ? null : o.cap,
      };
    }),
    since: energy.firstAt || null,
    tracked: energy.lastAt || null,
  };
}

// ------------------------------------------------------------------ 控制通道

const pendingAcks = new Map();
let cmdSeq = 0;

function rejectPendingAcks(reason) {
  for (const [, p] of pendingAcks) { clearTimeout(p.timer); p.resolve({ ok: false, error: reason }); }
  pendingAcks.clear();
}

/** 把一条命令写进采集器的 stdin，并等它的 ack。 */
function sendCommand(obj, timeoutMs) {
  return new Promise((resolve) => {
    const c = state.collector;
    if (!c || !c.stdin || c.stdin.destroyed) {
      return resolve({ ok: false, error: '采集器未运行，无法下发控制命令' });
    }
    if (state.link.state !== 'connected') {
      return resolve({ ok: false, error: '蓝牙尚未连接（当前：' + state.link.state + '）' });
    }
    const id = ++cmdSeq;
    const timer = setTimeout(() => {
      pendingAcks.delete(id);
      resolve({ ok: false, error: '设备响应超时' });
    }, timeoutMs || 15000);
    pendingAcks.set(id, { resolve, timer });
    try {
      c.stdin.write(JSON.stringify(Object.assign({ id }, obj)) + '\n');
    } catch (e) {
      clearTimeout(timer);
      pendingAcks.delete(id);
      resolve({ ok: false, error: e.message });
    }
  });
}

/** 端口开关：读-改-写 piid 16 的位掩码（bit0=C1, bit1=C2, bit2=C3, bit3=A）。 */
async function setPort(port, action) {
  const bits = { c1: 0, c2: 1, c3: 2, a: 3 };
  let cur = 0x0F;
  try {
    const s = state.latest && state.latest.settings;
    if (s && typeof s.port_ctl === 'number') cur = s.port_ctl;
  } catch (_) {}
  let next;
  if (port === 'all') next = action === 'on' ? 0x0F : 0x00;
  else if (bits[port] != null) {
    next = action === 'on' ? (cur | (1 << bits[port])) : (cur & ~(1 << bits[port]));
  } else return { ok: false, error: '未知端口：' + port };
  if (next === cur) return { ok: true, piid: 16, value: cur, readback: cur, noop: true };
  return sendCommand({ cmd: 'set', piid: 16, value: next });
}

/**
 * 协议开关：读-改-写 piid 21（扩展协议控制，u32）的位掩码。
 *
 * 位定义在 collector.py 的 PROTO_SWITCH_BITS 里，2026-09-22 用 --probe 逐位实测过：
 * 把 A 口 UFCS 的 bit24 翻掉后回读 0x02030f0f、还原回 0x03030f0f。
 * c1/c2 各有一位置 1 的保留位，这里只翻转目标位，保留位天然不动。
 * 设备在 2.21 变化时会主动推一帧 0x0f 通知，所以界面刷新很快。
 */
async function setProtocol(port, sw, on) {
  const table = Array.isArray(state.switches) ? state.switches : [];
  const hit = table.find((s) => s.port === port && s.sw === sw);
  if (!hit) return { ok: false, error: `未知协议开关 ${port || '?'}/${sw || '?'}` };
  const s = state.latest && state.latest.settings;
  const cur = s && typeof s.protocol_ctl_extend === 'number' ? s.protocol_ctl_extend : null;
  if (cur == null) return { ok: false, error: '还没读到协议开关的当前值，等一次轮询后再试' };
  const next = on ? (cur | (1 << hit.bit)) : (cur & ~(1 << hit.bit));
  if (next === cur) return { ok: true, piid: 21, value: cur, readback: cur, noop: true };
  return sendCommand({ cmd: 'set', piid: 21, value: next >>> 0 });
}

/**
 * 单属性写入。取值全部对着**采集器 hello 里声明的清单**校验一遍 ——
 * 界面即使被改坏，也写不进清单外的东西。
 */
function setProp(piid, value, opts) {
  const spec = (state.writable || []).find((w) => w.piid === piid);
  if (!spec) return Promise.resolve({ ok: false, error: `属性 2.${piid} 不在可写清单内` });
  if (opts && opts.onlyAdvanced && !spec.advanced) {
    return Promise.resolve({ ok: false, error: `属性 2.${piid} 不属于高级区` });
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return Promise.resolve({ ok: false, error: '取值必须是整数' });
  }
  if (n < spec.min || n > spec.max) {
    return Promise.resolve({ ok: false, error: `${spec.name} 取值需在 ${spec.min}..${spec.max} 之间` });
  }
  return sendCommand({ cmd: 'set', piid, value: n });
}

/** 恢复常用状态：四口全开、场景 AI。倒计时属性在本固件上不存在，不碰。 */
const DEFAULTS = [
  { piid: 16, value: 0x0f, label: '所有端口开启' },
  { piid: 5, value: 1, label: '场景模式 = AI' },
];

async function handleControl(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: '请求体不是合法 JSON' };
  const a = body.action;

  if (a === 'port') return setPort(body.port, body.on ? 'on' : 'off');

  if (a === 'protocol') return setProtocol(body.port, body.sw, !!body.on);

  // 用「把 2.7 换成 2.8」的 15 项替换形状，把常态轮询读不到的 2.8 读出来
  if (a === 'ext') return sendCommand({ cmd: 'ext-read' });

  // MIOT action #1「恢复默认设置」：把充电头自己的设置恢复出厂。会覆盖端口开关、
  // 场景、息屏、协议开关等，所以界面上要二次确认。
  if (a === 'reset') return sendCommand({ cmd: 'reset' }, 30000);

  if (a === 'set') return setProp(body.piid, body.value, { onlyAdvanced: !!body.advanced });

  if (a === 'defaults') {
    const done = [];
    for (const step of DEFAULTS) {
      const r = await setProp(step.piid, step.value);
      done.push({ piid: step.piid, label: step.label, ok: r.ok, error: r.error || null });
      if (!r.ok) return { ok: false, error: step.label + ' 失败：' + r.error, done };
      await new Promise((res2) => setTimeout(res2, 260));   // 让设备一条一条喘口气
    }
    return { ok: true, done };
  }

  return { ok: false, error: '未知动作：' + String(a) };
}

// ------------------------------------------------------------------ 隐藏属性扫描

function lastJsonOfType(text, type) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (!type || o.t === type) return o;
    } catch (_) {}
  }
  return null;
}

/**
 * 扫一遍 siid=2 的未知 piid 并列出 GATT 表 —— 用来回答「温度能不能读」，
 * 也顺手给未来固件升级后可能新增的属性留个探针。
 * BLE 同时只允许一个中心端，所以必须先把常驻采集器停掉。
 */
async function runSweep(loReq, hiReq) {
  const lo = Number.isInteger(loReq) ? loReq : 0x16;
  const hi = Number.isInteger(hiReq) ? hiReq : 0x40;
  const py = findPython();
  if (!py) return { ok: false, error: '找不到 Python 运行环境' };
  if (!fs.existsSync(TOKEN)) return { ok: false, error: '尚未登录小米云，无法认证' };

  const resume = !!state.collector;
  if (resume) {
    pushLog('扫描前暂停采集器（蓝牙同一时间只允许一个连接）');
    stopCollector();
    await new Promise((r) => setTimeout(r, 1000));
  }
  pushLog('开始扫描 siid=2 隐藏属性并枚举 GATT，约 20-40 秒…');

  const r = await runPy('collector.py', [
    '--address', effectiveAddress(), '--token-file', TOKEN, '--sweep', '--scan-timeout', '30',
    '--sweep-lo', String(lo), '--sweep-hi', String(hi),
  ], 150000);

  if (resume) setTimeout(() => startCollector(), 500);

  try {
    fs.writeFileSync(path.join(DATA, 'sweep.log'),
      '--- stdout ---\n' + (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || '') + '\n');
  } catch (_) {}

  const j = lastJsonOfType(r.stdout, 'sweep');
  if (!j) {
    const tail = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    const err = [(r.error || ''), String(r.stderr || '').trim().slice(-400), tail]
      .filter(Boolean).join(' ');
    pushLog('扫描失败：' + err);
    return { ok: false, error: err || '没有取到扫描结果' };
  }
  const found = j.found || [];
  pushLog(`扫描完成：0x${j.lo.toString(16)}..0x${j.hi.toString(16)} 共 ${j.rows.length} 个 piid，`
    + `设备可读 ${found.length} 个`);
  state.sweep = Object.assign({ at: Date.now() }, j);
  return Object.assign({ ok: true }, j);
}

// ------------------------------------------------------------------ 采集器

function stopCollector() {
  const c = state.collector;
  state.collector = null;
  state.collecting = false;
  // 主动停掉不是"掉线"：重启采集器 / 让位 / 退出都会走到这里，
  // 打个时间戳以免弹一个假的"连接中断"提醒（见 noticeLinkProblem）。
  intentionalLinkBreak = Date.now();
  rejectPendingAcks('采集器已停止，命令未送达');
  if (!c) return;
  try { c.kill(); } catch (_) {}
}

/** 重启采集器：**等旧进程真的退出**再拉新的。
 *
 * 直接 `stopCollector(); setTimeout(startCollector, 500)` 有两个坑：
 *  1. 旧进程（venv 的 python.exe 会再拉一个真解释器）握着的 BLE 链路未必已经释放，
 *     新进程这时已经开扫了 —— 两个 MIOT 会话在同一台充电头上打架，表现出来的正是
 *     “MIOT RX counter repeated or moved backwards”，也就是用户看到的“过一会就断”。
 *  2. 扫描 + 重新认证本来就要 10~20 秒，多等这一两秒根本感知不到。
 * 所以这里挂 close 事件，并留一个 4 秒兑底定时器（close 没来也不卡住）。
 */
function restartCollectorSoon() {
  const c = state.collector;
  stopCollector();
  if (!c) { setTimeout(startCollector, 300); return; }
  let fired = false;
  const go = () => {
    if (fired) return;
    fired = true;
    if (!state.collector) startCollector();
  };
  c.once('close', () => setTimeout(go, 400));
  setTimeout(go, 4000);
}

// ------------------------------------------------------------------ 让位（释放蓝牙）
//
// 这台充电头同一时刻只接受**一个** BLE 中心：电脑连着的时候，手机米家连设备广播都
// 收不到（2026-09-22 实测钉死），而且它没有 Wi-Fi、不支持蓝牙网关 —— 米家只能靠手机
// 蓝牙直连，没有第二条路可走。所以“让位”只能是**互斥**的：暂停采集器、把链路彻底放掉，
// 用多久自己定，到点自动收回。

let yieldUntil = 0;
let yieldTimer = null;
const YIELD_MAX_MIN = 120;

function yielding() { return yieldUntil > 0 && Date.now() < yieldUntil; }

function startYield(minutes) {
  const m = Math.max(1, Math.min(YIELD_MAX_MIN, Math.round(Number(minutes) || 10)));
  stopCollector();
  yieldUntil = Date.now() + m * 60000;
  if (yieldTimer) clearTimeout(yieldTimer);
  yieldTimer = setTimeout(() => endYield('到点'), m * 60000);
  state.link = { state: 'yielded', attempt: 0, msg: `已释放蓝牙 ${m} 分钟，手机米家现在可以连` };
  pushLog(`让位：释放蓝牙 ${m} 分钟给手机米家（到点自动恢复）`);
  sseState();
  return { ok: true, minutes: m, until: yieldUntil };
}

function endYield(reason) {
  if (yieldTimer) { clearTimeout(yieldTimer); yieldTimer = null; }
  if (!yieldUntil) return { ok: true, already: true };
  yieldUntil = 0;
  state.link = { state: 'idle', attempt: 0, msg: '让位结束，正在恢复采集' };
  pushLog('让位结束，恢复采集' + (reason ? '（' + reason + '）' : ''));
  sseState();
  startCollector();
  return { ok: true };
}

function startCollector() {
  if (state.collector) return { ok: true, already: true };
  if (yielding()) {
    const left = Math.ceil((yieldUntil - Date.now()) / 60000);
    return { ok: false, error: `正在让位给手机米家，约 ${left} 分钟后自动恢复` };
  }
  const py = findPython();
  if (!py) {
    state.link = { state: 'error', attempt: 0, msg: '找不到 Python 运行环境，请先运行 tools\\setup-env.ps1' };
    return { ok: false, error: state.link.msg };
  }
  if (!fs.existsSync(TOKEN)) {
    state.link = { state: 'need-login', attempt: 0, msg: '尚未登录小米云，请先扫码授权' };
    return { ok: false, error: state.link.msg };
  }
  if (!effectiveAddress()) {
    state.link = { state: 'need-login', attempt: 0, msg: '还没有设备地址，请登录小米云自动识别充电头' };
    return { ok: false, error: state.link.msg };
  }

  const args = [
    path.join(APP, 'collector.py'),
    '--address', effectiveAddress(),
    '--token-file', TOKEN,
    '--interval', String(config.interval),
  ];
  log('spawn collector', py, args.join(' '));

  let child;
  try {
    child = spawn(py, args, {
      cwd: APP,
      windowsHide: true,
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1',
      }),
    });
  } catch (e) {
    state.link = { state: 'error', attempt: 0, msg: '启动采集器失败：' + e.message };
    return { ok: false, error: state.link.msg };
  }

  state.collector = child;
  state.collecting = true;
  state.lastSpawnAt = Date.now();

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { pushLog('采集器输出无法解析：' + line.slice(0, 200)); continue; }
      handleCollectorLine(obj);
    }
  });

  let ebuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    ebuf += chunk;
    let nl;
    while ((nl = ebuf.indexOf('\n')) >= 0) {
      const line = ebuf.slice(0, nl).trim();
      ebuf = ebuf.slice(nl + 1);
      if (line) pushLog(line);
    }
  });

  child.on('error', (e) => pushLog('采集器进程错误：' + e.message));
  child.on('close', (code) => {
    pushLog('采集器退出，code=' + code);
    state.collecting = false;
    rejectPendingAcks('采集器已退出，命令未送达');
    state.writable = [];
    state.switches = [];
    if (state.collector !== child) return;      // 主动停止
    state.collector = null;
    state.link = { state: 'reconnecting', attempt: state.restarts + 1, msg: `采集器已退出（code=${code}），3 秒后重启` };
    state.restarts += 1;
    setTimeout(() => { if (!state.collector) startCollector(); }, 3000);
  });

  return { ok: true };
}

// ------------------------------------------------------------ 小米电风扇（Wi-Fi / miIO）
//
// 风扇和充电头是**两种完全不同的链路**，所以它有自己独立的采集进程 fan_collector.py：
//   充电头  蓝牙 BLE，MiOT 长连接 + 会话认证，12 字节 bindkey
//   风扇    Wi-Fi UDP 54321（miIO），AES-128-CBC，16 字节 token + 局域网 IP
// 混在一个进程里没有任何好处，反而让那条已经够脆弱的 BLE 链路多担风险。
// 这块**可失败**：风扇连不上只是这张卡灰掉，充电头与温湿度计毫发无伤。
//
// ⚠️ 风扇**没有功率传感器、也没有电量统计**（官方规格表里一个电参量属性都没有），
//    所以这块**不做功率、不做用电量、也不保留历史曲线** —— 只做「状态回读 + 反向控制」。
//    （v1.9.0 曾按档位推算瓦数并积分出电量，2026-10-11 按用户要求整体删除：
//      推算出来的数看着像实测，反而误导。）

/** 风扇轮询间隔（秒）—— 配置里可改，采集器跟着它走，不许写死。 */
function fanInterval() {
  const v = Number(config.fanInterval);
  return (v >= 0.5 && v <= 30) ? v : 2;
}

/** 登录时落盘的风扇身份（IP + token）。没有它就只能先去登录小米云。 */
function readFanToken() {
  try {
    const t = JSON.parse(fs.readFileSync(FAN_TOKEN, 'utf8'));
    if (t && t.ip && t.token) return t;
  } catch (_) {}
  return null;
}

/** 采集器真正读的那份配置。
 *  ⚠️ token 只写进这个文件，**绝不进命令行** —— 命令行参数在任务管理器里人人可见。 */
function writeFanConfig() {
  const t = readFanToken();
  if (!t) return false;
  try {
    fs.writeFileSync(FAN_CFG, JSON.stringify({
      ip: t.ip, token: t.token, interval: fanInterval(),
    }, null, 2));
    return true;
  } catch (e) { log('写 fan.json 失败：' + e.message); return false; }
}

/** 风扇设备信息（给界面看的那几个字段，不含 token）。 */
function fanDeviceInfo() {
  const t = readFanToken();
  if (!t) return null;
  return {
    name: t.name || '小米电风扇', model: t.model || '', ip: t.ip || '',
    mac: t.mac || '', did: t.did || '', online: !!t.online,
    savedAt: t.saved_at ? Math.round(t.saved_at * 1000) : 0,
    ipFromLan: !!t.ip_from_lan,
  };
}

// ---- 采集器进程看护 ----------------------------------------------------------

function stopFanCollector() {
  const c = state.fan.proc;
  state.fan.proc = null;
  state.fan.running = false;
  for (const [, p] of state.fan.pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, error: '风扇采集器已停止，命令未送达' });
  }
  state.fan.pending.clear();
  if (!c) return;
  try { if (c.stdin && !c.stdin.destroyed) c.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch (_) {}
  setTimeout(() => { try { c.kill(); } catch (_) {} }, 1500);
}

function startFanCollector() {
  if (state.fan.proc) return { ok: true, already: true };
  const py = findPython();
  if (!py) {
    state.fan.link = { state: 'error', msg: '找不到 Python 运行环境', at: Date.now() };
    return { ok: false, error: state.fan.link.msg };
  }
  if (!readFanToken()) {
    // 没登录就没有 IP/token，这时去拉采集器只会让它一启动就报"读配置失败"然后退出。
    state.fan.link = {
      state: 'need-login',
      msg: '风扇走 Wi-Fi（miIO），需要先从米家云取到它的 IP 和密钥 —— 点右上角「登录小米云」扫一次码',
      at: Date.now(),
    };
    return { ok: false, error: state.fan.link.msg };
  }
  if (!writeFanConfig()) {
    state.fan.link = { state: 'error', msg: '写 fan.json 失败', at: Date.now() };
    return { ok: false, error: state.fan.link.msg };
  }

  const args = [path.join(APP, 'fan_collector.py'), '--config', FAN_CFG];
  log('spawn fan_collector', py, args.join(' '));

  let child;
  try {
    child = spawn(py, args, {
      cwd: APP,
      windowsHide: true,
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONUTF8: '1',
      }),
    });
  } catch (e) {
    state.fan.link = { state: 'error', msg: '启动风扇采集器失败：' + e.message, at: Date.now() };
    return { ok: false, error: state.fan.link.msg };
  }

  state.fan.proc = child;
  state.fan.running = true;

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { pushLog('风扇采集器输出无法解析：' + line.slice(0, 160)); continue; }
      handleFanLine(obj);
    }
    if (buf.length > (1 << 20)) buf = '';
  });

  let ebuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    ebuf += chunk;
    let nl;
    while ((nl = ebuf.indexOf('\n')) >= 0) {
      const line = ebuf.slice(0, nl).trim();
      ebuf = ebuf.slice(nl + 1);
      if (line) pushLog('风扇：' + line);
    }
  });

  child.on('error', (e) => pushLog('风扇采集器进程错误：' + e.message));
  child.on('close', (code) => {
    pushLog('风扇采集器退出，code=' + code);
    state.fan.running = false;
    for (const [, p] of state.fan.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: '风扇采集器已退出' }); }
    state.fan.pending.clear();
    state.fan.hello = null;
    state.fan.writable = [];
    if (state.fan.proc !== child) return;      // 主动停止
    state.fan.proc = null;
    state.fan.restarts += 1;
    state.fan.link = { state: 'reconnecting', msg: `风扇采集器退出（code=${code}），5 秒后重启`, at: Date.now() };
    setTimeout(() => { if (!state.fan.proc && !stopping) startFanCollector(); }, 5000);
  });

  return { ok: true };
}

/** 配置变了（间隔 / 额定功率）或刚登录拿到 token —— 重写配置并重启采集器。 */
function restartFanCollectorSoon() {
  const c = state.fan.proc;
  stopFanCollector();
  if (!c) { setTimeout(() => { if (!stopping) startFanCollector(); }, 300); return; }
  let fired = false;
  const go = () => {
    if (fired) return;
    fired = true;
    if (!state.fan.proc && !stopping) startFanCollector();
  };
  c.once('close', () => setTimeout(go, 400));
  setTimeout(go, 4000);
}

/** 把一条命令写进风扇采集器的 stdin 并等它的 ack。 */
function fanCall(obj, timeoutMs) {
  return new Promise((resolve) => {
    const c = state.fan.proc;
    if (!c || !c.stdin || c.stdin.destroyed) {
      return resolve({ ok: false, error: '风扇采集器没在运行' });
    }
    const id = ++state.fan.seq;
    const timer = setTimeout(() => {
      state.fan.pending.delete(id);
      resolve({ ok: false, error: '风扇无响应（超时）' });
    }, timeoutMs || 15000);
    // 记下这条命令是哪个属性 —— ack 里只有 siid/piid，日志要写中文名得靠这里
    state.fan.pending.set(id, { resolve, timer, name: obj.name || null });
    try {
      c.stdin.write(JSON.stringify(Object.assign({ id }, obj)) + '\n');
    } catch (e) {
      clearTimeout(timer);
      state.fan.pending.delete(id);
      resolve({ ok: false, error: e.message });
    }
  });
}

/**
 * 局域网广播发现（只读）。
 *
 * 它只能回答"网上有哪些 miIO 设备、IP 是多少"，**拿不到 token** —— 没有 token
 * 连一条命令都发不出去。所以这一步的用处是排查：云端给的 IP 是不是过期了、
 * 风扇到底有没有连上 Wi-Fi。
 */
function fanLanDiscover() {
  return new Promise((resolve) => {
    const py = findPython();
    if (!py) return resolve({ ok: false, error: '找不到 Python 运行环境' });
    const code = 'import sys,json;sys.path.insert(0,"vendor");from miio_lan import discover;'
      + 'print(json.dumps(discover(5.0)))';
    let child;
    try {
      child = spawn(py, ['-c', code], {
        cwd: APP, windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
      });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    const so = [], se = [];
    let done = false;
    const fin = (r) => { if (done) return; done = true; resolve(r); };
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} fin({ ok: false, error: '超时（15 秒）' }); }, 15000);
    child.stdout.on('data', (d) => so.push(d));
    child.stderr.on('data', (d) => se.push(d));
    child.on('error', (e) => { clearTimeout(t); fin({ ok: false, error: e.message }); });
    child.on('close', () => {
      clearTimeout(t);
      const text = Buffer.concat(so).toString('utf8').trim();
      let rows = [];
      try { rows = JSON.parse(text.split('\n').pop()); } catch (_) {}
      fin({ ok: true, rows: Array.isArray(rows) ? rows : [], stderr: Buffer.concat(se).toString('utf8').slice(-500) });
    });
  });
}

function handleFanLine(obj) {
  if (obj.t === 'hello') {
    state.fan.hello = obj;
    if (Array.isArray(obj.writable)) state.fan.writable = obj.writable;
    pushLog('风扇采集器已启动 pid=' + obj.pid + '（' + (obj.model || '') + ' @ ' + (obj.ip || '') + '）');
    return;
  }
  if (obj.t === 'link') {
    state.fan.link = { state: obj.state || 'unknown', msg: obj.msg || '', at: Date.now() };
    if (obj.state !== 'scanning') pushLog('风扇链路：' + obj.state + (obj.msg ? ' — ' + obj.msg : ''));
    sseState();
    return;
  }
  if (obj.t === 'ack') {
    const p = state.fan.pending.get(obj.id);
    const cmdName = p && p.name;
    if (p) { clearTimeout(p.timer); state.fan.pending.delete(obj.id); p.resolve(obj); }
    if (obj.cmd === 'set') {
      const cn = FAN_PROP_CN[obj.name || cmdName] || (obj.siid + '.' + obj.piid);
      pushLog(obj.ok
        ? `风扇控制：${cn} 设为 ${obj.value}（回读 ${obj.readback}）`
        : `风扇控制失败：${cn} — ${obj.error || '未知原因'}`);
    }
    sseState();
    return;
  }
  if (obj.t === 'error') {
    pushLog('风扇采集器报错：' + obj.msg);
    state.fan.link = { state: 'error', msg: obj.msg || '', at: Date.now() };
    sseState();
    return;
  }
  if (obj.t === 'state') {
    state.fan.latest = obj;
    state.fan.restarts = 0;
    if (state.fan.link.state !== 'online') {
      state.fan.link = { state: 'online', msg: '已连接 ' + (obj.ip || ''), at: Date.now() };
    }
    // 没有曲线了，所以这里只把整份状态推给界面（数字/开关都由前端重算）
    sseBroadcast('fan', { fan: fanPayload() });
    return;
  }
  pushLog('风扇采集器未知输出：' + JSON.stringify(obj).slice(0, 160));
}

/** 给界面的风扇全量状态。 */
function fanPayload() {
  return {
    running: !!state.fan.proc,
    link: state.fan.link,
    latest: state.fan.latest,
    device: fanDeviceInfo(),
    props: state.fan.hello ? state.fan.hello.props : [],
    writable: state.fan.writable,
    interval: fanInterval(),
    restarts: state.fan.restarts,
  };
}

// ------------------------------------------------------------ 环境温度计
//
// 外挂传感器（小米 LYWSD03MMC 温湿度计）走**独立进程** env_sensor.py：
//   充电头是 MiOT 长连接 + 会话认证，温度计是"连上去读一个特征值就断"的轮询设备，
//   混在一个进程里会让充电头那条脆弱的链路多担风险。
//   这块**可失败**：读不到就只是温度卡灰掉，功率采集毫发无伤。
//
// 为什么不在充电头的同一进程里读：BLE 同时只允许一个中心端。温度计要连接，
//   而充电头已经长期占着一条连接 —— 两者用的是不同的外设，互不干扰，
//   但都要各自守"不要和手机米家抢"的规矩（轮询间隔 ≥60s）。

function loadEnvConfig() {
  const d = { address: 'A4:C1:38:3C:25:A2', interval: 90, enabled: true };
  try { Object.assign(d, JSON.parse(fs.readFileSync(ENV_CFG, 'utf8'))); } catch (_) {}
  if (!MAC_RE.test(String(d.address || '').toUpperCase())) d.address = 'A4:C1:38:3C:25:A2';
  if (!(d.interval >= 30 && d.interval <= 600)) d.interval = 90;
  return d;
}
function saveEnvConfig(c) {
  try { fs.writeFileSync(ENV_CFG, JSON.stringify(c, null, 2)); } catch (_) {}
}

let envConfig = loadEnvConfig();

function startEnvSensor() {
  const E = state.env;
  if (!envConfig.enabled) {
    E.ok = false; E.msg = '温度计采集已暂停';
    return { ok: true, paused: true };
  }
  if (E.proc) return { ok: true, already: true };
  const py = findPython();
  if (!py) { E.ok = false; E.msg = '找不到 Python 运行环境'; return { ok: false, error: E.msg }; }
  if (!fs.existsSync(path.join(APP, 'env_sensor.py'))) {
    E.ok = false; E.msg = '缺少 env_sensor.py'; return { ok: false, error: E.msg };
  }

  const args = [
    path.join(APP, 'env_sensor.py'),
    '--address', envConfig.address,
    '--interval', String(envConfig.interval),
  ];
  log('spawn env_sensor', py, args.join(' '));

  let child;
  try {
    child = spawn(py, args, {
      cwd: APP, windowsHide: true,
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONUTF8: '1',
      }),
    });
  } catch (e) {
    E.ok = false; E.msg = '启动温度计采集失败：' + e.message;
    return { ok: false, error: E.msg };
  }

  E.proc = child;
  E.address = envConfig.address;
  E.interval = envConfig.interval;

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj.t === 'env_hello') {
        pushLog('温度计已启动：' + obj.address + '（每 ' + obj.interval + 's 一次）');
        continue;
      }
      if (obj.t !== 'env') continue;
      if (obj.ok) {
        const E2 = state.env;
        E2.reading = {
          temp_c: obj.temp_c, humidity: obj.humidity, battery: obj.battery,
          source: obj.source, rssi: obj.rssi, at: obj.at || Date.now(),
        };
        E2.ok = true;
        E2.msg = '';
        E2.since = Date.now();
        // 落盘 + 进内存环形缓冲（供曲线）。原始行按天滚动，另补一行到分钟文件。
        appendEnvRow(E2.reading);
        E2.history = E2.history || [];
        E2.history.push({ at: E2.reading.at, t: E2.reading.temp_c, h: E2.reading.humidity,
          b: E2.reading.battery != null ? E2.reading.battery : undefined });
        // 90s 一个点，留 1 小时只要 40 个；给足余量留 2000 个（≈50 小时）也无所谓。
        if (E2.history.length > 2000) E2.history.splice(0, E2.history.length - 2000);
        // 温度是低频量（90s 一次），推一次就够，不需要走 sample 那条高频通道
        sseBroadcast('env', { env: envPayload() });
      } else {
        state.env.ok = false;
        // obj.last 保留上一轮的成功读数，界面可以继续显示旧的（标注"多久没更新"）
        if (obj.last) state.env.reading = Object.assign({}, state.env.reading, { stale: true });
        state.env.msg = obj.msg || '读取失败';
        sseBroadcast('env', { env: envPayload() });
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    const l = String(d).trim();
    if (l) pushLog('温度计：' + l);
  });

  child.on('error', (e) => pushLog('温度计进程错误：' + e.message));
  child.on('close', (code) => {
    E.proc = null;
    if (!envConfig.enabled) return;
    E.ok = false;
    E.msg = '温度计采集退出（code=' + code + '），稍后重试';
    E.restarts += 1;
    pushLog('温度计采集退出，code=' + code);
    // 退避重启：别在蓝牙被占用/设备没电时疯狂刷日志
    const delay = Math.min(60000, 8000 * Math.max(1, E.restarts));
    // ★ 读历史期间让路：history-read 需要独占这台单连接设备，轮询进程 8 秒后
    //   自动重启会把连接抢回去（实测：历史 0 条 notify，全是被轮询踢的）。
    setTimeout(() => { if (!state.env.proc && envConfig.enabled && !envHistBusy) startEnvSensor(); }, delay);
  });

  return { ok: true };
}

function stopEnvSensor() {
  const E = state.env;
  if (E.proc) {
    const p = E.proc;
    E.proc = null;
    try { p.kill(); } catch (_) {}
  }
  E.ok = false;
}

// ------------------------------------------------------------ 读取设备内置历史
// 温度计（LYWSD03MMC）内部存着最近 152 小时的 min/max 记录（每小时一条），
// 比"从软件开始跑才积累的实时曲线"早得多。读回来合并进盘上的日文件，
// 切到 7 天 / 30 天区间就能看到软件还没跑之前的温度走势。
// 慢操作（全量 ~10 分钟），同一时刻只允许一个，进度/结果走 SSE 'envhist' 事件。
let envHistBusy = false;
let envHistProc = null;

/**
 * 把设备历史区间行 {at,tmin,tmax,hmin,hmax} 转成单点 {at,t,h} 落盘。
 * 历史只有上下限、没有单点值 —— 取区间中值 (min+max)/2 当代表值画线。
 * 合并进按天的原始文件 + 每分钟降采样文件（后者按分钟去重）。
 */
/**
 * 设备内置历史落盘。
 *
 * 语义（2026-10-06 起）：**设备历史是权威数据，覆盖它覆盖得到的一切旧记录**。
 * 为什么：设备每小时记的是那一小时的**最高/最低**，而本应用自己采的是 90 秒瞬时值 ——
 * 两种粒度混在一起，"当日最低~最高"会忽宽忽窄（有本机采样的那天 100+ 个点、没采样的
 * 那天只有 24 个点），看着像数据坏了。读完历史就统一成一种来源。
 *
 * 保留：比设备最后一条**更新**的本机采样（那是历史还没覆盖到的时段，即当前这一小时
 * 之后的新读数），以及比设备第一条**更早**的（如果有）。覆盖范围内的本机采样一律丢弃。
 * 按天文件同步重写（只重写设备覆盖到的那些天），否则长区间读一套、短区间又读另一套。
 *
 * ⚠️ 落盘按「天」分组后再写，并且**不要在循环里调 pruneEnvHistDays()**：
 *    那个函数是按 envHistDay 这个"当前天"去算保留窗口的。历史行跨了半年，循环里逐行改
 *    envHistDay 会让清理窗口跟着往回退 —— 结果是**刚写进去的历史日文件在同一轮里被自己
 *    删掉**（实测：读回 156 天，data\env-history\ 只剩 30 个文件，5~8 月全没了）。
 *    正确做法：先把这一批全写完，再统一清理一次。
 */
function mergeEnvHistory(rows) {
  try {
    fs.mkdirSync(ENV_HIST_DIR, { recursive: true });
    // ---- 1) 设备历史 → 一行"覆盖一小时"的记录
    //  ⚠️ 设备每小时只记一条，而且记的是**刚走完的那一小时**：记录在 xx:42 落下，
    //     覆盖的是 xx-1:42 ~ xx:42（实测：11:42 那条 = 22.8℃，而 11:48 的实时读数是
    //     23.65℃、10:42 那条是 21.55℃ —— 22.8 正好落在"10:42~11:42"这段的中间，
    //     如果它覆盖的是 11:42~12:42，均值该接近 23.6 才对）。
    //  所以每条记录都带上 sp = 一小时 与当天区间 tmin/tmax —— 前端据此把它画成
    //  **一小段带子**（而不是一个孤点）。否则在 30 分钟这种短窗口里，历史看着就像
    //  "只有一个点、其余全是空白"（用户 2026-10-06 报的就是这个）。
    const dev = [];
    const nnum = envNum;     // 同上
    for (const r of rows) {
      if (!r || typeof r.at !== 'number') continue;
      const at = Math.round(r.at);
      const tlo = nnum(r.tmin), thi = nnum(r.tmax);
      const hlo = nnum(r.hmin), hhi = nnum(r.hmax);
      const rec = { at, sp: DEV_HIST_SPAN_MS };
      const tm = (Number.isFinite(tlo) && Number.isFinite(thi)) ? round3((tlo + thi) / 2) : null;
      const hm = (Number.isFinite(hlo) && Number.isFinite(hhi)) ? round1((hlo + hhi) / 2) : null;
      if (tm != null) { rec.t = tm; rec.tmin = round3(tlo); rec.tmax = round3(thi); }
      if (hm != null) { rec.h = hm; rec.hmin = round1(hlo); rec.hmax = round1(hhi); }
      if (rec.t == null && rec.h == null) continue;
      dev.push(rec);
    }
    if (!dev.length) return 0;
    dev.sort((a, b) => a.at - b.at);
    const firstDevAt = dev[0].at, lastDevAt = dev[dev.length - 1].at;

    // ---- 2) 覆盖：**设备历史盖住的那一段**用设备记录替换，那段的本机采样一律丢掉；
    //        但**比设备最后一条更新的**（以及比第一条更早的）本机采样必须留下 ——
    //        那些时刻设备里根本没有记录，删掉曲线右端就会空一段。
    //
    // ⚠️ 2026-10-08 用户报「一小时温度有断点」就是这么来的：v1.8.4 曾按
    //    「本机采样一条都不留」做（把用户 2026-10-06 说的"把之前所有数据覆盖"
    //    理解成了连更新的也删）—— 结果读完历史后，从设备最后一条（每小时 :38）
    //    到下一次本机采样之间（约几分钟）是空的。用户要的"覆盖"是**被设备历史
    //    盖住的那一段**，不是"连设备里没有的新数据也删"。
    let dropped = 0;
    const keep = [];
    try {
      for (const r of readEnvMinRows()) {
        if (r.at > lastDevAt || r.at < firstDevAt) keep.push(r); else dropped += 1;
      }
    } catch (_) {}
    const out = dev.concat(keep).sort((a, b) => a.at - b.at);
    fs.writeFileSync(ENV_HIST_MIN, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
    envMinCache = { mtime: 0, rows: [] };        // 失效降采样缓存，下次 /api/env/history 重读

    // ---- 3) 按天文件跟着 out 重做：out（设备记录 + 保留的本机采样）里有的天就按它重写，
    //        那些天在盘上却不在 out 里的（比如更早的、已经没有任何数据的空日文件）才删。
    //        ⚠️ 别再理解成"范围外一律删" —— 范围外可能存着用户自己的本机采样。
    const dayLo = dayKey(firstDevAt), dayHi = dayKey(lastDevAt);
    const byDay = new Map();
    for (const r of out) {
      const k = dayKey(r.at);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(r);        // 整行写下去：sp/tmin/tmax 一个都不能掉（见上）
    }
    let wrote = 0, removed = 0;
    try {
      for (const f of fs.readdirSync(ENV_HIST_DIR)) {
        if (!/^env-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
        const k = f.slice(4, 14);
        const list = byDay.get(k);
        const p = path.join(ENV_HIST_DIR, f);
        if (list) {
          fs.writeFileSync(p, list.map((r) => JSON.stringify(r)).join('\n') + '\n');
          byDay.delete(k); wrote += 1;
        } else {
          try { fs.unlinkSync(p); removed += 1; } catch (_) {}
        }
      }
    } catch (_) {}
    for (const [k, list] of byDay) {          // 设备有、盘上还没有的那几天
      fs.writeFileSync(path.join(ENV_HIST_DIR, 'env-' + k + '.jsonl'),
        list.map((r) => JSON.stringify(r)).join('\n') + '\n');
      wrote += 1;
    }
    pruneEnvHistDays();                          // 全部写完再统一清理（见上面的警告）
    envHistDay = dayKey(Date.now());             // 复位成"今天"，别停在最后一条历史上

    const n = dev.length;
    log(`设备历史覆盖：写入 ${n} 条（${dayLo} ~ ${dayHi}），按天文件重写 ${wrote} 个 / 删除 ${removed} 个，`
      + `丢弃旧的本机采样 ${dropped} 条（覆盖后数据只来自设备内置历史）`);
    // ⚠️ 内存里那批"最近 1 小时"的读数也得跟着换 —— 它是启动时从**旧**日文件读进来的，
    //    不重读的话，短区间（≤1 小时）还在画刚被覆盖掉的那些行（界面与磁盘不一致）。
    try { seedEnvHistory(); } catch (_) {}
    // 记下历史覆盖的区间 —— 界面用它决定要不要放出 90天/全部 两档
    state.env.histFromAt = out[0].at;
    state.env.histToAt = out[out.length - 1].at;
    state.env.histDays = Math.max(1, Math.round((state.env.histToAt - state.env.histFromAt) / 86400000));
    state.env.histDropped = dropped;
    return n;
  } catch (e) {
    log('历史合并落盘失败：', e && e.message);
    return 0;
  }
}

/** 读取设备历史（后台跑 env_sensor.py --read-history，进度/结果走 SSE）。 */
function readDeviceHistory() {
  if (envHistBusy) return { ok: false, error: '已在读取中' };
  const py = findPython();
  if (!py) return { ok: false, error: '找不到 Python 运行环境' };
  if (!fs.existsSync(path.join(APP, 'env_sensor.py'))) {
    return { ok: false, error: '缺少 env_sensor.py' };
  }

  envHistBusy = true;
  // ★ 关键：温度计轮询进程（--interval 90）也占着这台设备 —— LYWSD03MMC 是
  //   单连接设备，轮询每 90s 连一次，和读历史的几分钟长连接必然互踢，
  //   实测表现就是 BleakDeviceNotFoundError / TimeoutError。读历史期间先暂停轮询。
  const wasPolling = !!state.env.proc && envConfig.enabled;
  if (state.env.proc) { stopEnvSensor(); pushLog('读取历史期间暂停温度计轮询（单连接设备，读完自动恢复）'); }
  const args = [path.join(APP, 'env_sensor.py'), '--address', envConfig.address,
    '--read-history', '--max-wait', '600', '--scan', '10'];
  log('读取温度计历史', py, args.join(' '));
  sseBroadcast('envhist', { phase: 'start', address: envConfig.address });

  let buf = '';
  let child;
  try {
    child = spawn(py, args, {
      cwd: APP, windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' }),
    });
  } catch (e) {
    envHistBusy = false;
    sseBroadcast('envhist', { phase: 'error', msg: '启动读取进程失败：' + e.message });
    return { ok: false, error: e.message };
  }
  envHistProc = child;

  const finish = (payload) => {
    envHistBusy = false; envHistProc = null;
    // 读完恢复轮询（原来开着的才恢复；等一拍再起，让蓝牙栈释放连接）
    if (wasPolling && envConfig.enabled && !state.env.proc) setTimeout(() => startEnvSensor(), 1500);
    sseBroadcast('envhist', payload);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj.t === 'env_hist_progress') {
        // cap = 设备保留条数上限（152），**不是本次要读的条数** —— 设备会把它
        // 内存里的历史全部推出来，got 超过 cap 是正常的。别拿它当进度分母。
        sseBroadcast('envhist', { phase: 'progress', got: obj.got, total: obj.cap, elapsed: obj.elapsed });
      } else if (obj.t === 'env_hist_retry') {
        // 连接阶段自动重试（设备广播间歇性消失/连接被抢），前端显示"重试中"
        sseBroadcast('envhist', { phase: 'retry', attempt: obj.attempt, msg: obj.msg });
      } else if (obj.t === 'env_history') {
        if (obj.ok) {
          const merged = mergeEnvHistory(obj.rows || []);
          const dropped = state.env.histDropped || 0;
          const days = state.env.histDays || 0;
          pushLog(`温度计历史读回 ${obj.count} 条：已覆盖旧数据（写盘 ${merged} 条，`
            + `覆盖 ${days} 天，丢弃覆盖范围内的本机采样 ${dropped} 条）`);
          finish({ phase: 'done', count: obj.count, merged, dropped, days,
                   truncated: !!(obj.meta && obj.meta.truncated) });
        } else {
          pushLog('温度计历史读取失败：' + (obj.msg || ''));
          finish({ phase: 'error', msg: obj.msg || '读取失败' });
        }
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { log('env历史 stderr：', c.trim()); });
  child.on('error', (e) => finish({ phase: 'error', msg: '读取进程异常：' + e.message }));
  child.on('close', (code) => {
    if (envHistBusy) { // stdout 没收到 env_history 就退了（被米家占用 / 设备没电）
      finish({ phase: 'error', msg: '读取进程提前退出（code=' + code + '），多半是设备被米家占用或没电' });
    }
  });

  return { ok: true, started: true };
}

/** 给界面用的温度计状态（只读快照）。 */
function envPayload() {
  const E = state.env;
  const r = E.reading;
  return {
    available: !!r,
    enabled: !!envConfig.enabled,
    address: envConfig.address,
    interval: envConfig.interval,
    running: !!E.proc,
    ok: E.ok,
    msg: E.msg,
    tempC: r ? r.temp_c : null,
    humidity: r ? r.humidity : null,
    battery: r ? r.battery : null,
    source: r ? r.source : null,       // 'adv'=广播直读，'gatt'=连接读取
    rssi: r && r.rssi != null ? r.rssi : null,   // 信号强度 dBm（串口直读时才有）
    at: r ? r.at : null,               // 读数时刻（ms）
    ageMs: r && r.at ? (Date.now() - r.at) : null,
    stale: !!(r && (r.stale || (r.at && Date.now() - r.at > envConfig.interval * 3000))),
    // 曲线：有几个点、最早一个是什么时候 —— 界面据此决定是画曲线还是提示"还在积累"
    points: (state.env.history || []).length,
    keepDays: ENV_KEEP_DAYS,
    // 读回设备内置历史之后才有值：最早/最新一条历史点的时刻（ms）。
    // 前端拿它放出 90天/全部 两档区间，并显示"有几天数据"。
    histFromAt: state.env.histFromAt || null,
    histToAt: state.env.histToAt || null,
    histDays: state.env.histDays || 0,
  };
}

// ------------------------------------------------------------ 设备识别记录
//
// 充电头每口报一个 4 字节端口字（b0 在用 / b1 协议码 / b2 电流 / b3 电压）。
// b1 是这颗头"识别设备"的口径之一：已知值见 vendor/cuktech_ble/ports.py 的
// PROTOCOL_NAMES，但实机上还见过没登记的值（如 0x0b）。另外 2.17/2.18 的高字节
// 给出握手协议号（PD / PPS / QC / SCP / FCP / AFC / UFCS / 5V）。
//
// 把每个新出现的 (端口, b1, 握手号, 协商功率, 档位类型) 组合记一行 ——
// 插上不同设备后回头就能把「码 → 厂商/型号」对上，这是拿到"设备型号"的正路。
// ⚠️ 别把电压/电流算进 key：它们一直在变，否则日志会被刷爆。
const identSeen = new Set();

function trackIdent(latest) {
  if (!latest || !Array.isArray(latest.ports)) return;
  for (const p of latest.ports) {
    if (!p.in_use) continue;
    const code = String(p.raw || '').slice(2, 4);        // b1
    const key = [p.id, code, p.proto_num, p.cap, p.kind].join('|');
    if (identSeen.has(key)) continue;
    identSeen.add(key);
    const line = new Date().toISOString() +
      ` ${p.label} 代码=${code} 握手=${p.proto_text || '-'}` +
      `(号 ${p.proto_num == null ? '-' : p.proto_num})` +
      ` 协商=${p.cap == null ? '-' : p.cap + 'W'}${p.kind ? '/' + p.kind : ''}` +
      ` 当时 ${p.v}V ${p.a}A ${p.w}W`;
    try { fs.appendFileSync(IDENT, line + '\r\n'); } catch (_) {}
    if (identSeen.size <= 30) pushLog('识别到新组合：' + line.slice(25));
  }
}

function handleCollectorLine(obj) {
  if (obj.t === 'hello') {
    pushLog('采集器已启动 pid=' + obj.pid);
    if (Array.isArray(obj.writable)) state.writable = obj.writable;
    if (Array.isArray(obj.switches)) state.switches = obj.switches;
    return;
  }
  if (obj.t === 'ack') {
    const p = pendingAcks.get(obj.id);
    if (p) {
      clearTimeout(p.timer);
      pendingAcks.delete(obj.id);
      p.resolve(obj);
    }
    if (obj.ok) {
      pushLog(`控制：${obj.name || ('2.' + obj.piid)} 设为 ${obj.value}` +
        (obj.readback != null && obj.readback !== obj.value ? `（回读 ${obj.readback}）` : ''));
    } else {
      pushLog(`控制失败：${obj.name || ('2.' + obj.piid)} — ${obj.error || '未知原因'}`);
    }
    return;
  }
  if (obj.t === 'link') {
    const prev = state.link && state.link.state;
    // 「上一次为什么失败」必须**留住**：采集器的节奏是
    //   搜索 2~8s → 连接（最多 60s）→ 失败 → 退避 2~30s → 再来一轮
    // 失败那一刻只闪一下 "reconnecting"，用户盯着看的绝大部分时间都是
    // "连接中"，界面上反而什么原因都没有。2026-11-08 有人在别人电脑上就一直
    // 只看到"正在建立 BLE 连接"，查不出所以然。
    const lastError = (obj.state === 'reconnecting' || obj.state === 'error')
      ? { msg: obj.msg || '', at: Date.now(), attempt: obj.attempt || 0 }
      : (obj.state === 'connected' ? null : ((state.link && state.link.lastError) || null));
    state.link = {
      state: obj.state,
      msg: obj.msg || '',
      attempt: obj.attempt || 0,
      rssi: obj.rssi != null ? obj.rssi : (state.link && state.link.rssi),
      lastError,
    };
    pushLog('链路：' + obj.state + (obj.msg ? ' — ' + obj.msg : ''));
    if (obj.state !== 'connected') noticeLinkProblem(prev, state.link);
    return;
  }
  if (obj.t === 'error') { pushLog('采集器报错：' + obj.msg); return; }
  if (obj.t === 'state') {
    state.latest = obj;
    state.restarts = 0;
    if (state.link.state !== 'connected') state.link = { state: 'connected', msg: '已连接', attempt: 0, rssi: obj.rssi };
    else if (obj.rssi != null) state.link.rssi = obj.rssi;
    trackIdent(obj);
    pushHistory(obj);
    // 自动断电：放在 pushHistory 之后 —— 判定只依赖这一帧，和曲线/账本无关
    try { autoOffTick(obj); } catch (e) { pushLog('自动断电判定异常：' + e.message); }
  }
}

// ------------------------------------------------------------------ 登录

const loginJob = { running: false, kind: null, startedAt: 0, result: null, proc: null };

function runPy(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const py = findPython();
    if (!py) return resolve({ ok: false, error: '找不到 Python 运行环境' });
    let child;
    try {
      child = spawn(py, [path.join(APP, script)].concat(args), {
        cwd: APP, windowsHide: true,
        env: Object.assign({}, process.env, {
          PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONUTF8: '1',
        }),
      });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    const so = [], se = [];
    let done = false;
    const t = setTimeout(() => {
      if (done) return; done = true;
      try { child.kill(); } catch (_) {}
      resolve({ ok: false, error: '超时', stderr: Buffer.concat(se).toString('utf8') });
    }, timeoutMs || 60000);
    child.stdout.on('data', (d) => so.push(d));
    child.stderr.on('data', (d) => se.push(d));
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(t);
      resolve({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(t);
      resolve({ ok: code === 0, code, stdout: Buffer.concat(so).toString('utf8'),
                stderr: Buffer.concat(se).toString('utf8') });
    });
  });
}

/**
 * 在桌面上创建快捷方式。
 * 会话沙箱里建不了 .lnk（COM / wscript / WMI 都被拦），但应用自己可以 ——
 * 因为它跑在用户环境里。用 -EncodedCommand（Base64/UTF-16LE）彻底规避
 * 中文路径的编码问题，并且只靠 ASCII 标记 RESULT_OK 判定成功。
 */
function createShortcut() {
  return new Promise((resolve) => {
    const bat = path.join(APP, '启动酷态科10号Ultra.bat');
    const ico = path.join(APP, 'app.ico');
    const q = (s) => String(s).replace(/'/g, "''");
    const ps = [
      '$w = New-Object -ComObject WScript.Shell',
      "$d = [Environment]::GetFolderPath('Desktop')",
      "$lnk = Join-Path $d '酷态科10号Ultra.lnk'",
      '$s = $w.CreateShortcut($lnk)',
      "$s.TargetPath = '" + q(bat) + "'",
      "$s.WorkingDirectory = '" + q(APP) + "'",
      "$s.IconLocation = '" + q(ico + ',0') + "'",
      "$s.Description = '酷态科10号Ultra（AD1204U）充电监视器'",
      '$s.WindowStyle = 7',
      '$s.Save()',
      "if (Test-Path $lnk) { 'RESULT_OK' } else { 'RESULT_FAIL' }",
    ].join('; ');
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    let child;
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
        { windowsHide: true });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    let so = '';
    child.stdout.on('data', (d) => { so += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', () => {
      const ok = so.indexOf('RESULT_OK') >= 0;
      pushLog(ok ? '已创建桌面快捷方式' : '创建桌面快捷方式失败（COM 未返回标记）');
      resolve({ ok, raw: so.trim().slice(0, 200) });
    });
  });
}

// ------------------------------------------------------------ 开机自启动

/** 当前档位：off / tray（只后台，不弹窗） / window（连窗口一起开）。 */
function autostartMode() {
  try { if (!fs.existsSync(AUTOSTART_LNK)) return 'off'; } catch (_) { return 'off'; }
  // .lnk 在就说明开着；具体哪一档记在 config 里。用户手删了 .lnk 就是 off。
  return config.autostartMode === 'window' ? 'window' : 'tray';
}

/**
 * 找出启动服务该用的 node.exe（给「开机自启动」那条 .lnk 用，见 setAutostart）。
 * 顺序：便携包自带的 runtime\node.exe → 当前正在跑的这个 node（process.execPath）
 *       → 系统安装的 Program Files\nodejs\node.exe。
 * ⚠️ 便携包里一定有 runtime\node.exe；开发机上没有，就落到 process.execPath。
 */
function findNodeExe() {
  const cands = [
    path.join(APP, 'runtime', 'node.exe'),
    process.execPath,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
  ];
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) {}
  }
  return 'node.exe';   // 最后交给 PATH
}

/**
 * 把自己的**控制台窗口**藏起来（Windows）。
 *
 * 为什么需要（2026-10-11 用户报「开机自启动窗口打不开 … 这个窗口隐藏」）：
 *   node.exe 是控制台程序，从 bat / 快捷方式启动时 Windows 会给它一个**真实存在的
 *   控制台窗口**（bat 里的 `start /min` 只是把它最小化）。逐像素看过用户那张截图：
 *   窗口客户区是 #0C0C0C（Windows 控制台默认底色），里面只有一行自己的 stdout
 *   「酷态科10号Ultra 服务已启动：http://127.0.0.1:8799/」，下面空白 —— 就是它。
 *   两个后果：
 *     · 它会一直挂在任务栏里，直到 node 退出（几小时）；
 *     · **关掉它 = 立刻杀掉服务**：点 ✕ 发的是 CTRL_CLOSE_EVENT，进程直接没了，
 *       没有退出日志、data\running.lock 与 alive.json 全部残留 —— 之后每次双击都会
 *       踩进「以为还有实例在跑」的坑（和 v1.8.22 修的 PID 回收是同一类现象）。
 *   所以进程一起来就 SW_HIDE：窗口还在（stdout 照旧写进它的缓冲区），但不在屏幕上、
 *   也不在任务栏里，用户没机会误关。**不依赖改成怎样启动**，手动跑也一样有效。
 *
 * ⚠️ 取不到控制台（GetConsoleWindow 返回 0）时什么都不做 —— 被当库 require、
 *    stdout 被重定向、或在压根没有控制台的环境里跑，都是这种情况，不能因此报错。
 * ⚠️ koffi 有两份来源，**两份都不能少**：
 *      ① `node_modules/koffi` —— 本机开发目录 / npm install 出来的；
 *      ② `vendor/koffi` —— **便携包专用**（包里不含 node_modules，见 tools/package.ps1 的
 *         隐私红线"不许出现 node_modules"）。它是把 koffi 的 JS + 预编译的
 *         `build/koffi/win32_x64/koffi.node` 一起塞进 vendor 的副本，靠 koffi 自己的
 *         查找规则（`<dirname>/../../build/koffi/<triplet>/koffi.node`）加载，
 *         已在 node 22 与 24 上实测可用（koffi 走 Node-API，ABI 稳定）。
 *    两份都没有就返回 no-koffi：只是窗口继续可见，功能一切照旧，不报错。
 */
function hideOwnConsole() {
  if (process.platform !== 'win32') return { ok: false, why: 'not-windows' };
  let koffi = null;
  let from = '';
  for (const cand of ['koffi', path.join(APP, 'vendor', 'koffi')]) {
    try { koffi = require(cand); from = cand; break; } catch (_) {}
  }
  if (!koffi) return { ok: false, why: 'no-koffi' };
  try {
    const kernel32 = koffi.load('kernel32.dll');
    const user32 = koffi.load('user32.dll');
    const GetConsoleWindow = kernel32.func('GetConsoleWindow', 'void *', []);
    const ShowWindow = user32.func('ShowWindow', 'bool', ['void *', 'int']);
    const hwnd = GetConsoleWindow();
    if (!hwnd) return { ok: false, why: 'no-console', from };
    ShowWindow(hwnd, 0);              // SW_HIDE
    // 回读一次当作凭据（只读诊断，失败不影响结果）—— 日志里能直接看出藏没藏住
    let stillVisible = null;
    try {
      const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['void *']);
      stillVisible = !!IsWindowVisible(hwnd);
    } catch (_) {}
    return { ok: true, why: 'hidden', stillVisible, from };
  } catch (e) {
    return { ok: false, why: 'error:' + ((e && e.message) || e), from };
  }
}

/**
 * 设置开机自启动。mode: off / tray / window。
 * 同样走 -EncodedCommand + COM —— 会话沙箱建不了 .lnk，但应用自己的进程可以。
 *
 * ⚠️ 2026-10-11 改：**.lnk 直接指向 node.exe**，不再经过那个 .bat。
 * 为什么：走 bat 时开机必定创建一个 cmd 控制台窗口（先是被 .lnk 的 WindowStyle=7
 *   最小化、随后 bat 立刻退出）—— 用户原话「这个窗口隐藏」。直连 node 之后开机这条
 *   链路上一个 cmd 都不会起；node 的控制台由它自己的 hideOwnConsole() 收掉。
 *   传参形状：`"<APP>\server.js"`（后台档再加 ` --no-window`）。
 *   工作目录仍设为 APP（server.js 里全用 __dirname，但留着更稳）。
 */
function setAutostart(mode) {
  const m = ['off', 'tray', 'window'].includes(mode) ? mode : 'off';
  return new Promise((resolve) => {
    const sjs = path.join(APP, 'server.js');
    const ico = path.join(APP, 'app.ico');
    const q = (s) => String(s).replace(/'/g, "''");
    const ps = [
      '$w = New-Object -ComObject WScript.Shell',
      "$p = '" + q(AUTOSTART_LNK) + "'",
      'if (Test-Path $p) { Remove-Item $p -Force }',
    ];
    if (m !== 'off') {
      const node = findNodeExe();
      ps.push('$s = $w.CreateShortcut($p)');
      ps.push("$s.TargetPath = '" + q(node) + "'");
      ps.push("$s.Arguments = '" + q('"' + sjs + '"' + (m === 'tray' ? ' --no-window' : '')) + "'");
      ps.push("$s.WorkingDirectory = '" + q(APP) + "'");
      ps.push("$s.IconLocation = '" + q(ico + ',0') + "'");
      ps.push("$s.Description = '酷态科10号Ultra 开机自启动"
        + (m === 'tray' ? '（后台运行）' : '（打开窗口）') + "'");
      ps.push('$s.WindowStyle = 7');
      ps.push('$s.Save()');
    }
    ps.push("if (Test-Path $p) { 'RESULT_OK' } else { 'RESULT_OFF' }");
    const b64 = Buffer.from(ps.join('; '), 'utf16le').toString('base64');
    let child;
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
        { windowsHide: true });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    let so = '';
    child.stdout.on('data', (d) => { so += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', () => {
      const raw = so.trim();
      const ok = raw.indexOf('RESULT_OK') >= 0 || (m === 'off' && raw.indexOf('RESULT_OFF') >= 0);
      if (ok) { config.autostartMode = (m === 'off' ? undefined : m); saveConfig(config); }
      pushLog(ok
        ? ('开机自启动：' + (m === 'off' ? '已关闭'
          : (m === 'tray' ? '已开启（后台运行，不弹窗）' : '已开启（打开窗口）')))
        : ('设置开机自启动失败（COM 未返回标记）' + (raw ? '：' + raw.slice(0, 120) : '')));
      resolve({ ok, mode: ok ? m : autostartMode(), raw: raw.slice(0, 200) });
    });
  });
}

function lastJson(text) {  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) { try { return JSON.parse(lines[i]); } catch (_) {} }
  }
  return null;
}

async function loginStart() {
  if (loginJob.running) return { ok: false, error: '已有登录任务在进行' };
  loginJob.running = true; loginJob.kind = 'qr'; loginJob.startedAt = Date.now(); loginJob.result = null;
  pushLog('开始申请登录二维码…');
  const r = await runPy('login.py', ['qr'], 60000);
  const j = lastJson(r.stdout);
  loginJob.running = false; loginJob.kind = null;
  if (!j || !j.ok || !j.png) {
    let err = (j && j.error) || r.error || '申请二维码失败';
    if ((j && j.certError) || isCertText(err)) err += await tlsVerdict();
    pushLog('申请二维码失败：' + err);
    return { ok: false, error: err };
  }
  pushLog('二维码已生成，等待扫码（%ss 内有效）'.replace('%s', j.timeout));
  return { ok: true, timeout: j.timeout, ts: Date.now() };
}

function loginPoll() {
  if (loginJob.running) return { ok: false, error: '已有登录任务在进行' };
  loginJob.running = true; loginJob.kind = 'poll'; loginJob.startedAt = Date.now();
  loginJob.result = null;
  const py = findPython();
  if (!py) { loginJob.running = false; return { ok: false, error: '找不到 Python 运行环境' }; }

  let child;
  try {
    child = spawn(py, [path.join(APP, 'login.py'), 'poll',
      '--address', effectiveAddress() || 'auto', '--wait', '280', '--verbose'], {
      cwd: APP, windowsHide: true,
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONUTF8: '1',
      }),
    });
  } catch (e) { loginJob.running = false; return { ok: false, error: e.message }; }

  loginJob.proc = child;
  let so = '', se = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { so += d; });
  let eb = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    eb += d;
    let nl;
    while ((nl = eb.indexOf('\n')) >= 0) {
      const l = eb.slice(0, nl).trim(); eb = eb.slice(nl + 1);
      if (l) pushLog('登录：' + l);
    }
  });
  child.on('close', async (code) => {
    loginJob.running = false;
    loginJob.proc = null;
    const j = lastJson(so);
    if (j && j.ok) {
      loginJob.result = { ok: true, region: j.region, tokenLen: j.tokenLen, fan: j.fan || null };
      // 自动发现：账号里找到哪台充电头就记哪台（便携包给别人用时对方没填过地址）
      if (typeof j.mac === 'string' && MAC_RE.test(j.mac) && j.mac.toUpperCase() !== effectiveAddress()) {
        config.address = j.mac.toUpperCase();
        saveConfig(config);
        pushLog('已记住设备地址 ' + config.address);
      }
      pushLog('登录成功，已保存 BLE 密钥');
      restartCollectorSoon();
      // ★ 同一次扫码也把风扇的 IP + token 取回来了（login.py 一次登录取两把钥匙）。
      //   风扇是 Wi-Fi 设备，没有这两样连一条命令都发不出去。
      if (j.fan) {
        pushLog(`风扇已认到：${j.fan.name || ''} ${j.fan.model || ''} @ ${j.fan.ip || '（云端没给 IP）'}`);
        writeFanConfig();
        restartFanCollectorSoon();
      } else if (j.fanError) {
        pushLog('风扇未配置：' + j.fanError);
        state.fan.link = { state: 'need-login', msg: j.fanError, at: Date.now() };
      }
    } else {
      let err = (j && j.error) || ('退出码 ' + code);
      if ((j && j.certError) || isCertText(err)) err += await tlsVerdict();
      loginJob.result = { ok: false, error: err };
      pushLog('登录失败：' + err);
    }
  });
  pushLog('已开始等待扫码授权…');
  return { ok: true };
}

// ------------------------------------------------------------------ TLS 自检
//
// 小米云登录在别人机器上偶发 "certificate verify failed: Basic Constraints of CA cert
// not marked critical"（详见 netfix.py 顶部说明）：要么是 Python 3.13 的严格模式误杀了
// 小米证书链（本程序已自动放宽口径），要么是那台机器/那个网络的 HTTPS 被解密
// （抓包工具、杀软网页防护、公司 VPN、加速器）。两种情况的处置完全不同，
// 所以失败时顺手把 netfix.py 的体检跑一遍，把结论写进弹层 —— 而不是让用户
// 对着一行 OpenSSL 报错发呆。
let tlsProbeMemo = { at: 0, payload: null };

function trimProbe(j) {
  const chainOf = (h) => {
    const list = (h.relaxed.chain && h.relaxed.chain.length ? h.relaxed.chain : h.strict.chain) || [];
    return list.map((c) => ({
      i: c.i, subject: c.subject, issuer: c.issuer, isCA: c.isCA, bcCritical: c.bcCritical,
      inStore: c.inStore, selfSigned: c.selfSigned,
    }));
  };
  // 校验失败时 relaxed/strict 的链都是空的 —— 真正有用的是 peek 偷看到的那条
  const peekOf = (h) => {
    const list = (h.peek && h.peek.chain) || [];
    return list.map((c) => ({
      i: c.i, subject: c.subject, issuer: c.issuer, isCA: c.isCA, bcCritical: c.bcCritical,
      inStore: c.inStore, selfSigned: c.selfSigned,
    }));
  };
  return {
    verdict: j.verdict,
    advice: j.advice || [],
    missingRoot: j.missingRoot || null,
    strictDefault: !!j.strictDefault,
    python: j.python, openssl: j.openssl,
    reportFile: j.reportFile || null,
    proxy: j.proxy || null,
    trust: j.trust || null,
    bundle: j.bundle || null,
    cas: { count: (j.cas && j.cas.count) || 0, suspicious: (j.cas && j.cas.suspicious) || [] },
    classify: (j.classify || []).map((c) => ({
      host: c.host, cls: c.cls, missing: c.missing, signer: c.signer, detail: c.detail,
    })),
    hosts: (j.hosts || []).map((h) => ({
      host: h.host,
      strict: { ok: h.strict.ok, error: h.strict.error },
      relaxed: { ok: h.relaxed.ok, error: h.relaxed.error, tls: h.relaxed.tls },
      chain: chainOf(h),
      peek: peekOf(h),
      peekError: (h.peek && h.peek.error) || null,
    })),
  };
}

async function tlsProbe(force) {
  if (!force && tlsProbeMemo.payload && Date.now() - tlsProbeMemo.at < 60000) return tlsProbeMemo.payload;
  const r = await runPy('netfix.py', ['--probe', '--json'], 45000);
  const j = lastJson(r.stdout);
  const payload = (j && j.verdict)
    ? Object.assign({ ok: true }, trimProbe(j))
    : { ok: false, error: r.error || '自检没能跑起来', stderr: String(r.stderr || '').slice(-600) };
  tlsProbeMemo = { at: Date.now(), payload };
  return payload;
}

/** 给登录失败的报错追加一段"人话结论"（跑不起来就静默，不抢主报错的位置）。 */
async function tlsVerdict() {
  try {
    const p = await tlsProbe(true);
    if (!p.ok) return '\n\n【网络自检】没能跑起来：' + (p.error || '未知原因');
    const lines = (p.advice || []).join(' ');
    const file = p.reportFile ? '（完整报告：' + p.reportFile + '）' : '';
    return '\n\n【网络自检】' + (lines || '未发现明显问题，请点「重试」再试一次') + file;
  } catch (_) { return ''; }
}

function isCertText(s) {
  // "unable to get local issuer certificate" 是**另一类**证书错（本机缺根 / 被中间人），
  // 2026-10-24 有人在别人电脑上撞到它，之前这条正则漏了 —— 于是失败时不会自动跑体检。
  return /CERTIFICATE_VERIFY_FAILED|Basic Constraints|certificate verify failed|SSLCertVerificationError|self-signed certificate|unable to get local issuer|certificate has expired/i
    .test(String(s || ''));
}

// ------------------------------------------------------------------ 历史查询

/**
 * 把磁盘上还留存的**原始**采样补进 history-min.jsonl。
 *
 * 升级到两层存储之前只写 history.jsonl，没有降采样文件 —— 不补的话
 * 7 天 / 30 天曲线要等好几天才慢慢有东西看。启动时跑一次，幂等：
 * 已经存在的分钟不重复追加；只有当回填出来的那一分钟**采样更全**时才替换
 * （崩溃/重启前写下的残行会在下次启动被补齐）。当前那一分钟不补（留给 flushMinute 写）。
 */
function rebuildMin() {
  const raw = [];
  try {
    for (const f of fs.readdirSync(HIST_DIR)) {
      if (/^history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) raw.push(...parseRows(path.join(HIST_DIR, f)));
    }
  } catch (_) {}
  raw.push(...parseRows(HIST));
  if (!raw.length) return 0;
  raw.sort((a, b) => a.at - b.at);

  const rows = minRowsClean(parseRows(HIST_MIN));   // 顺手修掉老文件里的重复分钟
  const idxOf = new Map(rows.map((r, i) => [r.at, i]));
  const curMinute = Math.floor(Date.now() / MIN_ROW_MS) * MIN_ROW_MS;
  const buckets = new Map();
  for (const r of raw) {
    const m = Math.floor(r.at / MIN_ROW_MS) * MIN_ROW_MS;
    if (m === curMinute) continue;                  // 当前这一分钟留给 flushMinute 写
    let b = buckets.get(m);
    if (!b) { b = { n: 0, total: 0, peak: 0, ports: zeroPorts() }; buckets.set(m, b); }
    const t = Number(r.total || 0);
    b.n++;
    b.total += t;
    b.peak = Math.max(b.peak, t);
    for (const id of PORTS) b.ports[id] += Number((r.w && r.w[id]) || 0);
  }
  if (!buckets.size) return 0;
  let touched = 0;
  for (const m of [...buckets.keys()].sort((a, b) => a - b)) {
    const b = buckets.get(m);
    const out = { at: m, n: b.n, total: round3(b.total / b.n), peak: round3(b.peak), w: {} };
    for (const id of PORTS) out.w[id] = round3(b.ports[id] / b.n);
    const i = idxOf.get(m);
    if (i === undefined) {
      idxOf.set(m, rows.length);
      rows.push(out);
      touched++;
      continue;
    }
    // 同一分钟已有记录：只有回填出来的更完整才替换。这样「崩溃时写下的残行」
    // （例如退出那一刻只攒了 12 秒的 n=24）会在下次启动被整分钟的完整行修好。
    if (Number(rows[i].n || 0) < b.n) { rows[i] = out; touched++; }
  }
  if (!touched) return 0;
  rows.sort((a, b) => a.at - b.at);
  fs.writeFileSync(HIST_MIN, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return touched;
}

/** 降采样文件跟能量账本同寿命（DAYS_KEEP 天）。 */
function pruneHistMin() {
  try {
    const cut = Date.now() - DAYS_KEEP * 86400000;
    const rows = parseRows(HIST_MIN);
    const kept = minRowsClean(rows).filter((r) => r.at >= cut);
    if (kept.length !== rows.length) {
      fs.writeFileSync(HIST_MIN, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
      log('history-min 整理：' + rows.length + ' -> ' + kept.length + ' 行'
        + (rows.length - kept.length ? '（含重复分钟去重 / 过期裁剪）' : ''));
    }
  } catch (_) {}
}

/**
 * history-min.jsonl 的「读出来就能用」版本：按时间排序 + 同一分钟只留一条。
 *
 * 重复分钟的成因见 flushMinute 的注释（迟到采样重开桶）。写入端已经改成幂等，
 * 这里再兜一层：**老文件里已经存在的重复行**不用等重写就能被正确查询，
 * 而且是"同一分钟保留 n 更大（采样更全）的那一条"。
 */
function minRowsClean(rows) {
  const byAt = new Map();
  for (const r of rows) {
    if (!r || !Number.isFinite(r.at)) continue;
    const prev = byAt.get(r.at);
    if (!prev || Number(r.n || 0) > Number(prev.n || 0)) byAt.set(r.at, r);
  }
  return [...byAt.values()].sort((a, b) => a.at - b.at);
}

// history-min.jsonl 会被反复读（前端每秒拉一次）。整文件读 + 按 mtime 缓存，
// 不然 30 天有 4 万多行、每秒读一遍太浪费。
let minCache = { mtime: 0, rows: [] };
function readMinRows() {
  try {
    const st = fs.statSync(HIST_MIN);
    if (st.mtimeMs !== minCache.mtime) minCache = { mtime: st.mtimeMs, rows: minRowsClean(parseRows(HIST_MIN)) };
  } catch (_) { minCache = { mtime: 0, rows: [] }; }
  return minCache.rows;
}

/** 把任意长的点列降采样到最多 maxPoints 个（分组取均值，峰值保留组内最大）。 */
function downsample(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const step = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += step) {
    const g = rows.slice(i, i + step);
    const w = zeroPorts();
    let total = 0;
    let peak = 0;
    for (const r of g) {
      total += Number(r.total || 0);
      peak = Math.max(peak, Number(r.peak != null ? r.peak : (r.total || 0)));
      for (const id of PORTS) w[id] += Number((r.w && r.w[id]) || 0);
    }
    const n = g.length || 1;
    for (const id of PORTS) w[id] = round3(w[id] / n);
    out.push({ at: g[g.length - 1].at, n, total: round3(total / n), peak: round3(peak), w });
  }
  return out;
}

/**
 * 按区间取曲线点。
 * ≤ 1 小时用内存里的原始采样（间隔由「采样间隔」决定），更长的读 history-min.jsonl（每分钟一行）。
 * 两者都降到 CHART_MAX_POINTS 以内再发给前端 —— ≤1h 以前漏了这一步，所以
 * 0.5s 采样下选「1 小时」会一次下发 7000+ 个点（≈600KB JSON），区间切换自然发卡。
 * 短窗（1m/5m/10m）在 1.5s 采样下点数本就不超过 400，downsample 原样返回，细节不受影响。
 */
function queryHistory(rangeKey, seconds) {
  const sec = (Number.isFinite(seconds) && seconds > 0)
    ? seconds
    : (HISTORY_RANGES[rangeKey] || HISTORY_RANGES['1h']);
  const named = Object.keys(HISTORY_RANGES).find((k) => HISTORY_RANGES[k] === sec) || null;
  const fromDisk = sec > HISTORY_RANGES['1h'];
  const since = Date.now() - sec * 1000;
  const src = fromDisk
    ? readMinRows()
    : state.history;
  const rows = downsample(src.filter((r) => r.at >= since), CHART_MAX_POINTS);
  const last = state.history.length ? state.history[state.history.length - 1] : null;
  return { range: named || (sec + 's'), seconds: sec, source: fromDisk ? 'minute' : 'raw', rows, latest: last };
}

// ⚠️ 这里原来是「响应缓存 10 秒」，键里只有 range —— 前端每 1.5 秒来取一次，
//    却连拿 6~7 次同一份旧数据，曲线于是**每 10 秒才跳一格**（用户反馈的
//    "刷新有点滞后"就是它，不是前端慢）。
//    现在把「数据版本」并进缓存键：内存里多一个采样点、或每分钟文件被写过，
//    键就变了、立刻重算。TTL 只是兜底，防止同一毫秒内被重复请求打爆。
const histMemo = new Map();
const HIST_MEMO_MS = 1000;

/** 当前区间的数据版本号：数据真变了才变，没变就一直命中缓存。 */
function histVersion(sec) {
  if (sec > HISTORY_RANGES['1h']) {
    // 长区间读 data/history-min.jsonl，文件每分钟追加一次 —— 用 mtime 当版本。
    try { return 'M' + fs.statSync(HIST_MIN).mtimeMs; } catch (_) { return 'M0'; }
  }
  const h = state.history;
  return 'R' + h.length + '.' + (h.length ? h[h.length - 1].at : 0);
}

function queryHistoryCached(rangeKey, seconds) {
  const sec = (Number.isFinite(seconds) && seconds > 0)
    ? seconds
    : (HISTORY_RANGES[rangeKey] || HISTORY_RANGES['1h']);
  const k = rangeKey + ':' + sec + ':' + histVersion(sec);
  const hit = histMemo.get(k);
  if (hit && Date.now() - hit.at < HIST_MEMO_MS) return hit.payload;
  const payload = queryHistory(rangeKey, seconds);
  histMemo.set(k, { at: Date.now(), payload });
  if (histMemo.size > 12) histMemo.delete(histMemo.keys().next().value);
  return payload;
}

// ------------------------------------------------------------------ CSV 导出

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 带 UTF-8 BOM —— 不加的话 Excel 会把中文认成 ANSI 乱码。 */
function sendCsv(res, filename, rows) {
  const body = Buffer.from('\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="cuktech.csv"; filename*=UTF-8\'\'' + encodeURIComponent(filename),
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function buildCsv(what) {
  const stamp = dayKey(Date.now());
  if (what === 'sessions') {
    const rows = [['开始', '结束', '时长(分钟)', '电量(Wh)', '峰值(W)', 'C1(Wh)', 'C2(Wh)', 'C3(Wh)', 'USB-A(Wh)']];
    for (const s of energy.sessions) {
      rows.push([
        new Date(s.start).toLocaleString('zh-CN'),
        new Date(s.end).toLocaleString('zh-CN'),
        round3((s.ms || 0) / 60000), round3(s.wh), round3(s.peak),
        round3(s.ports && s.ports.c1), round3(s.ports && s.ports.c2),
        round3(s.ports && s.ports.c3), round3(s.ports && s.ports.a),
      ]);
    }
    return { filename: '充电会话-' + stamp + '.csv', rows };
  }
  if (what === 'plugs') {
    const rows = [['端口', '插入', '拔出', '时长(分钟)', '电量(Wh)', '度数', 'mAh', '峰值(W)', '协议', '协商(W)']];
    for (const g of energy.plugs) {
      rows.push([
        g.label || PORT_LABEL[g.id] || g.id,
        new Date(g.start).toLocaleString('zh-CN'),
        g.end ? new Date(g.end).toLocaleString('zh-CN') : '',
        g.ms ? round3(g.ms / 60000) : '',
        round3(g.wh), round3(g.wh / 1000), Math.round((g.wh / CELL_V) * 1000),
        round3(g.peak), g.proto || '', g.cap == null ? '' : g.cap,
      ]);
    }
    return { filename: '插拔记录-' + stamp + '.csv', rows };
  }
  if (what === 'ports') {
    const total = energy.totalWh || 0;
    const rows = [['端口', '累计电量(Wh)', '占比(%)']];
    for (const id of PORTS) {
      const wh = Number(energy.ports[id] || 0);
      rows.push([PORT_LABEL[id], round3(wh), total > 0 ? round3((wh / total) * 100) : 0]);
    }
    rows.push(['合计', round3(total), 100]);
    return { filename: '分口电量-' + stamp + '.csv', rows };
  }
  const rows = [['日期', '电量(Wh)', 'C1(Wh)', 'C2(Wh)', 'C3(Wh)', 'USB-A(Wh)']];
  for (const k of Object.keys(energy.days).sort()) {
    const b = energy.days[k] || {};
    rows.push([
      k, round3(b.total),
      round3(b.ports && b.ports.c1), round3(b.ports && b.ports.c2),
      round3(b.ports && b.ports.c3), round3(b.ports && b.ports.a),
    ]);
  }
  return { filename: '每日电量-' + stamp + '.csv', rows };
}

// ------------------------------------------------------------------ HTTP

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 65536) { try { req.destroy(); } catch (_) {} }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};

function serveStatic(res, rel) {
  const p = path.join(WEB, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!p.startsWith(WEB)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ------------------------------------------------------------ 蓝牙适配器（只读）
//
// 为什么要在界面里显示它：2026-11-08 有人在别人电脑上「扫得到、连不上」，
// 最后落在**适配器**上 —— 那台是 MS-B550M WIFI ICE，板载 Realtek RTL8821CE
// （Wi-Fi + BT4.2 组合卡，1x1 天线由 Wi-Fi 和蓝牙分时共用）。这类信息光看界面
// 永远猜不到，而在失败提示里顺带写出来，一眼就能对号入座（换驱动 / 关 Wi-Fi / 换棒）。
//
// 只跑一次，失败就当没有（拿不到就少一行字，绝不能因此影响采集）。
let btAdapter = null;
let btAdapterTried = false;

function probeBtAdapter() {
  if (btAdapterTried) return Promise.resolve(btAdapter);
  btAdapterTried = true;
  return new Promise((resolve) => {
    const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
      + "Get-PnpDevice -Class Bluetooth -Status OK -ErrorAction SilentlyContinue | "
      + "Where-Object { $_.InstanceId -like 'USB\\*' } | "
      + "Select-Object -First 1 -ExpandProperty FriendlyName";
    let child;
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { windowsHide: true });
    } catch (_) { return resolve(null); }
    let so = '';
    const done = (v) => { try { child.kill(); } catch (_) {} resolve(v); };
    const timer = setTimeout(() => done(btAdapter), 6000);
    child.stdout.on('data', (d) => { so += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const name = so.trim().split(/\r?\n/)[0].trim();
      if (name && name.length < 80) {
        btAdapter = { name };
        pushLog('蓝牙适配器：' + name);
      }
      resolve(btAdapter);
    });
  });
}

// ------------------------------------------------------- 自动断电（5V 空载）
//
// 需求（2026-11-13 用户提）：「检查到充电口带 5V 以上电压、但没有电流，自动关闭该充电口」。
//
// 为什么可行：设备把端口开关放在 2.16 的位掩码里（bit0..3 = C1/C2/C3/A），
// 每个端口的上报里也有 v / a（见 collector.py 的 decode_port_info：
// b3=电压×0.1、b2=电流×0.1），所以"判定"和"动手"都不需要猜。
//
// 三条安全设计（都是踩过坑才写进来的）：
//  ① **必须连续满足 idleSec 秒**才动手 —— 协议协商、插拔瞬间的 0A 不算数；
//  ② 关掉之后**默认 15 分钟自动恢复** —— 否则这个口从此没电，用户插新设备时
//     根本想不到是软件关的。恢复后**不立即重新武装**（disarmed），要等
//     "拔掉(v<1)" 或 "重新取电(a>iMax)" 才再次监听 —— 不然会变成每 15 分钟
//     通断一次的循环；
//  ③ USB-A 的「小电流模式」开着时不碰 A 口（那是给手环/耳机用的，本来就该 0A）。
// 默认值 AUTO_OFF_DEF 定义在文件顶部的常量区（见那里的说明：const 有 TDZ）。
function normAutoOff(raw) {
  const c = Object.assign({}, AUTO_OFF_DEF, (raw && typeof raw === 'object') ? raw : {});
  const num = (v, lo, hi, d) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    enabled: c.enabled !== false,
    vMin: num(c.vMin, 3, 20, AUTO_OFF_DEF.vMin),
    iMax: num(c.iMax, 0, 0.5, AUTO_OFF_DEF.iMax),
    idleSec: Math.round(num(c.idleSec, 5, 3600, AUTO_OFF_DEF.idleSec)),
    restoreMin: Math.round(num(c.restoreMin, 0, 240, AUTO_OFF_DEF.restoreMin)),
    // 只有明确写成 false 才关；缺字段时按"保护"处理
    skipSmallA: c.skipSmallA !== false,
  };
}

/**
 * 一个端口一帧的判定 —— **纯函数**，喂假数据就能验证，不碰设备也不碰时间。
 * @param prev 上一帧留下的 {idleSince, disarmed}
 * @param s    本帧 {v, a, enabled}
 * @returns {{state:{idleSince:number,disarmed:boolean}, action:'none'|'cut', why:string}}
 */
function autoOffStep(prev, s, cfg, now) {
  // ⚠️ "还没开始计时"用 **null**，不能用 0：now 有可能正好是 0（离线测试就是），
  //    那时 `if (!st.idleSince) st.idleSince = now` 会把它永远钉在 0 ——
  //    表现为"怎么等都不关"。第一次写就踩了，测试第一次跑就红。
  const st = {
    idleSince: (prev && prev.idleSince != null) ? prev.idleSince : null,
    disarmed: !!(prev && prev.disarmed),
  };
  if (!s.enabled) { st.idleSince = null; return { state: st, action: 'none', why: 'port-off' }; }
  if (!(s.v >= 1)) {                       // 没有电压 = 没插东西，重新武装
    st.idleSince = null; st.disarmed = false;
    return { state: st, action: 'none', why: 'unplugged' };
  }
  if (s.a > cfg.iMax) {                     // 正在取电，重新武装
    st.idleSince = null; st.disarmed = false;
    return { state: st, action: 'none', why: 'load' };
  }
  if (s.v < cfg.vMin) { st.idleSince = null; return { state: st, action: 'none', why: 'below-v' }; }
  if (st.disarmed) { st.idleSince = null; return { state: st, action: 'none', why: 'disarmed' }; }
  if (st.idleSince == null) st.idleSince = now;
  if (now - st.idleSince >= cfg.idleSec * 1000) {
    st.idleSince = null; st.disarmed = true;
    return { state: st, action: 'cut', why: 'idle' };
  }
  return { state: st, action: 'none', why: 'arming' };
}

const autoOffState = new Map();     // port -> {idleSince, disarmed}
const autoOffTimers = new Map();    // port -> setTimeout（自动恢复）
let autoOffLast = null;             // 最近一次触发，给界面显示

function autoOffRestore(port, min) {
  const old = autoOffTimers.get(port);
  if (old) { clearTimeout(old); autoOffTimers.delete(port); }
  if (!min) return;
  const t = setTimeout(() => {
    autoOffTimers.delete(port);
    const en = state.latest && state.latest.settings && state.latest.settings.ports_enabled;
    if (en && en[port] === true) return;      // 用户已经手动开回来了，别重复写
    setPort(port, 'on').then((r) => {
      const msg = `自动断电：${port.toUpperCase()} 已按设定恢复供电`
        + (r && r.ok ? '' : '（失败：' + ((r && r.error) || '未知') + '）');
      pushLog(msg);
      log(msg);
    });
  }, min * 60000);
  if (t.unref) t.unref();
  autoOffTimers.set(port, t);
}

// ---- 异常检查：每次「有电压没电流」都记一条 ---------------------------------
//
// 和"要不要自动关"是两件事：**记录永远做**，关不关由 enabled 决定。
// 一次空载 = 一个 episode（从满足条件开始，到重新取电 / 拔掉 / 被关掉为止），
// 结束时落一行 JSONL —— 而不是每帧记一条（1.5 秒一帧，一天就是 5 万条）。
const AOOFF_KEEP = 500;               // 文件与内存都只留最近 500 条
let autoOffEvents = [];               // 最近的事件（给界面）
const autoOffEpisodes = new Map();    // port -> {start, vMax, aMax, lastV, lastA}
const autoOffLastCut = new Map();     // port -> ts：刚关过，5 秒内别急着开新 episode

function loadAutoOffEvents() {
  try {
    const rows = fs.readFileSync(AUTO_OFF_LOG, 'utf8').split('\n').filter(Boolean);
    autoOffEvents = rows.slice(-AOOFF_KEEP).map((l) => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
    // 文件超了就在启动时压一次（不必每次写都重写整个文件）
    if (rows.length > AOOFF_KEEP * 2) {
      fs.writeFileSync(AUTO_OFF_LOG, autoOffEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    log(`异常检查：已载入 ${autoOffEvents.length} 条空载记录`);
  } catch (_) { autoOffEvents = []; }
}

function appendAutoOffEvent(ev) {
  const row = Object.assign({ id: (autoOffEvents.length ? autoOffEvents[autoOffEvents.length - 1].id : 0) + 1 }, ev);
  autoOffEvents.push(row);
  if (autoOffEvents.length > AOOFF_KEEP) autoOffEvents.splice(0, autoOffEvents.length - AOOFF_KEEP);
  try { fs.appendFileSync(AUTO_OFF_LOG, JSON.stringify(row) + '\n'); } catch (_) {}
  pushLog(`异常检查：${String(row.port).toUpperCase()} 有电压没电流`
    + ` ${(row.durMs / 1000).toFixed(1)} 秒（${row.vMax} V / ${row.aMax} A）`
    + (row.action === 'cut' ? ' → 已自动关闭' : ' → 自行恢复'));
  return row;
}

/**
 * 空载 episode 的记账（纯函数）。
 * @param prev 进行中的 episode 或 null
 * @returns {{episode: object|null, closed: object|null}}
 */
function autoOffTrack(prev, s, cfg, now, lastCutAt) {
  const idle = s.v >= cfg.vMin && s.a <= cfg.iMax;
  if (!idle) {
    if (!prev) return { episode: null, closed: null };
    return {
      episode: null,
      closed: Object.assign({}, prev, {
        endAt: now, durMs: Math.max(0, now - prev.start),
        lastV: s.v, lastA: s.a, action: 'clear',
      }),
    };
  }
  if (prev) {
    return {
      episode: {
        start: prev.start,
        vMax: Math.max(prev.vMax, s.v),
        aMax: Math.max(prev.aMax, s.a),
        lastV: s.v, lastA: s.a,
      },
      closed: null,
    };
  }
  // 刚自动关过：端口电压要过一两帧才掉下去，别把这段残影再记成一次"自行恢复"
  if (lastCutAt && now - lastCutAt < 5000) return { episode: null, closed: null };
  return { episode: { start: now, vMax: s.v, aMax: s.a, lastV: s.v, lastA: s.a }, closed: null };
}

function autoOffTick(frame) {
  const cfg = normAutoOff(config.autoOff);
  const en = (frame.settings && frame.settings.ports_enabled) || {};
  const aSmall = !!(frame.settings && frame.settings.usb_a_always_on);
  const now = Date.now();
  for (const p of frame.ports || []) {
    if (!p || !p.id) continue;
    const sample = {
      v: Number(p.v) || 0, a: Number(p.a) || 0, enabled: en[p.id] !== false,
    };
    // 1) 记账：不管功能开没开，"有电压没电流"这件事都要留痕
    const tr = autoOffTrack(autoOffEpisodes.get(p.id) || null, sample, cfg,
      now, autoOffLastCut.get(p.id));
    if (tr.closed) appendAutoOffEvent(tr.closed);
    if (tr.episode) autoOffEpisodes.set(p.id, tr.episode);
    else autoOffEpisodes.delete(p.id);

    // 2) 动手：只有开着才关
    if (!cfg.enabled) continue;
    if (cfg.skipSmallA && p.id === 'a' && aSmall) continue;
    const prev = autoOffState.get(p.id) || { idleSince: null, disarmed: false };
    const r = autoOffStep(prev, sample, cfg, now);
    autoOffState.set(p.id, r.state);
    if (r.action !== 'cut') continue;

    autoOffLastCut.set(p.id, now);
    const ep = autoOffEpisodes.get(p.id);
    if (ep) {
      appendAutoOffEvent(Object.assign({}, ep, {
        endAt: now, durMs: Math.max(0, now - ep.start),
        lastV: sample.v, lastA: sample.a, action: 'cut',
      }));
      autoOffEpisodes.delete(p.id);
    }
    autoOffLast = {
      port: p.id, at: now, v: p.v, a: p.a,
      restoreAt: cfg.restoreMin ? now + cfg.restoreMin * 60000 : 0,
    };
    // 这条会真的断电，必须留**可追溯**的记录：addNotice 会写进 app.log，
    // 托盘也会弹一次气泡（人在远处时正是最需要知道的时候）。pushLog 只进内存 400 行。
    addNotice('autooff', `${String(p.id).toUpperCase()} 已自动关闭：空载`
      + `（${p.v} V / ${p.a} A 持续 ${cfg.idleSec} 秒）`
      + (cfg.restoreMin ? `，${cfg.restoreMin} 分钟后自动恢复` : '（不自动恢复）'));
    setPort(p.id, 'off').then((res) => {
      if (!res || !res.ok) {
        const err = (res && res.error) || '未知原因';
        pushLog('自动断电写入失败：' + err);
        log('autooff write failed:', err);
      }
    });
    autoOffRestore(p.id, cfg.restoreMin);
  }
}

function buildStatePayload() {
  const py = findPython();
  const todayKey = dayKey(Date.now());
  const tb = energy.days[todayKey];
  const cur = energy.current;
  return {
    ok: true,
    version: VERSION,
    now: Date.now(),
    link: state.link,
    bt: btAdapter,
    // 自动断电：参数 + 最近一次触发（界面用它在设置区显示状态，不必再开一条接口）
    autoOff: {
      cfg: normAutoOff(config.autoOff),
      last: autoOffLast,
      pending: Array.from(autoOffTimers.keys()),
    },
    collecting: state.collecting,
    device: { name: META.name, model: META.model, bleName: META.bleName, productId: META.productId },
    config: { address: effectiveAddress(), interval: config.interval, tray: config.tray !== false, trayMode: [ 'all', 'panel' ].includes(config.trayMode) ? config.trayMode : 'total', notify: config.notify !== false, autostart: autostartMode() },
    env: {
      python: py,
      pythonFound: !!py,
      tokenPresent: fs.existsSync(TOKEN),
      appDir: APP,
      platform: process.platform + ' ' + os.release(),
    },
    latest: state.latest,
    historyCount: state.history.length,
    writable: state.writable,
    switches: state.switches,
    sweep: state.sweep,
    energy: {
      todayWh: tb ? round3(tb.total) : 0,
      totalWh: round3(energy.totalWh),
      tracking: !!cur,
      current: cur ? {
        ms: cur.lastActiveAt - cur.start,
        wh: round3(cur.wh),
        peak: round3(cur.peak),
        ports: mapPorts(cur.ports),
      } : null,
    },
    login: { running: loginJob.running, kind: loginJob.kind, result: loginJob.result },
    envSensor: envPayload(),
    // 小米电风扇（独立的 Wi-Fi 链路）。它有自己的 link/latest，
    // 与充电头那条蓝牙链路完全解耦 —— 风扇掉线不该让功率面板跟着变灰。
    fan: fanPayload(),
    shell: { available: !!findElectron(), running: !!shellProc, probePort: shellProbePort },
    notices: notices.list.slice(-5),
    noticeSeq: notices.seq,
    yield: { active: !!yieldUntil, until: yieldUntil, leftMs: yieldUntil ? Math.max(0, yieldUntil - Date.now()) : 0 },
    // 页面心跳时间戳：界面每 10 秒 /api/beat 一次。用来回答
    // "界面是冻住了还是本来就没数据" —— 看它距今多少秒即可。
    pageBeatAt,
  };
}

let lastActivity = Date.now();

// ---------------------------------------------------------------- 实时推送 (SSE)
//
// 为什么要有这条通道：轮询最快也只能「每 1.5 秒一次」，而且中间隔着一次 HTTP
// 往返 —— 数字和曲线总是差一截。改成服务端在**采样落地的那一刻**把新点推给界面，
// 曲线就是跟手的。
//
// 用 SSE 而不是 WebSocket：这里只要单向（服务端→界面），SSE 是纯 HTTP、
// 浏览器内置自动重连、不需要任何依赖。Electron/Edge 一样支持。
const sseClients = new Set();

function sseWrite(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    return true;
  } catch (_) { return false; }
}

function sseBroadcast(event, data) {
  if (!sseClients.size) return;
  for (const res of Array.from(sseClients)) {
    if (!sseWrite(res, event, data)) sseClients.delete(res);
  }
}

/** 推一份完整状态。链路/让位这类「不是采样引起」的变化走它。 */
function sseState() {
  if (!sseClients.size) return;
  sseBroadcast('meta', { state: buildStatePayload() });
}

// 页面心跳：界面每 10 秒报一次到这儿。它的用处是回答一个今天问了三遍的问题
// ——"界面是冻住了还是数据本来就不动？"。看 state.pageBeatAt 距今多少秒就知道：
// 几秒内 = 页面活着；几十秒没动 = 页面脚本卡了/窗口关了。
let pageBeatAt = 0;

/** 新采样落地时推一个「增量」（只带最新一点），比整份状态小得多。 */
function sseSample() {
  if (!sseClients.size) return;
  sseBroadcast('sample', { latest: state.latest, link: state.link, at: Date.now() });
}

/** 挂上一个 SSE 客户端。 */
function sseAttach(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': hello\n\n');
  sseClients.add(res);
  // 连上就给一份全量，界面不用等下一次轮询。
  sseWrite(res, 'meta', { state: buildStatePayload() });
  const drop = () => sseClients.delete(res);
  req.on('close', drop);
  req.on('error', drop);
  res.on('error', drop);
}

// 心跳：中间任何一层（代理、防火墙、系统的 TCP 空闲回收）都可能悄悄掐掉
// 长时间没数据的连接。定期写一个 SSE 注释帧，连接就一直活着。
setInterval(() => {
  for (const res of Array.from(sseClients)) {
    try { res.write(': ping\n\n'); } catch (_) { sseClients.delete(res); }
  }
}, 20000);

const server = http.createServer((req, res) => {
  // 异常安全网：处理函数里任何未捕获错误都必须回 500。
  // 否则 async 函数的 reject 没人接，连接就吊着不结束 —— 前端 Promise.all
  // 会一直等，界面卡在「正在初始化」（2026-09-22 实际发生过）。
  handleReq(req, res).catch((err) => {
    try { pushLog('HTTP 处理异常: ' + (err && err.stack || err)); } catch (_) {}
    if (!res.headersSent) json(res, 500, { ok: false, error: String((err && err.message) || err) });
    else try { res.end(); } catch (_) {}
  });
});

async function handleReq(req, res) {
  lastActivity = Date.now();
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  if (p === '/api/ping') return json(res, 200, { ok: true, v: VERSION });
  if (p === '/api/state') return json(res, 200, buildStatePayload());
  // 唤出窗口：**GET/POST 都要认**。⚠️ 老版本把这条窝在下面的 POST 块里，GET /api/show 直接 404 ——
  // 谁用 GET 谁静默失败（"双击快捷方式唤出已有窗口"就靠它）。2026-10-08 提到顶层。
  if (p === '/api/show') {
    openWindow(`http://127.0.0.1:${server.address().port}/`);
    return json(res, 200, { ok: true, shell: findElectron() ? 'electron' : 'browser' });
  }
  if (p === '/api/stream') return sseAttach(req, res);
  if (p === '/api/beat') { pageBeatAt = Date.now(); return json(res, 200, { ok: true }); }
  if (p === '/api/env') return json(res, 200, envPayload());
  if (p === '/api/wallpaper') {
    // 只读探测：给透明窗口方案当"退路背景"用（见 wallpaper.js 的说明）。
    return json(res, 200, findWallpaper());
  }
  if (p === '/api/wallpaper/img') {
    const w = findWallpaper();
    if (!w.ok) { res.writeHead(404); return res.end('no wallpaper'); }
    return fs.readFile(w.file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('read fail'); }
      res.writeHead(200, { 'Content-Type': w.mime, 'Cache-Control': 'no-cache', 'Content-Length': buf.length });
      res.end(buf);
    });
  }

  if (p === '/api/history') {
    const rangeKey = u.searchParams.get('range');
    const secRaw = parseInt(u.searchParams.get('seconds') || '', 10);
    return json(res, 200, Object.assign({ ok: true }, queryHistoryCached(rangeKey, secRaw)));
  }

  // 温湿度曲线：和功率曲线共用同一套区间（?range=1h 等），前端一个控件切两条曲线。
  if (p === '/api/env/history') {
    const secRaw = parseInt(u.searchParams.get('seconds') || '', 10);
    const rangeKey = u.searchParams.get('range');
    // 'all' = 0，表示"不限窗口，把留着的都给我" —— queryEnvHistory(0) 会回落到 1h，
    // 所以这里显式转成"从最早一条到现在"的秒数（温度历史可能有半年）。
    let sec;
    if (rangeKey === 'all') {
      sec = Number.MAX_SAFE_INTEGER;
    } else if (Number.isFinite(secRaw) && secRaw > 0) {
      sec = secRaw;
    } else {
      sec = HISTORY_RANGES[rangeKey] || HISTORY_RANGES['1h'];
    }
    // ?daily=1 = 按天聚合（一天一个点：日均温/均湿 + 当日最高最低），
    // 长区间上用它看"哪几天热"，不必在几千个小时点里找规律。
    const daily = u.searchParams.get('daily') === '1';
    return json(res, 200, Object.assign({ ok: true, range: rangeKey || null },
      queryEnvHistory(sec, { daily })));
  }

  if (p === '/api/log') return json(res, 200, { ok: true, lines: state.logLines.slice(-200) });

  // 「异常检查」明细：每次"有电压没电流"一条（episode 结束时落盘）。
  // 单独一个接口是因为 /api/state 每秒都在推，把几十条事件塞进去纯属浪费。
  if (p === '/api/auto-off') {
    const limit = Math.min(AOOFF_KEEP,
      Math.max(1, parseInt(u.searchParams.get('limit') || '60', 10) || 60));
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const since = dayStart.getTime();
    const today = autoOffEvents.filter((e) => (e.endAt || e.at) >= since);
    return json(res, 200, {
      ok: true,
      events: autoOffEvents.slice(-limit).reverse(),   // 最新在前
      open: Array.from(autoOffEpisodes.entries()).map(([port, ep]) => ({
        port, start: ep.start, sec: Math.round((Date.now() - ep.start) / 1000),
        v: ep.lastV, a: ep.lastA,
      })),
      stats: {
        today: today.length,
        cutToday: today.filter((e) => e.action === 'cut').length,
        idleMsToday: today.reduce((n, e) => n + (Number(e.durMs) || 0), 0),
        total: autoOffEvents.length,
      },
      cfg: normAutoOff(config.autoOff),
      file: AUTO_OFF_LOG,
    });
  }

  // 网络/证书自检：弹层里的「网络自检」按钮，也在登录失败时被自动调用。
  if (p === '/api/diag/tls') {
    const force = u.searchParams.get('force') === '1';
    tlsProbe(force).then((payload) => json(res, 200, payload))
      .catch((e) => json(res, 200, { ok: false, error: e.message }));
    return;
  }

  if (p === '/api/energy') {
    const days = parseInt(u.searchParams.get('days') || '7', 10) || 7;
    return json(res, 200, energySnapshot(days));
  }

  if (p === '/api/export') {
    const what = u.searchParams.get('what') || 'days';
    const { filename, rows } = buildCsv(what);
    pushLog(`导出 CSV：${filename}（${rows.length - 1} 行）`);
    return sendCsv(res, filename, rows);
  }

  if (p === '/api/login/qr.png') {
    const f = path.join(DATA, 'qr.png');
    return fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('no qr'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }

  if (req.method === 'POST') {
    if (p === '/api/login/start') return json(res, 200, await loginStart());
    if (p === '/api/login/poll') return json(res, 200, loginPoll());
    // 清空「异常检查」记录（文件与内存一起清；只影响明细，不影响账本/曲线）
    if (p === '/api/auto-off/clear') {
      autoOffEvents = [];
      autoOffEpisodes.clear();
      try { fs.writeFileSync(AUTO_OFF_LOG, ''); } catch (_) {}
      pushLog('异常检查：记录已清空');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/reconnect') {
      pushLog('手动重连…');
      if (yielding()) endYield('手动取消');
      restartCollectorSoon();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/yield') {
      const body = await readBody(req);
      if (body && body.cancel) return json(res, 200, endYield('手动取消'));
      return json(res, 200, startYield(body && body.minutes));
    }
    if (p === '/api/shortcut') return json(res, 200, await createShortcut());
    if (p === '/api/autostart') {
      const body = await readBody(req);
      return json(res, 200, await setAutostart(body && body.mode));
    }
    if (p === '/api/control') {
      const body = await readBody(req);
      const r = await handleControl(body);
      return json(res, 200, r);
    }
    if (p === '/api/sweep') {
      const lo = parseInt(u.searchParams.get('lo') || '', 0);
      const hi = parseInt(u.searchParams.get('hi') || '', 0);
      return json(res, 200, await runSweep(lo, hi));
    }
    if (p === '/api/selftest') {
      // 只收小体积的纯文本报告，落盘供人/工具查看。回环地址，无鉴权需求，
      // 但也别让它变成"任意文件写"的入口 —— 固定路径、限长、只追加。
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 8192) { body = body.slice(0, 8192); req.destroy(); } });
      return req.on('end', () => {
        try {
          const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
          fs.appendFileSync(SELFTEST_LOG, `===== ${stamp}  v${VERSION} =====\n` + String(body).replace(/\s+$/, '') + '\n');
        } catch (e) { pushLog('自测报告写入失败：' + e.message); }
        return json(res, 200, { ok: true });
      });
    }

    if (p === '/api/config') {
      let body = '';
      req.on('data', (d) => { body += d; });
      return req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          const prevInterval = config.interval;
          const prevAddress = effectiveAddress();
          if (typeof j.interval === 'number' && j.interval >= 0.5 && j.interval <= 10) config.interval = j.interval;
          if (typeof j.address === 'string' && /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(j.address)) config.address = j.address.toUpperCase();
          if (typeof j.notify === 'boolean') config.notify = j.notify;
          if (typeof j.tray === 'boolean') {
            config.tray = j.tray;
            if (j.tray) startTray(); else stopTray();
          }
          let modeChanged = false;
          if ([ 'all', 'panel', 'total' ].includes(j.trayMode)) {
            modeChanged = config.trayMode !== j.trayMode;
            config.trayMode = j.trayMode;
            if (modeChanged) pushLog('任务栏显示模式：' + (j.trayMode === 'panel' ? '一行面板（四口+总）' : j.trayMode === 'all' ? '图标轮流显示' : '仅总功率'));
            // 托盘进程每秒都会从 /api/state 读回 trayMode，不用重启它
          }
          // 自动断电：允许部分字段（界面只改一个开关时不必回传全部）
          if (j.autoOff && typeof j.autoOff === 'object') {
            const next = normAutoOff(Object.assign({}, config.autoOff, j.autoOff));
            const onOff = next.enabled !== config.autoOff.enabled;
            config.autoOff = next;
            if (onOff) {
              const msg = '自动断电（5V 空载）：' + (next.enabled ? '已开启' : '已关闭'); pushLog(msg); log(msg);
              if (!next.enabled) {                 // 关掉时把状态清干净，别留半截计时
                autoOffState.clear();
                for (const t of autoOffTimers.values()) clearTimeout(t);
                autoOffTimers.clear();
              }
            } else {
              pushLog(`自动断电参数：≥${next.vMin}V 且 ≤${next.iMax}A 持续 ${next.idleSec}s`
                + `，关闭后 ${next.restoreMin ? next.restoreMin + ' 分钟恢复' : '不恢复'}`);
            }
          }
          saveConfig(config);
          pushLog('配置已保存：间隔 ' + config.interval + 's');
          // 只有采样间隔 / 地址**真的变了**才重启 BLE 采集器；纯托盘开关别折腾连接。
          // 之前这里只判断 “body 里带了 interval”，而网页「应用」按钮总是会带上它 ——
          // 于是只想改个托盘开关也会白白断线重连一次。
          const restartCollector =
            config.interval !== prevInterval || effectiveAddress() !== prevAddress;
          if (restartCollector) restartCollectorSoon();
          return json(res, 200, { ok: true, config });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      });
    }
    // /api/show 已提到上面顶层（GET/POST 都认）—— 老版本放在这里，导致 GET 404。
    if (p === '/api/env/config') {
      let body = '';
      req.on('data', (d) => { body += d; });
      return req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          const prev = JSON.stringify(envConfig);
          let restart = false;
          if (typeof j.address === 'string' && MAC_RE.test(j.address)) {
            if (envConfig.address !== j.address.toUpperCase()) restart = true;
            envConfig.address = j.address.toUpperCase();
          }
          if (typeof j.interval === 'number' && j.interval >= 30 && j.interval <= 600) {
            if (envConfig.interval !== j.interval) restart = true;
            envConfig.interval = Math.round(j.interval);
          }
          if (typeof j.enabled === 'boolean') {
            if (envConfig.enabled !== j.enabled) restart = true;
            envConfig.enabled = j.enabled;
          }
          saveEnvConfig(envConfig);
          // 只有真的改了地址/间隔/开关才重启温度计进程（老坑：切个托盘开关也断线）
          if (restart || JSON.stringify(envConfig) !== prev) {
            stopEnvSensor();
            state.env.restarts = 0;
            if (envConfig.enabled) setTimeout(() => startEnvSensor(), 600);
          }
          pushLog('温度计设置已保存：' + envConfig.address + ' / ' + envConfig.interval + 's'
            + (envConfig.enabled ? '' : ' / 已暂停'));
          return json(res, 200, { ok: true, env: envPayload() });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      });
    }
    if (p === '/api/env/probe') {
      // 单次广播探测：回答"这台温度计是不是刷过机、能不能免连接读"。
      const py = findPython();
      if (!py) return json(res, 200, { ok: false, error: '找不到 Python 运行环境' });
      const outFile = path.join(DATA, 'env-probe.txt');
      const args = [path.join(APP, 'env_sensor.py'), '--address', envConfig.address,
        '--probe', '--scan', '10', '--out', outFile];
      return spawn(py, args, { cwd: APP, windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) })
        .on('close', (code) => {
          let text = '';
          try { text = fs.readFileSync(outFile, 'utf8'); } catch (_) {}
          pushLog('温度计广播探测完成（code=' + code + '）');
          // 探测结果直接塞进 SSE，不用再轮询一次
          sseBroadcast('envprobe', { ok: code === 0, text });
        })
        .on('error', () => sseBroadcast('envprobe', { ok: false, text: '探测进程启动失败' }));
      // 立刻回一个"已开始"，结果走 SSE 推
    }
    if (p === '/api/env/history-read') {
      // 读温度计内置历史（152 小时，慢）。开始后进度/结果走 SSE 'envhist' 事件。
      const r = readDeviceHistory();
      return json(res, r.ok ? 200 : 409, r);
    }
    // ---- 小米电风扇（独立于充电头那条蓝牙链路）---------------------------
    if (p === '/api/fan/control') {
      let body = '';
      req.on('data', (d) => { body += d; });
      return req.on('end', async () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
        const name = String(j.name || '');
        const spec = FAN_PROPS[name];
        if (!spec) return json(res, 400, { ok: false, error: '未知风扇属性 ' + name });
        if (!state.fan.proc) return json(res, 200, { ok: false, name, error: '风扇采集器没在运行' });
        const ack = await fanCall({ cmd: 'set', name, siid: spec[0], piid: spec[1], value: j.value }, 18000);
        return json(res, 200, Object.assign({ ok: false }, ack, { name }));
      });
    }
    if (p === '/api/fan/refresh') {
      return json(res, 200, Object.assign({ ok: false }, await fanCall({ cmd: 'read' }, 8000)));
    }
    if (p === '/api/fan/config') {
      let body = '';
      req.on('data', (d) => { body += d; });
      return req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
        const before = fanInterval();
        if (typeof j.interval === 'number' && j.interval >= 0.5 && j.interval <= 30) config.fanInterval = j.interval;
        saveConfig(config);
        // ⚠️ 只有真的变了才重启 —— 网页提交整个配置体，切个别的东西不该白断一次线
        const changed = before !== fanInterval();
        if (changed) {
          pushLog(`风扇设置已保存：间隔 ${fanInterval()}s`);
          writeFanConfig();
          restartFanCollectorSoon();
        }
        return json(res, 200, { ok: true, interval: fanInterval() });
      });
    }
    if (p === '/api/fan/probe') {
      // 一次性的连接自检：连一次、把属性读出来就退出（不进常态轮询）。
      if (!readFanToken()) return json(res, 400, { ok: false, error: '还没登录小米云，没有风扇配置（IP + token）' });
      writeFanConfig();
      const r = await runPy('fan_collector.py', ['--config', FAN_CFG, '--probe'], 45000);
      const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      let st = null;
      const link = [];
      for (const l of lines) {
        try {
          const o = JSON.parse(l);
          if (o.t === 'state') st = o;
          if (o.t === 'link' || o.t === 'error') link.push(o);
        } catch (_) {}
      }
      pushLog(st ? '风扇连接自检成功' : '风扇连接自检失败');
      return json(res, 200, { ok: !!st, state: st, link, stderr: String(r.stderr || '').slice(-600) });
    }
    if (p === '/api/fan/discover') {
      const r = await fanLanDiscover();
      return json(res, 200, r);
    }
    if (p === '/api/quit') {
      json(res, 200, { ok: true });
      pushLog('收到退出请求');
      setTimeout(shutdown, 200);
      return;
    }
  }

  if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
  if (p === '/favicon.ico') {
    const ico = path.join(APP, 'app.ico');
    return fs.readFile(ico, (err, buf) => {
      if (err) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      res.end(buf);
    });
  }
  return serveStatic(res, p);
}

// ------------------------------------------------------------------ 生命周期

// 探活：返回该端口上那个实例的应答对象（拿不到就 null）。
// ⚠️ 超时别太短：老实例的事件循环被同步大活（重建分钟曲线、按天聚合、CSV 导出）卡住时，
//    1.2 秒会误判成"没人在跑"→ 于是又起一个 → 撞端口 → 顺延到保留端口 → EACCES → 整条链死。
function probe(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: timeoutMs || 2500 }, (r) => {
      let s = ''; r.on('data', (d) => s += d);
      r.on('end', () => { try { const j = JSON.parse(s); resolve(j && j.ok ? j : null); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
  });
}

/** 进程还活着吗？（接管判断的**辅助**判据 —— 单靠它会踩 PID 回收，见 aliveFresh） */
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }   // 权限不足也是一种"存在"
}

// ------------------------------------------------------------------ 心跳
//
// ⚠️ 为什么不能只用 pidAlive（2026-10-09 用户报「我电脑上的打不开了」，根因就在这）：
//   服务 10:18 启动（pid 17372），下午不明原因退出。Windows 把 **pid 17372 回收**给了
//   另一个进程（实测是 msedgewebview2.exe）。于是每次双击快捷方式：
//     · HTTP 探活失败（日志里那句"检测到已有实例…"连版本号都没有，就是探活没答应的证据）；
//     · 但 process.kill(17372, 0) 成功 ⇒ 判成"还在跑"⇒ 接管、开一个指向**死端口**的壳、
//       本进程退出 —— 用户看到的就是"双击没反应/打不开"。
//   ⇒ pid 只能当**辅助**：必须在探活失败时再看心跳，才能确认那个 pid 真是我们的服务。
let aliveTimer = null;
function writeAliveFile() {
  try {
    const tmp = ALIVE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, hb: Date.now() }));
    fs.renameSync(tmp, ALIVE);      // 先写临时再改名：读端不会读到写了一半的 JSON
  } catch (_) {}
}
function startAlive() {
  writeAliveFile();
  if (aliveTimer) clearInterval(aliveTimer);
  aliveTimer = setInterval(writeAliveFile, ALIVE_EVERY_MS);
  // 别让心跳定时器拖着进程不让退出（unref 之后它不影响事件循环的存活判断）
  if (aliveTimer.unref) aliveTimer.unref();
}
function stopAlive() {
  if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
  try { fs.unlinkSync(ALIVE); } catch (_) {}
  try { fs.unlinkSync(ALIVE + '.tmp'); } catch (_) {}
}
/**
 * 心跳文件还新鲜吗？且是不是**这个 pid** 写的？
 * 心跳停 = 那个进程已经不在了（哪怕它的 pid 现在被别的进程占着）。
 */
function aliveFresh(wantPid) {
  try {
    const j = JSON.parse(fs.readFileSync(ALIVE, 'utf8'));
    if (wantPid && j.pid !== wantPid) return false;
    return Number.isFinite(j.hb) && (Date.now() - j.hb) <= ALIVE_FRESH_MS;
  } catch (_) { return false; }
}

/** 向已有实例发一个不关心返回体的 POST。⚠️ 必须用 POST：老版本把 /api/show 放在 POST 分支里。 */
function postQuiet(port, apiPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: apiPath, method: 'POST',
      headers: { 'Content-Length': 0 }, timeout: timeoutMs || 6000,
    }, (r) => { r.resume(); r.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
    req.end();
  });
}

/**
 * 「磁盘上的 lock 指向的那个实例，现在是不是真的在跑？」—— 纯判定，不带副作用（可离线测）。
 *
 * 判据（v1.8.22 起）：
 *   ① **HTTP 探活有应答** —— 铁证，直接认（还能顺便拿到对方版本号）。
 *   ② 探活没应答时，才轮到 pid —— 但**必须再加一道心跳**：
 *        pid 活着 ≠ 我们的服务活着。Windows 会回收 pid（本机踩过：服务退出后 pid 落到了
 *        msedgewebview2.exe 头上），只凭 pidAlive 会把每一次启动都判成"已在运行"，
 *        于是只弹一个指向死端口的空壳 —— 用户看到的就是「打不开」。
 *        真在跑的服务每 5 秒刷一次 alive.json，心跳新鲜才说明"这个 pid 是我们的、只是忙"。
 * 为什么还留着 pid 这条路：老实例的事件循环被同步大活（重建分钟曲线 / 按天聚合 / CSV 导出）
 *   卡住时，HTTP 会超时 —— 那属于"活着但不答话"，绝不能因此另起一个（两个进程抢 BLE）。
 *
 * @returns {Promise<{port:number,pid:number,version:string,outdated:boolean,why:string}|null>}
 */
async function resolveRunningInstance(lk) {
  if (!lk || !lk.port) return null;
  if (lk.at && Date.now() - lk.at > 3 * 86400000) return null;   // 陈年 lock，不认
  const st = await probe(lk.port);
  if (st) {
    const version = st.v ? String(st.v) : '';
    return { port: lk.port, pid: lk.pid, version, outdated: !!version && version !== String(VERSION),
             why: 'probe' };
  }
  if (!pidAlive(lk.pid)) return null;        // 进程真没了（最常见：服务被关掉/崩了）
  if (!aliveFresh(lk.pid)) return null;      // pid 被回收 / 服务早就退出 → 残留 lock，别再认
  return { port: lk.port, pid: lk.pid, version: '', outdated: false, why: 'heartbeat' };
}

/**
 * 启动前的「单实例接管」：如果我这份软件**已经在跑**，就别再起一个 ——
 * 把它的窗口唤到前台、把 ready.json 写回去（bat 正等着它），然后本进程退出。
 *
 * 为什么需要它（2026-10-08 用户报「桌面快捷方式打不开」）：
 *   用户双击桌面快捷方式时，多半是**窗口被关了**（只剩托盘/后台在跑），而不是真没启动。
 *   老代码一律去 listen → 撞上已在用的 8799 → 顺延到系统保留端口 8800 → EACCES → 退出，
 *   而 bat 还在等 ready.json，15 秒后弹「未能在 15 秒内启动」。
 *   原来的接管判据只有 `/api/ping`，老实例一忙就超时判 false —— 所以这次加了 pid 存活判据。
 *
 * @returns {Promise<boolean>} true = 已接管，调用方应立即 return（不要再往下 listen）
 */
async function attachToRunning() {
  let lk = null;
  try { lk = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (_) { return false; }
  const hit = await resolveRunningInstance(lk);
  if (!hit) {
    // 残留 lock 的两种情况留一条日志 —— 下次再出"打不开"，看日志就能分辨是
    // "服务真没了" 还是 "pid 被回收骗了我们"（v1.8.22 之前这里什么都不写，
    // 出问题时只能看到"每次双击都说已在运行"，根本查不下去）。
    if (lk && lk.port && pidAlive(lk.pid)) {
      log(`残留的 running.lock 指向 pid ${lk.pid}，但探活与心跳都不通（进程已退出或 pid 被回收）→ 按新实例启动`);
    }
    return false;
  }

  const url = `http://127.0.0.1:${hit.port}/`;
  log(`检测到已有实例：端口 ${hit.port}、pid ${hit.pid}${hit.version ? '、版本 ' + hit.version : ''}`
    + `（依据：${hit.why === 'probe' ? '探活应答' : '心跳，对方正忙'}）→ 唤出它的窗口，本进程退出`);

  // ① 让老实例自己开窗（窗口归它管，壳的状态才对）
  const shown = await postQuiet(hit.port, '/api/show');
  // ② 它没答（忙 / 老版本没有该路由）就替它开一个指向同一页面的窗口
  if (!shown || !hit.version) {
    try { openWindow(url, hit.port); } catch (e) { log('替已有实例开窗失败：' + (e && e.message)); }
  }
  // ③ bat 还在等 ready.json —— 必须写回去，否则它 15 秒后报「启动失败」。
  //    `reused` / `upgrade` 是给 bat 用 findstr 认的纯 ASCII 标记（中文在 bat 里会乱码）：
  //    没有 upgrade 这个键就代表版本一致，所以 findstr 搜 "upgrade" 不会误判。
  try {
    const ready = { port: hit.port, pid: hit.pid, url, reused: true };
    if (hit.outdated) { ready.upgrade = hit.version || true; ready.version = hit.version || undefined; }
    fs.writeFileSync(READY, JSON.stringify(ready));
  } catch (_) {}
  console.log('酷态科10号Ultra 已经在运行，已把它的窗口唤到前面：' + url);
  if (hit.outdated) {
    log(`提示：正在跑的仍是旧版 ${hit.version}（本程序 ${VERSION}）。要升级请先右键任务栏图标选「退出」，再双击启动。`);
  }
  return true;
}

// ------------------------------------------------------------------ 任务栏功率图标
let trayProc = null;
let trayTries = 0;
let stopping = false;

// ------------------------------------------------------------------ Electron 透明外壳
//
// 「真透明窗口」（能看见窗口后面的其它程序）只有一个技术前提：窗口本身要由
// 支持 transparent 的宿主来开。浏览器（含 Edge --app）做不到 —— 它的窗口背景
// 永远不透明，CSS 的 backdrop-filter 也只作用于窗口内的像素。
// 所以这里优先用 Electron；**没装 Electron 时自动回退到原来的 Edge --app 窗口**，
// 功能完全一致，只是少了"透"这一层 —— 便携包发给别人时不至于打不开。
let shellProc = null;
// 外壳的自检探针口（/probe、/shot）。外壳绑成哪个口只有它自己知道（本机上
// 8800 被系统进程占了，所以它是从 PORT+11 往上找），这里记一份供 /api/state 报出去，
// 自检脚本就能从状态里直接拿到，不必猜端口。
let shellProbePort = 0;

/** 找到项目内自带的 Electron（开发时装在 node_modules）。 */
/**
 * 找出 Electron 外壳的可执行文件。
 *
 * ⚠️⚠️ 2026-10-12 修（用户报「**打包的不是透明的**」）：这里原来**只认一个路径**
 *   `<APP>/node_modules/electron/dist/electron.exe` —— 而便携包里的 Electron 是
 *   `package.ps1 -WithElectron` 放在 **`<APP>/electron/`** 的（包里根本没有
 *   node_modules，那是 verify_package.js 的隐私红线）。两处对不上，后果是：
 *     就算用 -WithElectron 打了包，`findElectron()` 也 **永远返回 null** →
 *     一律回退 Edge --app 窗口 → **没有透明玻璃**，那 87MB 白带了。
 *   （更早的版本连 -WithElectron 都没开，所以"打包版不透明"一直存在，只是没人报。）
 * 现在按**同一个顺序**多路查找，任何一处能命中就行。
 */
function findElectron() {
  const cands = [
    path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe'),  // 开发目录 / npm install
    path.join(APP, 'electron', 'electron.exe'),                          // 便携包（package.ps1 -WithElectron）
    path.join(APP, 'runtime', 'electron', 'electron.exe'),               // 备用位置
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

/**
 * 找出外壳真正绑上的探针口。
 *
 * 外壳从 basePort 开始往上试绑（本机 8800 被系统占用），所以这里也往上探几个，
 * 第一个能应答 /probe 的就是它。纯本机回环请求，代价可以忽略；只试 20 次就放弃。
 */
function pollShellProbe(basePort) {
  let port = basePort;
  let tries = 0;
  const tick = () => {
    if (++tries > 24 || !shellProc) { shellProbePort = port; return; }
    const req = http.request({ host: '127.0.0.1', port, path: '/probe', method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j && j.ok) { shellProbePort = port; return; }   // 找到
        } catch (_) {}
        port += 1; setTimeout(tick, 300);
      });
    });
    req.on('error', () => { port += 1; setTimeout(tick, 300); });
    req.setTimeout(1200, () => { try { req.destroy(); } catch (_) {} port += 1; setTimeout(tick, 300); });
  };
  setTimeout(tick, 1500);        // 给外壳一点启动时间
}

/**
 * 打开窗口。有 Electron 就用透明外壳，没有就退回 Edge --app。
 * @param {string} url
 */
function openWindow(url, targetPort) {
  const exe = findElectron();
  if (!exe) {
    log('未发现 Electron，回退到浏览器窗口');
    return launchWindow(url);
  }
  if (shellProc && !shellProc.killed) {
    log('Electron 外壳已在运行，忽略重复打开');
    return { shell: 'electron', already: true };
  }
  // targetPort：接管"已有实例"时本进程**还没 listen**，server.address() 会是 null，
  // 必须由调用方把目标端口显式传进来，否则下面 String(server.address().port) 直接 TypeError。
  const port = targetPort || (server.address() && server.address().port) || 0;
  const args = [path.join(APP, 'shell', 'main.js'), '--port', String(port),
    '--probeport', String(port + 11)];
  log('spawn electron shell', exe, args.join(' '));
  // ⚠️ 必须显式清掉 ELECTRON_RUN_AS_NODE！
  //
  // 这个环境变量只要存在（本机是从上游会话环境里继承来的），Electron 就会
  // **把自己当成普通 Node 跑**：主进程代码照跑、窗口也照"创建"，但渲染器根本
  // 不会起来 —— 表现为页面在 Electron 里加载了，可 web/shell.js 里
  // "我在壳里"的判断为假（additionalArguments 没生效、圆角玻璃板/标题栏/拖动
  // 全都不工作），外观上就是"窗口是方的、还有一圈白边"。
  // 之前一直没发现，是因为窗口确实开出来了，看起来"壳在跑"。
  const shellEnv = Object.assign({}, process.env);
  delete shellEnv.ELECTRON_RUN_AS_NODE;
  try {
    shellProc = spawn(exe, args, {
      cwd: APP, windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'], env: shellEnv,
    });
  } catch (e) {
    log('Electron 启动失败，回退浏览器窗口：' + e.message);
    return launchWindow(url);
  }
  shellProbePort = port + 11;
  // 外壳可能因为端口占用往上挪，实际绑到哪个口它会在日志里说；也从这里兜一下：
  // 直接试探几个候选，把真正能应答的记录到 state 里。
  pollShellProbe(port + 11);
  shellProc.stderr.setEncoding('utf8');
  shellProc.stderr.on('data', (d) => {
    const l = String(d).trim();
    if (l) pushLog('外壳：' + l);
  });
  shellProc.on('error', (e) => {
    pushLog('Electron 外壳错误：' + e.message);
    shellProc = null;
    launchWindow(url);          // 起不来就退到浏览器，别让用户对着空屏
  });
  shellProc.on('close', (code) => {
    shellProc = null;
    if (!stopping) pushLog('Electron 外壳退出，code=' + code);
  });
  return { shell: 'electron' };
}

/** 在任务栏通知区放一个功率图标（powershell + WinForms，零第三方依赖）。 */
function startTray() {
  if (config.tray === false || process.env.CUKTECH_NO_TRAY === '1') return;
  if (trayProc || trayTries >= 4 || stopping) return;
  const port = server.address() && server.address().port;
  if (!port) return;
  try {
    trayProc = spawn('powershell.exe', [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', path.join(APP, 'tray.ps1'), '-Port', String(port),
      '-Mode', ([ 'all', 'panel' ].includes(config.trayMode) ? config.trayMode : 'total'),
    ], { cwd: APP, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    trayProc.stderr.setEncoding('utf8');
    trayProc.stderr.on('data', (d) => {
      const l = String(d).trim();
      if (l) pushLog('任务栏图标：' + l);
    });
    trayProc.on('exit', () => {
      trayProc = null;
      // 不是我们主动关的（也不是正在退出）就拉起来，但最多重试 4 次
      if (!stopping && config.tray !== false && process.env.CUKTECH_NO_TRAY !== '1') {
        trayTries++;
        pushLog('任务栏图标退出了，3 秒后重启（第 ' + trayTries + ' 次）');
        setTimeout(startTray, 3000);
      }
    });
    log('tray icon started on port', port);
  } catch (e) { log('tray icon failed: ' + e.message); }
}

function stopTray() {
  const p = trayProc;
  trayProc = null;
  try { if (p) p.kill(); } catch (_) {}
}

function shutdown() {
  stopping = true;
  stopTray();
  stopCollector();
  stopEnvSensor();
  try { stopFanCollector(); } catch (_) {}
  if (shellProc) { try { shellProc.kill(); } catch (_) {} shellProc = null; }
  if (yieldTimer) clearTimeout(yieldTimer);
  try { flushMinute(); } catch (_) {}     // 最后那一分钟别丢
  try { saveEnergy(); } catch (_) {}
  try { if (loginJob.proc) loginJob.proc.kill(); } catch (_) {}
  // ⚠️ 读设备历史那个子进程必须显式杀掉：它是"读几分钟"的长任务，不是常驻采集器
  //    （stopEnvSensor 管不到它）。不杀的话退出后会留一个孤儿 python 独占温湿度计的
  //    蓝牙链路，下次点"读取设备历史"会一直连不上（单连接设备）。
  if (envHistProc) {
    try { envHistProc.kill(); log('退出：中止正在进行的设备历史读取'); } catch (_) {}
    envHistProc = null; envHistBusy = false;
  }
  try { fs.unlinkSync(LOCK); } catch (_) {}
  try { fs.unlinkSync(READY); } catch (_) {}
  stopAlive();          // 心跳必须跟着删 —— 留着会让下次启动误判"还有实例在跑"
  process.exit(0);
}

(async function main() {
  // ★ 第一件事：把自己的控制台窗口藏起来（见 hideOwnConsole 的完整说明）。
  //   放在最前面，是因为下面 loadEnergy / pruneHistDays 这些同步大活会跑上一会儿，
  //   先藏掉才不会让那个黑窗口在屏幕上多待几百毫秒。
  const hid = hideOwnConsole();
  if (hid.ok) {
    log('已隐藏服务自身的控制台窗口（看不到、也关不掉 —— 免得被误关而连带杀掉服务）'
      + (hid.stillVisible ? ' ⚠️ 但回读显示仍然可见' : ' 回读确认已不可见'));
  } else if (hid.why !== 'no-console' && hid.why !== 'not-windows' && hid.why !== 'no-koffi') {
    log('控制台窗口隐藏失败：' + hid.why);
  }

  loadEnergy();
  loadAutoOffEvents();                     // 异常检查的历史（最近 500 条）
  // 蓝牙适配器型号：只读、只跑一次、失败就算了。放在这里是"不阻塞启动" ——
  // 它是给"连不上"的报错页当配料用的，晚几秒出来完全没关系。
  probeBtAdapter();
  const filled = backfillEnergy();
  const minFilled = rebuildMin();
  pruneHistMin();
  pruneHistDays();
  const seeded = seedHistory();            // 重启后 1 小时内的曲线不留白
  healEnvSpans();                          // 老数据补 sp（设备小时记录画成"该小时一段"）
  const envSeeded = seedEnvHistory();      // 温度曲线同理（从分钟文件回填最近 1 小时）
  scanEnvHistRange();                      // 标出温度历史覆盖的区间（决定是否放出 90天/全部 档）
  log(`能量账本已载入：累计 ${round3(energy.totalWh)} Wh，回填 ${filled} 个采样，`
    + `history-min 补/修 ${minFilled} 分钟，曲线预热 ${seeded} 点，温度预热 ${envSeeded} 点`);

  // 已经在跑就把它的窗口唤出来，别再起第二个服务（判据与理由见 attachToRunning）。
  if (await attachToRunning()) {
    setTimeout(() => process.exit(0), 1500);    // 留一点时间让刚 spawn 的外壳接稳
    return;
  }

  // 固定端口：网页才能存书签（之前 server.listen(0) 每次都是随机端口）。
  // 首选被占用就顺延，五个都占满再退回系统随机端口。
  const candidates = PREFERRED_PORTS.concat([0]);
  let idx = 0;
  const boot = () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/`;
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ port, pid: process.pid, at: Date.now() }));
      fs.writeFileSync(READY, JSON.stringify({ port, pid: process.pid, url }));
    } catch (_) {}
    startAlive();        // 心跳：证明"lock 里这个 pid 是我们的服务"，见 resolveRunningInstance
    log('listening', url, 'python=' + findPython());
    console.log('酷态科10号Ultra 服务已启动：' + url);

    if (!BOOT_NO_WINDOW && process.env.CUKTECH_NO_WINDOW !== '1') openWindow(url);
    startTray();
    startCollector();
    startEnvSensor();
    // 风扇走完全独立的 Wi-Fi 链路：没登录过就停在 need-login（界面上给「登录小米云」），
    // 不影响充电头与温度计。立刻起，别用 setTimeout 拖后 —— 那段时间里状态会停在
    // "尚未启动"，界面上看着像没接好。
    startFanCollector();

    setInterval(() => {
      if (Date.now() - lastActivity > IDLE_EXIT_MS) {
        log('空闲超时，自动退出');
        shutdown();
      }
    }, 15000);
  };
  const tryListen = () => {
    const want = candidates[Math.min(idx, candidates.length - 1)];
    const onOk = () => { server.removeListener('error', onErr); boot(); };
    const onErr = (err) => {
      server.removeListener('listening', onOk);
      // EACCES = 绑到了系统保留端口（netsh excludedportrange 那些）。这不是致命错误，
      // 和"端口被占"一样顺延就对了 —— 2026-10-08 就是它把整条启动链判死的。
      if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES') && idx < candidates.length - 1) {
        log(`端口 ${want} 被占用或保留（${err.code}），顺延到下一个`);
        idx++;
        setTimeout(tryListen, 50);
        return;
      }
      log('listen 失败：' + (err && err.message));
      process.exit(1);
    };
    server.once('listening', onOk);
    server.once('error', onErr);
    server.listen(want, '127.0.0.1');
  };
  tryListen();
})();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => { log('uncaught: ' + e.stack); });
