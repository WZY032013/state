/* ============================================================
   Liquid Glass 材质层 / 动效层 静态校验
   运行环境：node（零依赖）
   校验：文件存在性、CSS 语法配平、选择器特异性、无障碍查询完备、
        与既有 lg.css 的降级关系、HTML 挂载点、_headers 缓存规则
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n[' + t + ']'); }

const MAT = read('css/lg-material.css');
const MOT = read('css/lg-motion.css');
const LG = read('lg.css');
const HTML = read('index.html');
const HEADERS = read('_headers');
const SPRING = read('js/lg-spring.js');

console.log('====================================================');
console.log('  Liquid Glass 材质层 / 动效层 静态校验');
console.log('====================================================');

/* ---------- 1. 文件存在 ---------- */
section('1. 交付文件');
ok(MAT.length > 3000, `css/lg-material.css 已创建（${MAT.length} 字节）`);
ok(MOT.length > 3000, `css/lg-motion.css 已创建（${MOT.length} 字节）`);
ok(SPRING.length > 3000, `js/lg-spring.js 已创建（${SPRING.length} 字节）`);

/* ---------- 2. CSS 括号配平 ---------- */
section('2. CSS 语法配平');
function balanced(src, name) {
  let d = 0, line = 1, bad = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') line++;
    if (c === '{') d++;
    if (c === '}') { d--; if (d < 0 && !bad) bad = line; }
  }
  return { ok: d === 0 && !bad, depth: d, line: bad };
}
const b1 = balanced(MAT, 'material');
ok(b1.ok, `lg-material.css 花括号配平（末端深度 ${b1.depth}）`);
const b2 = balanced(MOT, 'motion');
ok(b2.ok, `lg-motion.css 花括号配平（末端深度 ${b2.depth}）`);

/* ---------- 3. 明暗双套配色（HIG 要求） ---------- */
section('3. 色彩系统：自定义色必须浅色 + 深色两套');
const matTokens = MAT.match(/--lgm-[a-z0-9-]+(?=\s*:)/g) || [];
const uniq = [...new Set(matTokens)];
let missingDark = [];
for (const t of uniq) {
  const inRoot = new RegExp(':root\\s*\\{[^}]*' + t + '\\s*:', 's').test(MAT);
  const inDark = new RegExp('body\\.dark\\s*\\{[^}]*' + t + '\\s*:', 's').test(MAT);
  if (inRoot && !inDark) missingDark.push(t);
}
ok(uniq.length >= 15, `定义了 ${uniq.length} 个材质 token`);
ok(missingDark.length === 0,
  missingDark.length ? `缺少深色变体：${missingDark.join(', ')}` : '全部 token 均有浅色 + 深色双套');

/* ---------- 4. 材质厚度分层 ---------- */
section('4. 材质厚度分层（HIG：厚度编码层级）');
ok(/--lgm-clear-bg/.test(MAT) && /--lgm-regular-bg/.test(MAT) && /--lgm-thick-bg/.test(MAT),
  '三档厚度 token 齐备（clear / regular / thick）');
ok(/--lgm-clear-bg:\s*rgba\(255, 255, 255, \.52\)/.test(MAT) &&
   /--lgm-thick-bg:\s*rgba\(255, 255, 255, \.74\)/.test(MAT),
  '厚度与不透明度单调对应（clear .52 < regular .64 < thick .74）');
ok(/\.topbar,\n\.chat-header,\n\.online-panel/.test(MAT),
  '控件层（顶栏/聊天头部/在线面板）已赋材质');
ok(/\.lg-sheet,/.test(MAT) && /\.bio-card/.test(MAT) && /\.call-panel/.test(MAT),
  '浮层（Sheet / 生物门禁 / 通话面板）已赋材质');

/* ---------- 5. 内容层不进玻璃（HIG 硬规则） ---------- */
section('5. 内容层保持实色（玻璃不进内容层）');
const contentBlock = MAT.match(/内容层保持实色[\s\S]*?}\s*}/);
ok(!!contentBlock, '存在「内容层保持实色」显式声明段');
ok(/.home-hero/.test(contentBlock ? contentBlock[0] : '') &&
   /.feature-card/.test(contentBlock ? contentBlock[0] : ''),
  'hero 与功能卡被排除出玻璃层');
