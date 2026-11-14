// 用电量单位换算的离线回归 —— 不需要浏览器。
//
// 界面上的「度」和「mAh」是 app.js 里的 fmtKwh() / fmtMah() 算的（Wh/1000、Wh/3.7*1000），
// 但那个文件是浏览器脚本（顶层就用 document），Node 里 require 不了，所以这里把几行声明
// 源码抠出来单独跑，再把各量级的期望值钉住：除数写错（÷100、÷10000、忘 ×1000）、
// 3.7 V 被改成别的电压、小数位或千分位规则被改坏，都会红。
//
// 口径：1 度 = 1 kWh = 1000 Wh；mAh = Wh ÷ 3.7V × 1000（锂电芯标称，理想值）。
//
// 用法: node tools/test_kwh.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web', 'style.css'), 'utf8');

const out = [];
let bad = 0;
const check = (name, cond, extra) => {
  if (!cond) bad++;
  out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   — ' + extra : ''));
};

// ---- 1. 抠出常量与换算函数并求值 -------------------------------------------
// 这几行都必须写成**单行声明**，正则按行取（注意不要把结尾的 `;` 一起带走）。
const names = ['CELL_V', 'scaleFix', 'fmtKwh', 'mahFix', 'grp', 'fmtMah'];
const srcs = [];
for (const n of names) {
  const m = appJs.match(new RegExp('^const\\s+' + n + '\\s*=[^\\n]*;', 'm'));
  if (!m) check(`app.js 里能找到 ${n} 定义`, false);
  else srcs.push(m[0]);
}
check('六个声明都找到了', srcs.length === names.length, srcs.length + '/' + names.length);

let fns = null;
if (srcs.length === names.length) {
  try {
    fns = new Function(srcs.join('\n')
      + '\nreturn { CELL_V, scaleFix, fmtKwh, mahFix, grp, fmtMah };')();
    check('换算函数能被求值', true);
  } catch (e) {
    check('换算函数能被求值', false, e.message);
  }
}

// ---- 2. 度：除数是 1000 ----------------------------------------------------
if (fns) {
  const kwhCases = [
    [0, '0.000', '零值'],
    [null, '0.000', 'null 当 0'],
    [1, '0.001', '1 Wh'],
    [12.34, '0.012', '12.34 Wh'],
    [999, '0.999', '不足 1 度'],
    [1000, '1.00', '正好 1 度'],
    [12500, '12.50', '12.5 度'],
    [50000, '50.00', '50 度'],
    [500000, '500.0', '500 度'],
    [1000000, '1000.0', '1000 度'],
  ];
  for (const [wh, want, label] of kwhCases) {
    const got = fns.fmtKwh(wh);
    check(`fmtKwh(${wh}) = ${want}`, got === want, `${label}  实际=${got}`);
  }
  check('除数不是 100 / 10000（1000 Wh 恰好 1.00 度）', fns.fmtKwh(1000) === '1.00', fns.fmtKwh(1000));
  check('100 Wh = 0.100 度', fns.fmtKwh(100) === '0.100', fns.fmtKwh(100));

  // ---- 3. mAh：3.7 V 电芯口径 ---------------------------------------------
  check('CELL_V 是 3.7（锂电芯标称）', fns.CELL_V === 3.7, String(fns.CELL_V));
  const mahCases = [
    [0, '0.00', '零值'],
    [null, '0.00', 'null 当 0'],
    // ⚠️ 别拿正好落在 10 / 1000 这种进位点上的值当用例：0.037 Wh 除以 3.7 在浮点下是
    //    9.999999999999998，会走"不足 10 留 2 位"那一档显示成 10.00 —— 那是浮点误差，
    //    不是实现错。用例挑错开进位点的值。
    [0.04, '10.8', '0.04 Wh ≈ 10.8 mAh'],
    [1, '270.3', '1 Wh ≈ 270 mAh'],
    [3.7, '1,000', '3.7 Wh = 1000 mAh'],
    [37, '10,000', '37 Wh = 一个 10000 mAh 充电宝'],
    [370, '100,000', '370 Wh = 10 万 mAh'],
    [1000, '270,270', '1 度 ≈ 27 万 mAh'],
  ];
  for (const [wh, want, label] of mahCases) {
    const got = fns.fmtMah(wh);
    check(`fmtMah(${wh}) = ${want}`, got === want, `${label}  实际=${got}`);
  }
  // 反向陷阱：忘了 ×1000（把 mAh 当 Ah）时这条会红
  check('单位是毫安而不是安（37 Wh → 10,000）', fns.fmtMah(37) === '10,000', fns.fmtMah(37));
  check('不再出现「万毫安」这种口径', fns.fmtMah(37) !== '1.00', fns.fmtMah(37));

  // ---- 4. 小数位与千分位 --------------------------------------------------
  check('小数位：0.999 度留 3 位', fns.fmtKwh(999) === '0.999', fns.fmtKwh(999));
  check('小数位：1 度起留 2 位', fns.fmtKwh(1000) === '1.00', fns.fmtKwh(1000));
  check('小数位：100 度起留 1 位', fns.fmtKwh(100000) === '100.0', fns.fmtKwh(100000));
  check('scaleFix 对负数也按量级走', fns.scaleFix(-1) === '-1.00', fns.scaleFix(-1));

  check('mAh 小数位：不足 10 留 2 位', fns.mahFix(9.99) === '9.99', fns.mahFix(9.99));
  check('mAh 小数位：10 起留 1 位', fns.mahFix(10) === '10.0', fns.mahFix(10));
  check('mAh 小数位：1000 起不留小数', fns.mahFix(1000) === '1000', fns.mahFix(1000));

  check('千分位：1234 → 1,234', fns.grp('1234') === '1,234', fns.grp('1234'));
  check('千分位：1234567 → 1,234,567', fns.grp('1234567') === '1,234,567', fns.grp('1234567'));
  check('千分位：三位数不加分隔', fns.grp('123') === '123', fns.grp('123'));
  check('千分位：小数部分不被切开', fns.grp('1234.5') === '1,234.5', fns.grp('1234.5'));
}

