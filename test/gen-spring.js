/* 生成符合 Apple WWDC 弹簧物理的 CSS linear() 缓动函数
   弹簧解：x(t) = 1 - e^(-ζωₙt)(cos(ω_d t) + (ζωₙ/ω_d) sin(ω_d t))  [ζ<1]
           x(t) = 1 - e^(-ωₙt)(1 + ωₙ t)                              [ζ=1 临界阻尼]
   ωₙ = 2π / response，ω_d = ωₙ·sqrt(1-ζ²)
   用法：node gen-spring.js */
'use strict';

// response 单位秒；damping 为阻尼比（1 = 临界阻尼，无过冲）
const PRESETS = [
  { name: 'UI 弹簧（默认，临界阻尼）',        response: 0.35, damping: 1.0 },
  { name: '快按压（按压反馈）',              response: 0.22, damping: 1.0 },
  { name: '抽屉 / Sheet（阻尼 0.8）',         response: 0.38, damping: 0.8 },
  { name: '动量甩动（阻尼 0.7）',             response: 0.45, damping: 0.7 },
];

// 采样点数：临界阻尼 18 点足够；欠阻尼需更多以捕捉回摆
function samples(response, damping, n) {
  const wn = (2 * Math.PI) / response;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const p = i / n;
    const t = p * response * 1.6;           // 采样至 1.6×response，确保收敛
    let x;
    if (damping >= 1) {
      x = 1 - Math.exp(-wn * t) * (1 + wn * t);
    } else {
      const wd = wn * Math.sqrt(1 - damping * damping);
      x = 1 - Math.exp(-damping * wn * t) *
        (Math.cos(wd * t) + ((damping * wn) / wd) * Math.sin(wd * t));
    }
    out.push(x);
  }
  // 归一化到 [0,1]：首点强制 0，末点强制 1
  const head = out[0];
  out[0] = 0;
  out[out.length - 1] = 1;
  return out.map((v) => v);
}

function fmt(v) {
  return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
}

for (const p of PRESETS) {
  const n = p.damping >= 1 ? 18 : 26;
  const s = samples(p.response, p.damping, n);
  const body = s.map(fmt).join(', ');
  console.log(`/* ${p.name}  response=${p.response}s  damping=${p.damping} */`);
  console.log(`--lgx-spring-${String(p.response).replace('.', '')}-${String(p.damping).replace('.', '')}: linear(${body});`);
  // 诊断：过冲峰值与回摆次数
  const peak = Math.max(...s);
  const t0 = s[0];
  let crossings = 0;
  for (let i = 1; i < s.length; i++) {
    if ((s[i] - 1) * (s[i - 1] - 1) < 0) crossings++;
  }
  console.log(`   → 峰值 ${peak.toFixed(4)}，过冲 ${((peak - 1) * 100).toFixed(2)}%，回摆点 ${crossings}\n`);
}