/* ============================================================
   lg-spring.js 弹簧引擎测试
   运行环境：node（零依赖），vm 加载 js/lg-spring.js
   覆盖：物理正确性、可打断性、速度交接、静止收敛、降级路径
   ============================================================ */
'use strict';
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(__dirname + '/../js/lg-spring.js', 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n[' + t + ']'); }

/* ---------- rAF 桩：手动逐帧推进，可控 dt ---------- */
function makeEnv() {
  const queue = [];
  const env = {
    window: {
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (fn) => { queue.push(fn); return queue.length; },
      cancelAnimationFrame: () => {},
      addEventListener: () => {},
    },
    document: {
      addEventListener: () => {},
      documentElement: {},
      hidden: false,
    },
    navigator: { hardwareConcurrency: 8 },
    MutationObserver: undefined,
    console: console,
    requestAnimationFrame: (fn) => { queue.push(fn); return queue.length; },
    cancelAnimationFrame: () => {},
    setTimeout: setTimeout,
    Map: Map,
    Set: Set,
  };
  env.window.window = env.window;
  const ctx = vm.createContext(env);
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx, { filename: 'lg-spring.js' });
  // 逐帧推进：每次推进 16.67ms
  let now = 0;
  return {
    ctx,
    frame(ms) {
      now += ms == null ? 16.67 : ms;
      const batch = queue.splice(0, queue.length);
      batch.forEach((fn) => fn(now));
      return batch.length;
    },
    run(n, ms) { for (let i = 0; i < n; i++) this.frame(ms); },
    pending() { return queue.length; },
  };
}

console.log('====================================================');
console.log('  lg-spring.js 弹簧引擎测试');
console.log('====================================================');

/* ---------- 1. 模块加载 ---------- */
section('1. 模块加载与导出');
const e = makeEnv();
const api = e.ctx.window.__lgSpring;
ok(!!api, 'window.__lgSpring 已挂载');
ok(api.supported === true, 'supported = true');
ok(typeof api.Spring === 'function', '导出 Spring 构造器');
ok(typeof api.projectVelocity === 'function', '导出 projectVelocity');
ok(api.reducedMotion === false, 'reducedMotion = false（matchMedia 桩返回 false）');

/* ---------- 2. 临界阻尼不过冲 ---------- */
section('2. 临界阻尼（damping=1.0）物理正确性');
{
  let samples = [];
  const s = new api.Spring({
    from: 0, to: 100, response: 0.35, damping: 1.0,
    onUpdate: (v) => { samples.push(v); },
  });
  s.start();
  e.run(90);   // 90 帧 × 16.67ms ≈ 1.5s
  const max = Math.max(...samples);
  const min = Math.min(...samples);
  ok(max <= 100.001, `不过冲：峰值 ${max.toFixed(4)} ≤ 目标 100`);
  ok(min >= -0.001, `不回摆下冲：最小值 ${min.toFixed(4)} ≥ 0`);
  ok(!s.isMoving(), '已收敛静止');
  ok(Math.abs(s.value - 100) < 0.05, `收敛到目标：${s.value.toFixed(4)} ≈ 100`);
}

/* ---------- 3. 欠阻尼允许过冲 ---------- */
section('3. 欠阻尼（damping=0.7）应产生过冲');
{
  let samples = [];
  const s = new api.Spring({
    from: 0, to: 100, response: 0.45, damping: 0.7,
    onUpdate: (v) => { samples.push(v); },
  });
  s.start();
  e.run(90);
  const max = Math.max(...samples);
  ok(max > 100, `产生过冲：峰值 ${max.toFixed(4)} > 100`);
  ok(!s.isMoving(), '最终仍收敛');
  ok(Math.abs(s.value - 100) < 0.05, `收敛到目标：${s.value.toFixed(4)} ≈ 100`);
}

/* ---------- 4. 单调性：临界阻尼全程无反向 ---------- */
section('4. 单调性（临界阻尼应单调逼近，不抖动）');
{
  let bad = 0, prev = null;
  const s = new api.Spring({
    from: 0, to: 1, response: 0.3, damping: 1.0,
    onUpdate: (v) => {
      if (prev !== null && v < prev - 1e-9) bad++;
      prev = v;
    },
  });
  s.start();
  e.run(60);
  ok(bad === 0, `无反向抖动（检测到 ${bad} 次回退）`);
}

