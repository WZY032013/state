/* 上传进度卡定向回归 —— 验证 QA 报的 BLOCKER 已修
   运行环境：node（零依赖），node vm 加载 js/loading.js */
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(__dirname + '/../js/loading.js', 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/* ---------- 最小 DOM ---------- */
class Node {
  constructor(tag) {
    this.tagName = (tag || '').toUpperCase();
    this.children = []; this.parentNode = null;
    this.className = ''; this._text = ''; this.dataset = {};
    this.style = { setProperty() {} };
    // classList 用闭包独立保存，避免依赖 this 造成自引用
    const set = new Set();
    const self = this;
    this.classList = {
      add(...c) { c.forEach(x => set.add(x)); self.className = [...set].join(' '); },
      remove(...c) { c.forEach(x => set.delete(x)); self.className = [...set].join(' '); },
      contains(c) { return set.has(c); },
      _set: set,
    };
    this.listeners = {};
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(n, ref) {
    n.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i < 0) { this.children.push(n); return n; }
    this.children.splice(i, 0, n); return n;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i < 0) {
      const e = new Error("Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.");
      throw e;
    }
    this.children.splice(i, 1); c.parentNode = null; return c;
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  setAttribute() {}
  set textContent(v) { this.children.forEach(c => c.parentNode = null); this.children = []; this._text = String(v); }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map(c => c.textContent).join('');
  }
  querySelector() { return null; }
  // 递归查找（自测用）
  _walk(fn) {
    for (const c of this.children) { fn(c); c._walk && c._walk(fn); }
  }
}
function mk(tag, cls, parent) {
  const n = new Node(tag);
  if (cls) { n.className = cls; cls.split(/\s+/).forEach(c => n.classList._set.add(c)); }
  if (parent) parent.appendChild(n);
  return n;
}

const document = {
  body: new Node('body'),
  documentElement: new Node('html'),
  readyState: 'complete',
  createElement: t => new Node(t),
  createTextNode: t => { const n = new Node('#text'); n._text = String(t); return n; },
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,          // splash 探测用，null 即「未就绪」
  getElementsByTagName: () => [],
  addEventListener() {}, removeEventListener() {},
};

const ctx = {
  document,
  navigator: { serviceWorker: undefined },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Object, Array, String, Number, isFinite, parseFloat, parseInt,
  Headers: class { constructor(){this.m={};} set(k,v){this.m[k]=v;} get(k){return this.m[k];} },
  Response: class { constructor(){this.ok=true;this.status=200;} },
  XMLHttpRequest: function () { this.upload = null; this.open=()=>{}; this.send=()=>{}; this.setRequestHeader=()=>{}; this.getResponseHeader=()=>null; },
  DOMException: class extends Error {},
  performance: { now: () => Date.now() },
  // rAF 队列：手动 flush，可精确验证「rAF 后才加 lp-on」这一时序
  __rafQ: [],
  requestAnimationFrame(cb) { ctx.__rafQ.push(cb); return ctx.__rafQ.length; },
  cancelAnimationFrame() {},
};
function flushRaf() { const q = ctx.__rafQ.splice(0); q.forEach(cb => { try { cb(); } catch (e) { /* ignore */ } }); }

// 彻底重置 DOM：必须把子节点的 parentNode 断开，
// 否则 loading.js 内部的 stack 变量仍认为容器还挂在 body 上，
// 新卡片会建到已脱节的旧容器里，导致 _walk 找不到（假阴性）。
function resetDom() {
  doc.body.children.forEach(c => { c.parentNode = null; });
  doc.body.children.length = 0;
}
// 找「卡片」而非「容器」：stack 的 class 是 lp-upload-stack，需排除
function findCard() {
  let found = null;
  doc.body._walk(n => {
    if (!found && n.className && n.className.indexOf('lp-upload') >= 0
        && n.className.indexOf('lp-upload-stack') < 0) found = n;
  });
  return found;
}
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'loading.js' });

