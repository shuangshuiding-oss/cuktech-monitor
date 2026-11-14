/* 酷态科10号Ultra 界面脚本 —— 从 index.html 里拆出来的。
   原先 1162 行单文件，改一处要在 HTML 里滚很久；现在分开放，
   仍然是普通 <script src>，没有引入任何构建步骤。 */

'use strict';
const $ = (s) => document.querySelector(s);
const PORT_COLOR = { c1:'var(--c1)', c2:'var(--c2)', c3:'var(--c3)', a:'var(--a)' };
const PORT_HEX   = { c1:'#818cf8', c2:'#c084fc', c3:'#34d399', a:'#fbbf24' };
const TOTAL_HEX  = '#38bdf8';
const PROTO_CN = { idle:'空闲', pd:'PD', pd_fixed:'PD 固定档', pd_pps:'PD PPS', usb_a:'USB-A', usb_a_qc:'USB-A QC' };
const KIND_CN  = { pd_fixed:'固定档', pd_pps:'PPS' };

// 曲线区间：后端 ≤1h 用内存里的原始点，更长的读每分钟降采样（data/history-min.jsonl）。
// 1/5/10 分钟是短窗，用来看"刚才那一下"的细节；30 分钟用来对"这一路充电大概啥节奏"，
// 后端会把原始点压到 400 个（≈4.5s 一个），既能看出档位切换又不至于糊成一条直线。
// 2/3/4 小时（v1.6.5 加）落在分钟文件的自然分辨率上（120/180/240 点，不抽稀）。
const RANGES = [['1m', '1 分钟'], ['5m', '5 分钟'], ['10m', '10 分钟'], ['30m', '30 分钟'],
  ['1h', '1 小时'], ['2h', '2 小时'], ['3h', '3 小时'], ['4h', '4 小时'],
  ['6h', '6 小时'], ['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天'],
  // 后四档只有读过温度计设备内置历史才有意义（设备里存着半年，功率曲线没有这么长）。
  // 平时由 renderEnvRanges() 按 envHistLoaded 隐藏起来。90 天 / 半年 / 1 年 是"固定跨度"，
  // 「全部」看最长的存量；1 年是为了攒够一年之后一条轴看完。
  ['90d', '90 天'], ['180d', '半年'], ['1y', '1 年'], ['all', '全部']];
let RANGE = '1h';
let WINDOW_SEC = 3600;           // 由后端返回的 seconds 同步，图表按它画时间轴
let hidden = {};                 // 图例开关
let last = null;                 // /api/state 的负载
let lastEnergy = null;           // /api/energy 的负载（端口卡里那行“本次充电”要用）
let rows = [];                   // 历史
let envRows = [];                // 温湿度历史（和 rows 同一套区间）
let envHistoryAt = 0;            // 读回设备内置历史的时刻（0 = 从没读过）
let envHistLoaded = false;       // 是否读过设备内置历史（决定要不要放出 90天/全部 两档）
let envHistDays = 0;             // 设备历史覆盖多少天（提示文案用）
// 按天视图：把温湿度曲线换成"一天一个点"（日均 + 当日最高最低），并配一张按天明细表。
// 长区间上每小时一个点太密，按天压完才能一眼看出"哪几天热"。
let envDaily = false;
let envDailyPullAt = 0;          // 上次拉按天数据的时刻（SSE 重拉时节流）
let envDailyDay = '';            // 上次渲染时"今天"是哪天，跨零点要自动重拉
// 「按天」的窗口下限与明细表长度：常量放这里而不是放在函数旁边 ——
// pullEnvHistory() 可能在初始化早期就被调到，那时下面的 const 还在 TDZ 里。
const SHORT_RANGES = new Set(['1m', '5m', '10m', '30m', '1h', '2h', '3h', '4h', '6h', '24h']);
const MAX_DAILY_ROWS = 31;       // 明细表最多列多少天（更长就只列最近这些天）
// 只有设备内置历史（约半年）填得满的长窗：没读过历史时它们在按钮行里隐藏，点了也是空的。
// 以后再加长窗只要往这里补一个键（免得又去改 renderEnvRanges 里的那串 && 条件）。
const LONG_RANGES = new Set(['90d', '180d', '1y', 'all']);
try { envDaily = localStorage.getItem('cuk_env_daily') === '1'; } catch (_) {}
let envHidden = {};              // 温湿度图例开关（温度/湿度各自可关）
let envCache = { t0: 0, wsec: 3600 };  // 温湿度曲线的映射缓存（hover 提示要用同一套）
// ---- 小米电风扇（Wi-Fi / miIO）-------------------------------------------------
// 和上面那几条链路完全独立：风扇走家里局域网的 UDP，不碰蓝牙，
// 所以它连不上只是这张卡灰掉，充电头与温湿度计一点都不受影响。
// ⚠️ 这台风扇**没有任何电参量属性**（规格表逐项核过：没有功率传感器、没有电量统计），
//    所以界面上不做功率、不做用电量、也不画曲线 —— 它只做「状态回读 + 反向控制」。
//    （2026-10-11 用户要求：推算出来的瓦数/度数看着像实测，索性删干净。）
let fanFolded = false;                   // 整张卡的收起状态（记在 localStorage）
try { fanFolded = localStorage.getItem('cuk_fan_folded') === '1'; } catch (_) {}
// 一次写入还没回来时禁止再发：风扇的 miIO 一次只处理一条命令，
// 连点只会让后面的命令排队然后超时，看起来就像"点了没反应"。
let fanBusy = false;
let peak = 0;
let sseLive = false;             // 实时推送通道是否在线
let smoothOn = true;             // 功率曲线是否平滑显示（不影响数字与存档）
// 温湿度曲线的平滑开关（2026-10-08 用户要求"加一个曲线平滑开关"）—— 与功率曲线那个独立，
// 默认**开**（设备是每小时一条、台阶感强）；只影响画线，悬停/明细/CSV 都是原始值。
let envSmooth = true;
try { envSmooth = localStorage.getItem('cuk_env_smooth') !== '0'; } catch (_) {}
try { smoothOn = localStorage.getItem('cuk_smooth') !== '0'; } catch (_) {}
const wrap = { sp: null, w: 0, h: 0 };
// 图表尺寸/字号的缓存：时间轴每帧都在滑，getComputedStyle 不能每帧都调（会强制样式重算）。
const chartCache = { w: 0, h: 0, fs: 0 };
let chartT0 = 0;                 // 当前时间轴左端（悬停提示要跟图表用同一套映射）

const fmtW = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1));

// 电量单位换算。国内电费说的「度」是千瓦时（kWh）：1 度 = 1000 Wh。
// 「毫安」是充电宝口径：mAh = Wh ÷ 电芯电压 × 1000，按锂电芯标称 3.7 V 折算，
// 于是 1 Wh ≈ 270 mAh、10000 mAh = 37 Wh —— 理想值，没算升压/降压与发热损耗。
const CELL_V = 3.7;
// 小数位随量级收放：不足 1 留 3 位（小变化也看得见），不足 100 留 2 位，再大留 1 位，
// 免得出现 "1234.567 度" 这种全是噪声的数字。（单行声明，tools/test_kwh.js 会抠出来单测）
const scaleFix = (v) => v.toFixed(Math.abs(v) < 1 ? 3 : Math.abs(v) < 100 ? 2 : 1);
const fmtKwh = (wh) => scaleFix((wh || 0) / 1000);
// mAh 的量级大得多（一次充电动辄五位数），所以小数位再收一档，并加千分位分隔，
// 不然 "40319" 这种数字一眼读不出量级。
const mahFix = (v) => v.toFixed(Math.abs(v) < 10 ? 2 : Math.abs(v) < 1000 ? 1 : 0);
const grp = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtMah = (wh) => grp(mahFix(((wh || 0) / CELL_V) * 1000));
// 时长（端口卡「本次充电」那行旁边要显示"本次充了多久"）：≥1h 给「H 小时 M 分」，
// ≥1min 给「M 分」，不足 1 分钟给「S 秒」——秒级只在刚插上那会儿出现，卡片放不下更长的串。
// （单行声明，tools/test_plug.js 会把它抠出来单测）
const fmtDur = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60); return h >= 1 ? h + ' 小时 ' + (m % 60) + ' 分' : m >= 1 ? m + ' 分' : s + ' 秒'; };

// ---------------------------------------------------------------- 历史点的合并
//
// 两条来源会往同一个数组里写：SSE 增量推送 和 定时/切区间的整份拉取。
// 若不合并，重合或乱序的点会让曲线**往回缩一格再弹回来**（看上去就是"曲线在前后跳"）。
// 规则：同一时刻只留一个点（后到的覆盖），更早的点直接丢。
function mergeRow(row) {
  const n = rows.length;
  if (n && row.at <= rows[n - 1].at) {
    if (row.at === rows[n - 1].at) rows[n - 1] = row;
    return false;
  }
  rows.push(row);
  return true;
}

/** 整份替换（拉取后）：按时刻去重并保序。 */
function setRows(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (seen.has(r.at)) { out[out.length - 1] = r; continue; }
    seen.add(r.at);
    out.push(r);
  }
  return out;
}

// ------------------------------------------------------------------ 轮询
async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

async function tick() {
  try {
    // 三条一起拉：状态、功率曲线、温湿度曲线。温湿度那条「可失败」——
    // 它挂掉只会让那张卡灰着，不该把整页的轮询拖垮。
    const [st, hi, eh] = await Promise.all([
      api('/api/state'),
      api('/api/history?range=' + RANGE),
      api('/api/env/history?range=' + RANGE).catch(() => null),
    ]);
    last = st;
    rows = setRows((hi && hi.rows) || []);
    if (hi && hi.seconds) WINDOW_SEC = hi.seconds;
    if (eh) envRows = eh.rows || [];
    render();
  } catch (e) {
    setLink('error', '与本地服务失联：' + e.message);
  }
}

/** 只刷状态（轻量）。SSE 在线时每 10 秒校正一次，防止"连接看着还在、其实不推了"。 */
async function pullState() {
  beat();
  try { last = await api('/api/state'); render(); }
  catch (e) { setLink('error', '与本地服务失联：' + e.message); }
}

/** 页面心跳：让服务端知道"界面还活着"。排查"界面是不是冻住了"时看 /api/state.pageBeatAt。 */
function beat() {
  try { fetch('/api/beat', { method: 'POST' }).catch(() => {}); } catch (_) {}
}

/** 只刷曲线数据。区间切换后、以及 SSE 在线时的低频校正走它。 */
// 'all' 是个前端专用档位：不传 seconds（后端就会返回它保留的全部点）。
// 服务端 history 接口对未知 range 一律回落到默认窗口，所以这里显式传 seconds=0。
function rangeQuery(k) {
  return k === 'all' ? 'seconds=0' : 'range=' + k;
}

/** 切区间时两条曲线的窗口长度可能不一样（温度历史比功率长得多）——记下来给时间轴用。 */
let envWindowSec = 3600;

async function resyncHistory() {
  const hi = await api('/api/history?' + rangeQuery(RANGE));
  rows = setRows((hi && hi.rows) || []);
  if (hi && hi.seconds) WINDOW_SEC = hi.seconds;
  return hi;
}

/** 取温湿度曲线数据。与功率曲线共用 RANGE（一个控件切两条线）。
 *  按天视图时多带一个 daily=1，后端按本地自然日聚合（日均/最高/最低）。 */
async function pullEnvHistory() {
  const hi = await api('/api/env/history?' + rangeQuery(RANGE) + (envDaily ? '&daily=1' : ''));
  envRows = (hi && hi.rows) || [];
  if (hi && hi.seconds) envWindowSec = hi.seconds;
  envDailyPullAt = Date.now();
  envDailyDay = new Date().toDateString();
  renderEnvDaily();
  return hi;
}

/**
 * 温度曲线的窗口秒数（画图与"裁掉滑出窗口的点"都必须用同一个值）。
 *
 * ⚠️ 不能直接用功率曲线的 WINDOW_SEC：两条曲线虽然共用一个区间控件，但"全部"档
 *    在两边不是一个东西 —— 功率那边 all 会回落到 1 小时（它最多留 400 天），
 *    温度这边却是半年的全部数据。曾经因此把温度曲线画成"只有最近 1 小时"，
 *    而且每来一条实时读数就把刚取回来的半年历史从数组头裁掉。
 * ⚠️「全部」档后端回的是 Number.MAX_SAFE_INTEGER，直接当窗口用会把所有点挤在最右边，
 *    所以这里退化成"数据实际跨度 + 半天余量"。
 */
function envWinSec() {
  const sec = Number(envWindowSec);
  if (Number.isFinite(sec) && sec > 0 && sec <= 400 * 86400) return sec;
  const span = envRows.length > 1 ? (envRows[envRows.length - 1].at - envRows[0].at) : 0;
  return Math.max(3600, Math.round((span + 43200000) / 1000));
}

// ------------------------------------------------------------------ 实时推送
//
// 服务端每落一个采样点就推一条增量（SSE），曲线于是"跟手"——不用等下一次轮询的
// HTTP 往返。SSE 断了浏览器会自己重连；断开期间 1.5 秒的全量轮询兜底，界面不卡。
function connectStream() {
  try {
    const es = new EventSource('/api/stream');
    es.addEventListener('open', () => { sseLive = true; });
    es.addEventListener('error', () => { sseLive = false; });
    es.addEventListener('meta', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d && d.state) { last = d.state; render(); }
      } catch (_) {}
    });
    es.addEventListener('sample', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (!d) return;
        if (last) {
          if (d.latest) last.latest = d.latest;
          if (d.link) last.link = d.link;
        }
        if (d.row) {
          mergeRow(d.row);
          const cut = Date.now() - WINDOW_SEC * 1000;
          while (rows.length && rows[0].at < cut) rows.shift();
        }
        renderTick();     // 轻量刷新：数字 + 曲线，不重建设置区
      } catch (_) {}
    });
    // 温度计是低频量（90s 一次），单独一条通道推，不挤在 sample 里
    es.addEventListener('env', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (!d || !d.env) return;
        const e = d.env;
        const prevAt = (last && last.envSensor && last.envSensor.at) || 0;
        if (last) last.envSensor = e;
        // 新读数就追加到曲线（与 /api/env/history 的 row 形状统一：{at,t,h,b}）。
        // 同一个 at 只留一个点，避免 SSE 重放导致曲线出现重复横坐标。
        if (e.at && e.tempC != null && e.at !== prevAt) {
          if (envDaily) {
            // 按天视图里每个点是"一整天"聚出来的，往里插一条原始读数会凭空多出一个
            // 假的尖点（当天的均值只该由后端重算）。跨零点、或超过 5 分钟才整段重拉。
            const today = new Date().toDateString();
            if (envDailyDay && envDailyDay !== today) {
              pullEnvHistory().then(drawEnvChart).catch(() => {});
            } else if (Date.now() - envDailyPullAt > 300000) {
              pullEnvHistory().then(() => drawEnvChart()).catch(() => {});
            }
          } else {
            if (envRows.length && envRows[envRows.length - 1].at === e.at) envRows.pop();
            envRows.push({ at: e.at, t: e.tempC, h: e.humidity, b: e.battery });
            const cut = Date.now() - envWinSec() * 1000;
            while (envRows.length && envRows[0].at < cut) envRows.shift();
          }
        }
        renderEnv();
        drawEnvChart();
      } catch (_) {}
    });
    es.addEventListener('envprobe', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        const box = $('#env-note');
        if (box && d) {
          box.innerHTML = '<b>广播探测结果：</b><br>' +
            String(d.text || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
              .replace(/\n/g, '<br>');
        }
      } catch (_) {}
    });
    // 读取设备历史：慢操作（几分钟），进度/结果走这条通道推
    es.addEventListener('envhist', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (!d) return;
        const st = $('#env-hist-status'), btn = $('#env-hist-read'), note = $('#env-note');
        const esc = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        if (d.phase === 'start') {
          if (st) st.textContent = '正在读取（约几分钟，会占用设备蓝牙）…';
          if (btn) btn.disabled = true;
        } else if (d.phase === 'progress') {
          // ⚠️ 别写成 `${got}/${total}`：total 是设备**保留上限**（HIST_MAX_IDX=152），
          //    不是"这次要读多少条"。设备是把自己内存里**全部**历史逐条推出来的，
          //    条数可以远超 152（实测一次能推 3000+），写成 got/152 会显示成
          //    "3105/152 条" 这种看起来像出错的数字。
          const n = Number(d.got) || 0;
          const cap = Number(d.total) || 0;
          if (st) st.textContent = `读取中 ${n} 条（${Math.round(d.elapsed || 0)}s）`
            + (cap && n > cap ? ' · 已超过设备保留上限 ' + cap + ' 条，仍在传' : '');
        } else if (d.phase === 'retry') {
          if (st) st.textContent = `第 ${d.attempt} 次连接失败，8 秒后自动重试…`;
        } else if (d.phase === 'done') {
          if (btn) btn.disabled = false;
          if (d.count === 0) {
            // 连上了但一条 notify 都没收到 —— 多半是连接被别的中心端抢走
            if (st) st.textContent = '没读到记录';
            if (note) note.innerHTML = '<b>连接上了但没收到历史记录。</b>' +
              '多半是读取期间蓝牙连接被抢走（手机米家 / 别的程序）。' +
              '请先<b>完全退出手机米家</b>，再点一次「读取设备历史」。';
          } else {
            if (st) st.textContent = `已读回 ${d.count} 条`;
            // 读回后温度覆盖了多久？直接用刚更新过的区间算，提示里写清楚有几档可看。
            const days = (last && last.envSensor && last.envSensor.histDays) || 0;
            const spanTxt = days >= 2 ? `设备里存着约 ${days} 天数据，` : '';
            if (note) note.innerHTML = `<b>历史读取完成：</b>读回 ${d.count} 条、落盘 ${d.merged} 条。`
              + spanTxt + '已自动切到能看全的区间，下面这条就是软件运行之前的温湿度走势。'
              + (days > 30 ? '想看更长的，区间里已经多出「90 天」和「全部」两档。' : '')
              // 覆盖语义要说清楚：读完只留设备这一套来源（本机的旧数据一条不留）
              + (d.dropped
                ? `<br>已用设备历史覆盖旧数据（清掉本机采样 ${d.dropped} 条）—— `
                  + '同期的曲线统一改用设备每小时记录的最高/最低，所以最近几天看起来会比之前"平"一点，这是正常的。'
                  + '之后新采的读数会照常往后接。'
                : '');
            // 自动切到能**看全**这段历史的档位：设备里存了半年就切「全部」，
            // 只存了几天就切 7 天 —— 一律切 7 天的话，156 天的数据只能看到最后 5%，
            // 用户会以为"读回来的没多少"。
            const want = days >= 60 ? 'all' : (days >= 20 ? '30d' : '7d');
            RANGE = want;
            yScale.max = 0; envYScale.t = 0; envYScale.h = 0;
            renderRanges(); renderEnvRanges();
            Promise.all([resyncHistory(), pullEnvHistory()]).then(render).catch(() => {});
          }
        } else if (d.phase === 'error') {
          const why = String(d.msg || '读取失败');
          if (st) st.textContent = '读取失败：' + (why.length > 60 ? why.slice(0, 60) + '…' : why);
          if (btn) btn.disabled = false;
          if (note) note.innerHTML = '<b>历史读取失败：</b>' + esc(why) +
            '<br>常见原因：手机米家正连着它（先退出米家再试）；设备不在蓝牙范围内；或电池没电了。';
        }
      } catch (_) {}
    });
    // 风扇：状态与控件全部交给 renderFan() 从整份 payload 重算，不做增量
    // （没有曲线了，所以不用像功率/温度那样在这儿往数组里追加点）。
    es.addEventListener('fan', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (!d || !d.fan) return;
        if (last) last.fan = d.fan;
        renderFan();
      } catch (_) {}
    });
    return es;
  } catch (_) { sseLive = false; return null; }
}

// 界面脚本崩了必须看得见 —— 否则就是"数字停在某个值不动"，很难查（2026-09-22 踩过两次）。
// 除了在界面上标红，还往服务端写一条，这样"刚才界面坏过一次"是有记录的（data/selftest.log）。
window.addEventListener('error', (e) => {
  const msg = (e && e.message) || '未知错误';
  try { setLink('error', '界面脚本出错：' + msg); } catch (_) {}
  try {
    fetch('/api/selftest', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: 'UI-ERROR ' + msg + '  @ ' + ((e && e.filename) || '') + ':' + ((e && e.lineno) || 0) + ':' + ((e && e.colno) || 0),
    }).catch(() => {});
  } catch (_) {}
});