/* ---------- 5. 可打断性（Apple 第一原则） ---------- */
section('5. 可打断性：中断后从当前值起播，不跳变');
{
  let last = 0, maxJump = 0;
  const s = new api.Spring({
    from: 0, to: 100, response: 0.35, damping: 1.0,
    onUpdate: (v) => {
      if (last !== 0) maxJump = Math.max(maxJump, Math.abs(v - last));
      last = v;
    },
  });
  s.start();
  e.run(6);                       // 跑 6 帧，让它动起来
  const atInterrupt = s.value;    // 记录中断瞬间的值
  ok(atInterrupt > 0 && atInterrupt < 100, `中断点在途中：${atInterrupt.toFixed(2)}`);
  s.setTarget(0);                 // 反向重定向到 0
  const afterRedirect = s.value;
  ok(Math.abs(afterRedirect - atInterrupt) < 0.001,
    `重定向瞬间无位置跳变（${atInterrupt.toFixed(4)} → ${afterRedirect.toFixed(4)}）`);
  ok(s.isMoving(), '重定向后继续运动（未重置为静止）');
  e.run(60);
  ok(Math.abs(s.value) < 0.05, `反向收敛到 0：${s.value.toFixed(4)}`);
  // 单帧位移不应超过总行程的 15%，否则视觉上会「窜」
  ok(maxJump < 15, `单帧最大位移 ${maxJump.toFixed(3)} < 15（行程 100），无突跳`);
}

/* ---------- 6. 速度继承 ---------- */
section('6. 速度交接：setTarget 可指定初速度');
{
  const s = new api.Spring({ from: 0, to: 100, response: 0.35, damping: 1.0 });
  s.start();
  e.run(5);
  const vBefore = s.velocity;
  s.setTarget(0, { velocity: 500 });
  ok(s.velocity === 500, '外部速度已注入');
  ok(vBefore > 0, `动量方向为正（${vBefore.toFixed(2)}）→ 反向时会先减速，符合物理直觉`);
}

/* ---------- 7. dt 钳位防发散 ---------- */
section('7. dt 钳位：标签页切回前台不得数值发散');
{
  const s = new api.Spring({ from: 0, to: 100, response: 0.35, damping: 1.0 });
  s.start();
  e.run(3);
  e.frame(60000);   // 模拟切后台 60 秒后回来，单帧 dt = 60s
  ok(Number.isFinite(s.value), `单帧 60s dt 后数值仍有限：${s.value.toFixed(4)}`);
  ok(Math.abs(s.value) < 100.5, `未超出目标区间（${s.value.toFixed(4)}）`);
}

/* ---------- 8. jump 直接落位 ---------- */
section('8. jump() 直接落位（reduced-motion 路径）');
{
  let called = 0;
  const s = new api.Spring({
    from: 0, to: 1, onRest: () => { called++; },
  });
  s.jump(0.5);
  ok(s.value === 0.5, '值已直接设置');
  ok(!s.isMoving(), '未启动动画循环');
  ok(called === 1, 'onRest 回调已触发一次');
}

/* ---------- 9. 速度投射公式 ---------- */
section('9. 速度投射（WWDC 公式）');
{
  const p = api.projectVelocity(100, 1000, 0.998);
  // 100 + (1000/1000) * (0.998/0.002) = 100 + 499 = 599
  ok(Math.abs(p - 599) < 0.5, `投射落点 ${p.toFixed(2)} ≈ 599（公式 current + v/1000·d/(1−d)）`);
  ok(api.projectVelocity(0, 0, 0.998) === 0, '零速度时落点 = 原值');
  ok(api.projectVelocity(50, -1000, 0.998) < 50, '负速度向负方向投射');
}

/* ---------- 10. 降级：reduced-motion 不启动动画 ---------- */
section('10. 降级路径');
{
  const env2 = {
    window: {
      matchMedia: (q) => ({ matches: q.includes('reduced-motion') }),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      addEventListener: () => {},
    },
    document: { addEventListener: () => {}, documentElement: {}, hidden: false },
    navigator: { hardwareConcurrency: 8 },
    console,
    setTimeout,
    Map, Set,
  };
  const ctx2 = vm.createContext(env2);
  ctx2.globalThis = ctx2;
  vm.runInContext(SRC, ctx2, { filename: 'lg-spring.js' });
  const api2 = ctx2.window.__lgSpring;
  ok(api2 && api2.supported === true, 'reduced-motion 下仍导出 API');
  ok(api2.reducedMotion === true, 'reducedMotion = true');
}

{
  const env3 = {
    window: {
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: undefined,
      cancelAnimationFrame: undefined,
      addEventListener: () => {},
    },
    document: { addEventListener: () => {}, documentElement: {} },
    navigator: {},
    console,
    Map, Set,
  };
  const ctx3 = vm.createContext(env3);
  ctx3.globalThis = ctx3;
  vm.runInContext(SRC, ctx3, { filename: 'lg-spring.js' });
  ok(ctx3.window.__lgSpring.supported === false, '无 rAF 时 supported = false（安全降级）');
}

/* ---------- 11. 无 eval / 无全局泄漏 ---------- */
section('11. 安全与副作用');
ok(!/\beval\s*\(/.test(SRC), '源码不含 eval');
ok(!/new\s+Function\s*\(/.test(SRC), '源码不含 new Function');
ok(!/document\.querySelectorAll\s*\(/.test(SRC), '不做全文档批量查询（避免无谓遍历）');

console.log('\n====================================================');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('====================================================');
process.exit(fail ? 1 : 0);