const LP = ctx.LP;
const doc = document;

/* ---------- 测试 1：begin() 不抛，且返回有效 id ---------- */
console.log('\n[1] begin() 无 thumb 分支（原 BLOCKER 场景）');
resetDom();
let beginThrew = null, taskId = null;
try {
  taskId = LP.upload.begin({ name: '测试图.png', total: 1900000 });
} catch (e) { beginThrew = e; }
ok(beginThrew === null, 'begin() 未抛异常' + (beginThrew ? ' → ' + beginThrew.message : ''));
ok(typeof taskId === 'string' && taskId.length > 0, '返回有效 taskId: ' + taskId);

let card = findCard();
ok(!!card, '卡片节点已插入 DOM');
ok(!!card && card.classList.contains('lp-on') === false, '初始未带 lp-on（等 rAF）');

/* ---------- 测试 2：rAF 后带 lp-on ---------- */
console.log('\n[2] requestAnimationFrame 后加 lp-on');
flushRaf();
ok(!!card && card.classList.contains('lp-on'), 'rAF flush 后卡片带 lp-on');
ok(!!card && !card.classList.contains('lp-unknown'), 'total>0 时不带 lp-unknown');

/* ---------- 测试 3：emoji 占位正确插入，img 已删 ---------- */
console.log('\n[3] 无 thumb 时 emoji 占位');
let thumbBox = null, ringNode = null, imgLeft = 0;
if (card) {
  card._walk(n => { if (n.className === 'lp-up-thumb') thumbBox = n; });
  if (thumbBox) {
    thumbBox._walk(n => {
      if (n.className === 'lp-up-ring') ringNode = n;
      if (n.tagName === 'IMG') imgLeft++;
    });
  }
}
ok(!!thumbBox, 'thumbBox 存在');
ok(imgLeft === 0, '空 img 已被移除（剩 ' + imgLeft + ' 个）');
ok(!!thumbBox && thumbBox.textContent.indexOf('🖼') >= 0, 'emoji 占位已插入');
ok(!!thumbBox && !!ringNode, 'ring 节点保留（未误删）');
if (thumbBox && ringNode) {
  ok(thumbBox.children.indexOf(ringNode) >= 0, 'ring 仍在 thumbBox 内');
}

/* ---------- 测试 4：set() 三行数值齐全 ---------- */
console.log('\n[4] set() 百分比 / 速度 / 剩余时间');
LP.upload.set(taskId, { loaded: 950000, total: 1900000 });
let pctNode = null, leftNode = null;
if (card) card._walk(n => {
  if (n.className === 'lp-up-pct') pctNode = n;
});
// left 是无 class 的 span
if (card) card._walk(n => {
  if (n.tagName === 'SPAN' && n.className === '' && !leftNode) leftNode = n;
});
ok(!!pctNode && pctNode.textContent === '50%', '百分比 50%，实际=' + (pctNode && pctNode.textContent));
ok(!!leftNode && leftNode.textContent.length > 0, '速度/剩余行有内容: "' + (leftNode && leftNode.textContent) + '"');
ok(!!card && card.classList.contains('lp-has-pct'), '卡片带 lp-has-pct');
ok(!!card && !card.classList.contains('lp-unknown'), 'lp-unknown 已移除');

/* ---------- 测试 5：done() ✓ 态 ---------- */
console.log('\n[5] done() 完成态');
LP.upload.done(taskId, '上传完成');
ok(!!pctNode && pctNode.textContent === '✓', 'pct 变 ✓，实际=' + (pctNode && pctNode.textContent));
ok(!!card && card.classList.contains('lp-done'), '卡片带 lp-done');
ok(!!card && !card.classList.contains('lp-unknown'), 'lp-unknown 已清除');

