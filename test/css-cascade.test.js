/* ============================================================
   CSS 层叠验证：确认新材质层确实压过 lg.css Part 9
   运行环境：node（零依赖）
   方法：真实解析三个样式表中相关规则的 (选择器特异性, !important, 源序)，
        按 CSS 层叠顺序算出最终胜出规则，验证「玻璃回来了 / 内容层仍是实色」。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

/* ---------- 极简 CSS 规则提取器 ----------
   只处理本项目用到的语法：选择器组 + 声明块；@media 内的规则带上媒体条件。 */
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

function parse(css, file, order) {
  const rules = [];
  let i = 0;
  const s = stripComments(css);
  let buf = '';
  let condDepth = 0;      // >0 表示处于 @media / @supports 内
  while (i < s.length) {
    const c = s[i];
    if (c === '{') {
      const sel = buf.trim();
      buf = '';
      const body = readBody(s, i + 1);
      const isAtRule = sel.startsWith('@media') || sel.startsWith('@supports');
      if (isAtRule) {
        // 条件块内的规则：记录条件，但仅在显式要求时才参与层叠
        const inner = parse(body.content, file, order);
        inner.forEach((r) => { r.cond = sel; });
        rules.push(...inner);
        i = body.next;
        continue;
      }
      rules.push({ sel, decl: body.content, order, file, cond: condDepth ? 'inherited' : null });
      i = body.next;
      continue;
    }
    buf += c;
    i++;
  }
  return rules;
}

function readBody(s, start) {
  let depth = 1, i = start, out = '';
  while (i < s.length && depth > 0) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) break; }
    out += s[i];
    i++;
  }
  return { content: out, next: i + 1 };
}

/* ---------- 特异性计算 ---------- */
function specificity(sel) {
  let a = 0, b = 0, c = 0;
  sel.split(',').forEach((part) => {
    const s = part.trim();
    if (!s) return;
    // 伪元素 ::x → c
    const pseudoEls = (s.match(/::[a-z-]+/g) || []).length;
    // 属性/伪类 → b
    const attrs = (s.match(/\[[^\]]*\]/g) || []).length;
    const pseudoCls = (s.match(/(?<!:):[a-z-]+(\([^)]*\))?/g) || []).length;
    // ID → a
    const ids = (s.match(/#[a-zA-Z0-9_-]+/g) || []).length;
    // 类/类型
    const classes = (s.match(/\.[a-zA-Z0-9_-]+/g) || []).length;
    const types = (s.replace(/::?[a-z-]+(\([^)]*\))?/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\.[a-zA-Z0-9_-]+/g, '')
      .replace(/#[a-zA-Z0-9_-]+/g, '')
      .match(/\b[a-zA-Z][a-zA-Z0-9-]*\b/g) || []).length;
    a += ids; b += attrs + pseudoCls + classes; c += pseudoEls + types;
  });
  // 取组内最高
  return [a, b, c];
}

