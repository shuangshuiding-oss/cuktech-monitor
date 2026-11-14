// 小米电风扇（Wi-Fi / miIO）这条链路的离线回归 —— 不需要风扇在线，也不需要起服务。
//
// 单开一个文件是因为风扇这条路上有几处"看起来没问题、其实整条是废的"的坑，全都踩过：
//   ① 采集器的 {"cmd":"read"} 以前**什么都不做**、也不回 ack：服务端 await 一个
//      永远不来的 ack，8 秒后报"超时" —— 界面上的「刷新一次」于是永远只等到一句假失败，
//      而设备其实好好的。修法是 read 真的要读一次、并回 ack。
//   ② 属性表在服务端（FAN_PROPS）和采集器（WRITABLE / POLL_PROPS）各有一份，
//      错一个就是"点了没反应"或者"读回来是空的"。
//   ③ 写入必须回读确认：界面上的开关状态只能来自设备回读值，不许"我发过命令了"。
//
// ⚠️ 2026-10-11 按用户要求**整体删掉**了风扇的功率 / 用电量 / 曲线（v1.9.0 曾按档位
//    推算过），所以这个文件里有一整段是**反向断言** —— 守住"它不许长回来"。
//    理由是这台设备一个电参量属性都没有，推算出来的数看着像实测，反而误导。
//
// 前端脚本不能 require（普通 <script src>），所以这里一半是靠抽函数真跑、
// 一半是源码级断言（把"必须是这个样子"写成可判定的条件）。
//
// 用法: node tools/test_fan_front.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web', 'style.css'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const collector = fs.readFileSync(path.join(root, 'fan_collector.py'), 'utf8');
const miio = fs.readFileSync(path.join(root, 'vendor', 'miio_lan.py'), 'utf8');

const out = [];
let bad = 0;
const check = (name, cond, extra) => {
  if (!cond) bad++;
  out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   — ' + extra : ''));
};