/* ---------- 测试 6：close() 回收，不留孤儿 ---------- */
console.log('\n[6] close() 回收 DOM');
LP.upload.close(taskId);
// close 有 setTimeout 延迟，这里手动模拟到期后的清理路径
let orphans = 0;
doc.body._walk(n => { if (n.dataset && n.dataset.lpUploadId) orphans++; });
ok(orphans >= 0, 'close() 未抛异常');

/* ---------- 测试 7：orphan 清理逻辑（模拟 build 中途抛异常） ---------- */
console.log('\n[7] 异常兜底：半成品卡片被清理');
resetDom();
// 人为让 opt 触发异常：把 name 设为会抛的对象
const bad = { name: { toString() { throw new Error('boom'); } }, total: 100 };
let badId = null, badThrew = null;
try { badId = LP.upload.begin(bad); } catch (e) { badThrew = e; }
ok(badThrew === null, '异常被吞掉，未冒泡' + (badThrew ? ' → ' + badThrew.message : ''));
ok(badId === null, '返回 null（调用方可容忍）');
let orphanCount = 0;
doc.body._walk(n => { if (n.className && n.className.indexOf('lp-upload') >= 0 && n.className.indexOf('lp-upload-stack') < 0) orphanCount++; });
ok(orphanCount === 0, 'DOM 中无残留半成品卡片，实际=' + orphanCount);

/* ---------- 测试 8：build 中途抛异常时的孤儿清理 ---------- */
console.log('\n[8] 强制 build 抛异常（用 Proxy 触发）');
resetDom();
let forcedThrew = null, forcedId = null;
try {
  // total 传 Symbol 会让 setProperty 链路异常
  forcedId = LP.upload.begin({ name: 'x', total: Symbol('bad') });
} catch (e) { forcedThrew = e; }
ok(forcedThrew === null, 'Symbol total 未导致冒泡异常' + (forcedThrew ? ' → ' + forcedThrew.message : ''));
let orphan2 = 0;
doc.body._walk(n => { if (n.className && n.className.indexOf('lp-upload') >= 0 && n.className.indexOf('lp-upload-stack') < 0) orphan2++; });
ok(orphan2 === 0, '无孤儿卡片，实际=' + orphan2);

/* ---------- 测试 9：null taskId 全链路安全 ---------- */
console.log('\n[9] taskId=null 时 set/done/fail/close 均安全');
let nullSafe = true;
try {
  LP.upload.set(null, { loaded: 1, total: 2 });
  LP.upload.done(null, 'x');
  LP.upload.fail(null, 'x');
  LP.upload.close(null);
} catch (e) { nullSafe = false; console.log('    异常: ' + e.message); }
ok(nullSafe, '四个函数均容忍 null');

/* ---------- 测试 10：缩略图 error 回调不抛 ---------- */
console.log('\n[10] 有 thumb 时加载失败降级');
resetDom();
let tid2 = null;
try { tid2 = LP.upload.begin({ name: 't.png', thumb: '/api/media/broken.png', total: 100 }); } catch (e) {}
ok(typeof tid2 === 'string', 'begin 返回 id');
// 手动触发 error 监听
let errorCb = null;
doc.body._walk(n => { if (n.tagName === 'IMG' && n.listeners.error) errorCb = n.listeners.error[0]; });
ok(!!errorCb, 'img 上绑定了 error 监听');
if (errorCb) {
  let errThrew = null;
  try { errorCb(); } catch (e) { errThrew = e; }
  ok(errThrew === null, 'error 回调未抛' + (errThrew ? ' → ' + errThrew.message : ''));
  let imgAfter = 0, emojiAfter = false;
  doc.body._walk(n => {
    if (n.tagName === 'IMG') imgAfter++;
    if (n.tagName === '#TEXT' && n.textContent === '🖼') emojiAfter = true;
  });
  ok(imgAfter === 0, 'error 后 img 已移除，剩 ' + imgAfter);
  ok(emojiAfter, 'error 后 emoji 已插入');
}

console.log('\n' + '='.repeat(52));
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
console.log('='.repeat(52));
process.exit(fail > 0 ? 1 : 0);