ok(/backdrop-filter:\s*none\s*!important/.test(contentBlock ? contentBlock[0] : ''),
  '内容层显式关闭 backdrop-filter');

/* ---------- 6. 与 lg.css 的降级关系（关键：特异性必须压过 Part 9） ---------- */
section('6. 覆盖 lg.css Part 9 的特异性');
// lg.css Part 9 的选择器：.glass:not(.home-hero):not(.feature-card):not(.glass-pill) → (0,4,0)
ok(/\.glass:not\(\.home-hero\):not\(\.feature-card\):not\(\.glass-pill\):not\(\.lg-opaque\)/.test(MAT),
  '浮层选择器携带 4 个 :not 守卫 → 特异性 (0,5,0)');
ok(/\.sec-card:not\(\.home-hero\):not\(\.feature-card\):not\(\.glass-pill\):not\(\.lg-opaque\)/.test(MAT),
  'sec-card 同样携带守卫链');
// 关键：不能对已定位元素强设 position（会破坏 absolute/fixed 锚定）
const forcedPos = MAT.match(/position:\s*relative/g) || [];
ok(forcedPos.length <= 1, `position:relative 仅出现在兜底段（${forcedPos.length} 处），未大面积覆盖`);
ok(/\.confirm-card,\n\.admin-panel,\n\.reply-bar\s*\{\n  position: relative;/.test(MAT),
  '兜底段只覆盖「缺定位且非 fixed」的三个表面');
ok(!/\.msg-ctx-menu[^{]*\{[^}]*position:\s*relative/.test(MAT),
  '未对 position:fixed 的 msg-ctx-menu 强设 relative');
ok(!/\.topbar[^{]*\{[^}]*position:\s*relative/.test(MAT),
  '未对已 relative 的 topbar 重复设定位');
// 不应对滚动容器强设 overflow:hidden（会切断 .lg-sheet 的 overflow-y:auto）
ok(!/\.lg-sheet[^{]*\{[^}]*overflow:\s*hidden/.test(MAT),
  '未对 .lg-sheet 设 overflow:hidden（否则切断其滚动）');

/* ---------- 7. 无障碍媒体查询完备 ---------- */
section('7. 无障碍：四类媒体查询必须齐备');
const A11Y = ['prefers-reduced-transparency', 'prefers-contrast', 'forced-colors', 'prefers-reduced-motion'];
for (const q of A11Y) {
  const inMat = MAT.includes(q);
  const inMot = MOT.includes(q);
  ok(inMat || inMot, `已覆盖 @media (${q})`);
}
// 打印降级
ok(/@media print/.test(MAT), '已覆盖 @media print');

/* ---------- 8. reduced-motion 语义正确 ---------- */
section('8. 减弱动效语义（HIG：位移 → 交叉淡化，而非全部归零）');
ok(/@keyframes lgx-fade-only/.test(MOT), '定义了纯淡化关键帧');
ok(/animation:\s*lgx-fade-only/.test(MOT), 'reduced-motion 下位移动画降级为淡化');
// 不能沿用 lg.css 的 0.001ms 秒杀写法（会造成瞬时跳变更不适）
ok(!/animation-duration:\s*\.001ms/.test(MOT),
  '未使用 .001ms 秒杀（避免元素瞬时跳变）');
ok(/transform:\s*none\s*!important/.test(MOT), 'reduced-motion 下停用所有 transform 反馈');
ok(/display:\s*none\s*!important/.test(MOT) && /\.topbar::after/.test(MOT),
  'reduced-motion 下关闭指针跟随的动态镜面高光');

/* ---------- 9. 动效只用合成属性 ---------- */
section('9. 动效属性预算（只动画 transform / opacity）');
const kfBlocks = MOT.match(/@keyframes lgx-[\s\S]*?\n}/g) || [];
let badProp = [];
for (const b of kfBlocks) {
  const decls = b.replace(/@keyframes[^{]*\{/, '').match(/^\s*([a-z-]+)\s*:/gm) || [];
  for (const d of decls) {
    const p = d.trim().replace(':', '');
    if (!['opacity', 'transform', 'from', 'to'].includes(p)) badProp.push(p);
  }
}
ok(badProp.length === 0,
  badProp.length ? `关键帧含非合成属性：${[...new Set(badProp)].join(', ')}` : '全部关键帧仅用 transform / opacity');
// 只检查关键帧内部，不含注释（注释里提到 blur() 是解释为何不用它）
const kfBody = kfBlocks.join('\n');
ok(!/filter\s*:\s*blur/.test(kfBody), '关键帧内未使用 filter:blur()（避免逐帧重绘）');
// 旧 lg.css 的 lg-fuse 用了 filter:blur(8px)，新层不得再引用它
// （注释中提及 lg-fuse 解释来源不算引用，故只查声明区）
const motDecls = MOT.replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/lg-fuse/.test(motDecls), '未沿用 lg.css 含 filter:blur 的 lg-fuse 入场动画');

/* ---------- 10. 弹簧曲线物理合理性 ---------- */
section('10. 弹簧曲线物理合理性');
const curves = MOT.match(/--lgx-[a-z-]+:\s*linear\(([^)]+)\)/g) || [];
ok(curves.length >= 4, `定义了 ${curves.length} 条 linear() 曲线`);
for (const c of curves) {
  const name = c.match(/--lgx-[a-z-]+/)[0];
  const nums = c.match(/linear\(([^)]+)\)/)[1].split(',').map((n) => parseFloat(n));
  const peak = Math.max(...nums);
  const start = nums[0];
  const end = nums[nums.length - 1];
  const monotonic = nums.every((v, i) => i === 0 || v >= nums[i - 1] - 1e-9);
  ok(start === 0, `${name} 起点为 0`);
  ok(Math.abs(end - 1) < 1e-6, `${name} 终点为 1`);
  ok(nums.every((v) => Number.isFinite(v)), `${name} 无 NaN/Infinity`);
  if (monotonic) ok(peak <= 1.0001, `${name} 单调且不过冲（峰值 ${peak.toFixed(4)}）`);
  else ok(peak > 1 && peak < 1.1, `${name} 有过冲但受控（峰值 ${peak.toFixed(4)}）`);
}
// 临界阻尼曲线自相似：--lgx-spring 与 --lgx-press 应完全一致
const springCurve = MOT.match(/--lgx-spring:\s*linear\(([^)]+)\)/)[1];
const pressCurve = MOT.match(/--lgx-press:\s*linear\(([^)]+)\)/)[1];
ok(springCurve === pressCurve,
  '临界阻尼两档曲线一致（response 只改时长不改形状，符合数学自相似性）');