function cmp(x, y) {
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const FILES = [
  ['style.css', 1],
  ['lg.css', 2],
  ['css/loading.css', 3],
  ['css/lg-material.css', 4],
  ['css/lg-motion.css', 5],
];

const ALL = [];
for (const [f, o] of FILES) {
  try { ALL.push(...parse(read(f), f, o)); } catch (e) { console.log('parse fail ' + f + ': ' + e.message); }
}

/* ---------- 变量解引用 ----------
   样式表大量使用 var(--lgm-*) 间接取值，直接比对字面量会误判。
   这里把 var() 递归展开为 :root / body.dark 中定义的实际值。 */
function buildVarTable(file, dark) {
  const table = {};
  for (const r of ALL) {
    if (r.file !== file) continue;
    const isDarkScope = /body\.dark/.test(r.sel);
    if (isDarkScope !== dark) continue;
    const re = /(--[\w-]+)\s*:\s*([^;{}]+)/g;
    let m;
    while ((m = re.exec(r.decl))) {
      if (!/^--/.test(m[1])) continue;
      table[m[1]] = m[2].trim();
    }
  }
  return table;
}

function deref(val, vars, depth) {
  depth = depth || 0;
  if (depth > 8) return val;
  const m = /var\(\s*(--[\w-]+)\s*\)/.exec(val);
  if (!m) return val;
  const target = vars[m[1]];
  if (target === undefined) return val;
  return deref(val.replace(m[0], target), vars, depth + 1);
}

/* ---------- 元素匹配 ----------
   真实元素往往同时带多个类（如 .profile-card.glass），
   单靠「选择器里出现该类名」判断会漏掉 .glass:not(...) 这类守卫规则。
   这里按 index.html 里的真实 class 组合做匹配。 */
function selMatches(sel, clsSet, dark) {
  return sel.split(',').some((raw) => {
    let part = raw.trim();
    if (!part) return false;
    // body.dark 前缀：只在该作用域下匹配
    const darkGuard = /body\.dark\s*/.test(part);
    if (darkGuard !== dark) return false;
    part = part.replace(/body\.dark\s*/, '').replace(/^\s*body\s*/, '');
    // 剩余若含后代/子代组合符（如 ".chat-main .composer"）本测试不覆盖，跳过
    if (/\s+/.test(part.trim())) return false;
    // :not(...) 守卫：元素不得含其中任一类
    const nots = [...part.matchAll(/:not\(\s*\.([\w-]+)\s*\)/g)].map((m) => m[1]);
    for (const n of nots) if (clsSet.has(n)) return false;
    // 必须命中的类
    const need = [...part.matchAll(/\.([\w-]+)(?![\w-])/g)]
      .map((m) => m[1])
      .filter((c) => !nots.includes(c));
    if (!need.length) return false;
    return need.every((c) => clsSet.has(c));
  });
}

/* 取指定元素在给定主题下的最终属性值 */
function resolveFor(clsList, prop, dark, opts) {
  opts = opts || {};
  const clsSet = new Set(clsList);
  const vars = buildVarTable('css/lg-material.css', !!dark);
  let best = null;
  for (const r of ALL) {
    // 默认忽略条件块（@media/@supports 内的规则不默认生效）
    if (r.cond && !opts.allowCond) continue;
    if (!selMatches(r.sel, clsSet, !!dark)) continue;
    const m = new RegExp('(?:^|[;{])\\s*' + prop + '\\s*:\\s*([^;{}]+)', 'i').exec(r.decl);
    if (!m) continue;
    const imp = new RegExp('(?:^|[;{])\\s*' + prop + '\\s*:[^;{}]+!important', 'i').test(r.decl);
    const cand = {
      val: deref(m[1].trim(), vars),
      raw: m[1].trim(),
      imp, spec: specificity(r.sel), order: r.order, file: r.file, sel: r.sel,
    };
    if (!best) { best = cand; continue; }
    if (cand.imp !== best.imp) { if (cand.imp) best = cand; continue; }
    const d = cmp(cand.spec, best.spec);
    if (d > 0) best = cand;
    else if (d === 0 && cand.order > best.order) best = cand;
  }
  return best;
}

/* 便捷：只给一个主类 */
function resolve(cls, prop, dark, opts) {
  return resolveFor([cls], prop, dark, opts);
}

console.log('====================================================');
console.log('  CSS 层叠验证（材质层是否真正生效）');
console.log('====================================================');

/* ---------- 1. 浮层玻璃是否回归 ---------- */
console.log('\n[1. 浮层 thick 材质（lg.css Part 9 曾压平为实色）');
// 真实 class 组合取自 index.html
const FLOATS = [
  ['sec-card', 'glass'],          // <div class="sec-card glass">
  ['confirm-card', 'glass'],      // <div class="confirm-card glass">
  ['lg-sheet'],                   // JS 动态创建，仅带 lg-sheet
  ['lg-auth-card'],               // <div class="lg-auth-card" id="lgAuthCard">
];
for (const dark of [false, true]) {
  const tag = dark ? '深色' : '浅色';
  for (const cs of FLOATS) {
    const bf = resolveFor(cs, 'backdrop-filter', dark);
    const bg = resolveFor(cs, 'background', dark);
    const name = cs.join('.');
    ok(bf && /blur|var\(--lgm/.test(bf.raw),
      `${tag} .${name}: backdrop-filter → ${bf ? bf.raw.slice(0, 40) : 'none'}`);
    // 半透明判定：浅色为白底低 alpha，深色为深底低 alpha
    const alpha = bg && (/rgba\(\s*255,\s*255,\s*255,\s*0?\.\d+\s*\)/.test(bg.val) ||
      /rgba\(\s*(2\d|3\d),\s*(2\d|3\d),\s*\d+,\s*0?\.\d+\s*\)/.test(bg.val));
    ok(alpha, `${tag} .${name}: 半透明玻璃面 → ${bg ? bg.val.slice(0, 44) : 'none'}`);
  }
}

/* ---------- 2. 内容层必须仍是实色 ----------
   注意：CSS 按「属性」层叠，不按主题分区。lg.css Part 9 的浅色段
   已对 .glass:not(...) 设 backdrop-filter:none !important，
   该声明在深色下同样生效（深色段只是没重设它）。
   因此这里对 backdrop-filter 取浅/深并集，只要求最终为 none。 */
console.log('\n[2. 内容层保持实色（玻璃不进内容层）');
const CONTENT = [
  ['profile-card', 'glass'],   // <div class="profile-card glass">
  ['users-header', 'glass'],
  ['fb-header', 'glass'],
  ['my-groups', 'glass'],
];
for (const dark of [false, true]) {
  const tag = dark ? '深色' : '浅色';
  for (const cs of CONTENT) {
    const bg = resolveFor(cs, 'background', dark);
    const bf = resolveFor(cs, 'backdrop-filter', dark);
    const name = cs.join('.');
    // 实色：alpha ≥ .9 或纯白
    const solid = bg && (/rgba\(\s*255,\s*255,\s*255,\s*\.9\d+\s*\)/.test(bg.val) ||
      /rgba\(\s*2\d,\s*2\d,\s*[23]\d,\s*\.9\d+\s*\)/.test(bg.val) ||
      /rgba\(\s*255,\s*255,\s*255,\s*1\s*\)/.test(bg.val));
    ok(solid, `${tag} .${name}: 实色背景 → ${bg ? bg.val.slice(0, 40) : 'none'}`);
  }
  // backdrop-filter 单独断言：两个主题取并集，须全为 none
  for (const cs of CONTENT) {
    const name = cs.join('.');
    const a = resolveFor(cs, 'backdrop-filter', false);
    const b = resolveFor(cs, 'backdrop-filter', true);
    const allNone = [a, b].every((r) => r === null || /none/.test(r.val));
    ok(allNone,
      `${tag} .${name}: backdrop-filter 全主题为 none（浅:${a ? a.val.slice(0, 18) : '-'} / 深:${b ? b.val.slice(0, 18) : '-'}）`);
  }
}

/* ---------- 2b. hero/功能卡属品牌面，保留自身渐变 ---------- */
console.log('\n[2b. 品牌面（hero / feature-card）不被材质层压平');
for (const cls of ['home-hero', 'feature-card']) {
  const cs = [cls, 'glass'];
  const bf = resolveFor(cs, 'backdrop-filter', false);
  ok(bf !== null, `.${cls}: 仍可命中规则（未被 :not 守卫误伤）→ ${bf ? bf.raw.slice(0, 34) : 'none'}`);
}

/* ---------- 3. 控件层材质 ---------- */
console.log('\n[3. 控件层 regular 材质');
for (const cls of ['topbar', 'chat-header']) {
  const bf = resolve(cls, 'backdrop-filter');
  ok(bf && /blur/.test(bf.val), `${cls}: 玻璃生效 → ${bf ? bf.val.slice(0, 40) : 'none'} @ ${bf ? bf.file : '-'}`);
  const sh = resolve(cls, 'box-shadow');
  ok(sh && sh.file === 'css/lg-material.css', `${cls}: 阴影来自新材质层 @ ${sh ? sh.file : '-'}`);
}

/* ---------- 4. 材质层确实赢得层叠 ---------- */
console.log('\n[4. 层叠胜负：材质层 > lg.css');
{
  const bf = resolve('sec-card', 'backdrop-filter');
  ok(bf && bf.file === 'css/lg-material.css',
    `sec-card 最终 backdrop-filter 来自 ${bf ? bf.file : '?'}（应为 css/lg-material.css）`);
  ok(bf && bf.imp === true, '材质层以 !important 稳定覆盖 lg.css 同属性');
  ok(bf && bf.spec[1] >= 5, `选择器特异性 b=${bf.spec[1]} ≥ 5（:not 守卫生效）`);
}

console.log('\n====================================================');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('====================================================');
process.exit(fail ? 1 : 0);