// ------------------------------------------------------------------ 渲染
function setLink(state, msg) {
  const dot = $('#link-dot'), txt = $('#link-txt');
  dot.className = 'dot';
  const map = {
    connected: ['on', '已连接'], scanning: ['warn', '搜索中'], connecting: ['warn', '连接中'],
    auth: ['warn', '认证中'], reconnecting: ['warn', '重连中'], error: ['err', '出错'],
    'need-login': ['warn', '待登录'], idle: ['', '未启动'], yielded: ['warn', '已让位给手机'],
  };
  const m = map[state] || ['', state];
  if (m[0]) dot.classList.add(m[0]);
  // 已连接时不重复副标题，否则会出现「已连接 · 已连接并认证」
  txt.textContent = (state === 'connected' || !msg) ? m[1] : (m[1] + ' · ' + msg);
}

// 量程随读数抬升，且只升不降（避免弧线在 120W 以上溢出表盘）
function gaugeMaxFor(v) {
  for (const s of [120, 150, 200, 250, 300]) if (v <= s) return s;
  return Math.ceil(v / 50) * 50;
}

function renderNotices() {
  const box = $('#notices');
  const out = [];
  if (!last) return;
  if (!last.env.pythonFound) {
    out.push(['bad', '✖', '找不到 Python 运行环境',
      '采集器需要 Python。请在应用目录执行 <code>tools\\setup-env.ps1</code> 建立运行环境后重试。']);
  } else if (!last.env.tokenPresent) {
    out.push(['warn', '⚠', '尚未登录小米云',
      '读取充电器需要一个 BLE 密钥。点右上角「登录小米云」扫码授权一次即可。']);
  } else {
    const s = last.link.state;
    if (s === 'yielded') {
      const left = Math.ceil(((last.yield && last.yield.leftMs) || 0) / 60000);
      out.push(['warn', '⇄', '已让位给手机米家',
        `蓝牙已释放，手机上的米家现在可以连上充电头。约 <b>${left} 分钟</b>后自动收回；` +
        '想提前拿回来就点右上角「重连」。']);
    } else if (s === 'reconnecting' || s === 'error') {
      out.push(['warn', '⚠', '蓝牙链路未就绪', (last.link.msg || '') +
        '<br>常见原因：充电器未通电；米家 App 占用了这条蓝牙连接（蓝牙同时只允许一个中心端）；离得太远。']);
    } else if (s === 'scanning' || s === 'connecting') {
      // 采集器的循环是「搜索 2~8s → 连接（最多 60s）→ 失败 → 退避 → 再来」，
      // 真正的原因只在失败那一两秒的 "重连中" 里出现过。用户盯着"连接中"时反而
      // 什么都看不到 —— 所以把上一次的失败原因**常驻**显示，并按 RSSI 给出判断：
      //   · 有 RSSI（扫得到）却连不上 ⇒ 几乎不是距离问题，而是被别的中心端占着，
      //     或者本机适配器做不了 BLE 连接（台式机插 USB 蓝牙棒最常见）
      //   · 没 RSSI（扫不到）      ⇒ 才是通电/距离/被占用导致的"不广播"
      const le = last.link.lastError;
      const fresh = le && le.msg && (Date.now() - (le.at || 0) < 10 * 60 * 1000);
      if (fresh) {
        const esc2 = (t) => String(t || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const rssi = last.link.rssi;
        const why = (rssi != null)
          ? `设备<b>扫得到</b>（${rssi} dBm）却连不上 —— 距离和通电基本可以排除。`
            + '最可能是<b>这条蓝牙已被别的设备占用</b>（手机米家、或另一台电脑上的同一软件；'
            + 'BLE 同时只允许一个中心端），其次是这台电脑的蓝牙适配器不支持 BLE 连接'
            + '（台式机外接的廉价 USB 蓝牙棒常见）。'
          : '一直没扫到设备 —— 先确认充电头已插市电、米家 App 已断开它，再靠近一点。';
        // 适配器型号是"最后一块拼图"：Realtek 8821/8822 这类 Wi-Fi+蓝牙组合卡
        // （BT4.2、1x1 天线与 2.4G Wi-Fi 分时共用）在 Windows 上出现"扫得到、连不上"
        // 是常事；而 CSR8510 那种廉价棒是连不稳。写出来，用户就知道该动哪儿。
        const bt = last.bt && last.bt.name;
        let tip = '';
        if (bt) {
          if (/8821|8822|rtl88/i.test(bt)) {
            tip = '这颗是 Wi-Fi+蓝牙<b>组合卡</b>：蓝牙和 2.4G Wi-Fi 共用同一副天线。'
              + '先<b>关掉 Wi-Fi</b>（或把 Wi-Fi 切到 5GHz）再试；还不行就去更新 Realtek 蓝牙驱动。';
          } else if (/csr8510|generic bluetooth|bluetooth 4\.0/i.test(bt)) {
            tip = '这颗是通用/廉价蓝牙棒（BT4.0），BLE 连接很不稳 —— 换一根 BT5.0 的棒最省事。';
          }
        }
        out.push(['warn', '⚠', `第 ${le.attempt || 1} 次连接没成功`, why
          + (tip ? `<br>${tip}` : '')
          + (bt ? `<br><span class="mute">蓝牙适配器：${esc2(bt)}</span>` : '')
          + `<br><span class="mute">原始错误：${esc2(le.msg)}</span>`]);
      } else if (s === 'scanning') {
        out.push(['', '⏳', '正在搜索充电器', '请确认充电头已插上市电，并且米家 App 已断开它。']);
      } else if (!last.latest) {
        out.push(['', '⏳', '等待第一帧数据', (last.link.msg || '')]);
      }
    } else if (!last.latest) {
      out.push(['', '⏳', '等待第一帧数据', (last.link.msg || '')]);
    }
  }
  box.innerHTML = out.map(([cls, ico, t, d]) =>
    `<div class="notice ${cls}"><div class="ico">${ico}</div><div><div class="t">${t}</div><div class="d">${d}</div></div></div>`
  ).join('');
}

function renderGauge(ports, total) {
  const MAX = gaugeMaxFor(Math.max(total, peak));
  const frac = Math.max(0, Math.min(1, total / MAX));
  $('#gauge-fg').setAttribute('stroke-dashoffset', String(414.7 * (1 - frac)));
  $('#gauge-max').textContent = String(MAX);
  $('#gauge-val').textContent = fmtW(total);
  $('#peak').textContent = fmtW(peak) + ' W';
  $('#active-n').textContent = String((ports || []).filter((p) => p.in_use).length);
}

function renderPorts(ports) {
  const host = $('#ports');
  // 端口卡里的那一行「本次充电」：这一口此刻在充就显示**实时值**（带“充电中”），
  // 没在充就显示**最近一次插拔**算出来的结算值 —— 也就是下次充电才刷新的那个数。
  // 数据来自 /api/energy（每 8 秒拉一次），不是每秒的状态帧。
  const plugLine = (p) => {
    const E = lastEnergy;
    if (!E) return '<div class="cap"><span>本次充电</span><b class="mute">—</b></div>';
    const lv = (E.plugsLive || []).find((g) => g.id === p.id);
    const rec = lv || (E.plugs || []).find((g) => g.id === p.id);
    if (!rec) return '<div class="cap"><span>本次充电</span><b class="mute">还没有记录</b></div>';
    const wh = Number(rec.wh || 0);
    const whTxt = wh >= 100 ? wh.toFixed(1) : wh >= 10 ? wh.toFixed(2) : wh.toFixed(3);
    // 时长：在充就按"起点到现在"现算（端口卡每秒重画，数字是跳的），
    // 已结算的用记录里的 ms。Math.max 兜住时钟略慢导致的倒退。
    const dur = fmtDur(lv ? Math.max(rec.ms || 0, Date.now() - rec.start) : (rec.ms || 0));
    const when = lv ? '' : new Date(rec.start).toLocaleString('zh-CN',
      { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    return `<div class="cap"><span>本次充电</span><b>${whTxt} Wh`
      + ` <span class="mute">· ${dur}</span>`
      + `${lv ? ' <i class="live-dot">充电中</i>' : ''}</b></div>`
      + `<div class="cap"><span class="mute">${when}</span>`
      + `<b class="mute">${fmtKwh(wh)} 度 · ${fmtMah(wh)} mAh</b></div>`;
  };
  const html = (ports || []).map((p) => {
    const on = p.in_use;
    const pct = Math.max(0, Math.min(100, (p.w / 100) * 100));
    const cap = p.cap == null ? '未协商' : (p.cap + ' W' + (p.kind ? '（' + (KIND_CN[p.kind] || p.kind) + '）' : ''));
    // 充电头"识别"出的结果主要体现在这里：握手协议（2.17/2.18 的高字节 →
    // PD / PPS / QC / SCP / FCP / AFC / UFCS / 5V）。端口字的 b1 是另一套协议码
    // （vendor 的 PROTOCOL_NAMES），实机还会出现没登记的值（如 0x0b），只放 tooltip 备查。
    const code = String(p.raw || '').slice(2, 4) || '--';
    const ident = p.proto_text || PROTO_CN[p.proto] || '在用';
    return `<div class="port ${on ? 'active' : ''}" style="--pc:${PORT_COLOR[p.id]}">
      <div class="top"><div class="name">${p.label}</div>
        <div class="st ${on ? 'on' : ''}" title="识别到的握手协议 · 端口协议码 0x${code}">${on ? ident : '空闲'}</div></div>
      <div class="big">${fmtW(p.w)}<small>W</small></div>
      <div class="sub"><span>电压</span><div>${p.v.toFixed(2)} V</div></div>
      <div class="sub"><span>电流</span><div>${p.a.toFixed(2)} A</div></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="cap"><span>识别协议</span><b>${on ? ident : '—'}</b></div>
      <div class="cap"><span>协商上限</span><b>${cap}</b></div>
      ${plugLine(p)}
    </div>`;
  }).join('');
  host.innerHTML = html;
}

function renderNeg() {
  const p = (last.latest && last.latest.ports) || [];
  const active = p.filter((x) => x.in_use);
  const dev = last.device || {};
  let html = '';
  html += `<dt>充电器型号</dt><dd><b>${dev.model || 'AD1204U'}</b>` +
    (dev.bleName ? ` <span class="mute">${dev.bleName}</span>` : '') +
    (dev.productId ? ` <span class="mute">· 产品号 ${dev.productId}</span>` : '') + '</dd>';
  if (!active.length) {
    html += '<dt>设备识别</dt><dd class="mute">当前四口都没有接入设备</dd>';
  } else {
    for (const x of active) {
      const code = String(x.raw || '').slice(2, 4) || '--';
      const idt = x.proto_text || PROTO_CN[x.proto] || x.proto || '未知';
      html += `<dt>${x.label} 识别到</dt><dd><b>${idt}</b>` +
        (x.cap != null
          ? ` · ${x.cap} W${x.kind ? '（' + (KIND_CN[x.kind] || x.kind) + '）' : ''}`
          : '') +
        ` <span class="mute">· 协议码 0x${code}</span></dd>`;
    }
  }
  html += `<dt>采集器</dt><dd>${last.collecting ? '运行中' : '<span class="mute">已停止</span>'}</dd>`;
  html += `<dt>设备地址</dt><dd class="mono">${last.config.address}</dd>`;
  html += `<dt>本地历史</dt><dd>${rows.length} 点 / 内存 ${last.historyCount} 点</dd>`;
  $('#neg').innerHTML = html;
  $('#in-interval').value = last.config.interval;
  if (document.activeElement !== $('#in-tray')) $('#in-tray').checked = last.config.tray !== false;
  if (document.activeElement !== $('#in-notify')) $('#in-notify').checked = last.config.notify !== false;
  if (document.activeElement !== $('#in-traymode')) $('#in-traymode').value = last.config.trayMode || 'total';
  if (document.activeElement !== $('#in-autostart')) $('#in-autostart').value = last.config.autostart || 'off';
}

function renderSettings() {
  const s = (last.latest && last.latest.settings) || null;
  const box = $('#settings');
  if (!s) { box.innerHTML = '<dt>状态</dt><dd class="mute">等待数据</dd>'; return; }
  const b = (v) => (v == null ? '<span class="mute">—</span>' : (v ? '开启' : '关闭'));
  const raw = (v) => (v == null ? '<span class="mute">—</span>' : v);
  const en = s.ports_enabled;
  const chips = ['c1', 'c2', 'c3', 'a'].map((k) =>
    `<span class="chip ${en && en[k] ? 'on' : 'off'}">${k === 'a' ? 'USB-A' : k.toUpperCase()}</span>`).join('');
  box.innerHTML = `
    <dt>息屏时间</dt><dd>${s.screen_save_text || raw(s.screen_save_time)}</dd>
    <dt>场景模式</dt><dd>${s.scene_mode_text || raw(s.scene_mode)}</dd>
    <dt>端口开关</dt><dd><div class="chips">${chips}</div></dd>
    <dt>USB-A 常开</dt><dd>${b(s.usb_a_always_on)}</dd>
    <dt>空闲熄屏</dt><dd>${b(s.screenoff_while_idle)}</dd>
    <dt>屏幕方向锁</dt><dd>${b(s.screen_dir_lock)}</dd>
    <dt>协议控制</dt><dd class="mono">0x${(s.protocol_ctl == null ? 0 : s.protocol_ctl).toString(16).padStart(2, '0')}</dd>
    <dt>语言</dt><dd>${raw(s.device_language)}</dd>
    <dt>扩展控制字</dt><dd class="mono">0x${(s.protocol_ctl_extend == null ? 0 : s.protocol_ctl_extend).toString(16).padStart(8, '0')}</dd>`;
}

// 自动断电（5V 空载）：参数来自 server 的 autoOff.cfg，触发记录来自 autoOff.last。
// ⚠️ 只回填**不在编辑中**的控件 —— 每秒都会重画，否则用户正在输入的数字会被覆盖。
function renderAutoOff(ao) {
  if (!ao || !ao.cfg) return;
  const c = ao.cfg;
  const setNum = (sel, v) => { const el = $(sel); if (el && document.activeElement !== el) el.value = v; };
  const setChk = (sel, v) => { const el = $(sel); if (el && document.activeElement !== el) el.checked = !!v; };
  // 启用开关是 .switch 组件（和「端口开关」同一个），没有 .checked，只有 .on 类。
  // 正在等回包（busy）时别拿上一次的状态把它拨回去，否则点了像没反应。
  const sw = $('#ao-on');
  if (sw && !sw.classList.contains('busy')) sw.classList.toggle('on', !!c.enabled);
  setNum('#ao-v', c.vMin);
  setNum('#ao-i', c.iMax);
  setNum('#ao-sec', c.idleSec);
  setNum('#ao-restore', c.restoreMin);
  setChk('#ao-skipa', c.skipSmallA);
  const box = $('#ao-state');
  if (!box) return;
  const L = ao.last;
  if (!L) { box.textContent = c.enabled ? '尚未触发' : '已关闭（不会自动断电）'; return; }
  const when = new Date(L.at).toLocaleTimeString('zh-CN', { hour12: false });
  const port = String(L.port || '').toUpperCase();
  const left = L.restoreAt ? Math.max(0, Math.ceil((L.restoreAt - Date.now()) / 60000)) : 0;
  box.textContent = `最近一次：${when} 关闭 ${port}（${L.v} V / ${L.a} A 空载）`
    + (L.restoreAt ? `，约 ${left} 分钟后自动恢复` : '，不会自动恢复');
}

function renderRaw() {
  const items = (last.latest && last.latest.raw) || [];
  const tb = $('#raw').querySelector('tbody');
  const n = $('#raw-n');
  if (n) n.textContent = String(items.length);
  if (!items.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">等待数据…</td></tr>'; return; }
  const NAME = {1:'C1 端口字',2:'C2 端口字',3:'C3 端口字',4:'USB-A 端口字',5:'场景模式',6:'息屏时间',
    7:'协议控制',13:'语言',15:'USB-A 常开',16:'端口开关',17:'C1/C2 协议',18:'C3/A 协议',
    19:'空闲熄屏',20:'屏幕方向锁',21:'扩展控制字'};
  tb.innerHTML = items.slice().sort((a, b) => a.piid - b.piid).map((it) => {
    const v = it.type === 'u32' ? it.value + ' (0x' + it.value.toString(16).padStart(8, '0') + ')'
      : (it.type === 'bool' ? (it.value ? 'true' : 'false') : it.value);
    return `<tr><td>2.${it.piid}<br><span class="muted" style="font-size:0.79rem">${NAME[it.piid] || ''}</span></td>
      <td class="mono">${it.type}</td><td class="mono">${v}</td><td class="mono">${it.raw}</td>
      <td class="mono">0x${it.status.toString(16).padStart(4, '0')}</td></tr>`;
  }).join('');
}

function render() {
  if (!last) return;
  const dev = last.device || {};
  $('#dev-sub').textContent = (dev.model || 'AD1204U') +
    (dev.productId ? ' · 产品号 ' + dev.productId : '') +
    ' · ' + last.config.address + ' · 采样 ' + last.config.interval + 's · v' + last.version;
  setLink(last.link.state, last.link.msg);
  const lt = last.latest;
  const rssi = (lt && lt.rssi != null) ? lt.rssi : (last.link ? last.link.rssi : null);
  $('#rssi').textContent = (rssi != null) ? (rssi + ' dBm') : '—';
  // 窗口标题带上实时功率 —— Windows 任务栏按钮上会直接显示这串字，
  // 最小化时也能从任务栏瞄一眼当前多少瓦。
  const linkOk = last.link && last.link.state === 'connected';
  document.title = (linkOk && lt && lt.total > 0)
    ? (fmtW(lt.total) + ' W · 酷态科10号Ultra')
    : '酷态科10号Ultra';
  renderNotices();
  $('#ver-line').textContent = '酷态科10号Ultra v' + last.version +
    '  ·  功率与电量数据只保存在本机 data\\ 目录，不上传任何地方';
  const yb = $('#btn-yield');
  if (last.yield && last.yield.active) {
    yb.textContent = '收回蓝牙（' + Math.ceil(last.yield.leftMs / 60000) + ' 分）';
  } else {
    yb.textContent = '让位给手机';
  }
  const ports = lt ? lt.ports : [];
  const total = lt ? lt.total : 0;
  if (lt) peak = Math.max(peak, total);
  renderGauge(ports, total);
  renderPorts(ports);
  renderEnv();
  renderEnvRanges();
  renderFan();
  renderNeg();
  renderSettings();
  renderAutoOff(last.autoOff);
  syncControl();
  renderRaw();
  drawChart();
  drawEnvChart();
}

/** 采样级的轻量刷新：只动数字与曲线。
 *  采样间隔可低到 0.5 秒，全量 render() 会连着重建设置区/开关区的一堆 DOM，
 *  既浪费又容易打断用户正在点的按钮。结构化区域交给 meta/轮询/切区间时的 render()。 */
function renderTick() {
  if (!last || !last.latest) return;
  const lt = last.latest;
  const ports = lt.ports || [];
  const total = lt.total || 0;
  if (total > peak) peak = total;
  setLink(last.link.state, last.link.msg);
  const rssi = (lt.rssi != null) ? lt.rssi : (last.link ? last.link.rssi : null);
  $('#rssi').textContent = (rssi != null) ? (rssi + ' dBm') : '—';
  const linkOk = last.link && last.link.state === 'connected';
  document.title = (linkOk && total > 0)
    ? (fmtW(total) + ' W · 酷态科10号Ultra')
    : '酷态科10号Ultra';
  renderGauge(ports, total);
  renderPorts(ports);
  renderNeg();
  drawChart();
}

// ------------------------------------------------------------------ 环境温度计
//
// 数据来自外挂的小米温湿度计（LYWSD03MMC），由服务端独立进程采集。
// 这张卡的原则：**宁可不显示，也不显示编的数**。
//   · 没读到 → 显示上次读数 + 明确标注"多久没更新"，大数字变灰（不装成最新值）
//   · 从未读到 → 显示 — 并给出原因（蓝牙被占用 / 设备没电 / 地址不对）
// 「读取」一栏区分来源：广播直读（刷过机，零打扰）还是连接读取（短暂占用它的蓝牙）。
// 信号强度数值翻译成人话：蓝牙 RSSI 大致 -30（贴脸）到 -100（几乎收不到）。
const rssiWord = (v) => v >= -55 ? '很强' : v >= -70 ? '良好' : v >= -85 ? '一般' : '偏弱';
function fmtAge(ms) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' 秒前';
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h >= 1) return h + ' 小时 ' + (m % 60) + ' 分前';
  return m + ' 分前';
}

function renderEnv() {
  const e = (last && last.envSensor) || null;
  const card = $('#env-card');
  if (!e) return;

  // 设备内置历史的覆盖区间（读过一次才有）—— 它决定 90天/全部 两档要不要出现。
  // 每次 renderEnv 都同步一次，因为读历史是异步的，env 推送可能先到。
  const hadHist = envHistLoaded;
  envHistLoaded = !!(e.histFromAt && e.histToAt);
  envHistDays = e.histDays || 0;
  if (envHistLoaded !== hadHist) renderEnvRanges();

  const tEl = $('#env-temp'), hEl = $('#env-hum'), stEl = $('#env-state');
  const bEl = $('#env-batt'), aEl = $('#env-age'), vEl = $('#env-via'), srcEl = $('#env-src');

  const has = e.tempC != null;
  tEl.textContent = has ? (Math.round(e.tempC * 10) / 10).toFixed(1) : '—';
  hEl.textContent = (e.humidity != null) ? (Math.round(e.humidity * 10) / 10).toFixed(0) : '—';
  bEl.textContent = (e.battery != null) ? (e.battery + ' %') : '—';

  // 卡片收起时，标题行右侧补一个读数摘要 —— 内容藏起来了，至少让数字还看得见。
  const foldSum = $('#env-fold-sum');
  if (foldSum) {
    foldSum.textContent = has
      ? tEl.textContent + ' ℃' + (e.humidity != null ? ' · ' + hEl.textContent + ' %' : '')
      : '无数据';
  }

  // 信号强度：只有「广播直读」那条路才拿得到 RSSI（连接读取时读不到），
  // 拿不到就显示「—」并说明原因，不拿旧值糊弄。数值顺手翻译成人话（强/中/弱）。
  const sigEl = $('#env-signal');
  if (sigEl) {
    if (e.rssi != null) {
      sigEl.textContent = e.rssi + ' dBm · ' + rssiWord(e.rssi);
    } else {
      sigEl.textContent = '—';
      sigEl.title = '连接读取（GATT）时读不到信号强度；只有刷成 ATC/pvvx 固件的广播直读才有。';
    }
  }
  aEl.textContent = fmtAge(e.ageMs);
  vEl.textContent = e.source === 'adv' ? '广播直读' : (e.source === 'gatt' ? '连接读取' : '—');
  if (srcEl) {
    srcEl.textContent = e.source === 'adv' ? '外挂传感器 · 免连接'
      : (e.source === 'gatt' ? '外挂传感器 · 轮询 ' + (e.interval || 90) + 's' : '外挂传感器');
  }

  // 三态：正常 / 数据陈旧（显示旧值但标灰）/ 完全没数据
  card.classList.toggle('stale', has && e.stale);
  card.classList.toggle('down', !has);
  if (!e.enabled) {
    stEl.textContent = '已暂停';
    card.classList.add('stale');
  } else if (e.ok && !e.stale) {
    stEl.textContent = '正常';
  } else if (has) {
    stEl.textContent = '数据陈旧';
  } else if (!has) {
    stEl.textContent = e.running ? '等待首次读数' : '未运行';
  }

  // 设置区的输入框（别打断正在输入的人）
  const addr = $('#env-addr'), itv = $('#env-int');
  if (addr && document.activeElement !== addr) addr.value = e.address || '';
  if (itv && document.activeElement !== itv) itv.value = e.interval || 90;
  const tg = $('#env-toggle');
  if (tg) tg.textContent = e.enabled ? '暂停温度计' : '启动温度计';

  // 把"为什么没数据"说清楚 —— 蓝牙环境里最常见的原因就那么几个
  const note = $('#env-note');
  if (note) {
    if (!e.enabled) {
      note.innerHTML = '温度计采集已暂停，不会占用任何蓝牙。点上面的按钮可以随时恢复。';
    } else if (!has && e.msg && !e.running) {
      note.innerHTML = '温度计采集进程没在跑：<b>' + e.msg + '</b>。检查设备地址是否正确、'
        + '温湿度计的电池是否还有电。';
    } else if (!has) {
      note.innerHTML = '<b>还没读到读数。</b>常见原因：温湿度计离得太远或没电；'
        + '手机米家正连着它（一个中心端限制）；或者地址填错了（默认 ' + (e.address || '') + '）。'
        + '下方「探测广播」能确认它到底在不在广播范围内。';
    } else if (e.stale) {
      note.innerHTML = '<b>数据已陈旧：</b>最近一次成功读数是 ' + fmtAge(e.ageMs) + '。'
        + '多半是蓝牙一时连不上（被手机占用 / 距离远 / 电池低），进程会在下一轮自动重试。';
    } else {
      note.innerHTML = '读取方式：<b>' + (e.source === 'adv' ? '广播直读（零连接，最省电）'
        : '连接读取（每次占用它约 1 秒，所以间隔 ≥60 秒）') + '</b>。'
        + '和充电头一样，温湿度计同一时刻只接受<b>一个中心端</b> —— '
        + '轮询的那一下，手机米家会连不上它。';
    }
  }
}

// ------------------------------------------------------------------ 温湿度曲线
//
// 与功率曲线共用同一个 RANGE（一个控件切两条线），但画法上有两个关键区别：
//   1. **不补 0**：温度没有"空档=0℃"的语义，补 0 会画出一条掉到冰点的假线。
//      空档直接断开连线（这里不做平滑，因为温度本来就是慢变量，无锯齿可压）。
//   2. **双轴**：温度（左轴，暖橙）与湿度（右轴，青蓝）量纲差一个数量级，
//      共用一个轴必然其中一条被压成直线。左轴给温度、右轴给湿度。

function renderEnvRanges() {
  const box = $('#env-ranges');
  if (!box) return;
  // 半年级档位（90天/全部）平时是隐藏的：没读过设备内置历史时它只会是一片空白，
  // 白白占地方。读过一次（envHistLoaded）才放出来 —— 只有设备历史能填满那么长的时间。
  // 半年级档位（90 天 / 1 年 / 全部）平时是隐藏的：没读过设备内置历史时它只会是一片空白，
  // 白白占地方。读过一次（envHistLoaded）才放出来 —— 只有设备历史能填满那么长的时间。
  const list = RANGES.filter(([k]) => !LONG_RANGES.has(k) || envHistLoaded);
  if (!box.childElementCount || box.dataset.ndef !== (envHistLoaded ? '1' : '0')) {
    box.dataset.ndef = envHistLoaded ? '1' : '0';
    box.innerHTML = list.map(([k, label]) =>
      `<button class="${k === RANGE ? '' : 'ghost'}" data-range="${k}">${label}</button>`).join('');
  } else {
    for (const b of box.querySelectorAll('button')) b.classList.toggle('ghost', b.dataset.range !== RANGE);
  }
  const cur = list.find(([k]) => k === RANGE) || RANGES.find(([k]) => k === RANGE);
  const tag = $('#env-win-tag');
  if (tag) tag.textContent = '最近 ' + (cur ? cur[1] : RANGE);
  renderEnvDailyBtn();      // 「按天」按钮状态与曲线下方的说明文案跟着一起同步
}

$('#env-ranges').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-range]');
  if (!b || b.dataset.range === RANGE) return;
  RANGE = b.dataset.range;
  yScale.max = 0;
  envYScale.t = 0; envYScale.h = 0;
  renderRanges(); renderEnvRanges();
  try {
    await Promise.all([resyncHistory(), pullEnvHistory()]);
    render();
  } catch (err) {
    setLink('error', '取曲线数据失败：' + err.message);
  }
});