// ---- 5. 界面接线：大数字=度、副行=Wh+mAh --------------------------------
const ids = ['e-today-kwh', 'e-total-kwh', 'e-sess-kwh',
             'e-today-mah', 'e-total-mah', 'e-sess-mah'];
for (const id of ids) {
  check(`index.html 有 #${id}`, html.indexOf('id="' + id + '"') >= 0);
  check(`app.js 给 #${id} 赋值`, appJs.indexOf("$('#" + id + "').textContent") >= 0);
}
check('旧 id（-wmah）已经没有了', html.indexOf('-wmah"') < 0 && appJs.indexOf('-wmah') < 0);

// 视觉层级：度在大字号 .v 里（后面紧跟 <small>度</small>），Wh/mAh 在 .sub 副行。
for (const p of ['today', 'total', 'sess']) {
  check(`#e-${p}-kwh 是主数字（</span><small>度</small>）`,
    new RegExp('id="e-' + p + '-kwh">[^<]*</span><small>度</small>').test(html));
}
check('三个副行都是「Wh · mAh」',
  (html.match(/Wh · <span id="e-(today|total|sess)-mah">/g) || []).length === 3);
check('app.js 里度赋值不再自己拼单位（单位只留 HTML 一份）',
  !/fmtKwh\([^)]*\)\s*\+\s*'/.test(appJs));
check('app.js 里 mAh 赋值不再自己拼单位',
  !/fmtMah\([^)]*\)\s*\+\s*'/.test(appJs));
check('样式里有 .stat .sub', /\.stat\s+\.sub\s*\{/.test(css));
check('7 天柱状图悬浮提示带度数', /fmtKwh\(d\.wh\)/.test(appJs));
check('7 天柱状图悬浮提示带 mAh', /fmtMah\(d\.wh\)/.test(appJs));
check('说明文字写明 3.7 V 口径（不然 mAh 容易被误读）',
  /3\.7\s*V/.test(html) && /37\s*Wh|10000\s*mAh/.test(html));
check('说明文字点明「大数字就是度」', /大数字就是「度」/.test(html));
check('界面里不再出现「万毫安」口径',
  !/万毫安/.test(html) && !/万毫安/.test(appJs));

// 「每口累计分解」和「最近充电会话」两个清单，也必须给全三种单位（Wh 不能丢）。
check('每口分解给了三种单位',
  appJs.includes('${fmtKwh(wh)} 度') && appJs.includes('${fmtMah(wh)} mAh'));
check('每口分解里 Wh 仍在', /\$\{wh\.toFixed\(3\)\} Wh/.test(appJs));
check('充电会话给了三种单位',
  appJs.includes('${fmtKwh(s.wh)} 度') && appJs.includes('${fmtMah(s.wh)} mAh'));
check('充电会话里 Wh 仍在', /\$\{s\.wh\.toFixed\(2\)\} Wh/.test(appJs));

const txt = out.join('\n') + '\n\n' + (bad ? `RESULT: FAIL (${bad} 项失败)` : `RESULT: PASS (${out.length} 项)`) + '\n';
fs.writeFileSync(path.join(root, 'tools', 'test_kwh.out.txt'), txt, 'utf8');
process.stdout.write(txt);
process.exit(bad ? 1 : 0);
