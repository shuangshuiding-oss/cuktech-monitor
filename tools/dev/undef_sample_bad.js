'use strict';
// 故意写坏的样例：用来验证工具能抓到这两类错误（不要被服务器加载）
const ok = 1;
function fine() { return ok; }

missingFn();          // 调用了不存在的函数
undeclaredVar = 2;    // 未声明就赋值（'use strict' 下会抛 ReferenceError）