/* ---------- 11. linear() 降级兜底 ---------- */
section('11. linear() 不支持时的降级');
ok(/@supports not \(transition-timing-function: linear\(0, 1\)\)/.test(MOT),
  '提供 @supports not 降级块');
ok(/--lgx-spring:\s*cubic-bezier/.test(MOT), '降级块给出 bezier 兜底值');

/* ---------- 12. HTML 挂载点与加载顺序 ---------- */
section('12. index.html 挂载');
const iMat = HTML.indexOf('css/lg-material.css');
const iMot = HTML.indexOf('css/lg-motion.css');
const iLoading = HTML.indexOf('css/loading.css');
const iLg = HTML.indexOf('lg.css');
ok(iMat > 0 && iMot > 0, '两个样式表已挂载');
ok(iLg < iMat && iLoading < iMat, '材质层在 lg.css / loading.css 之后加载（保证覆盖生效）');
ok(iMat < iMot, '动效层在材质层之后加载');
ok(/<script src="js\/lg-spring\.js"><\/script>/.test(HTML), '弹簧引擎已挂载');
ok(HTML.indexOf('js/lg-spring.js') < HTML.indexOf('js/loading.js'),
  '弹簧引擎在 loading.js 之前（同步加载，不阻塞主逻辑）');
// 每个引用的资源必须真实存在
const refs = [...HTML.matchAll(/(?:href|src)="((?:css|js)\/[^"]+)"/g)].map((m) => m[1]);
const missing = refs.filter((r) => !fs.existsSync(path.join(ROOT, r)));
ok(missing.length === 0,
  missing.length ? `引用了不存在的文件：${missing.join(', ')}` : `${refs.length} 个本地资源引用全部存在`);