// ---- 按天视图（一天一个点） -------------------------------------------------
//
// 长区间上每小时一个点是"数据"不是"信息"：156 天 ≈ 3800 个点，谁也读不出规律。
// 按天压成日均值后，一张图就能看完一个季度；再配一张明细表把每天的具体数值列出来
// （曲线看趋势、表格看数字）。曲线上那条阴影带是"当天最高 ~ 最低"。
//
// 约定：开关状态存 localStorage；打开时如果当前窗口短于 7 天会自动跳到 7 天 ——
// 一天一个点，1 小时的窗口里最多画出一个点。
// （SHORT_RANGES / MAX_DAILY_ROWS 两个常量在文件顶部与 envDaily 放在一起）
/**
 * 曲线下方那行说明：状态文字 + **空档提示**。
 *
 * 2 小时以上的空档 = 那段时间电脑没开机（设备一小时才记一条，除非真的整段没有数据，
 * 否则不会出现这么大的洞）。温度计自己存着约半年的记录，点一次「读取设备历史」就能补上。
 * ⚠️ 用户前后问过两次"为什么有空白/历史没覆盖" —— 直接写在图上，别让他猜。
 */
function renderEnvHint() {
  const el = $('#env-chart-hint');
  if (!el) return;
  const base = envDaily
    ? '按天聚合 · 一天一个点（日均值），阴影带是当天最高 ~ 最低'
    : '温度与湿度共用时间轴 · 空档处断开连线（不补 0）';
  let gaps = 0;
  for (let i = 1; i < envRows.length; i += 1) {
    if (envRows[i].at - envRows[i - 1].at > 2 * 3600000) gaps += 1;
  }
  const extra = gaps
    ? (envHistLoaded
      ? ` · 有 ${gaps} 段空档（那段时间电脑没开机）—— 点「读取设备历史」能用温度计里存着的记录补上`
      : ` · 有 ${gaps} 段空档 —— 点「读取设备历史」把温度计里的半年记录读回来`)
    : '';
  const txt = base + extra;
  if (el.textContent !== txt) el.textContent = txt;
  el.style.color = gaps ? 'var(--warn)' : '';
}

function renderEnvDailyBtn() {
  const b = $('#btn-env-daily');
  if (!b) return;
  b.classList.toggle('ghost', !envDaily);
  b.textContent = envDaily ? '按天 ✓' : '按天';
  b.title = envDaily
    ? '当前按天聚合：一天一个点（日均值），阴影带是当天最高 ~ 最低'
    : '把曲线按天聚合：一天一个点，看每天的均温和均湿';
  renderEnvHint();
}