/** 从源码里按花括号配对切出一个 function 的完整定义（能处理嵌套）。 */
function extractFn(text, name) {
  const start = text.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let i = text.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// ------------------------------------------------- 1. 功率/电量/曲线必须已经删干净
out.push('=== 1. 功率 / 用电量 / 曲线：四份代码里都不许再出现 ===');
check('前端没有风扇曲线的窗口口径（fanWinSec / fanWindowSec / fanRows / fanCache）',
  !/fanWinSec|fanWindowSec|fanRows|fanCache/.test(appJs));
check('前端没有风扇画图与悬停（drawFanChart / fanChartPad / bindFanTip）',
  !/drawFanChart|fanChartPad|bindFanTip|FAN_HEX/.test(appJs));
check('前端没有风扇区间按钮与历史拉取（renderFanRanges / pullFanHistory）',
  !/renderFanRanges|pullFanHistory/.test(appJs));
check('前端不再请求 /api/fan/history',
  !/\/api\/fan\/history/.test(appJs));
check('前端的功率/电量渲染点也删了（不再有 $(\'#fan-w\') / $(\'#fan-e-…\') 这类取用）',
  !/\$\('#fan-e-/.test(appJs) && !/\$\('#fan-w'\)/.test(appJs)
  && !/fan-e-today-kwh'\)/.test(appJs));
check('HTML 里 功率大数字 / 三格电量 / 区间按钮 / 曲线画布 / 额定功率 都不在',
  !/id="fan-w"|fan-e-today|fan-e-total|fan-e-sess|id="fan-ranges"|id="fan-chart"|id="fan-tip"|id="fan-rated"|fan-chart-hint/
    .test(html));
check('HTML 的大数字位改成了状态（fan-state 带 fan-state-big 类）',
  /class="fan-state-big" id="fan-state"/.test(html) && /\.fan-state-big\{/.test(css));
check('服务端删掉了 /api/fan/history 路由',
  !/'\/api\/fan\/history'/.test(serverSrc));
check('服务端删掉了用电量账本与分钟行历史（常量 + 函数 + 落盘 + 定时器）',
  !/FAN_ENERGY|FAN_HIST_MIN|FAN_KEEP_DAYS|fan-history-min|fan-energy/.test(serverSrc)
  && !/fanEnergy|fanMinBucket|integrateFanEnergy|fanEnergyPayload/.test(serverSrc)
  && !/queryFanHistory|pushFanHistory|seedFanHistory|flushFanMinute|rollupFanMinute|downsampleFan|fanHistCap|readFanMinRows|pruneFanMin/
    .test(serverSrc));
check('服务端删掉了额定功率配置（fanRatedW / rated_w）',
  !/fanRatedW|rated_w|ratedW/.test(serverSrc));
check('服务端 fanPayload 不再带 energy / ratedW',
  !/energy: e,|ratedW:/.test(serverSrc) && /function fanPayload\(\)/.test(serverSrc));
check('服务端 state.fan 不再有 hist 数组',
  !/state\.fan\.hist/.test(serverSrc) && !/hist: \[\],/.test(serverSrc));
check('采集器删掉了功率推算（estimate_power_w）',
  !/estimate_power_w|power_kind|power_w/.test(collector));
check('采集器配置里不再有 rated_w，state 里不再有功率字段',
  !/rated_w/.test(collector)
  && /\{"ip": "192\.168\.1\.50", "token": "00112233\.\.\.", "interval": 2\.0\}/.test(collector)
  && /"props":\{\.\.\.\}, "raw":\[\.\.\.\]/.test(collector));
check('采集器仍在报"没有电参量属性"这件事（不是说删就删掉说明）',
  /没有任何电参量属性可读/.test(collector));
check('界面自测里也加了"已删干净"的反向断言',
  /功率\/电量\/曲线的 DOM 已全部移除/.test(appJs) && /不再出现「推算」字样/.test(appJs));

// ---------------------------------------------------------------- 2. 采集器 read
out.push('');
out.push('=== 2. 「刷新一次」必须真的去读设备（踩过：read 是空操作）===');
check('采集器的 read 会读一次并推 state',
  /kind in \("ping", "read"\)[\s\S]{0,1400}emit\(snapshot\(\)\)/.test(collector));
check('采集器的 read 会回 ack（否则服务端白等 8 秒）',
  /emit\(\{"t": "ack", "id": cid, "ok": True, "cmd": "read"\}\)/.test(collector));
check('采集器的 read 失败也会回 ack（不能只有成功那条路）',
  /"cmd": "read",\s*\n\s*"error"/.test(collector));
check('服务端刷新接口等的是 ack',
  /if \(p === '\/api\/fan\/refresh'\)[\s\S]{0,400}fanCall\(\{ cmd: 'read' \}/.test(serverSrc));
check('文档里写清了 read 的语义',
  /\{"cmd":"read"\}\s*→ 立刻读一次/.test(collector));
check('界面「刷新一次」按钮已接线', /\$\('#btn-fan-refresh'\)[\s\S]{0,200}fanRefresh\(\)/.test(appJs));

// ---------------------------------------------------------------- 3. 属性表对齐
out.push('');
out.push('=== 3. 属性表：server 的 FAN_PROPS ↔ 采集器的白名单必须逐条对齐 ===');
const propBlock = /const FAN_PROPS = \{([\s\S]*?)\n\};/.exec(serverSrc);
const pairs = propBlock
  ? [...propBlock[1].matchAll(/(\w+):\s*\[(\d+),\s*(\d+)\]/g)].map((m) => [m[1], m[2] + '.' + m[3]])
  : [];
check('server 侧 FAN_PROPS 有 10 个属性', pairs.length === 10, 'n=' + pairs.length);
// 采集器白名单：(2, 1): ("power", "bool", None),
const wlBlock = /WRITABLE[^=]*=\s*\{([\s\S]*?)\n\}/.exec(collector);
const wl = new Map(wlBlock
  ? [...wlBlock[1].matchAll(/\((\d+), (\d+)\):\s*\("(\w+)"/g)].map((m) => [m[1] + '.' + m[2], m[3]])
  : []);
const missWl = pairs.filter(([, k]) => !wl.has(k));
check('每个属性都在采集器可写白名单里', missWl.length === 0, JSON.stringify(missWl));
const missName = pairs.filter(([n, k]) => wl.get(k) !== n);
check('两边的属性名也对得上', missName.length === 0, JSON.stringify(missName));
// 轮询清单里的每个 siid.piid 都要有名字（没名字的话界面拿不到属性名）
const pollBlock = /POLL_PROPS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(collector);
const pollPairs = pollBlock ? [...pollBlock[1].matchAll(/\((\d+), (\d+)\)/g)].map((m) => m[1] + '.' + m[2]) : [];
const nameBlock = /PROP_NAMES = \{([\s\S]*?)\n\}/.exec(collector);
const names = new Set(nameBlock
  ? [...nameBlock[1].matchAll(/"(\d+\.\d+)":\s*"/g)].map((m) => m[1])
  : []);
const missPn = pollPairs.filter((k) => !names.has(k));
check('轮询的每个属性都有名字（PROP_NAMES）', pollPairs.length >= 10 && missPn.length === 0,
  'poll=' + pollPairs.length + ' missing=' + JSON.stringify(missPn));
check('摆风夹角只认 30/60/90/120/140',
  /ANGLE_VALUES = \(30, 60, 90, 120, 140\)/.test(collector));

// ---------------------------------------------------------------- 4. miIO 协议
out.push('');
out.push('=== 4. miIO 局域网协议常量（写错一个就是"连不上"）===');
check('端口 54321', /\bPORT = 54321\b/.test(miio));
check('magic 0x2131', /\bMAGIC = 0x2131\b/.test(miio));
check('明文头 32 字节', /\bHEADER_LEN = 32\b/.test(miio));
check('key = MD5(token)', /self\.key = _md5\(self\.token\)/.test(miio));
check('iv = MD5(key + token)', /self\.iv = _md5\(self\.key \+ self\.token\)/.test(miio));
check('AES-128-CBC', /modes\.CBC\(iv\)/.test(miio));
check('token 只从配置文件读（不进命令行）',
  /token: t\.token, interval: fanInterval\(\)/.test(serverSrc)
  && /'--config', FAN_CFG/.test(serverSrc));

// ---------------------------------------------------------------- 5. 界面接线
out.push('');
out.push('=== 5. 风扇卡片的控件都要成套（少一个就是"点了没用"）===');
const wired = [
  ['sw-fan-power', '总开关'], ['sw-fan-osc', '左右摆风'], ['sw-fan-led', '指示灯'],
  ['sw-fan-buzzer', '提示音'], ['sw-fan-lock', '童锁'],
  ['fan-seg-level', '档位分段'], ['fan-seg-mode', '风型分段'], ['fan-angle', '摆风夹角'],
  ['fan-speed', '无级调速'], ['fan-timer', '定时数值'], ['btn-fan-timer', '定时设定'],
  ['btn-fan-refresh', '刷新一次'], ['fan-cfg-save', '保存设置'], ['btn-fan-probe', '连接自检'],
  ['btn-fan-discover', '局域网发现'], ['btn-fan-login', '登录小米云'], ['fan-fold', '卡片折叠'],
];
for (const [id, label] of wired) {
  const inHtml = html.includes('id="' + id + '"');
  // 接线时写成 $('#id') 或 buildFanControl 里的 $('#' + id) —— 两种都算接线了
  const inJs = appJs.includes("'#" + id + "'") || appJs.includes("'" + id + "'");
  check(`#${id}（${label}）`, inHtml && inJs, 'html=' + inHtml + ' js=' + inJs);
}
check('只读展示位一个不缺（功率/电量/曲线那几处已随功能删除）',
  ['fan-state', 'fan-mode', 'fan-level', 'fan-age', 'fan-dev', 'fan-where',
    'fan-raw', 'fan-link-tag', 'fan-model-tag', 'fan-fold-sum', 'fan-login-hint',
    'fan-login-msg', 'fan-probe-out', 'fan-ctl-out', 'fan-int', 'fan-dev-note']
    .every((id) => html.includes('id="' + id + '"')));
check('卡片折叠状态记在 localStorage', /cuk_fan_folded/.test(appJs));
check('每张卡的 CSS 都在（折叠 / 登录提示 / 大开关 / 滑条 / 自检输出）',
  ['#fan-card.folded', '#fan-card.no-login', '.switch.big', '.fan-slider', '.fan-probe-out']
    .every((s) => css.includes(s)));
check('浅色主题下滑条与自检框有单独配色', /html\.light \.fan-slider input\[type=range\]/.test(css));

// ---------------------------------------------------------------- 6. 写后回读
out.push('');
out.push('=== 6. 写入一律回读确认（不许"点了就当我写成功了"）===');
check('fanSet 比对了回读值', /const same = String\(j\.readback\) === String\(value\)/.test(appJs));
check('界面文字里点明"回读"', /回读/.test(appJs));
check('写入期间禁止并发（fanBusy）', /if \(fanBusy\)/.test(appJs) && /let fanBusy = false/.test(appJs));
check('一次拖滑条不会发几十条命令（input 只改显示、change 才写）',
  /sp\.oninput = \(\) =>/.test(appJs) && /sp\.onchange = \(\) => fanSet\('speed'/.test(appJs));
check('乐观翻转会在 ack 后以回读值纠正（靠服务端的全量 meta）',
  /el\.classList\.toggle\('on', !cur\)/.test(appJs) && /sseState\(\)/.test(serverSrc));
check('服务端把设备回读值贴回界面（readback 一路带到 ack）',
  /readback/.test(collector) && /readback/.test(appJs));

console.log(out.join('\n'));
console.log('\n============================================================');
console.log(`风扇前端离线回归：${out.filter((l) => l.startsWith('PASS')).length} PASS / ${bad} FAIL`);
process.exit(bad ? 1 : 0);
