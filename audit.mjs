// 全面 UI/功能排查 - Edge CDP
import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9225;
const OUT = 'C:\\Users\\zhang\\AppData\\Local\\Temp\\stating-audit';
fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=C:\\Users\\zhang\\AppData\\Local\\Temp\\lg-cdp\\profile-audit',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1280,900', 'http://localhost:8788/'
], { detached: true, stdio: 'ignore' });

let errors = [], warnings = [];

async function run() {
  await new Promise(r => setTimeout(r, 4000));

  const tabs = await new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json`, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject);
  });
  const page = tabs.find(t => t.url.includes('localhost:8788')) || tabs[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = {};

  ws.addEventListener('message', ev => {
    const r = JSON.parse(ev.data);
    if (pending[r.id]) { pending[r.id](r.result); delete pending[r.id]; }
    if (r.method === 'Runtime.consoleAPICalled') {
      const msg = (r.params.args || []).map(a => a.value || a.description || a.type).join(' ');
      if (r.params.type === 'error') errors.push(msg);
      else if (r.params.type === 'warning') warnings.push(msg);
    }
    if (r.method === 'Runtime.exceptionThrown') {
      const d = r.params.exceptionDetails;
      errors.push(`EXCEPTION: ${d.text} @ ${d.url?.split('/').pop()}:${d.lineNumber}`);
    }
    if (r.method === 'Log.entryAdded' && r.params.entry.level === 'error') {
      errors.push(`LOG-ERROR: ${r.params.entry.text}`);
    }
  });
  function call(method, params) {
    return new Promise(resolve => { const mid = ++id; pending[mid] = resolve; ws.send(JSON.stringify({ id: mid, method, params })); });
  }
  function evalJs(expr) {
    return call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  }
  async function screenshot(name) {
    const s = await call('Page.captureScreenshot', { format: 'png' });
    if (s?.data) fs.writeFileSync(`${OUT}\\${name}.png`, Buffer.from(s.data, 'base64'));
  }
  await new Promise(r => ws.addEventListener('open', r));
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Log.enable');

  // ========== 1. 登录页检查 ==========
  await new Promise(r => setTimeout(r, 1500));
  console.log('\n=== 1. 登录页 ===');
  const login = await evalJs(`JSON.stringify({
    simBtn: !!document.querySelector('#simLoginBtn'),
    smsBtn: !!document.querySelector('#smsLoginBtn'),
    wxBtn: !!document.querySelector('#wxLoginBtn'),
    simText: document.querySelector('#simLoginBtn .oauth-tx b')?.textContent?.trim(),
    smsText: document.querySelector('#smsLoginBtn .oauth-tx b')?.textContent?.trim(),
    divider: !!document.querySelector('.auth-oauth-divider'),
    note: document.querySelector('.auth-oauth-note')?.textContent?.trim(),
    usernameInput: !!document.querySelector('#loginPhone'),
    passwordInput: !!document.querySelector('#loginPassword'),
    loginBtn: !!document.querySelector('#loginBtn'),
  })`);
  console.log('  DOM检查:', login.result.value);
  await screenshot('01-login');

  // ========== 2. SIM 一键登录 ==========
  console.log('\n=== 2. SIM 登录流程 ===');
  await evalJs(`document.querySelector('#simLoginBtn').click()`);
  await new Promise(r => setTimeout(r, 2500));
  const afterSim = await evalJs(`JSON.stringify({
    toast: document.querySelector('.toast')?.textContent?.trim()?.slice(0,80),
    mainVisible: !document.querySelector('#mainScreen')?.hidden,
  })`);
  console.log('  SIM登录后:', afterSim.result.value);
  await screenshot('02-after-sim-login');

  // ========== 3. 个人菜单检查 ==========
  console.log('\n=== 3. 个人菜单 ===');
  await evalJs(`document.querySelector('#profileBtn')?.click()`);
  await new Promise(r => setTimeout(r, 600));
  const menu = await evalJs(`JSON.stringify({
    heatmap: !!document.querySelector('#heatmapBtn'),
    yearReport: !!document.querySelector('#yearReportBtn'),
    bioRoom: !!document.querySelector('#bioRoomBtn'),
    sessions: !!document.querySelector('#sessionsBtn'),
    passkey: !!document.querySelector('#passkeyManageBtn'),
    heatmapText: document.querySelector('#heatmapBtn')?.textContent?.trim(),
    yearText: document.querySelector('#yearReportBtn')?.textContent?.trim(),
    bioRoomText: document.querySelector('#bioRoomBtn')?.textContent?.trim(),
  })`);
  console.log('  菜单入口:', menu.result.value);

  // ========== 4. 热力图弹窗 ==========
  console.log('\n=== 4. 热力图弹窗 ===');
  await evalJs(`document.querySelector('#heatmapBtn').click()`);
  await new Promise(r => setTimeout(r, 1500));
  const hm = await evalJs(`JSON.stringify({
    modalVisible: !document.querySelector('#heatmapModal')?.hidden,
    gridExists: !!document.querySelector('#heatmapGrid'),
    cells: document.querySelectorAll('#heatmapGrid .hm-cell').length,
    stats: document.querySelector('#heatmapStats')?.textContent?.trim(),
  })`);
  console.log('  热力图:', hm.result.value);
  await screenshot('04-heatmap');
  await evalJs(`document.querySelector('#heatmapClose')?.click()`);
  await new Promise(r => setTimeout(r, 300));

  // ========== 5. 年度报告弹窗 ==========
  console.log('\n=== 5. 年度报告 ===');
  await evalJs(`document.querySelector('#yearReportBtn').click()`);
  await new Promise(r => setTimeout(r, 1500));
  const yr = await evalJs(`JSON.stringify({
    modalVisible: !document.querySelector('#yearReportModal')?.hidden,
    cards: document.querySelectorAll('#yrContent .yr-card').length,
    content: document.querySelector('#yrContent')?.textContent?.trim()?.slice(0,100),
  })`);
  console.log('  年度报告:', yr.result.value);
  await screenshot('05-yearreport');
  await evalJs(`document.querySelector('#yearReportClose')?.click()`);
  await new Promise(r => setTimeout(r, 300));

  // ========== 6. 双人生物房间 ==========
  console.log('\n=== 6. 双人生物房间 ===');
  await evalJs(`document.querySelector('#bioRoomBtn').click()`);
  await new Promise(r => setTimeout(r, 600));
  const br = await evalJs(`JSON.stringify({
    modalVisible: !document.querySelector('#bioRoomModal')?.hidden,
    createBtn: !!document.querySelector('#brCreate'),
    joinInput: !!document.querySelector('#brJoinCode'),
  })`);
  console.log('  生物房间:', br.result.value);
  await screenshot('06-bioroom');
  await evalJs(`document.querySelector('#bioRoomClose')?.click()`);
  await new Promise(r => setTimeout(r, 300));

  // 关闭个人菜单
  await evalJs(`document.querySelector('#profileBtn')?.click()`);

  // ========== 7. 创建群聊测试消息功能 ==========
  console.log('\n=== 7. 建群并测试消息功能 ===');
  // 先检查是否有群聊列表
  const groupList = await evalJs(`JSON.stringify({
    groupItems: document.querySelectorAll('.group-item').length,
    createBtn: !!document.querySelector('#createGroupBtn') || !!document.querySelector('[data-action="create-group"]'),
  })`);
  console.log('  群聊状态:', groupList.result.value);

  // 模拟发消息：直接用 API 建群发消息，然后检查渲染
  await evalJs(`
    (async () => {
      const token = localStorage.getItem('token') || '';
      const auth = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
      let r = await fetch('/api/groups', { method: 'POST', headers: auth, body: JSON.stringify({ name: '审计测试群', code: 'AUDIT1' }) });
      window.__auditGroup = (await r.json()).group?.code;
    })();
  `);
  await new Promise(r => setTimeout(r, 1500));
  // 刷新群组列表
  await evalJs(`location.reload()`);
  await new Promise(r => setTimeout(r, 2500));

  // 点击进入群聊
  await evalJs(`
    const items = document.querySelectorAll('.group-item');
    if (items.length > 0) items[0].click();
  `);
  await new Promise(r => setTimeout(r, 1500));

  const chat = await evalJs(`JSON.stringify({
    inChat: !!document.querySelector('#chatScreen') && !document.querySelector('#chatScreen').hidden,
    composer: !!document.querySelector('#composerInput'),
    multiPlus: !!document.querySelector('#multiPlusBtn'),
    sendBtn: !!document.querySelector('#sendBtn'),
  })`);
  console.log('  进入聊天:', chat.result.value);

  // ========== 8. + 菜单功能检查 ==========
  console.log('\n=== 8. + 菜单 ===');
  await evalJs(`document.querySelector('#multiPlusBtn')?.click()`);
  await new Promise(r => setTimeout(r, 500));
  const mm = await evalJs(`JSON.stringify({
    image: !!document.querySelector('#mmImage'),
    file: !!document.querySelector('#mmFile'),
    ephemeral: !!document.querySelector('#mmEphemeral'),
    capsule: !!document.querySelector('#mmCapsule'),
    whisper: !!document.querySelector('#mmWhisper'),
    bioSign: !!document.querySelector('#mmBioSign'),
    ephemeralLabel: document.querySelector('#mmEphemeral .mm-label')?.textContent,
    capsuleLabel: document.querySelector('#mmCapsule .mm-label')?.textContent,
    whisperLabel: document.querySelector('#mmWhisper .mm-label')?.textContent,
    bioSignLabel: document.querySelector('#mmBioSign .mm-label')?.textContent,
  })`);
  console.log('  +菜单项:', mm.result.value);
  await screenshot('08-plus-menu');

  // 关闭 + 菜单
  await evalJs(`document.querySelector('#multiPlusBtn')?.click()`);
  await new Promise(r => setTimeout(r, 300));

  // ========== 9. 发送普通消息并检查渲染 ==========
  console.log('\n=== 9. 发消息渲染检查 ===');
  await evalJs(`
    const input = document.querySelector('#composerInput');
    input.textContent = '审计测试消息';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sendBtn').click();
  `);
  await new Promise(r => setTimeout(r, 1500));
  const msgRender = await evalJs(`JSON.stringify({
    msgCount: document.querySelectorAll('.msg-row').length,
    lastMsgText: document.querySelectorAll('.msg-bubble .msg-text')?.[document.querySelectorAll('.msg-bubble .msg-text').length-1]?.textContent?.trim(),
    bubbles: document.querySelectorAll('.msg-bubble').length,
  })`);
  console.log('  消息渲染:', msgRender.result.value);
  await screenshot('09-chat-messages');

  // ========== 10. 右键菜单检查 ==========
  console.log('\n=== 10. 消息右键菜单 ===');
  await evalJs(`
    const bubble = document.querySelector('.msg-bubble');
    if (bubble) {
      const evt = new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 });
      bubble.dispatchEvent(evt);
    }
  `);
  await new Promise(r => setTimeout(r, 500));
  const ctx = await evalJs(`JSON.stringify({
    menuVisible: !document.querySelector('#msgContextMenu')?.hidden,
    items: Array.from(document.querySelectorAll('#msgContextMenu .ctx-item')).map(i => i.textContent.trim()),
  })`);
  console.log('  右键菜单:', ctx.result.value);

  // ========== 11. 深色模式 ==========
  console.log('\n=== 11. 深色模式 ===');
  await evalJs(`
    const toggle = document.querySelector('#themeToggle') || document.querySelector('[data-theme="dark"]');
    if (document.querySelector('#themeToggle')) document.querySelector('#themeToggle').click();
    else document.body.classList.toggle('dark');
  `);
  await new Promise(r => setTimeout(r, 500));
  const dark = await evalJs(`JSON.stringify({
    isDark: document.body.classList.contains('dark'),
  })`);
  console.log('  深色模式:', dark.result.value);
  await screenshot('11-dark-mode');

  // ========== 12. 文字动效测试 ==========
  console.log('\n=== 12. 文字动效 ===');
  await evalJs(`
    const input = document.querySelector('#composerInput');
    input.textContent = '生日快乐';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sendBtn').click();
  `);
  await new Promise(r => setTimeout(r, 1500));
  const fx = await evalJs(`JSON.stringify({
    effectLayer: document.querySelector('#textEffectLayer'),
    particles: document.querySelectorAll('.te-particle').length,
  })`);
  console.log('  文字动效:', fx.result.value);
  await screenshot('12-text-effect');

  // ========== 汇总 ==========
  console.log('\n\n========== 排查汇总 ==========');
  console.log('Console Errors (' + errors.length + '):');
  errors.forEach(e => console.log('  ❌', e.slice(0, 200)));
  console.log('\nConsole Warnings (' + warnings.length + '):');
  warnings.forEach(w => console.log('  ⚠️', w.slice(0, 150)));

  ws.close();
  proc.kill();
  process.exit(0);
}

run().catch(e => { console.error('FATAL:', e); proc.kill(); process.exit(1); });