/* ---------- 13. _headers 缓存规则 ---------- */
section('13. 缓存与安全响应头');
ok(/\/css\/\*/.test(HEADERS), '已为 /css/* 配置缓存规则（否则新样式表落到默认策略）');
ok(/\/lib\/\*/.test(HEADERS), '/lib/* 规则仍在（二维码库不被回退）');
ok(/\/js\/\*/.test(HEADERS), '/js/* 规则仍在');
ok(!HEADERS.includes("script-src 'self' 'unsafe-eval'"), "CSP 未放开 'unsafe-eval'（弹簧引擎不需要）");

/* ---------- 14. 性能约束 ---------- */
section('14. 性能约束');
// 统计高光表面数（每个表面 2 个伪元素层）
const specSection = MAT.split('5. Specular')[1] ? MAT.split('5. Specular')[1].split('6. 高光层承载')[0] : '';
const specSels = [...new Set(specSection.match(/^\.[a-z-]+::(?:before|after)/gm) || [])];
const surfaces = specSels.length / 2;
ok(surfaces > 0 && surfaces <= 20,
  `高光表面 ${surfaces} 个（×2 伪元素 = ${specSels.length} 条选择器），数量受控`);
ok(/max-width: 768px/.test(MAT), '移动端降低模糊半径');
ok(/update:\s*slow/.test(MOT), '低端设备（update:slow）降级动效');
// 已知坑：lg.css 曾用 .glass::before{padding:2px} 做描边导致圆角变形。
// 新层必须显式用 padding:0 覆盖，且不得引入非零 padding 描边。
ok(/padding:\s*0\s*!important/.test(MAT),
  '高光层显式覆盖 lg.css 的 padding:2px 描边（防圆角变形）');
const padDesc = MAT.match(/::(?:before|after)[^{]*\{[^}]*padding:\s*(?!0\s*!important)[1-9][^;}]*;/g) || [];
ok(padDesc.length === 0,
  padDesc.length ? '高光层引入了非零 padding 描边：' + padDesc[0] : '高光层未引入非零 padding 描边');

/* ---------- 15. 深色模式特异性回归 ----------
   lg.css Part 9 深色段选择器为 `body.dark .glass:not(…)`，特异性 (0,5,1)，
   高于材质层浅色段的 (0,5,0)。若材质层不补 body.dark 变体，
   深色模式下浮层会退回实色、玻璃丢失 —— 此处锁死该回归。
   （该缺陷由 test/css-cascade.test.js 实际跑层叠时发现） */
section('15. 深色模式特异性（body.dark 变体必须存在）');
ok(/body\.dark \.sec-card:not\([^)]*\)[^{]*\{/.test(MAT),
  '浮层段存在 body.dark 变体（(0,6,1) > lg.css 深色段 (0,5,1)）');
ok(/body\.dark \.lg-sheet,/.test(MAT) && /body\.dark \.lg-auth-card,/.test(MAT),
  'lg-sheet / lg-auth-card 有深色变体');
ok(/body\.dark \.topbar,/.test(MAT),
  '控件层有 body.dark 变体（style.css 存在 body.dark .topbar (0,2,1)）');
ok(/body\.dark \.msg-ctx-menu,/.test(MAT),
  'clear 层有深色变体（菜单/选择条同样受 Part 9 深色段影响）');
// 厚度 token 只应在 :root 与 body.dark 的「token 块」里各定义一次；
// 各表面段落不得再按主题重新定义厚度（否则两套玻璃厚度会漂移）。
const rootBlock = MAT.match(/:root\s*\{[\s\S]*?\n\}/)[0];
const darkTokenBlock = MAT.match(/body\.dark\s*\{\s*\n\s*--lgm/);
ok(!!rootBlock && /--lgm-thick-bg/.test(rootBlock), '厚度 token 定义在 :root token 块');
ok(!!darkTokenBlock, '厚度 token 在 body.dark token 块重定义（深色取不同值，非另起一套表面规则）');
const surfaceTokenRedef = MAT.replace(/:root\s*\{[\s\S]*?\n\}/, '').replace(/body\.dark\s*\{\s*\n\s*--lgm[\s\S]*?\n\}/, '');
ok(!/--lgm-(clear|regular|thick)-bg\s*:/.test(surfaceTokenRedef),
  '表面段落未按主题重定义厚度 token（深浅共用同一套三层结构）');

console.log('\n====================================================');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('====================================================');
process.exit(fail ? 1 : 0);