/** 按天明细表。数字列用 tabular-nums 右对齐，扫一眼就能比出哪天更热。 */
function renderEnvDaily() {
  const box = $('#env-daily');
  if (!box) return;
  if (!envDaily) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  if (!envRows.length) {
    box.innerHTML = '<div class="env-daily-hd">还没有可按天统计的读数。</div>';
    return;
  }
  const today = new Date().toDateString();
  // ⚠️ 判空必须显式写：Number(null) === 0，缺数据的那天会显示成 0.0℃ 而不是「—」
  //    （后端在没有温度的那些天给的就是 null）
  const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const n1 = (v, d) => (has(v) ? Number(v).toFixed(d) : '—');
  const rng = (lo, hi, d) => (has(lo) && has(hi) ? n1(lo, d) + ' ~ ' + n1(hi, d) : '—');
  const list = envRows.slice(-MAX_DAILY_ROWS).reverse();      // 最近的排最前
  const span = envRows.length > MAX_DAILY_ROWS
    ? `共 ${envRows.length} 天，下表只列最近 ${MAX_DAILY_ROWS} 天`
    : `共 ${envRows.length} 天`;
  const body = list.map((d) => {
    const isToday = new Date(d.at).toDateString() === today;
    return `<tr>
      <td class="mono">${String(d.day || '').slice(5)}${isToday ? '<span class="tag">今天</span>' : ''}</td>
      <td style="color:${ENV_T_HEX}">${n1(d.t, 1)}</td>
      <td class="mono" style="color:var(--txt-2)">${rng(d.tmin, d.tmax, 1)}</td>
      <td style="color:${ENV_H_HEX}">${n1(d.h, 0)}</td>
      <td class="mono" style="color:var(--txt-2)">${rng(d.hmin, d.hmax, 0)}</td>
      <td class="mono" style="color:var(--txt-3)">${d.n || 0}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="env-daily-hd">按天明细（${span}）</div>
    <table><thead><tr>
      <th>日期</th><th>均温 ℃</th><th>当天最低 ~ 最高 ℃</th>
      <th>均湿 %</th><th>当天最低 ~ 最高 %</th><th>采样点</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

$('#btn-env-daily').onclick = async () => {
  envDaily = !envDaily;
  try { localStorage.setItem('cuk_env_daily', envDaily ? '1' : '0'); } catch (_) {}
  // 打开时窗口太短就自动跳到一个有意义的窗口（一天一个点，1 小时画不出东西）
  if (envDaily && SHORT_RANGES.has(RANGE)) RANGE = '7d';
  envYScale.t = 0; envYScale.h = 0;
  envRows = [];                       // 行形状换了（原始行 ↔ 聚合行），先清空免得混画
  renderEnvDailyBtn(); renderEnvDaily();
  renderRanges(); renderEnvRanges();
  drawEnvChart();
  try {
    await Promise.all([resyncHistory(), pullEnvHistory()]);
    render();
  } catch (err) {
    setLink('error', '取按天数据失败：' + err.message);
  }
};

// 图例开关：温度/湿度各自可关（湿度右侧轴也要跟着让位）
(function bindEnvLegend() {
  const box = $('#env-legend');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const sp = e.target.closest('span[data-k]');
    if (!sp) return;
    const k = sp.dataset.k;
    envHidden[k] = !envHidden[k];
    for (const s of box.querySelectorAll('span[data-k]')) s.classList.toggle('off', !!envHidden[s.dataset.k]);
    drawEnvChart();
  });
})();

// Y 轴量程带滞后（理由同功率：尖峰滑出窗口时不要突然弹回小量程）
const envYScale = { t: 0, tAt: 0, h: 0, hAt: 0 };
function envYMax(kind, need) {
  const cur = kind === 't' ? envYScale.t : envYScale.h;
  const atk = kind === 't' ? 'tAt' : 'hAt';
  const now = Date.now();
  if (need >= cur) { envYScale[kind] = need; envYScale[atk] = now + 4000; return need; }
  if (now < envYScale[atk]) return cur;
  if (need >= cur * 0.8) { envYScale[atk] = now + 4000; return cur; }
  envYScale[kind] = need; envYScale[atk] = now + 4000;
  return need;
}

const ENV_T_HEX = '#ffb27a';
const ENV_H_HEX = '#5cc9f5';
// 断线阈值下限：设备固有粒度是**每小时一条**，1 小时的空档不是断档。
// 设 2 小时 ⇒ 正常的小时间隔连得上，真断档（关机几小时）仍然断开。
// ⚠️ 温湿度**两条线都用**（2026-10-08：温度也用上之后，短窗口里设备点之间
//    不再被误判成断档 —— 之前按本机采样间隔算出来的阈值才 4 分半）。
const ENV_DEV_GAP_MS = 2 * 3600 * 1000;

function drawEnvChart() {
  renderEnvHint();        // 曲线下方那行说明（含"有 N 段空档…"）跟着数据一起刷
  const cv = $('#env-chart');
  if (!cv) return;
  const box = cv.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const FS = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
  const K = FS / 14;
  const showH = !envHidden.h;
  const L = FS * 3.0, R = showH ? FS * 3.0 : FS * 0.86, T = FS * 0.71, B = FS * 1.71;
  const pw = w - L - R, ph = h - T - B;
  const now = Date.now();
  const lastAt = envRows.length ? envRows[envRows.length - 1].at : 0;
  const tEnd = lastAt > now ? lastAt : now;
  const winSec = envWinSec();          // 窗口按温度自己的口径（见 envWinSec），不是功率那条
  const t0 = tEnd - winSec * 1000;
  envCache.t0 = t0; envCache.wsec = winSec;

  const rowsIn = envRows.filter((r) => r.at >= t0);
  const showT = !envHidden.t;

  // 量程：温度按 [min-0.5, max+0.5] 取整，湿度固定 0~100（百分比本来就满量程）
  let tMin = Infinity, tMax = -Infinity;
  for (const r of rowsIn) {
    // 按天模式下"当天最高/最低"也要进量程，否则阴影带会被上下裁掉一截
    const cand = envDaily ? [Number(r.t), Number(r.tmin), Number(r.tmax)] : [Number(r.t)];
    for (const v of cand) { if (Number.isFinite(v)) { if (v < tMin) tMin = v; if (v > tMax) tMax = v; } }
  }
  if (!Number.isFinite(tMin)) { tMin = 15; tMax = 30; }
  if (tMax - tMin < 4) { const c = (tMax + tMin) / 2; tMin = c - 2; tMax = c + 2; }
  tMin -= 0.5; tMax += 0.5;
  const yTMin = Math.floor(tMin), yTMax = Math.ceil(tMax);

  const X = (t) => L + ((t - t0) / (winSec * 1000)) * pw;
  const YT = (v) => T + ph - ((v - yTMin) / Math.max(1e-6, (yTMax - yTMin))) * ph;
  const YH = (v) => T + ph - (Math.max(0, Math.min(100, v)) / 100) * ph;

  // ---- 网格 + 左轴（温度）+ 右轴（湿度）+ 时间轴
  g.font = (FS * 0.71).toFixed(1) + 'px "Segoe UI",sans-serif';
  g.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = yTMin + ((yTMax - yTMin) / 4) * i, y = YT(v);
    g.strokeStyle = 'rgba(122,162,255,.10)';
    g.lineWidth = 1; g.beginPath(); g.moveTo(L, y + .5); g.lineTo(w - R, y + .5); g.stroke();
    if (showT) { g.fillStyle = '#8a7a6d'; g.textAlign = 'right'; g.fillText(v.toFixed(1), L - 7 * K, y); }
    if (showH) {
      g.fillStyle = '#5f8296'; g.textAlign = 'left';
      g.fillText(Math.round(100 - (100 / 4) * i) + '%', w - R + 7 * K, y);
    }
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  // 时间轴刻度：窗口跨度决定格式。⚠️ 不能一律打印 HH:MM:SS —— 跨 7 天以上时
  // 每个刻度会是同一个时刻（"14:30:00" 重复五遍），等于没有时间轴。
  //   跨度 ≥ 30 天  → 月-日（10-05）
  //   跨度 ≥ 2 天   → 月-日 时（10-05 14）
  //   否则          → 时:分:秒
  const spanMs = winSec * 1000;
  //   跨度 ≥ 300 天 → 年-月（26-10：跨年的窗口用"月-日"看不出是哪一年）
  //   跨度 ≥ 30 天  → 月-日（10-05）
  //   跨度 ≥ 2 天   → 月-日 时（10-05 14）
  //   否则          → 时:分:秒
  const tickFmt = spanMs >= 300 * 86400000 ? 'ym'
    : (spanMs >= 30 * 86400000 ? 'md'
    : (spanMs >= 2 * 86400000 ? 'mdh' : 'hms'));
  const p2 = (n) => String(n).padStart(2, '0');
  for (let i = 0; i <= 4; i++) {
    const t = t0 + (spanMs / 4) * i, x = X(t);
    const d = new Date(t);
    g.strokeStyle = 'rgba(122,162,255,.07)';
    g.beginPath(); g.moveTo(x + .5, T); g.lineTo(x + .5, T + ph); g.stroke();
    g.fillStyle = '#5d6d90';
    let label;
    if (tickFmt === 'ym') label = String(d.getFullYear()).slice(2) + '-' + p2(d.getMonth() + 1);
    else if (tickFmt === 'md') label = p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    else if (tickFmt === 'mdh') label = p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours());
    else label = d.toTimeString().slice(0, 8);
    g.fillText(label, x, T + ph + 6 * K);
  }
  if (showT) { g.fillStyle = '#6b5647'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText('℃', 6 * K, T - 1); }
  if (showH) { g.fillStyle = '#4a6a7d'; g.textAlign = 'right'; g.textBaseline = 'top'; g.fillText('%', w - 6 * K, T - 1); }

  if (rowsIn.length < 2) {
    g.fillStyle = '#3f4c68'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = (13 * K).toFixed(1) + 'px "Segoe UI",sans-serif';
    const empty = envDaily
      ? (envRows.length ? '正在积累按天数据…（至少要跨过 2 天）' : '还没有可按天统计的温湿度历史')
      : (envRows.length ? '正在积累数据…' : '还没有温湿度历史（每 90 秒一个点）');
    g.fillText(empty, L + pw / 2, T + ph / 2);
    return;
  }

  // ---- 折线。⚠️ 不补 0：相邻点间隔超过「2.5 倍采样间隔」就断开，
  //      否则 3 小时的空档会被一条斜线跨过去，看着像温度平滑漂移。
  // ---- 折线。⚠️ 不补 0：相邻点间隔超过「该窗口的正常采样间隔」就断开，
  //      否则长空档会被一条斜线跨过去，看着像温度平滑漂移。
  //      ⚠️ 下限不能写死 180 秒：设备内置历史是**每小时一条**，用 180 秒判据的话
  //      156 天那条线上每两个点之间都是"空档"，整条线会碎成 3800 段看不见的短线。
  //      判据必须跟着「窗口内真实的中位间隔」走 —— 用中位数（而不是均值）取基准，
  //      这样"少数几个大空档"不会把基准自己抬上去。
  const ivs = [];
  for (let i = 1; i < rowsIn.length; i++) {
    const dt = rowsIn[i].at - rowsIn[i - 1].at;
    if (dt > 0) ivs.push(dt);
  }
  let medIv = 0;
  if (ivs.length) {
    const s = ivs.slice().sort((a, b) => a - b);
    medIv = s[Math.floor((s.length - 1) / 2)];   // 下中位数（偶数个取偏小那个）
  }
  const gapLimit = Math.max(3 * medIv, 180000, (winSec * 1000 / 400) * 3);
  // opts.skipRibbon === false → **不要**跳过「小时带」那些行。
  // 温度线要跳（带子那一段已经被上面画过了，重复画只会加深），但**湿度必须不跳** ——
  // 湿度没有带子逻辑，那些「设备小时记录」就是它唯一的点源。
  // ⚠️ 2026-10-08 用户报「7 天也没有湿度曲线」就是这里：湿度线跟着温度一起跳，
  //    而长区间里几乎全是小时记录 → 整条线被跳空，只剩零星几个本机采样点。
  // opts.smooth → 对画出来的这一串值跑一次「3 点中值 + 指数平滑」（同功率曲线那个开关）。
  //   ⚠️ 只影响**画线**：悬停气泡、按天明细、导出 CSV 用的都还是原始值。
  //   带子（该小时最低~最高）不平滑 —— 那是真实范围，不能改。
  function stroke(yl, pick, hex, width, opts) {
    const skipRibbon = !(opts && opts.skipRibbon === false);
    // 断线阈值：默认按本机采样间隔算（窗口越短越小）。但**设备的固有粒度是每小时一条**，
    // 那不是"断档"，所以温湿度两条线都要显式传一个更宽的值（见 ENV_DEV_GAP_MS）。
    // ⚠️ 2026-10-08 用户报「三小时湿度是断点」：3 小时档算出来的阈值才 4 分半，
    //    而设备点间隔 1 小时 → 每个点之间都被判成断档，整条湿度线碎成孤立点。
    const gapMs = (opts && opts.gapMs) || gapLimit;
    let vals = envSeries(rowsIn, pick, skipRibbon, isRibbon);
    if (opts && opts.smooth) vals = smoothSegments(vals, 0.35);
    g.beginPath();
    let pen = false;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] == null) { pen = false; continue; }
      const x = X(rowsIn[i].at), y = yl(vals[i]);
      if (pen && i > 0 && (rowsIn[i].at - rowsIn[i - 1].at) > gapMs) pen = false;
      if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
    }
    g.strokeStyle = hex; g.lineWidth = width * K;
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.shadowColor = hex; g.shadowBlur = 8 * K;
    g.stroke(); g.shadowBlur = 0;
  }

  g.save();
  g.beginPath(); g.rect(L, T - 2, pw, ph + 4); g.clip();
  // ---- 设备小时记录：画成"它覆盖的那一小时"的一小段（不是孤点）
  //      设备每小时只记一条（记的是**刚过去的那一小时**的最低/最高），所以一条记录
  //      代表整整一小时的数据。短窗口里如果按点画，看着就是"一个点 + 一大片空白"，
  //      其实那一小时是有数据的（用户 2026-10-06 就是被这个迷惑）。
  //      画法：一条横跨 [at-sp, at] 的均值线。
  //      ⚠️ 原本这里还给该小时铺一块「最低~最高」的橙色阴影带（fillRect）——
  //        2026-10-08 用户说「温度多出来的橙色边去掉」：那条带子的上下沿看着就是
  //        多出来的一圈橙色描边，所以**去掉填充，只留线**；最高/最低没有丢，
  //        悬停提示里照样写着"该小时 22.3 ~ 23.6 ℃"。
  //      窗口长到一小时不足 1px 时（≈ 48 天以上）就退回普通连线，免得出现台阶。
  const pxPerMs = pw / (winSec * 1000);
  const isRibbon = (r) => (Number(r.sp) || 0) * pxPerMs >= 0.6;
  if (!envDaily && showT) {
    for (const r of rowsIn) {
      if (!isRibbon(r)) continue;
      const sp = Number(r.sp);
      const mid = Number(r.t);
      const x0 = Math.max(L, X(r.at - sp)), x1 = Math.min(w - R, X(r.at));
      if (x1 <= x0) continue;
      if (Number.isFinite(mid) && (!envSmooth || !showT)) {
        // ⚠️ 平滑开着、且温度线可见时**不画这一截**：它是一段段水平的台阶，
        //    是"曲线看着不顺"的主因，而且会和下面那条（已含这些点的）平滑折线重叠。
        //    平滑关掉、或温度线被图例隐藏时照旧画它 —— 否则这段时间温度会一片空白。
        g.strokeStyle = ENV_T_HEX; g.lineWidth = 2.0 * K; g.lineCap = 'round';
        g.shadowColor = ENV_T_HEX; g.shadowBlur = 8 * K;
        g.beginPath(); g.moveTo(x0, YT(mid)); g.lineTo(x1, YT(mid)); g.stroke();
        g.shadowBlur = 0;
      }
    }
  }
  // ---- 按天模式先铺「当天最高 ~ 最低」的阴影带（画在均线下面）
  //      同样按 gapLimit 断段：中间缺几天时不能把带子横着连过去。
  if (envDaily && showT) {
    const segs = [];
    let seg = [];
    for (let i = 0; i < rowsIn.length; i++) {
      if (i > 0 && (rowsIn[i].at - rowsIn[i - 1].at) > gapLimit && seg.length) { segs.push(seg); seg = []; }
      const hi = Number(rowsIn[i].tmax), lo = Number(rowsIn[i].tmin);
      if (Number.isFinite(hi) && Number.isFinite(lo)) seg.push([X(rowsIn[i].at), YT(hi), YT(lo)]);
    }
    if (seg.length) segs.push(seg);
    g.fillStyle = 'rgba(255,178,122,.15)';
    for (const s of segs) {
      if (s.length < 2) continue;
      g.beginPath();
      g.moveTo(s[0][0], s[0][1]);
      for (let i = 1; i < s.length; i++) g.lineTo(s[i][0], s[i][1]);
      for (let i = s.length - 1; i >= 0; i--) g.lineTo(s[i][0], s[i][2]);
      g.closePath();
      g.fill();
    }
  }
  // 设备小时记录的固有间隔（1 小时）不算"断档" —— 温湿度两条线共用这个下限。
  const devGap = Math.max(gapLimit, ENV_DEV_GAP_MS);
  // ---- 温度折线
  //     ⚠️ 平滑开着时**不跳过**"小时带"那些行（skipRibbon:false）。
  //     2026-10-08 用户报「只平滑了湿度，温度没效果」：短窗口里几乎每一行都是设备小时
  //     记录，全被 skipRibbon 置成 null → 连续段长度不足 3，smoothValues 直接原样返回，
  //     温度那条线（连同带子里那截台阶均值线）自然纹丝不动。
  //     平滑关掉时保持原样：跳带子行 + 带子里的台阶均值线 = 原始台阶视图。
  if (showT) {
    stroke(YT, (r) => r.t, ENV_T_HEX, 2.0, { smooth: envSmooth, skipRibbon: !envSmooth, gapMs: devGap });
  }
  if (showH) {
    // ⚠️ 湿度线必须**带底衬**（2026-10-08 用户报「湿度曲线没有了」）。
    //    原因：湿度是 0~100% 轴，实测常在 36~38% → 落在图的下部；而温度从 v1.8.3 起
    //    画成「该小时最低~最高」的橙色带子，正好也覆盖那一片 —— 1.5px 的浅蓝细线
    //    被半透明橙色填充吃掉了，看着像没画（悬停里其实一直有湿度的数）。
    //    做法：先压一条深色粗线打底，再画亮蓝细线，任何背景上都清楚。
    // 设备每小时才记一条 —— 它的固有间隔不算"断档"（阈值见上面的 devGap）。
    stroke(YH, (r) => r.h, 'rgba(7,11,20,.55)', 4.0, { skipRibbon: false, smooth: envSmooth, gapMs: devGap });
    stroke(YH, (r) => r.h, ENV_H_HEX, 2.0, { skipRibbon: false, smooth: envSmooth, gapMs: devGap });
  }
  g.restore();

  // 末端圆点
  const lastRow = rowsIn[rowsIn.length - 1];
  if (lastRow) {
    const dots = [];
    if (showT && Number.isFinite(Number(lastRow.t))) dots.push([X(lastRow.at), YT(Number(lastRow.t)), ENV_T_HEX]);
    if (showH && Number.isFinite(Number(lastRow.h))) dots.push([X(lastRow.at), YH(Number(lastRow.h)), ENV_H_HEX]);
    for (const [x, y, hex] of dots) {
      if (x < L - 2) continue;
      g.beginPath(); g.arc(x, y, 2.8 * K, 0, Math.PI * 2);
      g.fillStyle = hex; g.fill();
      g.strokeStyle = 'rgba(7,11,20,.9)'; g.lineWidth = 2 * K; g.stroke();
    }
  }
}

// 温湿度悬停提示：与 drawEnvChart 共用 X()/量程缓存，避免两边映射错位
(function bindEnvTip() {
  const cv = $('#env-chart'), tip = $('#env-tip');
  if (!cv) return;
  cv.addEventListener('mousemove', (e) => {
    if (envRows.length < 1) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    const K = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 14) / 14;
    const showH = !envHidden.h;
    const R = showH ? 42 * K : 12 * K;
    const wsec = envCache.wsec || WINDOW_SEC;   // 与 drawEnvChart 同一个窗口（见 envWinSec）
    const t0 = envCache.t0 || (Date.now() - wsec * 1000);
    const t = t0 + (x - 42 * K) / Math.max(1, (r.width - 42 * K - R)) * wsec * 1000;
    let best = null;
    for (const q of envRows) if (!best || Math.abs(q.at - t) < Math.abs(best.at - t)) best = q;
    if (!best) return;
    const dt = new Date(best.at);
    // 同上：判空要显式（Number(null) === 0 会把缺数据显示成 0.0℃）
    const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    const n1 = (v, d) => (has(v) ? Number(v).toFixed(d) : '—');
    let h;
    if (envDaily) {
      // 按天：标题是日期，并额外给出"当天最高~最低" —— 一天一个点的时候，
      // 只看均值看不出那天的温差有多大。
      h = `<b>${best.day || dt.toDateString()}</b><div class="env-tip-rows">`;
      if (!envHidden.t) {
        h += `<span style="color:${ENV_T_HEX}">■ 均温</span><b>${n1(best.t, 1)} ℃</b>`;
        h += `<span style="color:${ENV_T_HEX}">■ 当天</span><b>${n1(best.tmin, 1)} ~ ${n1(best.tmax, 1)} ℃</b>`;
      }
      if (!envHidden.h) {
        h += `<span style="color:${ENV_H_HEX}">■ 均湿</span><b>${n1(best.h, 0)} %</b>`;
        h += `<span style="color:${ENV_H_HEX}">■ 当天</span><b>${n1(best.hmin, 0)} ~ ${n1(best.hmax, 0)} %</b>`;
      }
      h += `<span>采样点</span><b>${best.n || 0}</b></div>`;
    } else {
      const ttl = (Number(best.sp) > 0)
        ? dt.toTimeString().slice(0, 8) + ' 的设备记录（覆盖前 1 小时）'
        : dt.toTimeString().slice(0, 8);
      h = `<b>${ttl}</b><div class="env-tip-rows">`;
      if (!envHidden.t) h += `<span style="color:${ENV_T_HEX}">■ 温度</span><b>${n1(best.t, 1)} ℃</b>`;
      if (!envHidden.h) h += `<span style="color:${ENV_H_HEX}">■ 湿度</span><b>${n1(best.h, 0)} %</b>`;
      // 小时记录带上下沿：那一条带子表示"这一小时里最低~最高"
      if (!envHidden.t && has(best.tmin)) h += `<span style="color:${ENV_T_HEX}">■ 该小时</span><b>${n1(best.tmin, 1)} ~ ${n1(best.tmax, 1)} ℃</b>`;
      if (!envHidden.h && has(best.hmin)) h += `<span style="color:${ENV_H_HEX}">■ 该小时</span><b>${n1(best.hmin, 0)} ~ ${n1(best.hmax, 0)} %</b>`;
      h += '</div>';
    }
    tip.innerHTML = h;
    tip.style.opacity = '1';
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(4, x + 14 * K), r.width - tw - 4) + 'px';
    tip.style.top = Math.max(4, e.clientY - r.top - 46 * K) + 'px';
  });
  cv.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
})();

// ------------------------------------------------------------------ 图表
const SERIES = [
  { key: 'total', name: '总功率', hex: TOTAL_HEX, area: true },
  { key: 'c1', name: 'C1', hex: PORT_HEX.c1 },
  { key: 'c2', name: 'C2', hex: PORT_HEX.c2 },
  { key: 'c3', name: 'C3', hex: PORT_HEX.c3 },
  { key: 'a',  name: 'USB-A', hex: PORT_HEX.a },
];

function renderLegend() {
  if ($('#legend').childElementCount) return;
  $('#legend').innerHTML = SERIES.map((s) =>
    `<span data-k="${s.key}" class="${hidden[s.key] ? 'off' : ''}"><i style="background:${s.hex}"></i>${s.name}</span>`).join('');
  $('#legend').addEventListener('click', (e) => {
    const sp = e.target.closest('span'); if (!sp) return;
    const k = sp.dataset.k; hidden[k] = !hidden[k];
    renderLegend(); drawChart();
  });
}

function niceMax(v) {
  if (v <= 5) return 5;
  const steps = [10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 200];
  for (const s of steps) if (v <= s) return s;
  return Math.ceil(v / 50) * 50;
}

// Y 轴量程带「滞后」：涨上去立刻生效（不能把尖峰切掉），回落要慢半拍。
// 否则一个尖峰滑出窗口，整条曲线会**突然从 30W 量程弹回 20W**，看着像在跳。
const yScale = { max: 0, shrinkAt: 0 };
function yMaxFor(need) {
  const now = Date.now();
  if (need >= yScale.max) { yScale.max = need; yScale.shrinkAt = now + 4000; return yScale.max; }
  if (now < yScale.shrinkAt) return yScale.max;
  if (need >= yScale.max * 0.8) { yScale.shrinkAt = now + 4000; return yScale.max; }
  yScale.max = need; yScale.shrinkAt = now + 4000;   // 明显用不到那么大，才缩一档
  return yScale.max;
}

/** 3 点中值（干掉单点毛刺） + 指数平滑（压掉 PPS 在两档之间来回抖的锯齿）。
 *  只影响**画出来的线**：卡片上的数字、悬停提示、落盘数据全是原始值。
 *
 *  α 的取舍（实测过）：这种锯齿是"采样率级别的方波"，3 点中值对它基本无效
 *  （中值自己也跟着两档跳），必须靠低通。α=0.35 只能把峰峰值压掉 3 成，
 *  α=0.2 能压掉 近 9 成，代价是阶跃响应约 5 个采样（0.5s 采样 ≈ 2.5 秒）。
 *  1 分钟以上的视图本来就不看瞬变，这个代价可以接受；想要原始抖动就关掉「平滑」。 */
function smoothValues(arr, alpha) {
  const n = arr.length;
  if (n < 3) return arr.slice();
  const med = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = arr[i - 1] != null ? arr[i - 1] : arr[i];
    const b = arr[i];
    const c = arr[i + 1] != null ? arr[i + 1] : arr[i];
    med[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  if (alpha >= 1) return med;
  const out = new Array(n);
  out[0] = med[0];
  for (let i = 1; i < n; i++) out[i] = out[i - 1] + (med[i] - out[i - 1]) * alpha;
  return out;
}

/** 把"要画的那一串值"取出来（null = 这一行不画）。
 *
 *  单独抽成函数是为了能**离线回归**（测试见 tools/test_env_smooth.js）——取值规则出过两次 bug：
 *    ① 湿度跟着温度一起跳过「小时带」行 → 长区间里整条湿度线被跳空（2026-10-08）；
 *    ② 温度**自己**跳过之后，短窗口里几乎每一行都是设备小时记录，全被置 null，
 *       连续段长度不足 3，smoothValues 原样返回 → 平滑开关对温度完全无效
 *       （2026-10-08 用户报「只平滑了湿度，温度没效果」）。
 *
 *  skipRibbon=true ⇒ 跳过「已经铺成带子」的那些行（它们的均值线由带子那一段负责画）。
 */
function envSeries(rowsIn, pick, skipRibbon, isRibbonFn) {
  return rowsIn.map((r) => {
    if (skipRibbon && isRibbonFn(r)) return null;
    const raw = pick(r);
    // ⚠️ 必须拿**原始值**判空：Number(null) === 0、Number('') === 0 —— 直接 Number() 会把
    //    缺数据的行画成 0℃（温度轴是 20~26 的话，整条曲线的 y 轴会被它拉到 0，全被压平）。
    if (raw === null || raw === undefined || raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  });
}

/** 只对**连续段**做平滑 —— 空档（null）处不跨着抹，否则会把真断档连成假趋势。 */
function smoothSegments(vals, alpha) {
  const out = vals.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i] == null) { i += 1; continue; }
    let j = i;
    while (j < out.length && out[j] != null) j += 1;
    const seg = smoothValues(out.slice(i, j), alpha);
    for (let k = i; k < j; k += 1) out[k] = seg[k - i];
    i = j;
  }
  return out;
}

/** 按采样间距挑平滑强度：原始采样（≤3s）用强平滑，分钟级降采样数据只做轻度处理。
 *  对已经按分钟平均过的数据再套强平滑，会把真实趋势也拖平（那是失真，不是平滑）。 */
function alphaForGap(gapMs) {
  if (!gapMs || gapMs <= 3000) return 0.2;
  if (gapMs <= 70000) return 0.5;
  return 1;                 // 更粗的数据：只保留中值滤波，不再叠加惯性
}

// 空档补零：相邻两点间隔远大于正常采样间隔 = 中间没有数据（应用没开 / 采集中断）。
// 不能把两端直接连起来 —— 那会画成一条缓慢变化的斜线，看着像那段时间功率在渐变。
// 补两个 0 值点：曲线在前一个点之后垂直掉到 0、贴着 0 走、再在下个点前垂直抬回来。
// 正常间隔取中位数（原始采样 ≈1.5s、每分钟行 ≈60s，对偶尔的丢点免疫），
// 间隔超过 4 倍且 ≥90s 才算空档 —— 一两分钟的丢点仍直接连线，不值得掉零。
function fillGaps(list) {
  if (list.length < 2) return list.slice();
  const gaps = [];
  for (let i = 1; i < list.length; i++) gaps.push(list[i].at - list[i - 1].at);
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor((gaps.length - 1) / 2)] || 0;   // 下中位：偶数个 gap 时取小的那个，宁可不补也别误补
  const lim = Math.max(med * 4, 90000);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    out.push(list[i]);
    const dt = i + 1 < list.length ? list[i + 1].at - list[i].at : 0;
    if (dt > lim) {
      const half = lim / 4;
      out.push({ at: list[i].at + half, total: 0, peak: 0, w: {} });
      out.push({ at: list[i + 1].at - half, total: 0, peak: 0, w: {} });
    }
  }
  return out;
}

function drawChart() {
  const cv = $('#chart'), box = cv.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = box.clientWidth, h = box.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  // 图表内部度量随根字号缩放，这样窗口放大时坐标轴/字号也跟着变大，不会显得空。
  // ⚠️ 这个函数现在每秒会被 rAF 调用 ~12 次（时间轴平滑滑动），所以尺寸与字号都缓存，
  //    只在盒子尺寸真的变了时才重新读 getComputedStyle。
  if (!chartCache.fs || chartCache.w !== w || chartCache.h !== h) {
    chartCache.w = w; chartCache.h = h;
    chartCache.fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
  }
  const FS = chartCache.fs;
  const K = FS / 14;                       // 相对设计基准字号(14px)的缩放系数
  const L = FS * 3.0, R = FS * 0.86, T = FS * 0.71, B = FS * 1.71;
  const pw = w - L - R, ph = h - T - B;
  const now = Date.now();
  // 右边界取「现在」与「最后一个点」的较大者：采样时钟比浏览器时钟快几十毫秒时，
  // 最新点会落在绘图区右侧之外（画到坐标轴外面去），视觉上就是曲线末端一顿一顿地抽。
  const lastAt = rows.length ? rows[rows.length - 1].at : 0;
  const tEnd = lastAt > now ? lastAt : now;
  const t0 = tEnd - WINDOW_SEC * 1000;
  chartT0 = t0;

  // 先把各序列的原始值取出来（隐藏的跳过），再按需平滑。
  // ⚠️ 用 fillGaps 补过零点的列表：没有数据的时段要画 0，不能把空档两端直接连成斜线。
  const list = fillGaps(rows);
  const raws = [];
  let maxV = 0;
  for (const s of SERIES) {
    if (hidden[s.key]) continue;
    const v = list.map((r) => Number(s.key === 'total' ? r.total : (r.w ? r.w[s.key] : 0)) || 0);
    for (const x of v) if (x > maxV) maxV = x;
    raws.push([s, v]);
  }
  const yMax = yMaxFor(niceMax(maxV * 1.12));

  const X = (t) => L + ((t - t0) / (WINDOW_SEC * 1000)) * pw;
  const Y = (v) => T + ph - (Math.max(0, v) / yMax) * ph;

  // 网格
  g.font = (FS * 0.71).toFixed(1) + 'px "Segoe UI",sans-serif';
  g.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i, y = Y(v);
    g.strokeStyle = 'rgba(122,162,255,.10)';
    g.lineWidth = 1; g.beginPath(); g.moveTo(L, y + .5); g.lineTo(w - R, y + .5); g.stroke();
    g.fillStyle = '#5d6d90'; g.textAlign = 'right';
    g.fillText(String(Math.round(v)), L - 7 * K, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  // 时间轴刻度：窗口跨度决定格式。⚠️ 不能一律打印 HH:MM:SS —— 跨 7 天以上时
  // 每个刻度会是同一个时刻（"14:30:00" 重复五遍），等于没有时间轴。
  //   跨度 ≥ 30 天  → 月-日（10-05）
  //   跨度 ≥ 2 天   → 月-日 时（10-05 14）
  //   否则          → 时:分:秒
  const spanMs = WINDOW_SEC * 1000;
  //   跨度 ≥ 300 天 → 年-月（26-10：跨年的窗口用"月-日"看不出是哪一年）
  //   跨度 ≥ 30 天  → 月-日（10-05）
  //   跨度 ≥ 2 天   → 月-日 时（10-05 14）
  //   否则          → 时:分:秒
  const tickFmt = spanMs >= 300 * 86400000 ? 'ym'
    : (spanMs >= 30 * 86400000 ? 'md'
    : (spanMs >= 2 * 86400000 ? 'mdh' : 'hms'));
  const p2 = (n) => String(n).padStart(2, '0');
  for (let i = 0; i <= 4; i++) {
    const t = t0 + (spanMs / 4) * i, x = X(t);
    const d = new Date(t);
    g.strokeStyle = 'rgba(122,162,255,.07)';
    g.beginPath(); g.moveTo(x + .5, T); g.lineTo(x + .5, T + ph); g.stroke();
    g.fillStyle = '#5d6d90';
    let label;
    if (tickFmt === 'ym') label = String(d.getFullYear()).slice(2) + '-' + p2(d.getMonth() + 1);
    else if (tickFmt === 'md') label = p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    else if (tickFmt === 'mdh') label = p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours());
    else label = d.toTimeString().slice(0, 8);
    g.fillText(label, x, T + ph + 6 * K);
  }
  g.fillStyle = '#3f4c68'; g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillText('W', 6 * K, T - 1);

  if (rows.length < 2) {
    g.fillStyle = '#3f4c68'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = (13 * K).toFixed(1) + 'px "Segoe UI",sans-serif';
    g.fillText('正在积累数据…', L + pw / 2, T + ph / 2);
    return;
  }

  // 裁剪到绘图区：平滑/外推都不会画到坐标轴外面。
  g.save();
  g.beginPath(); g.rect(L, T - 2, pw, ph + 4); g.clip();
  // 点太多时抽稀再画（10 分钟区间有 1200 个点，每帧都画不值得）。
  const stride = Math.max(1, Math.ceil(list.length / 700));
  const gap = list.length > 1 ? (list[list.length - 1].at - list[0].at) / (list.length - 1) : 0;
  const alpha = alphaForGap(gap);
  for (const [s, vRaw] of raws) {
    const v = smoothOn ? smoothValues(vRaw, alpha) : vRaw;
    const pts = [];
    for (let i = 0; i < list.length; i += stride) pts.push({ x: X(list[i].at), y: Y(v[i]) });
    const li = list.length - 1;
    if (pts.length && pts[pts.length - 1].x !== X(list[li].at)) pts.push({ x: X(list[li].at), y: Y(v[li]) });
    if (s.area) {
      const grad = g.createLinearGradient(0, T, 0, T + ph);
      grad.addColorStop(0, 'rgba(56,189,248,.28)');
      grad.addColorStop(1, 'rgba(56,189,248,0)');
      g.beginPath(); g.moveTo(pts[0].x, T + ph);
      for (const p of pts) g.lineTo(p.x, p.y);
      g.lineTo(pts[pts.length - 1].x, T + ph); g.closePath();
      g.fillStyle = grad; g.fill();
    }
    g.beginPath();
    for (let i = 0; i < pts.length; i++) (i ? g.lineTo : g.moveTo).call(g, pts[i].x, pts[i].y);
    g.strokeStyle = s.hex; g.lineWidth = (s.area ? 2.2 : 1.6) * K;
    g.lineJoin = 'round'; g.lineCap = 'round';
    if (s.area) { g.shadowColor = s.hex; g.shadowBlur = 12 * K; }
    g.stroke(); g.shadowBlur = 0;

    const lp = pts[pts.length - 1];
    if (lp.x > L - 2) {
      g.beginPath(); g.arc(lp.x, lp.y, (s.area ? 3.6 : 2.6) * K, 0, Math.PI * 2);
      g.fillStyle = s.hex; g.fill();
      g.strokeStyle = 'rgba(7,11,20,.9)'; g.lineWidth = 2 * K; g.stroke();
    }
  }
  g.restore();
}

// 悬停提示
(function bindTip() {
  const cv = $('#chart'), tip = $('#tip');
  cv.addEventListener('mousemove', (e) => {
    if (rows.length < 1) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    // 与 drawChart 用同一套映射：左边距 L=3rem、右侧 R=0.86rem。
    // ⚠️ 时间轴左端要用 drawChart 存下来的 chartT0，不能各自算一遍 ——
    //    两边差几十毫秒，鼠标指到的地方和提示的点就会错位。
    const K = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 14) / 14;
    const t0 = chartT0 || (Date.now() - WINDOW_SEC * 1000);
    const t = t0 + (x - 42 * K) / Math.max(1, (r.width - 54 * K)) * WINDOW_SEC * 1000;
    // 与曲线同一套补零：鼠标指到没有数据的空档中间时，提示也显示 0，
    // 而不是空档旁边几小时前的旧值。
    const list = fillGaps(rows);
    let best = list[0];
    for (const q of list) if (Math.abs(q.at - t) < Math.abs(best.at - t)) best = q;
    const dt = new Date(best.at);
    let h = `<b>${dt.toTimeString().slice(0, 8)}</b>`;
    for (const s of SERIES) {
      if (hidden[s.key]) continue;
      const v = s.key === 'total' ? best.total : (best.w ? best.w[s.key] : 0);
      h += `<br><span style="color:${s.hex}">■</span> ${s.name} <b style="float:right;margin-left:1rem">${fmtW(v)} W</b>`;
    }
    tip.innerHTML = h;
    tip.style.opacity = '1';
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(4, x + 14 * K), r.width - tw - 4) + 'px';
    tip.style.top = Math.max(4, e.clientY - r.top - 46 * K) + 'px';
  });
  cv.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
})();

// ------------------------------------------------------------------ 日志
async function pullLog() {
  try {
    const j = await api('/api/log');
    const el = $('#log');
    el.textContent = (j.lines || []).join('\n');
    el.scrollTop = el.scrollHeight;
    $('#log-tag').textContent = (j.lines || []).length + ' 行';
  } catch (_) {}
}

// ------------------------------------------------------------------ 登录
function openLogin(open) {
  $('#login-layer').classList.toggle('hidden', !open);
}
$('#btn-login').onclick = () => openLogin(true);
$('#btn-login-close').onclick = () => openLogin(false);

// 「网络自检」：登录报证书错时，让用户自己也能看到结论 —— 而不是只看到一行
// "Basic Constraints of CA cert not marked critical"。结论分三种，处置完全不同：
//   ok           证书链正常
//   strict-only  只是 Python 3.13 的严格模式误判了小米证书链（本程序已自动放宽）
//   missing-root 本机信任库缺根证书（不是被拦；程序已随包带根，登录照常可用）
//   mitm         本机/本网络在解密 HTTPS（抓包工具 / 杀软网页防护 / 公司 VPN / 网关）
//   expired      系统时间不对      unreachable 根本没连上（DNS/防火墙/代理）
$('#btn-login-diag').onclick = async () => {
  const b = $('#btn-login-diag'), box = $('#login-diag');
  const esc = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const old = b.textContent;
  b.disabled = true; b.textContent = '自检中…';
  box.style.display = 'block';
  box.textContent = '正在测试到小米服务器的 HTTPS 连接（约几秒）…';
  try {
    const p = await api('/api/diag/tls?force=1');
    if (!p.ok) {
      box.innerHTML = '<b class="bad">自检没能跑起来</b>\n' + esc(p.error || '未知原因');
      return;
    }
    const cls = (p.verdict === 'ok' || p.verdict === 'strict-only') ? 'ok'
      : (p.verdict === 'missing-root' ? 'warn' : 'bad');
    const head = ({
      ok: '证书链正常',
      'strict-only': '证书链正常（仅 Python 3.13 的严格模式会误判，本程序已自动放宽）',
      'missing-root': '这台电脑的证书库里缺一张根证书（不是网络被拦）',
      mitm: '本机或本网络在解密 HTTPS —— 先别输密码',
      expired: '系统时间不对（证书不在有效期内）',
      unreachable: '连不上小米服务器（不是证书问题）',
    })[p.verdict] || ('结论：' + p.verdict);
    let html = `<b class="${cls}">${head}</b>\n`;
    for (const h of (p.hosts || [])) {
      html += `· ${esc(h.host)}：${h.relaxed.ok ? '可以连上' : '连不上（' + esc(h.relaxed.error) + '）'}\n`;
    }
    if (p.missingRoot) html += `· 缺的根证书：${esc(p.missingRoot)}\n`;
    for (const a of (p.advice || [])) html += '· ' + esc(a) + '\n';
    if (p.reportFile) html += '完整报告：' + esc(p.reportFile);
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = '<b class="bad">自检失败</b>\n' + esc(e.message);
  } finally {
    b.disabled = false; b.textContent = old;
  }
};

$('#btn-login-start').onclick = async () => {
  const btn = $('#btn-login-start');
  btn.disabled = true; btn.textContent = '正在申请…';
  $('#login-msg').textContent = '正在向小米云申请二维码…';
  const s = await api('/api/login/start', { method: 'POST' });
  if (!s.ok) {
    $('#login-msg').innerHTML = '<span style="color:var(--bad)">' + (s.error || '申请失败') + '</span>';
    btn.disabled = false; btn.textContent = '重试'; return;
  }
  $('#qrbox').innerHTML = '<img src="/api/login/qr.png?t=' + Date.now() + '" alt="登录二维码">';
  $('#login-msg').textContent = '请用米家 App 扫码，然后在手机上确认授权（二维码 ' + s.timeout + ' 秒内有效）…';
  const p = await api('/api/login/poll', { method: 'POST' });
  if (!p.ok) {
    $('#login-msg').innerHTML = '<span style="color:var(--bad)">' + (p.error || '无法开始等待') + '</span>';
    btn.disabled = false; btn.textContent = '重试'; return;
  }
  btn.textContent = '等待授权…';
  const iv = setInterval(async () => {
    const st = await api('/api/state');
    if (st.login && !st.login.running) {
      clearInterval(iv);
      btn.disabled = false;
      if (st.login.result && st.login.result.ok) {
        $('#login-msg').innerHTML = '<span style="color:var(--ok)">✓ 授权成功，正在重启采集器…</span>';
        setTimeout(() => openLogin(false), 1600);
      } else {
        $('#login-msg').innerHTML = '<span style="color:var(--bad)">✗ ' +
          ((st.login.result && st.login.result.error) || '登录失败') + '</span>';
        btn.textContent = '重新生成二维码';
      }
    }
  }, 2000);
};

// ------------------------------------------------------------------ 操作
// 曲线区间切换
function renderRanges() {
  $('#ranges').innerHTML = RANGES.map(([k, label]) =>
    `<button class="${k === RANGE ? '' : 'ghost'}" data-range="${k}"
       style="padding:0.21rem 0.64rem;font-size:0.82rem">${label}</button>`).join('');
  const cur = RANGES.find(([k]) => k === RANGE);
  $('#win-tag').textContent = '最近 ' + (cur ? cur[1] : RANGE);
}
$('#ranges').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-range]');
  if (!b || b.dataset.range === RANGE) return;
  RANGE = b.dataset.range;
  yScale.max = 0;                 // 换区间要把量程滞后清掉，否则会拿旧区间的大刻度画小数据
  envYScale.t = 0; envYScale.h = 0;
  renderRanges();                 // 先给反馈：按钮高亮 + 「最近 X」立刻变
  renderEnvRanges();              // 温度曲线的区间按钮/标题也跟着走
  // ⚠️ 这里以前还写了一行 `lastMinute = 0;`（一个没用上的想法的残留），但那个变量
  //    从未声明 —— 在 'use strict' 下直接抛 ReferenceError，点击处理器当场中断，
  //    区间按钮于是"点了半天才变"（实际是等 30 秒后的后台校正）。别再写裸赋值。
  try {
    // 只取曲线数据，不重复取 state；两条曲线共用同一区间，一起拉。
    await Promise.all([resyncHistory(), pullEnvHistory()]);
    render();
  } catch (err) {
    setLink('error', '取曲线数据失败：' + err.message);
  }
});
renderRanges();

// 曲线平滑开关（默认开；只影响画出来的线，面板数字与落盘数据始终是原始值）
$('#in-smooth').checked = smoothOn;
$('#in-smooth').onchange = (e) => {
  smoothOn = e.target.checked;
  try { localStorage.setItem('cuk_smooth', smoothOn ? '1' : '0'); } catch (_) {}
  drawChart();
};

// 温湿度曲线的平滑开关（独立于功率曲线那个）
$('#env-smooth').checked = envSmooth;
$('#env-smooth').onchange = (e) => {
  envSmooth = e.target.checked;
  try { localStorage.setItem('cuk_env_smooth', envSmooth ? '1' : '0'); } catch (_) {}
  drawEnvChart();
};

// ---- 温度计卡片折叠（2026-10-08 用户要求）--------------------------------
// 「有的人用不上」那张温湿度卡：收成一行标题就行。内容一个字都不删，展开就回来；
// 收起状态记在 localStorage，刷新 / 重开窗口都保持。
// ⚠️ 收起期间不画曲线（canvas 宽为 0，drawEnvChart 自己会 return），**展开时补一次重画**。
//    初始化那次不重画：drawEnvChart 依赖模块里靠后的 const，早期调用会撞 TDZ
//    （pullEnvHistory 那次就踩过）。
let envFolded = false;
try { envFolded = localStorage.getItem('cuk_env_folded') === '1'; } catch (_) {}

function applyEnvFold(redraw) {
  const cardEl = $('#env-card'), btn = $('#env-fold'), sum = $('#env-fold-sum');
  if (cardEl) cardEl.classList.toggle('folded', envFolded);
  if (btn) {
    btn.textContent = envFolded ? '展开' : '收起';
    btn.setAttribute('aria-expanded', envFolded ? 'false' : 'true');
    btn.title = envFolded
      ? '展开温度计卡片（曲线、设置都还在）'
      : '收起整张温度计卡片 —— 用不上温度计时可以收起来';
  }
  if (sum) sum.hidden = !envFolded;
  if (redraw && !envFolded) drawEnvChart();
}

if ($('#env-fold')) {
  $('#env-fold').onclick = () => {
    envFolded = !envFolded;
    try { localStorage.setItem('cuk_env_folded', envFolded ? '1' : '0'); } catch (_) {}
    applyEnvFold(true);
  };
  applyEnvFold(false);
}

// 导出 CSV：用隐藏的 a[download] 触发下载，不会把应用窗口导航走
Array.prototype.forEach.call(document.querySelectorAll('[data-export]'), (b) => {
  b.onclick = () => {
    const a = document.createElement('a');
    a.href = '/api/export?what=' + b.dataset.export;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
});

$('#btn-reconnect').onclick = async () => { await api('/api/reconnect', { method: 'POST' }); tick(); };
// 让位：蓝牙同时只允许一个中心端，电脑连着时手机米家连广播都收不到（实测）。
$('#btn-yield').onclick = async () => {
  const js = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  if (last && last.yield && last.yield.active) {
    await api('/api/yield', Object.assign({ body: JSON.stringify({ cancel: true }) }, js));
  } else {
    const raw = prompt('释放蓝牙多少分钟给手机米家？（1–120）\n这期间本应用不看充电头，到点自动收回。', '10');
    const min = parseInt(raw, 10);
    if (!min) return;
    await api('/api/yield', Object.assign({ body: JSON.stringify({ minutes: min }) }, js));
  }
  tick();
};
// 事件通知开关（充满 / 掉线）即时生效
$('#btn-quit').onclick = async () => { try { await api('/api/quit', { method: 'POST' }); } catch (_) {} window.close(); };
$('#btn-cfg').onclick = async () => {
  const v = parseFloat($('#in-interval').value);
  const j = await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interval: v, tray: $('#in-tray').checked }),
  });
  $('#btn-cfg').textContent = j.ok ? '已应用' : '失败';
  setTimeout(() => { $('#btn-cfg').textContent = '应用'; }, 1200);
};

// ---- 温度计设置 ----
$('#env-save').onclick = async () => {
  const addr = ($('#env-addr').value || '').trim().toUpperCase();
  const itv = parseFloat($('#env-int').value);
  const btn = $('#env-save');
  btn.textContent = '保存中…';
  const j = await api('/api/env/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: addr, interval: itv }),
  });
  btn.textContent = j.ok ? '已重启' : '失败';
  setTimeout(() => { btn.textContent = '保存并重启温度计'; }, 1400);
  if (j.ok && j.env && last) { last.envSensor = j.env; renderEnv(); }
};
$('#env-probe').onclick = async () => {
  const box = $('#env-note');
  if (box) box.innerHTML = '正在扫描广播（约 10 秒）…';
  try { await api('/api/env/probe', { method: 'POST' }); } catch (_) {}
};
$('#env-toggle').onclick = async () => {
  const cur = (last && last.envSensor && last.envSensor.enabled) !== false;
  const j = await api('/api/env/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !cur }),
  });
  if (j.ok && j.env && last) { last.envSensor = j.env; renderEnv(); }
};
$('#env-hist-read').onclick = async () => {
  const btn = $('#env-hist-read'), st = $('#env-hist-status');
  if (btn) btn.disabled = true;
  if (st) st.textContent = '启动中…';
  try {
    const j = await api('/api/env/history-read', { method: 'POST' });
    if (!j.ok) {
      if (st) st.textContent = j.error || '无法启动';
      if (btn) btn.disabled = false;
    }
    // 启动成功则等 SSE 'envhist' 事件驱动状态与进度
  } catch (_) {
    if (st) st.textContent = '请求失败';
    if (btn) btn.disabled = false;
  }
};
// 托盘开关单独即时生效，不用点「应用」
$('#in-tray').onchange = async (e) => {  await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tray: e.target.checked }),
  });
};
// 托盘显示模式（仅总功率 / 全部功率轮流）同样即时生效
// 托盘显示模式（仅总功率 / 全部功率轮流）同样即时生效
$('#in-notify').onchange = async (e) => {
  await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notify: e.target.checked }),
  });
};
$('#in-traymode').onchange = async (e) => {
  await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trayMode: e.target.value }),
  });
};
// 自动断电（5V 空载）：每个控件改完就存，不用点「应用」。
// ⚠️ 数字框用 change（失焦/回车）而不是 input —— 每敲一个字符就 POST 一次，
//    输 "0.02" 的过程里会把 0 / 0.0 逐次写进配置，阈值瞬间变成 0A（等于见谁关谁）。
const aoSave = async (patch) => {
  try {
    await api('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoOff: patch }),
    });
  } catch (_) {}
};
// 启用开关：和「端口开关」同一套 .switch 组件（点一下拨过去，等回包时置 busy）。
// 服务端下一个 state 帧会把类名纠正成真实值，所以这里只做"乐观切换"。
$('#ao-on').onclick = async (e) => {
  const sw = e.currentTarget;
  if (sw.classList.contains('busy')) return;
  const on = !sw.classList.contains('on');
  sw.classList.add('busy');
  sw.classList.toggle('on', on);
  try { await aoSave({ enabled: on }); } finally {
    setTimeout(() => sw.classList.remove('busy'), 500);
  }
};
$('#ao-skipa').onchange = (e) => aoSave({ skipSmallA: e.target.checked });
$('#ao-v').onchange = (e) => aoSave({ vMin: parseFloat(e.target.value) });
$('#ao-i').onchange = (e) => aoSave({ iMax: parseFloat(e.target.value) });
$('#ao-sec').onchange = (e) => aoSave({ idleSec: parseInt(e.target.value, 10) });
$('#ao-restore').onchange = (e) => aoSave({ restoreMin: parseInt(e.target.value, 10) });

// 异常检查（有电压没电流）：明细走独立接口 —— /api/state 每秒推一次，
// 把几十条事件塞进去纯属浪费。这里 5 秒拉一次，页面不可见时不拉。
function aoRender(j) {
  const esc = (t) => String(t == null ? '' : t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const portName = (p) => (String(p).toLowerCase() === 'a' ? 'USB-A' : String(p).toUpperCase());
  const st = j.stats || {};
  $('#ao-today').textContent = String(st.today || 0);
  $('#ao-cut-today').textContent = String(st.cutToday || 0);
  $('#ao-idle').textContent = ((st.idleMsToday || 0) / 60000).toFixed(1);
  $('#ao-total').textContent = String(st.total || 0);

  const open = j.open || [];
  $('#ao-open').innerHTML = open.length
    ? '进行中：' + open.map((o) => `<b>${esc(portName(o.port))}</b> 已 <b>${o.sec}</b> 秒`
      + `（${esc(o.v)} V / ${esc(o.a)} A）`).join('　')
    : '当前没有进行中的空载。';

  const tb = $('#ao-table').querySelector('tbody');
  const rows = j.events || [];
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6" class="muted">还没有记录 —— 插上一个不取电的设备就会出现</td></tr>';
  } else {
    tb.innerHTML = rows.map((e) => {
      const t = new Date(e.endAt || e.at || Date.now())
        .toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit',
          minute: '2-digit', second: '2-digit', hour12: false });
      const dur = (Number(e.durMs) || 0) / 1000;
      const act = e.action === 'cut'
        ? '<b class="bad">已自动关闭</b>' : '<span class="mute">自行恢复</span>';
      return `<tr><td class="mono">${esc(t)}</td><td>${esc(portName(e.port))}</td>`
        + `<td>${esc(e.vMax)} V</td><td>${esc(e.aMax)} A</td>`
        + `<td>${dur < 60 ? dur.toFixed(1) + ' 秒' : (dur / 60).toFixed(1) + ' 分'}</td>`
        + `<td>${act}</td></tr>`;
    }).join('');
  }
  if (j.file) $('#ao-file').textContent = '明细：' + j.file;
}

async function aoRefresh() {
  if (document.hidden) return;
  try {
    const j = await api('/api/auto-off?limit=60');
    if (j && j.ok) aoRender(j);
  } catch (_) {}
}

$('#btn-ao-refresh').onclick = () => aoRefresh();
$('#btn-ao-clear').onclick = async () => {
  if (!confirm('清空「异常检查」的全部记录？\n\n只删这份明细（data\\auto-off.jsonl），'
    + '不影响电量账本、功率曲线和温湿度历史。')) return;
  await api('/api/auto-off/clear', { method: 'POST' });
  aoRefresh();
};
setInterval(aoRefresh, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) aoRefresh(); });
aoRefresh();

// 开机自启动：off / tray（只后台，不弹窗） / window（连窗口一起开）。
// 实现在 server.js —— 往「启动」文件夹放一个 .lnk，用户随时能在资源管理器里删掉。
$('#in-autostart').onchange = async (e) => {
  const sel = e.target;
  const mode = sel.value;
  sel.disabled = true;
  try {
    const j = await api('/api/autostart', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!j.ok) alert('设置开机自启动失败：' + (j.error || j.raw || '未知原因'));
    sel.value = j.mode || 'off';
  } catch (err) {
    alert('设置开机自启动失败：' + err.message);
  } finally {
    sel.disabled = false;
    if (typeof tick === 'function') tick();
  }
};
$('#btn-shortcut').onclick = async () => {
  const b = $('#btn-shortcut');
  b.disabled = true; b.textContent = '正在创建…';
  const j = await api('/api/shortcut', { method: 'POST' });
  b.textContent = j.ok ? '已创建（见桌面）' : '创建失败';
  setTimeout(() => { b.disabled = false; b.textContent = '创建桌面快捷方式'; }, 2200);
};
window.addEventListener('resize', () => { drawChart(); drawEnvChart(); });

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openLogin(false); });

// ------------------------------------------------------------------ 控制面板
const PORT_LABEL = { c1: 'C1', c2: 'C2', c3: 'C3', a: 'USB-A' };
const SCENE_OPTS = [[1, 'AI'], [2, '数码生态'], [3, '单口'], [4, '均衡']];
// 息屏取值：米家插件逆向确认 1=5分/2=10分/3=30分/4=常亮/5=1分（0 非法）
const SCREEN_OPTS = [[1, '5 分钟'], [2, '10 分钟'], [3, '30 分钟'], [4, '常亮'], [5, '1 分钟']];
const LANG_OPTS = [[0, 'English'], [1, '中文']];
// 「看温度 · 屏幕常亮」：温度只在充电头机身屏幕上显示（MCU 内部 NTC），
// 蓝牙侧没有任何温度属性，所以这个按钮不涉及温度数值，只是把屏幕固定成常亮，
// 好让「界面二 · 核心温度」那一页不会自己黑掉。
// 取值 4 = 常亮，2026-09-23 用设备回读确认过：本机固件接受 1..5
// （写 5 回读也是 5，5 = 1 分钟），官方规格站那份 0..4（3=OFF）是旧的、对不上。
const SCREEN_ALWAYS_ON = 4;
let tempWatchPrev = null;   // 按「看温度」之前的 { sst, idle }，用于还原
const SW_KEY = { 15: 'usb_a_always_on', 19: 'screenoff_while_idle', 20: 'screen_dir_lock' };

// 协议开关位定义（PIID 21 = 2.21 protocol-ctl-extend，u32 掩码）。
// 与 collector.py 的 PROTO_SWITCH_BITS 逐位一致，2026-09-22 真机逐位验证过：
//   翻 A 口 UFCS 的 bit24 → 回读 0x02030f0f，还原 → 0x03030f0f（出厂值）。
// c1 的 bit3、c2 的 bit11 是固定为 1 的保留位，这里不列出来，翻转时自然不动。
const PROTO_LAYOUT = [
  ['c1', [['pd', 0, 'PD'], ['pps', 1, 'PPS'], ['ufcs', 2, 'UFCS']]],
  ['c2', [['pd', 8, 'PD'], ['pps', 9, 'PPS'], ['ufcs', 10, 'UFCS']]],
  ['c3', [['ufcs', 16, 'UFCS'], ['scp', 17, 'SCP']]],
  ['a', [['ufcs', 24, 'UFCS'], ['scp', 25, 'SCP']]],
];

let ctlMsgTimer = null;
function ctlMsg(msg, bad) {
  const el = $('#ctl-tag');
  el.textContent = msg;
  el.style.color = bad ? 'var(--bad)' : 'var(--ok)';
  clearTimeout(ctlMsgTimer);
  ctlMsgTimer = setTimeout(() => {
    el.style.color = ''; el.textContent = '写入需要蓝牙已连接';
  }, 4000);
}

async function ctl(payload) {
  const r = await api('/api/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r && r.ok) ctlMsg(r.noop ? '与当前值一致，未改动' : '已下发并确认');
  else ctlMsg((r && r.error) || '操作失败', true);
  tick();
  return r;
}

function fillSelect(sel, opts) {
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
}

function buildControl() {
  fillSelect($('#sel-scene'), SCENE_OPTS);
  fillSelect($('#sel-screen'), SCREEN_OPTS);
  fillSelect($('#sel-lang'), LANG_OPTS);

  $('#ctl-ports').innerHTML = ['c1', 'c2', 'c3', 'a'].map((p) =>
    `<div class="sw-row"><b>${PORT_LABEL[p]}</b><div class="switch" data-port="${p}"></div></div>`).join('');
  $('#ctl-ports').addEventListener('click', (e) => {
    const sw = e.target.closest('.switch'); if (!sw) return;
    const on = !sw.classList.contains('on');
    sw.classList.add('busy');
    ctl({ action: 'port', port: sw.dataset.port, on });
  });

  // 协议开关面板。位定义与 collector.py 的 PROTO_SWITCH_BITS 一致（2026-09-22 逐位实测：
  // 翻 A 口 UFCS 的 bit24 → 回读 0x02030f0f，还原 → 0x03030f0f）。
  // c1/c2 各位组里第 4 位是固定为 1 的保留位，这里只翻转目标位，保留位天然不动。
  $('#ctl-proto').innerHTML = PROTO_LAYOUT.flatMap(([p, list]) =>
    list.map(([sw, bit, lab]) =>
      `<div class="sw-row">${PORT_LABEL[p]} · ${lab}` +
      `<div class="switch" data-port="${p}" data-sw="${sw}"></div></div>`)).join('');
  $('#ctl-proto').addEventListener('click', (e) => {
    const sw = e.target.closest('.switch'); if (!sw) return;
    const on = !sw.classList.contains('on');
    sw.classList.add('busy');
    ctl({ action: 'protocol', port: sw.dataset.port, sw: sw.dataset.sw, on });
  });
  const protoMask = PROTO_LAYOUT.flatMap(([, l]) => l.map(([, bit]) => bit))
    .reduce((a, b) => a | (1 << b), 0) >>> 0;
  const writeProtoMask = (on) => {
    const s = (last && last.latest && last.latest.settings) || {};
    const cur = typeof s.protocol_ctl_extend === 'number' ? s.protocol_ctl_extend : null;
    if (cur == null) return ctlMsg('还没读到协议开关的当前值，等一次轮询后再试', true);
    const next = on ? ((cur | protoMask) >>> 0) : ((cur & ~protoMask) >>> 0);
    if (next === cur) return ctlMsg('与当前值一致，未改动');
    ctl({ action: 'set', piid: 21, value: next });
  };
  $('#btn-proto-on').onclick = () => writeProtoMask(true);
  $('#btn-proto-off').onclick = () => writeProtoMask(false);

  // 本机固件没有「定时关闭」：官方规格表把它记在 2.9–2.12，实测这四个属性不存在。
  // 说明文字直接写在 HTML 的高级区里，这里不再生成空面板。

  $('#sel-scene').onchange = (e) => ctl({ action: 'set', piid: 5, value: +e.target.value });
  $('#sel-screen').onchange = (e) => ctl({ action: 'set', piid: 6, value: +e.target.value });
  $('#sel-lang').onchange = (e) => ctl({ action: 'set', piid: 13, value: +e.target.value });

  // 一键「看温度」：息屏时间 → 常亮 + 关空闲熄屏；再按一次还原原值。
  // 以**设备当前状态**判断开关方向（刷新页面后仍然对），原值存在内存里，
  // 所以还原只在同一个页面会话内保证 —— 界面文字里写清了这一点。
  $('#btn-temp-watch').onclick = async () => {
    const s = (last && last.latest && last.latest.settings) || {};
    const b = $('#btn-temp-watch');
    const on = s.screen_save_time === SCREEN_ALWAYS_ON
      && s.screenoff_while_idle != null && !s.screenoff_while_idle;
    b.disabled = true;
    if (on) {
      const p = tempWatchPrev || { sst: 3, idle: false };
      tempWatchPrev = null;
      await ctl({ action: 'set', piid: 6, value: p.sst });
      await ctl({ action: 'set', piid: 19, value: p.idle ? 1 : 0 });
    } else {
      tempWatchPrev = { sst: s.screen_save_time, idle: s.screenoff_while_idle };
      await ctl({ action: 'set', piid: 6, value: SCREEN_ALWAYS_ON });
      await ctl({ action: 'set', piid: 19, value: 0 });
    }
    b.disabled = false;
  };

  for (const el of document.querySelectorAll('.switch[data-piid]')) {
    el.addEventListener('click', () => {
      const s = (last && last.latest && last.latest.settings) || {};
      el.classList.add('busy');
      ctl({ action: 'set', piid: +el.dataset.piid, value: s[SW_KEY[+el.dataset.piid]] ? 0 : 1 });
    });
  }

  $('#btn-all-on').onclick = () => ctl({ action: 'port', port: 'all', on: true });
  $('#btn-all-off').onclick = () => ctl({ action: 'port', port: 'all', on: false });

  $('#btn-defaults').onclick = async () => {
    const b = $('#btn-defaults');
    b.disabled = true; b.textContent = '正在逐条下发…';
    const r = await ctl({ action: 'defaults' });
    b.disabled = false; b.textContent = '恢复常用默认';
  };

  const readHex = (sel) => {
    const raw = String($(sel).value || '').trim().replace(/^0x/i, '');
    if (!raw) return null;
    const n = parseInt(raw, 16);
    return Number.isFinite(n) ? n : null;
  };

  $('#btn-adv').onclick = () => {
    const pc = readHex('#in-pc'), p8 = readHex('#in-p8'), pce = readHex('#in-pce');
    if (![pc, p8, pce].some((v) => v != null)) return ctlMsg('三栏都没填，没有下发', true);
    if (pc != null) ctl({ action: 'set', piid: 7, value: pc, advanced: true });
    if (p8 != null) ctl({ action: 'set', piid: 8, value: p8, advanced: true });
    if (pce != null) ctl({ action: 'set', piid: 21, value: pce });
  };

  $('#btn-ext').onclick = async () => {
    const b = $('#btn-ext');
    b.disabled = true; b.textContent = '正在读取…';
    const r = await api('/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ext' }),
    });
    b.disabled = false; b.textContent = '读取扩展属性 2.8';
    const box = $('#ext-res');
    if (r && r.ok) {
      const v = r.values && r.values['2.08'];
      box.innerHTML = `<b style="color:var(--ok)">扩展读取成功</b>：2.8 = ${v}`
        + `（0x${Number(v || 0).toString(16).padStart(2, '0')}）`
        + (v === 0 ? '<br><span class="muted">值为 0，即「端口关闭设置」当前是关闭状态。</span>' : '');
    } else {
      box.innerHTML = '<span style="color:var(--bad)">扩展读取失败：'
        + ((r && r.error) || '未知原因') + '</span>';
    }
  };

  $('#btn-reset').onclick = async () => {
    const ok1 = confirm('「恢复出厂设置」会把充电头的端口开关、场景模式、息屏时间、'
      + '协议开关等全部恢复为出厂值，且无法撤销。\n\n确定要继续吗？');
    if (!ok1) return;
    if (!confirm('最后确认：现在真的发送「恢复默认设置」？')) return;
    const b = $('#btn-reset');
    b.disabled = true; b.textContent = '正在下发…';
    const r = await api('/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    });
    b.disabled = false; b.textContent = '恢复出厂设置';
    ctlMsg(r && r.ok ? '已发送恢复默认设置' : ((r && r.error) || '失败'), !(r && r.ok));
    tick();
  };

  $('#btn-sweep').onclick = async () => {
    const b = $('#btn-sweep');
    b.disabled = true; b.textContent = '正在扫描…（采集已暂停）';
    $('#sweep-out').innerHTML = '<span class="muted">正在认证并扫描 siid=2 全部未知属性，约 20-40 秒…</span>';
    const r = await api('/api/sweep', { method: 'POST' });
    b.disabled = false; b.textContent = '扫描隐藏属性 / 温度';
    renderSweep(r);
  };
}

function renderSweep(r) {
  const box = $('#sweep-out');
  if (!r || !r.ok) {
    box.innerHTML = '<span style="color:var(--bad)">扫描失败：' + ((r && r.error) || '未知原因') + '</span>';
    return;
  }
  const rows = r.rows || [], found = r.found || [];
  const ct = r.control || { attempts: [] };
  const ctlLine = (ct.attempts || []).map((a) =>
    `· ${a.label}：发 ${a.sent} 条 → ` + (a.got ? `收到 ${a.got} 条` : `无应答（${(a.error || '').split(':')[0]}）`)).join('<br>');

  let h = `<b>① 通道自检</b><br>${ctlLine}<br>`;
  h += ct.ok
    ? '　→ 通道正常。设备只回答完整属性表；<b>多加一个属性就整批丢弃</b>，所以无法枚举未知属性。<br>'
    : '　→ <span style="color:var(--warn)">连完整属性表都没应答，本次结论不可信。</span><br>';

  h += `<b>② 未知属性 ${r.lo ? '2.0x' + r.lo.toString(16) : ''}…2.0x${(r.hi || 0).toString(16)}</b><br>`
    + `共问 ${rows.length} 个：可读 <b>${found.length}</b> · 表里没有 <b>${r.missing || 0}</b> · 整批被丢 <b>${r.dropped || 0}</b><br>`;
  h += found.length
    ? '<span style="color:var(--warn)">发现可用属性：</span><br>'
      + found.map((f) => `· 2.${f.piid} = ${f.value}（${f.type}，raw ${f.raw}）`).join('<br>')
    : '没有可读的新属性。<br>';

  const vs = r.vendor || [];
  const nf = r.notify || [];
  h += `<b>③ GATT</b>：${(r.services || []).length} 个服务；厂商服务 0xAF00 下 `
    + `${vs.length} 个特征`
    + (vs.length ? '（' + vs.map((v) => v.uuid.slice(4, 8) + '[' + v.props.join(',') + ']').join('、') + '）' : '')
    + '。<br>';
  if (nf.length) {
    h += '　notify 侦听：' + nf.map((x) =>
      x.error ? `${x.uuid.slice(4, 8)} 订阅失败（${x.error.split(':')[0]}）` :
        `${x.uuid.slice(4, 8)} 收到 ${x.count} 帧`).join('、') + '。<br>';
  }
  h += '<br><b>结论</b>：温度不在这条 BLE 通道上 —— 属性表里没有、未知属性问不出来、'
    + '厂商服务既不可读也不主动推数据。充电头屏幕上的温度来自内部 NTC，数据在 MCU 里，'
    + '但**没有对外出口**。';
  box.innerHTML = h;
}

/** 把设备当前状态灌进修控件；正在输入的控件不覆盖。 */
function syncControl() {
  const s = (last && last.latest && last.latest.settings) || null;
  if (!s) return;
  const en = s.ports_enabled || {};
  for (const el of document.querySelectorAll('#ctl-ports .switch')) {
    el.classList.toggle('on', !!en[el.dataset.port]);
    el.classList.remove('busy');
  }
  // 协议开关（2.21）：settings.protocol_switches = {端口:{协议:bool}}。
  // 设备在 2.21 变化时会主动推一帧，所以点完开关这里很快就能看到新状态。
  const ps = s.protocol_switches || null;
  if (ps) {
    for (const el of document.querySelectorAll('#ctl-proto .switch')) {
      const on = !!(ps[el.dataset.port] && ps[el.dataset.port][el.dataset.sw]);
      el.classList.toggle('on', on);
      el.classList.remove('busy');
    }
  }
  for (const el of document.querySelectorAll('.switch[data-piid]')) {
    el.classList.toggle('on', !!s[SW_KEY[+el.dataset.piid]]);
    el.classList.remove('busy');
  }
  if (document.activeElement !== $('#sel-scene') && s.scene_mode != null) $('#sel-scene').value = s.scene_mode;
  if (document.activeElement !== $('#sel-screen') && s.screen_save_time != null) $('#sel-screen').value = s.screen_save_time;
  if (document.activeElement !== $('#sel-lang') && s.device_language != null) $('#sel-lang').value = s.device_language;

  // 「看温度」按钮反映设备真实状态（常亮 + 空闲熄屏关 = 已在常亮）
  const bw = $('#btn-temp-watch');
  const watchOn = s.screen_save_time === SCREEN_ALWAYS_ON
    && s.screenoff_while_idle != null && !s.screenoff_while_idle;
  bw.classList.toggle('on', watchOn);
  if (!bw.disabled) {
    bw.textContent = !watchOn ? '看温度 · 屏幕常亮'
      : (tempWatchPrev ? '看温度 · 常亮中（再按还原）' : '看温度 · 常亮中（按一下关掉）');
  }

  if (document.activeElement !== $('#in-pc') && !$('#in-pc').value && s.protocol_ctl != null)
    $('#in-pc').placeholder = '0x' + s.protocol_ctl.toString(16).padStart(2, '0');
  if (document.activeElement !== $('#in-pce') && !$('#in-pce').value && s.protocol_ctl_extend != null)
    $('#in-pce').placeholder = '0x' + s.protocol_ctl_extend.toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ 小米电风扇
//
// 这张卡和上面那几条链路的根本区别：风扇是**局域网的 Wi-Fi 设备**（miIO，UDP 54321），
// 不经过蓝牙、也不经过米家云 —— 所以它能和手机米家同时用，不像充电头那样要「让位」。
// 数据由独立进程 fan_collector.py 采集，同样守"可失败"原则：它连不上只是这张卡灰掉。
//
// ⚠️ 这台风扇**没有任何电参量属性可读**（没有功率传感器、没有电量统计），所以这里
//    **不做功率、不做用电量、也不画曲线** —— 推算出来的数看着像实测，宁可没有。
//    这张卡只干两件事：把设备回读到的状态显示出来；把你点的每一个开关写进去并回读确认。

const FAN_MODE_CN = { 0: '自然风', 1: '直吹风' };
const FAN_LEVELS = [[1, '1 档'], [2, '2 档'], [3, '3 档'], [4, '4 档']];
const FAN_MODES = [[0, '自然风'], [1, '直吹风']];
const FAN_ANGLES = [30, 60, 90, 120, 140];          // 规格表就这五个值，别的写了会被拒
// 链路状态 → 中文说法。idle / need-login 是"还没开始"，只有 online 才算真的通。
const FAN_LINK_CN = {
  idle: '未启动', 'need-login': '待登录', connecting: '连接中', scanning: '搜索中',
  online: '已连接', offline: '已断开', error: '出错', done: '自检完成',
};
const fanState = () => (last && last.fan) || null;
// 只做转义，不做别的 —— 设备名/IP 都来自小米云，不能直接拼进 innerHTML
const fanEsc = (s) => String(s == null ? '' : s)
  .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function renderFan() {
  const f = fanState();
  if (!f) return;
  const card = $('#fan-card');
  const link = f.link || { state: 'idle', msg: '' };
  const online = link.state === 'online';
  const lt = f.latest || null;
  const props = (lt && lt.props) || null;
  const dev = f.device || null;

  // 标题行两个标签：链路状态 + 型号
  const tag = $('#fan-link-tag');
  if (tag) {
    tag.textContent = 'Wi-Fi · ' + (FAN_LINK_CN[link.state] || link.state);
    tag.title = link.msg || '';
  }
  const mt = $('#fan-model-tag');
  if (mt) mt.textContent = dev ? (dev.model || dev.name || '—') : '—';

  // 没登录（或还没从云端拿到 IP+密钥）：只露一条提示 + 一个按钮，别的控件全藏起来。
  // 一堆灰着的开关比一句"先登录"更让人以为是坏了。
  const needLogin = link.state === 'need-login' || !dev;
  const hint = $('#fan-login-hint');
  if (hint) hint.hidden = !needLogin;
  if (needLogin) {
    const msg = $('#fan-login-msg');
    if (msg) msg.textContent = link.msg
      || '风扇走 Wi-Fi（miIO），需要先从米家云取到它的 IP 和密钥 —— 点右边按钮扫一次码。';
  }
  const main = $('#fan-main');
  if (main) main.hidden = needLogin;
  if (card) card.classList.toggle('no-login', needLogin);

  // 大数字位放着「设备回读到的开关状态」—— 这是这张卡能给出的唯一真实口径。
  // 没读到读数时如实说"还没读到"，不猜一个数。
  const has = !!(lt && props);
  $('#fan-state').textContent = !has ? (f.running ? '等待首次读数' : '未运行')
    : (props.power ? '运行中' : '已关闭');
  const modeTxt = props ? (props.mode_text || FAN_MODE_CN[props.mode]) : null;
  $('#fan-mode').textContent = modeTxt || '—';
  // 档位与无级速度都给：档位是遥控器上那四颗按钮，速度是 1~100 的连续值
  const lv = props && Number(props.level) ? Number(props.level) : 0;
  const spv = props && Number(props.speed) ? Number(props.speed) : 0;
  $('#fan-level').textContent = (lv || spv)
    ? ((lv ? lv + ' 档' : '') + (lv && spv ? ' · ' : '') + (spv ? spv + '%' : '')) : '—';
  $('#fan-age').textContent = (lt && lt.at) ? fmtAge(Date.now() - Number(lt.at)) : '—';
  const devEl = $('#fan-dev');
  if (devEl) {
    devEl.textContent = dev ? (dev.ip || '—') : '—';
    devEl.title = dev ? [dev.name, dev.model, dev.mac, dev.did].filter(Boolean).join(' · ') : '';
  }

  // 卡片里那行说明跟着链路状态走：连不上时把它为什么连不上说出来，
  // 连着时才讲"不经过云、不用让位"这套常识。
  const where = $('#fan-where');
  if (where) {
    if (!online) {
      where.innerHTML = `<b>${fanEsc(FAN_LINK_CN[link.state] || link.state)}</b>：`
        + fanEsc(link.msg || '暂无详情')
        + (f.restarts ? `（采集器已自动重启 ${f.restarts} 次）` : '');
    } else {
      where.innerHTML = '走家里的 Wi-Fi 直连（miIO），不经过米家云 —— '
        + '所以它能和手机米家同时用，不像充电头那样要「让位」。'
        + `每 ${f.interval || 2} 秒读一次；这台风扇没有电参量属性可读，所以只读状态与开关。`;
    }
  }

  // 收起状态时标题行右侧给个摘要（内容藏了，至少状态还看得见）
  const foldSum = $('#fan-fold-sum');
  if (foldSum) {
    foldSum.textContent = props
      ? (props.power ? '运行中' : '已关闭')
        + (props.power && Number(props.speed) ? ' · ' + Number(props.speed) + '%' : '')
      : '无数据';
  }

  // 设置区（别打断正在输入的人）
  const itv = $('#fan-int');
  if (itv && document.activeElement !== itv && f.interval != null) itv.value = f.interval;
  const note = $('#fan-dev-note');
  if (note) {
    note.innerHTML = dev
      ? `设备 <b>${fanEsc(dev.name || '小米电风扇')}</b> ${fanEsc(dev.model || '')}<br>`
        + `IP <b>${fanEsc(dev.ip || '')}</b>`
        + (dev.mac ? ` · MAC ${fanEsc(dev.mac)}` : '')
        + (dev.savedAt ? '<br>密钥取回于 '
          + new Date(dev.savedAt).toLocaleString('zh-CN', { hour12: false }) : '')
        + '<br>密钥只写进 <b>data\\fan.token</b> 与 <b>data\\fan.json</b>，不进命令行。'
      : '还没从米家云取到这台风扇的 IP 与密钥（点右上角「登录小米云」扫一次码）。';
  }

  renderFanRaw(lt);
  syncFanControl(lt);
}

/** 原始属性表：值不经过任何换算。出问题时能一眼分清"设备没回"还是"界面没画"。
 *  末尾顺手把通信诊断计数带上（超时/重传一直涨 = 网络或设备不稳）。 */
function renderFanRaw(lt) {
  const box = $('#fan-raw');
  if (!box) return;
  const items = (lt && lt.raw) || [];
  if (!items.length) {
    box.innerHTML = '<dt>状态</dt><dd class="mute">'
      + (lt ? '这一帧没带回原始属性' : '还没有读数') + '</dd>';
    return;
  }
  const rows = items.map((r) => {
    const v = (r.code === 0) ? String(r.value) : ('读失败 code=' + r.code);
    return `<dt>${fanEsc(r.key)} <span class="mute">${fanEsc(r.name || '')}</span></dt>`
      + `<dd class="mono">${fanEsc(v)}</dd>`;
  });
  rows.push(`<dt>通信</dt><dd class="mono mute">超时 ${fanEsc(lt.timeouts)} 次 · 重传 ${fanEsc(lt.retransmits)} 次</dd>`);
  box.innerHTML = rows.join('');
}

/** 控制区的状态**一律来自回读值**，不做"我点了就当我写成功了"。
 *  ⚠️ 两处例外，都是怕跟用户打架：正在拖滑条/正在输数字时不覆盖它的值；
 *     正在写入（fanBusy）时不抢 busy 标记。 */
function syncFanControl(lt) {
  const p = (lt && lt.props) || null;
  const sw = (id, val) => {
    const el = $('#' + id);
    if (!el) return;
    const on = val === true;
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    if (!fanBusy) el.classList.remove('busy');
  };
  sw('sw-fan-power', p && p.power);
  sw('sw-fan-osc', p && p.oscillate);
  sw('sw-fan-led', p && p.led);
  sw('sw-fan-buzzer', p && p.buzzer);
  sw('sw-fan-lock', p && p.child_lock);

  const on = !!(p && p.power);
  const lbl = $('#fan-power-lbl');
  if (lbl) lbl.textContent = on ? '运行中' : '关闭';
  const pn = $('#fan-power-note');
  if (pn) {
    pn.textContent = p
      ? (on ? `设备回读：开机 · 风速 ${p.speed == null ? '—' : p.speed} · ${p.mode_text || '—'}`
        : '设备回读：已关机')
      : '所有开关的显示状态都来自写入后的回读';
  }

  const segLv = $('#fan-seg-level'), segMd = $('#fan-seg-mode');
  if (segLv) {
    for (const el of segLv.querySelectorAll('button'))
      el.classList.toggle('on', p != null && Number(p.level) === Number(el.dataset.v));
  }
  if (segMd) {
    for (const el of segMd.querySelectorAll('button'))
      el.classList.toggle('on', p != null && Number(p.mode) === Number(el.dataset.v));
  }

  const sp = $('#fan-speed');
  if (sp && document.activeElement !== sp && p && Number.isFinite(Number(p.speed))) {
    sp.value = String(Number(p.speed));
    const sv = $('#fan-speed-val');
    if (sv) sv.textContent = Number(p.speed) + '%';
  }
  const ang = $('#fan-angle');
  if (ang && document.activeElement !== ang && p && p.angle != null) ang.value = String(p.angle);
  const tm = $('#fan-timer');
  if (tm && document.activeElement !== tm && p && p.off_timer != null) tm.value = String(p.off_timer);
}

// ---- 卡片折叠（和温度计那张同一套做法：收起只藏内容，状态记在 localStorage）----
function applyFanFold() {
  const cardEl = $('#fan-card'), btn = $('#fan-fold'), sum = $('#fan-fold-sum');
  if (cardEl) cardEl.classList.toggle('folded', fanFolded);
  if (btn) {
    btn.textContent = fanFolded ? '展开' : '收起';
    btn.setAttribute('aria-expanded', fanFolded ? 'false' : 'true');
    btn.title = fanFolded
      ? '展开风扇卡片（控制与设置都还在）'
      : '收起整张风扇卡片 —— 用不上风扇时可以收起来';
  }
  if (sum) sum.hidden = !fanFolded;
}
if ($('#fan-fold')) {
  $('#fan-fold').onclick = () => {
    fanFolded = !fanFolded;
    try { localStorage.setItem('cuk_fan_folded', fanFolded ? '1' : '0'); } catch (_) {}
    applyFanFold();
  };
  applyFanFold();
}

// ---- 控制接线 --------------------------------------------------------------
//
// 三条铁律（每一处写入都遵守）：
//   1. 界面状态**只认回读值** —— 写完之后看设备读回来的那个数，不认"我发过了"；
//      （采集器写完会立刻推一帧新 state，所以纠正几乎是即时的）
//   2. 一次只发一条 —— 写入期间把控件标 busy，避免连点排队然后一起超时；
//   3. 失败要说清 —— 把设备的原话贴在按钮旁边，而不是默默变回原样。
let fanMsgTimer = null;

function fanMsg(msg, bad) {
  const el = $('#fan-ctl-out');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('bad', bad === true);
  el.classList.toggle('ok', bad === false);
  clearTimeout(fanMsgTimer);
  fanMsgTimer = setTimeout(() => {
    el.textContent = '';
    el.classList.remove('ok', 'bad');
  }, 6000);
}

/** 给风扇写一个属性并等 ack（ack 里带设备的回读值）。
 *  返回 true = 回读与写入一致，才算真的成功。 */
async function fanSet(name, value, label) {
  const f = fanState();
  if (!f || !f.running) { fanMsg('风扇采集器没在运行 —— 先看上面那条链路状态', true); return false; }
  if (fanBusy) { fanMsg('上一条命令还在路上，稍等一下', true); return false; }
  fanBusy = true;
  fanMsg((label || name) + ' 写入中…');
  try {
    const j = await api('/api/fan/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, value }),
    });
    if (!j || !j.ok) {
      fanMsg('写入失败：' + ((j && j.error) || '设备没有回应'), true);
      return false;
    }
    const same = String(j.readback) === String(value);
    fanMsg((label || name) + ' → 回读 ' + j.readback + (same ? '，一致' : '（与写入不一致！）'), !same);
    return same;
  } catch (e) {
    fanMsg('写入失败：' + e.message, true);
    return false;
  } finally {
    // ⚠️ 这里**刻意不重新同步控件**：ack 到达时服务端会推一条全量 meta
    //    （handleFanLine 里的 sseState），开关自然会以回读值为准。
    //    要是在这儿自己同步一次，成功的情况下拿到的是**旧的** latest ——
    //    开关会先弹回旧状态、再等新快照弹回来，看起来像闪了一下。
    fanBusy = false;
    // 顺手把 busy 标记收掉：SSE 那条 meta 可能比这条 HTTP 响应更早到，
    // 那会儿 fanBusy 还是 true（syncFanControl 会跳过清除）—— 留着就一直半透明。
    for (const el of document.querySelectorAll('#fan-ctl-wrap .switch.busy')) el.classList.remove('busy');
  }
}

/** 「刷新一次」：让采集器立刻读一遍（不等下一个轮询周期）。 */
async function fanRefresh() {
  const f = fanState();
  if (!f || !f.running) { fanMsg('风扇采集器没在运行', true); return false; }
  try {
    const j = await api('/api/fan/refresh', { method: 'POST' });
    if (!j || !j.ok) { fanMsg('刷新失败：' + ((j && j.error) || '设备没有回应'), true); return false; }
    fanMsg('已读回一帧新状态');
    return true;
  } catch (e) {
    fanMsg('刷新失败：' + e.message, true);
    return false;
  }
}

/** 把开关接到某个风扇属性上。点击时先**乐观翻转**给个即时反馈（局域网往返几百毫秒，
// 连着几次没反应会让人以为按钮坏了），ack 一到界面就以回读值纠正。 */
function bindFanSwitch(id, name, label) {
  const el = $('#' + id);
  if (!el) return;
  el.onclick = () => {
    const f = fanState();
    const p = (f && f.latest && f.latest.props) || null;
    const cur = p ? !!p[name] : el.classList.contains('on');
    el.classList.add('busy');
    el.classList.toggle('on', !cur);
    el.setAttribute('aria-checked', !cur ? 'true' : 'false');
    fanSet(name, !cur, label);
  };
}

function buildFanControl() {
  const segLv = $('#fan-seg-level');
  if (segLv && !segLv.childElementCount) {
    segLv.innerHTML = FAN_LEVELS.map(([v, s]) =>
      `<button type="button" data-v="${v}">${s}</button>`).join('');
    segLv.onclick = (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) fanSet('level', Number(b.dataset.v), b.textContent.replace(/\s/g, ''));
    };
  }
  const segMd = $('#fan-seg-mode');
  if (segMd && !segMd.childElementCount) {
    segMd.innerHTML = FAN_MODES.map(([v, s]) =>
      `<button type="button" data-v="${v}">${s}</button>`).join('');
    segMd.onclick = (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) fanSet('mode', Number(b.dataset.v), '风型 ' + b.textContent);
    };
  }
  const ang = $('#fan-angle');
  if (ang && !ang.childElementCount) {
    ang.innerHTML = FAN_ANGLES.map((v) => `<option value="${v}">${v}°</option>`).join('');
    ang.onchange = () => fanSet('angle', Number(ang.value), '摆风夹角 ' + ang.value + '°');
  }
  const sp = $('#fan-speed');
  if (sp) {
    // input 只动数字显示（拖动过程不写入 —— 一次拖动会发几十条命令，风扇会被淹）
    sp.oninput = () => { const v = $('#fan-speed-val'); if (v) v.textContent = sp.value + '%'; };
    sp.onchange = () => fanSet('speed', Number(sp.value), '风速 ' + sp.value + '%');
  }
  bindFanSwitch('sw-fan-power', 'power', '开关');
  bindFanSwitch('sw-fan-osc', 'oscillate', '左右摆风');
  bindFanSwitch('sw-fan-led', 'led', '指示灯');
  bindFanSwitch('sw-fan-buzzer', 'buzzer', '提示音');
  bindFanSwitch('sw-fan-lock', 'child_lock', '童锁');

  const tb = $('#btn-fan-timer');
  if (tb) tb.onclick = () => {
    const el = $('#fan-timer');
    const v = Math.max(0, Math.min(480, Math.round(Number(el.value) || 0)));
    el.value = String(v);
    fanSet('off_timer', v, v ? ('定时 ' + v + ' 分钟') : '取消定时');
  };

  const rb = $('#btn-fan-refresh');
  if (rb) rb.onclick = async () => {
    rb.disabled = true;
    await fanRefresh();
    setTimeout(() => { rb.disabled = false; }, 800);
  };

  const cs = $('#fan-cfg-save');
  if (cs) cs.onclick = async () => {
    cs.disabled = true; cs.textContent = '保存中…';
    try {
      const j = await api('/api/fan/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interval: parseFloat($('#fan-int').value),
        }),
      });
      if (j && j.ok) {
        cs.textContent = '已保存';
        fanMsg(`风扇设置已保存：间隔 ${j.interval}s（采集器正在重启）`);
      } else {
        cs.textContent = '保存失败';
        fanMsg('保存失败：' + ((j && j.error) || '未知原因'), true);
      }
    } catch (e) {
      cs.textContent = '保存失败';
      fanMsg('保存失败：' + e.message, true);
    } finally {
      setTimeout(() => { cs.disabled = false; cs.textContent = '保存并重启风扇采集'; }, 1500);
    }
  };

  const pb = $('#btn-fan-probe');
  if (pb) pb.onclick = async () => {
    const box = $('#fan-probe-out');
    pb.disabled = true;
    if (box) box.textContent = '正在连一次、把属性读回来（几秒）…';
    try {
      const j = await api('/api/fan/probe', { method: 'POST' });
      if (box) box.innerHTML = fanProbeHtml(j);
    } catch (e) {
      if (box) box.textContent = '自检请求失败：' + e.message;
    } finally {
      pb.disabled = false;
    }
  };

  const db = $('#btn-fan-discover');
  if (db) db.onclick = async () => {
    const box = $('#fan-probe-out');
    db.disabled = true;
    if (box) box.textContent = '正在向局域网广播一轮 miIO 发现（约 5 秒）…';
    try {
      const j = await api('/api/fan/discover', { method: 'POST' });
      if (box) box.innerHTML = fanDiscoverHtml(j);
    } catch (e) {
      if (box) box.textContent = '发现请求失败：' + e.message;
    } finally {
      db.disabled = false;
    }
  };

  const lb = $('#btn-fan-login');
  if (lb) lb.onclick = () => openLogin(true);
}

const fanYn = (v) => (v === true ? '开' : (v === false ? '关' : '—'));

/** 「连接自检」的结果：握手 + 全部属性 + 通信计数。 */
function fanProbeHtml(j) {
  if (!j) return '没有结果';
  if (j.error) return '<b>失败：</b>' + fanEsc(j.error)
    + (j.stderr ? '\n' + fanEsc(String(j.stderr).slice(-300)) : '');
  const out = [];
  const st = j.state;
  if (st) {
    const p = st.props || {};
    out.push('握手成功 · 设备 IP ' + fanEsc(st.ip));
    out.push('开关 ' + fanYn(p.power) + ' · 摆风 ' + fanYn(p.oscillate)
      + ' · 风型 ' + fanEsc(p.mode_text || FAN_MODE_CN[p.mode] || '—')
      + ' · 档位 ' + fanEsc(p.level) + ' · 风速 ' + fanEsc(p.speed));
    out.push('夹角 ' + fanEsc(p.angle) + '° · 定时 ' + fanEsc(p.off_timer)
      + ' 分 · 指示灯 ' + fanYn(p.led) + ' · 提示音 ' + fanYn(p.buzzer)
      + ' · 童锁 ' + fanYn(p.child_lock));
    out.push('通信：超时 ' + fanEsc(st.timeouts) + ' 次 · 重传 ' + fanEsc(st.retransmits) + ' 次');
    const bad = (st.raw || []).filter((r) => r.code !== 0);
    if (bad.length) {
      out.push('读失败的属性：' + bad.map((r) => r.key + '（code ' + r.code + '）').join('、')
        + ' —— 一般是这台风扇的固件没有这个属性。');
    }
  } else {
    out.push('没读到属性（下面是与设备的对话记录）。');
  }
  for (const l of (j.link || [])) {
    if (l.t === 'link') out.push('链路：' + fanEsc(l.state) + (l.msg ? ' — ' + fanEsc(l.msg) : ''));
    if (l.t === 'error') out.push('错误：' + fanEsc(l.msg));
  }
  if (j.stderr) out.push('stderr：' + fanEsc(String(j.stderr).slice(-300)));
  return out.join('\n');
}

/** 「局域网发现」的结果。
 *  ⚠️ 实测（2026-09-23 在这台机器上）：家里路由器不转发无线客户端的广播，
 *     风扇的 Wi-Fi 还会为了省电休眠漏包 —— 所以"广播 0 台"**不能**推出风扇不在线。
 *     这一点必须写在结果里，否则用户会因为一条无用的结论去折腾路由器。 */
function fanDiscoverHtml(j) {
  if (!j) return '没有结果';
  if (!j.ok) return '<b>失败：</b>' + fanEsc(j.error || '未知原因');
  const rows = j.rows || [];
  const out = [rows.length
    ? `<b>广播发现 ${rows.length} 台 miIO 设备</b>（只能拿到 did 和地址，拿不到密钥）`
    : '<b>广播没有发现任何 miIO 设备。</b>'];
  for (const r of rows) {
    out.push('· ' + fanEsc(r.ip || r.address || '') + '  did=' + fanEsc(r.did)
      + (r.model ? '  model=' + fanEsc(r.model) : ''));
  }
  const f = fanState();
  const dev = f && f.device;
  if (dev) {
    out.push('');
    out.push('注：广播发现不到**不代表**风扇离线 —— 家里路由器通常不转发无线客户端之间的广播，'
      + '风扇的 Wi-Fi 还会为省电休眠、漏掉广播。判断在不在线请看上面的链路状态；'
      + `现在用的 IP ${fanEsc(dev.ip || '—')} 是登录小米云时从云端设备列表取的。`);
  }
  if (j.stderr) out.push('stderr：' + fanEsc(String(j.stderr).slice(-300)));
  return out.join('\n');
}

// ------------------------------------------------------------------ 用电量
async function pullEnergy() {
  try { renderEnergy(await api('/api/energy?days=7')); } catch (_) {}
}

function renderEnergy(e) {
  if (!e || !e.ok) return;
  lastEnergy = e;                 // 端口卡里的「本次充电」要用它
  $('#e-today').textContent = (e.today.wh || 0).toFixed(2);
  $('#e-total').textContent = (e.totalWh || 0).toFixed(2);
  const c = e.current;
  $('#e-sess').textContent = c ? c.wh.toFixed(2) : '—';
  // 面板上的**大数字直接是「度」**（电费单口径），Wh 与 mAh 退到小字副行。
  // 单位（度 / Wh / mAh）只有 index.html 一份，这里只写数字 —— 两边各存一份早晚对不上。
  $('#e-today-kwh').textContent = fmtKwh(e.today.wh);
  $('#e-total-kwh').textContent = fmtKwh(e.totalWh);
  $('#e-sess-kwh').textContent = c ? fmtKwh(c.wh) : '—';
  $('#e-today-mah').textContent = fmtMah(e.today.wh);
  $('#e-total-mah').textContent = fmtMah(e.totalWh);
  $('#e-sess-mah').textContent = c ? fmtMah(c.wh) : '—';
  $('#energy-tag').textContent = c
    ? `充电中 · 峰 ${fmtW(c.peak)} W · ${fmtDur(c.ms)}`
    : '本机积分';

  const days = e.days || [];
  const max = Math.max(1e-6, ...days.map((d) => d.wh));
  const today = days.length ? days[days.length - 1].day : '';
  $('#ebars').innerHTML = days.map((d) => {
    const h = Math.max(1.5, (d.wh / max) * 100);
    return `<div class="col ${d.day === today ? 'today' : ''} ${d.wh <= 0 ? 'zero' : ''}"
      title="${d.day} · ${d.wh.toFixed(3)} Wh（${fmtKwh(d.wh)} 度 / ${fmtMah(d.wh)} mAh）">
      <div class="val">${d.wh > 0 ? d.wh.toFixed(2) : ''}</div>
      <div class="barwrap"><div class="b" style="height:${h}%"></div></div>
      <div class="lbl">${d.day.slice(5).replace('-', '/')}</div></div>`;
  }).join('');

  const pk = e.ports || {};
  const pmax = Math.max(1e-6, ...['c1', 'c2', 'c3', 'a'].map((k) => pk[k] || 0));
  // 每口分解也走主面板那套口径：度在前（主），Wh 与 mAh 跟在后（3 位小数保留原精度）。
  $('#e-ports').innerHTML = ['c1', 'c2', 'c3', 'a'].map((k) => {
    const wh = pk[k] || 0;
    return `<dt>${PORT_LABEL[k]}</dt><dd>${fmtKwh(wh)} 度
      <span class="muted">· ${wh.toFixed(3)} Wh · ${fmtMah(wh)} mAh · ${Math.round((wh / pmax) * 100)}%</span></dd>`;
  }).join('');

  const ss = e.sessions || [];
  $('#e-sessions').innerHTML = ss.length
    ? ss.slice(0, 5).map((s) => {
        const t = new Date(s.start).toLocaleString('zh-CN',
          { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        return `<dt>${t}</dt><dd>${fmtKwh(s.wh)} 度
          <span class="muted">· ${s.wh.toFixed(2)} Wh · ${fmtMah(s.wh)} mAh · ${fmtDur(s.ms)} · 峰 ${fmtW(s.peak)} W</span></dd>`;
      }).join('')
    : '<dt>状态</dt><dd class="mute">还没有完整的充电会话</dd>';

  // 每次插拔单独记账：正在充的列在最前（还没结算），已拔出的按时间倒序。
  // 三个都要给（度 / Wh / mAh），和主面板一个口径。
  const live = e.plugsLive || [];
  const plugs = e.plugs || [];
  const plugBody = (g) => `${fmtKwh(g.wh)} 度 <span class="muted">· `
    + `${Number(g.wh || 0).toFixed(3)} Wh · ${fmtMah(g.wh)} mAh`
    + (g.peak ? ` · 峰 ${fmtW(g.peak)} W` : '')
    + (g.proto ? ` · ${g.proto}${g.cap == null ? '' : ' ' + g.cap + 'W'}` : '')
    + (g.ms ? ` · ${fmtDur(g.ms)}` : '') + '</span>';
  const plugRows = live.map((g) =>
    `<dt>${g.label} <b class="live">充电中</b></dt><dd>${plugBody(g)}</dd>`);
  for (const g of plugs.slice(0, 12)) {
    const t = new Date(g.start).toLocaleString('zh-CN',
      { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    plugRows.push(`<dt>${g.label} · ${t}</dt><dd>${plugBody(g)}</dd>`);
  }
  $('#e-plugs').innerHTML = plugRows.length
    ? plugRows.join('')
    : '<dt>状态</dt><dd class="mute">还没有插拔记录（拔掉设备后这里会出现一条）</dd>';

  // 端口卡上那行「本次充电」跟着 energy 走，这边刷完顺手重画一次
  if (last && last.latest && last.latest.ports) renderPorts(last.latest.ports);
}

// ------------------------------------------------------------------ 启动
renderLegend();
renderEnvRanges();
buildControl();
buildFanControl();
tick();
pullEnergy();
pullLog();
beat();

// 时间轴平滑滑动：数据点每 ~1.5 秒才来一个，但"现在"是每帧都在走的。
// 用 rAF 以 ~12fps 重画（标签页不可见时自动停），曲线就不会看起来一秒一跳。
let lastDraw = 0;
(function anim() {
  const ts = performance.now();
  if (!document.hidden && ts - lastDraw > 80) { lastDraw = ts; drawChart(); drawEnvChart(); }
  requestAnimationFrame(anim);
})();

// 兜底轮询：SSE 断开时恢复 1.5 秒一次的全量轮询；SSE 正常时只做低频校正
// （防止连接"看着还在、其实不推了"这种静默故障）。
// ⚠️ 定时器必须在 connectStream() **之前**注册：推送通道初始化一旦抛错，
//    轮询兜底不能跟着一起没了 —— 2026-09-22 就是在这里中断，界面直接冻住。
setInterval(() => { if (!sseLive) tick(); }, 1500);
setInterval(pullState, 10000);
setInterval(() => {
  if (sseLive) Promise.all([resyncHistory(), pullEnvHistory()]).then(render).catch(() => {});
}, 30000);
setInterval(pullEnergy, 8000);
setInterval(pullLog, 3000);
connectStream();

// ------------------------------------------------------------------ 页面自测
//
// 今天连续踩了两次「界面冻住」：脚本一抛错，后面的定时器/监听就全没注册，
// 页面停在初始态 —— 光看截图和 `node --check` 都发现不了（语法是对的，运行才炸）。
// 所以留一个自测挂钩：加 `?selftest=1` 打开，页面自己点一下区间按钮、看数据有没有在动，
// 结论写进 <pre id="selftest"> 与标题；由 tools/uitest.js 用无头 Edge 读回来。
if (/[?&]selftest=1/.test(location.search)) {
  setTimeout(async () => {
    const out = [];
    const ok = (name, cond, extra) => out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  — ' + extra : ''));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const tag = () => ($('#win-tag') ? $('#win-tag').textContent : '(无)');

    ok('首屏拿到状态', !!last && !!last.latest, 'rows=' + rows.length);
    ok('推送通道在线', sseLive === true);

    const btn = document.querySelector('#ranges button[data-range="10m"]');
    ok('区间按钮存在', !!btn);
    if (btn) {
      btn.click();
      await wait(1200);
      ok('切区间后标签更新', tag() === '最近 10 分钟', tag());
      ok('切区间后曲线有数据', rows.length > 0, 'rows=' + rows.length);
      ok('切区间按钮高亮正确',
        !!document.querySelector('#ranges button[data-range="10m"]:not(.ghost)'));
      // 切回默认，别把用户的界面留在测试状态
      const back = document.querySelector('#ranges button[data-range="1h"]');
      if (back) back.click();
      await wait(600);
    }

    // 30 分钟（中等窗）：按钮要出现，点了要能切过去、标签跟着变、曲线得有数据。
    const btn30 = document.querySelector('#ranges button[data-range="30m"]');
    ok('30 分钟区间按钮存在', !!btn30);
    if (btn30) {
      btn30.click();
      await wait(1200);
      ok('30 分钟区间标签更新', tag() === '最近 30 分钟', tag());
      ok('30 分钟区间曲线有数据', rows.length > 0, 'rows=' + rows.length);
      ok('30 分钟区间秒数与后端一致', WINDOW_SEC === 1800, 'WINDOW_SEC=' + WINDOW_SEC);
      const back2 = document.querySelector('#ranges button[data-range="1h"]');
      if (back2) back2.click();
      await wait(600);
    }

    const n1 = rows.length;
    await wait(2600);
    ok('数据在持续更新', rows.length > n1 || rows.length >= 2, n1 + ' → ' + rows.length);

    // 面板口径：**大数字 = 度**（单位在紧跟的 <small> 里），副行给 Wh 和 mAh。
    // 容差按显示的末位取半格（不足 1 留 3 位、不足 100 留 2 位、再大留 1 位），
    // 这样写成 ÷100 或 ÷10000 都会被这条断言抓住。
    const unitOf = (id) => {
      const el = $('#' + id);
      const s = el && el.nextElementSibling;
      return s ? s.textContent.trim() : '';
    };
    const whTotal = parseFloat($('#e-total').textContent);
    const kwhTxt = $('#e-total-kwh').textContent;
    const kwhNum = parseFloat(kwhTxt);
    const kwhRel = Math.abs(whTotal) / 1000;
    const kwhTol = kwhRel < 1 ? 0.0005 : kwhRel < 100 ? 0.005 : 0.05;
    ok('三格大数字的单位都是「度」',
      unitOf('e-today-kwh') === '度' && unitOf('e-total-kwh') === '度' && unitOf('e-sess-kwh') === '度',
      [unitOf('e-today-kwh'), unitOf('e-total-kwh'), unitOf('e-sess-kwh')].join(' / '));
    ok('累计度数 = 累计 Wh ÷ 1000', Math.abs(kwhNum - kwhRel) <= kwhTol,
      whTotal + ' Wh → ' + kwhTxt + ' 度');
    ok('今日度数是大数字', !isNaN(parseFloat($('#e-today-kwh').textContent)),
      $('#e-today-kwh').textContent);
    const sessKwh = $('#e-sess-kwh').textContent;
    ok('本次会话度数可用', sessKwh === '—' || !isNaN(parseFloat(sessKwh)), sessKwh);

    // 副行「149.18 Wh · 40,319 mAh」：两个口径都要在，且 mAh = Wh ÷ 3.7V × 1000。
    // 千分位分隔符要先剥掉再 parseFloat，否则 "40,319" 只会解析出 40。
    const subTxt = $('#e-total').parentElement.textContent.replace(/\s+/g, ' ').trim();
    const wNum = parseFloat($('#e-total-mah').textContent.replace(/,/g, ''));
    const wRel = (Math.abs(whTotal) / 3.7) * 1000;
    const wTol = Math.max(1, wRel * 0.001);
    ok('副行同时给出 Wh 和 mAh', /Wh/.test(subTxt) && /mAh/.test(subTxt), subTxt);
    ok('累计 mAh = 累计 Wh ÷ 3.7V × 1000', Math.abs(wNum - wRel) <= wTol,
      whTotal + ' Wh → ' + wNum + ' mAh');
    ok('今日 mAh 可解析', !isNaN(parseFloat($('#e-today-mah').textContent.replace(/,/g, ''))),
      $('#e-today-mah').textContent);
    const sessW = $('#e-sess-mah').textContent;
    ok('本次会话 mAh 可用', sessW === '—' || !isNaN(parseFloat(sessW.replace(/,/g, ''))), sessW);

    // 下面两个清单也走同一套口径（有数据才断言，没数据时别假红）。
    const portText = ($('#e-ports') ? $('#e-ports').textContent : '').replace(/\s+/g, ' ');
    if (/Wh/.test(portText)) {
      ok('每口分解带 度/Wh/mAh 三种单位',
        /度/.test(portText) && /mAh/.test(portText), portText.slice(0, 100));
    }
    const sessText = ($('#e-sessions') ? $('#e-sessions').textContent : '').replace(/\s+/g, ' ');
    if (/分/.test(sessText)) {
      ok('充电会话带 度/Wh/mAh 三种单位',
        /度/.test(sessText) && /mAh/.test(sessText), sessText.slice(0, 100));
    }

    // ---- 小米电风扇卡片 ----------------------------------------------------
    // 风扇的采集链路「可失败」，所以这几条断言在任何环境下都成立（没登录也算过）：
    // 只要卡片在、文案是人话、不该露的控件没露，外加"功率/电量/曲线确实删干净了"。
    // 风扇真机联调时再看数值那条（tools\dev\smoke_fan.js 管接口，这里管界面）。
    const fanCard = $('#fan-card');
    ok('风扇卡片在', !!fanCard);
    if (fanCard) {
      const fanLink = ($('#fan-link-tag') || {}).textContent || '';
      ok('风扇链路状态是中文说法',
        /已连接|待登录|连接中|未启动|已断开|出错|搜索中/.test(fanLink), fanLink);
      const needLogin = !!($('#fan-login-hint') && !$('#fan-login-hint').hidden);
      if (needLogin) {
        ok('未登录时只露提示条（不露一堆灰开关）',
          fanCard.classList.contains('no-login')
          && getComputedStyle($('#fan-ctl-wrap')).display === 'none');
        ok('未登录时给了「登录小米云」按钮', !!$('#btn-fan-login'));
      } else {
        ok('已登录时控制区可见', getComputedStyle($('#fan-ctl-wrap')).display !== 'none');
      }
      // 大数字位现在放的是开关状态（设备回读值），不再是功率。
      // 「等待数据」是 HTML 里的初始文案（后端还没回 fan 时就是它），也算过。
      const fanSt = ($('#fan-state') || {}).textContent || '';
      ok('大数字位是开关状态而不是瓦数',
        /运行中|已关闭|等待首次读数|未运行|等待数据/.test(fanSt), fanSt);
      // 功率 / 电量 / 曲线这一套（v1.9.0 曾按档位推算）已整体删除，这里守住不让它回来
      const goneIds = ['#fan-w', '#fan-chart', '#fan-tip', '#fan-ranges', '#fan-rated',
        '#fan-e-today-kwh', '#fan-e-total-kwh', '#fan-e-sess'];
      ok('功率/电量/曲线的 DOM 已全部移除',
        goneIds.every((sel) => !$(sel)), goneIds.filter((s) => $(s)).join(',') || '都删干净了');
      ok('不再出现「推算」字样', !/推算/.test(fanCard.textContent));
    }

    const box = document.createElement('pre');
    box.id = 'selftest';
    box.style.cssText = 'position:fixed;left:0;bottom:0;z-index:99;background:#0b1220;color:#9fb3d9;'
      + 'font:12px/1.5 Consolas,monospace;padding:.5rem;white-space:pre;opacity:.92';
    box.textContent = out.join('\n');
    document.body.appendChild(box);
    const failed = out.some((l) => l.startsWith('FAIL'));
    document.title = 'SELFTEST ' + (failed ? 'FAIL' : 'OK');
    // 把结论回传服务端落盘（data/selftest.log）—— 这台机器上无头 Edge 拿不到 stdout，
    // 页面主动上报是最省事、也最可靠的一条路（见 tools/uitest.ps1）。
    try {
      await fetch('/api/selftest', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: location.search + '\n' + out.join('\n'),
      });
    } catch (_) {}
  }, 1500);
}
