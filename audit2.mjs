// 全面审计 v2 - 完整注册流程
import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9226;
const OUT = 'C:\\Users\\zhang\\AppData\\Local\\Temp\\stating-audit';
fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=C:\\Users\\zhang\\AppData\\Local\\Temp\\lg-cdp\\profile-audit2',
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
  await call('Network.enable');

  const failedReqs = [];
  ws.addEventListener('message', ev => {
    const r = JSON.parse(ev.data);
    if (r.method === 'Network.responseReceived' && r.params.response.status >= 400) {
      failedReqs.push(`${r.params.response.status} ${r.params.response.url.split('/api/').pop()?.split('?')[0]}`);
    }
  });

  // ===== 1. SIM 登录 → 完成注册 =====
  console.log('=== 1. SIM 一键登录 + 注册 ===');
  await evalJs(`document.querySelector('#simLoginBtn').click()`);
  await new Promise(r => setTimeout(r, 2000));

  // 检查是否打开了注册弹窗（新号需要注册）
  const regState = await evalJs(`JSON.stringify({
    smsModal: !document.querySelector('#smsModal')?.hidden,
    profileStep: !document.querySelector('[data-smsstep="profile"]')?.hidden,
    nickInput: !!document.querySelector('#smsNick'),
    regBtn: !!document.querySelector('#smsRegBtn'),
    mainVisible: !document.querySelector('#mainScreen')?.hidden,
  })`);
  console.log('  SIM后状态:', regState.result.value);
  await screenshot('01-sim-after-click');

  // 如果需要注册，填昵称并提交
  const reg = JSON.parse(regState.result.value);
  if (reg.profileStep && reg.regBtn) {
    await evalJs(`
      document.querySelector('#smsNick').value = '审计用户';
      document.querySelector('#smsNick').dispatchEvent(new Event('input', { bubbles: true }));
      // 选第一个头像
      const avs = document.querySelectorAll('#smsAvatars .lg-avatar');
      if (avs[0]) avs[0].click();
      document.querySelector('#smsRegBtn').click();
    `);
    await new Promise(r => setTimeout(r, 2500));
  }

  const afterReg = await evalJs(`JSON.stringify({
    mainVisible: !document.querySelector('#mainScreen')?.hidden,
    token: !!localStorage.getItem('stating_token'),
  })`);
  console.log('  注册后:', afterReg.result.value);
  await screenshot('02-after-register');

  // ===== 2. 个人菜单三入口 =====
  console.log('\n=== 2. 个人菜单入口 ===');
  await evalJs(`document.querySelector('#profileBtn').click()`);
  await new Promise(r => setTimeout(r, 600));
  const menu = await evalJs(`JSON.stringify({
    heatmap: !!document.querySelector('#heatmapBtn'),
    yearReport: !!document.querySelector('#yearReportBtn'),
    bioRoom: !!document.querySelector('#bioRoomBtn'),
  })`);
  console.log('  入口:', menu.result.value);

  // ===== 3. 热力图 =====
  console.log('\n=== 3. 热力图 ===');
  await evalJs(`document.querySelector('#heatmapBtn').click()`);
  await new Promise(r => setTimeout(r, 2000));
  const hm = await evalJs(`JSON.stringify({
    visible: !document.querySelector('#heatmapModal')?.hidden,
    cells: document.querySelectorAll('#heatmapGrid .hm-cell').length,
    stats: document.querySelector('#heatmapStats')?.textContent?.trim(),
  })`);
  console.log('  热力图:', hm.result.value);
  await screenshot('03-heatmap');
  await evalJs(`document.querySelector('#heatmapClose').click()`);
  await new Promise(r => setTimeout(r, 300));

  // ===== 4. 年度报告 =====
  console.log('\n=== 4. 年度报告 ===');
  await evalJs(`document.querySelector('#yearReportBtn').click()`);
  await new Promise(r => setTimeout(r, 2000));
  const yr = await evalJs(`JSON.stringify({
    visible: !document.querySelector('#yearReportModal')?.hidden,
    cards: document.querySelectorAll('#yrContent .yr-card').length,
    content: document.querySelector('#yrContent')?.textContent?.trim()?.slice(0,120),
  })`);
  console.log('  年度报告:', yr.result.value);
  await screenshot('04-yearreport');
  await evalJs(`document.querySelector('#yearReportClose').click()`);
  await new Promise(r => setTimeout(r, 300));

  // ===== 5. 双人生物房间 =====
  console.log('\n=== 5. 双人生物房间 ===');
  await evalJs(`document.querySelector('#bioRoomBtn').click()`);
  await new Promise(r => setTimeout(r, 600));
  const br = await evalJs(`JSON.stringify({
    visible: !document.querySelector('#bioRoomModal')?.hidden,
    createBtn: !!document.querySelector('#brCreate'),
    joinInput: !!document.querySelector('#brJoinCode'),
  })`);
  console.log('  生物房间:', br.result.value);
  await evalJs(`document.querySelector('#bioRoomClose').click()`);
  await new Promise(r => setTimeout(r, 300));

  // 关闭个人菜单
  await evalJs(`document.querySelector('#profileBtn').click()`);
  await new Promise(r => setTimeout(r, 300));

  // ===== 6. 建群（通过UI） =====
  console.log('\n=== 6. 建群 ===');
  // 找建群按钮
  const createInfo = await evalJs(`JSON.stringify({
    createBtn: !!document.querySelector('#createGroupBtn'),
    addBtn: !!document.querySelector('#addGroupBtn'),
    plusBtn: !!document.querySelector('.group-add-btn'),
    allButtons: Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('建') || b.textContent.includes('+')).map(b => b.id || b.className).slice(0,10),
  })`);
  console.log('  建群按钮:', createInfo.result.value);

  // 通过 UI 建群
  console.log('\n=== 6. 建群（UI流程） ===');
  // 先看是否在邀请码页面
  const gateState = await evalJs(`JSON.stringify({
    inviteGate: !document.querySelector('#inviteGate')?.hidden,
    createCard: !document.querySelector('#createGroupCard')?.hidden,
    showCreateBtn: !!document.querySelector('#showCreateGroup'),
  })`);
  console.log('  入口状态:', gateState.result.value);

  // 点创建新群聊
  await evalJs(`document.querySelector('#showCreateGroup')?.click()`);
  await new Promise(r => setTimeout(r, 600));

  const cardVisible = await evalJs(`JSON.stringify({
    createCardVisible: !document.querySelector('#createGroupCard')?.hidden,
    nameVal: document.querySelector('#groupName')?.value,
    avatarItems: document.querySelectorAll('#groupAvatarGrid .avatar-item').length,
  })`);
  console.log('  创建卡可见:', cardVisible.result.value);

  // 填表单
  await evalJs(`
    document.querySelector('#groupName').value = '审计群聊';
    document.querySelector('#groupName').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#groupCode').value = 'AU' + Math.random().toString(36).slice(2,6).toUpperCase();
    document.querySelector('#groupCode').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#groupAvatarGrid .avatar-item')?.click();
  `);
  await new Promise(r => setTimeout(r, 400));
  await evalJs(`document.querySelector('#createGroupBtn').click()`);
  await new Promise(r => setTimeout(r, 2500));

  const afterCreate = await evalJs(`JSON.stringify({
    createError: document.querySelector('#createError')?.textContent?.trim(),
    inviteGateHidden: document.querySelector('#inviteGate')?.hidden,
    chatRoomVisible: !document.querySelector('#chatRoom')?.hidden,
    chatName: document.querySelector('#chatName')?.textContent?.trim(),
  })`);
  console.log('  建群后:', afterCreate.result.value);

  const groupList = await evalJs(`JSON.stringify({
    count: document.querySelectorAll('.group-item').length,
    firstText: document.querySelector('.group-item')?.textContent?.trim()?.slice(0,40),
  })`);
  console.log('  群列表:', groupList.result.value);

  // 点击第一个群
  await evalJs(`document.querySelector('.group-item')?.click()`);
  await new Promise(r => setTimeout(r, 2000));

  const chat = await evalJs(`JSON.stringify({
    inChat: !!document.querySelector('#chatRoom') && !document.querySelector('#chatRoom').hidden,
    inviteGateHidden: document.querySelector('#inviteGate')?.hidden,
    groupName: document.querySelector('#chatName')?.textContent?.trim(),
    composer: !!document.querySelector('#composerInput'),
  })`);
  console.log('  进入聊天:', chat.result.value);
  await screenshot('06-chat-screen');

  // ===== 7. + 菜单 =====
  console.log('\n=== 7. + 菜单 ===');
  await evalJs(`document.querySelector('#multiPlusBtn').click()`);
  await new Promise(r => setTimeout(r, 500));
  const mm = await evalJs(`JSON.stringify({
    ephemeral: !!document.querySelector('#mmEphemeral'),
    capsule: !!document.querySelector('#mmCapsule'),
    whisper: !!document.querySelector('#mmWhisper'),
    bioSign: !!document.querySelector('#mmBioSign'),
  })`);
  console.log('  +菜单:', mm.result.value);
  await evalJs(`document.querySelector('#multiPlusBtn').click()`);

  // ===== 8. 发普通消息 =====
  console.log('\n=== 8. 发消息 ===');
  await evalJs(`
    const input = document.querySelector('#composerInput');
    input.textContent = '你好，这是审计测试';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sendBtn').click();
  `);
  await new Promise(r => setTimeout(r, 1500));
  const msg = await evalJs(`JSON.stringify({
    count: document.querySelectorAll('.msg-row').length,
    text: document.querySelectorAll('.msg-text')?.[document.querySelectorAll('.msg-text').length-1]?.textContent?.trim(),
  })`);
  console.log('  消息:', msg.result.value);
  await screenshot('08-message-sent');

  // ===== 9. 右键菜单 =====
  console.log('\n=== 9. 右键菜单 ===');
  await evalJs(`
    const bubble = document.querySelector('.msg-bubble');
    if (bubble) bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
  `);
  await new Promise(r => setTimeout(r, 400));
  const ctx = await evalJs(`JSON.stringify({
    visible: !document.querySelector('#msgContextMenu')?.hidden,
    items: Array.from(document.querySelectorAll('#msgContextMenu .ctx-item')).map(i => i.textContent.trim()),
  })`);
  console.log('  右键菜单:', ctx.result.value);

  // ===== 10. 文字动效 =====
  console.log('\n=== 10. 文字动效 ===');
  await evalJs(`document.querySelector('#msgContextMenu')?.hidden = true`);
  const beforeFx = await evalJs(`JSON.stringify({
    sendDisabled: document.querySelector('#sendBtn')?.disabled,
    inputHasText: !!document.querySelector('#composerInput')?.textContent?.trim(),
    groupSet: !!window.__debugGroup,
  })`);
  console.log('  发送前:', beforeFx.result.value);
  await evalJs(`
    try {
      const input = document.querySelector('#composerInput');
      input.textContent = '生日快乐';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.__fxInputVal = input.textContent;
      window.__fxBtnOnclick = typeof document.querySelector('#sendBtn').onclick;
      window.__fxErr = null;
    } catch (e) { window.__fxErr = e.message; }
  `);
  await new Promise(r => setTimeout(r, 300));
  const preSend = await evalJs(`JSON.stringify({
    inputVal: window.__fxInputVal,
    btnOnclickType: window.__fxBtnOnclick,
    sendDisabled: document.querySelector('#sendBtn')?.disabled,
    err: window.__fxErr,
  })`);
  console.log('  发送检查:', preSend.result.value);
  await evalJs(`document.querySelector('#sendBtn').click()`);
  await new Promise(r => setTimeout(r, 1500));
  const fx = await evalJs(`JSON.stringify({
    layer: document.querySelector('#textEffectLayer') && !document.querySelector('#textEffectLayer').hidden,
    particles: document.querySelectorAll('.te-particle').length,
    msgCount: document.querySelectorAll('.msg-row').length,
    lastMsg: document.querySelectorAll('.msg-text')?.[document.querySelectorAll('.msg-text').length-1]?.textContent?.trim(),
  })`);
  console.log('  动效:', fx.result.value);
  await screenshot('10-text-effect');

  // ===== 11. 阅后即焚消息 =====
  console.log('\n=== 11. 阅后即焚 ===');
  await evalJs(`
    document.querySelector('#multiPlusBtn').click();
  `);
  await new Promise(r => setTimeout(r, 400));
  await evalJs(`document.querySelector('#mmEphemeral').click()`);
  await new Promise(r => setTimeout(r, 400));
  await evalJs(`document.querySelector('.ep-options button[data-sec="5"]').click()`);
  await new Promise(r => setTimeout(r, 400));
  const modeBar = await evalJs(`JSON.stringify({
    bar: !document.querySelector('#composerModeBar')?.hidden,
    text: document.querySelector('#cmbText')?.textContent,
  })`);
  console.log('  模式条:', modeBar.result.value);
  await evalJs(`
    try {
      const input = document.querySelector('#composerInput');
      input.textContent = '看完就烧';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.__epInputVal = input.textContent;
      window.__epSendDisabled = document.querySelector('#sendBtn').disabled;
      document.querySelector('#sendBtn').click();
      window.__epErr = null;
    } catch (e) { window.__epErr = e.message; }
  `);
  await new Promise(r => setTimeout(r, 1500));
  const ep = await evalJs(`JSON.stringify({
    ephemeralTag: !!document.querySelector('.ephemeral-tag'),
    epCd: document.querySelector('.ep-cd')?.textContent,
    msgCount: document.querySelectorAll('.msg-row').length,
    lastText: Array.from(document.querySelectorAll('.msg-text')).pop()?.textContent?.trim(),
    inputVal: window.__epInputVal,
    sendDisabled: window.__epSendDisabled,
    err: window.__epErr,
  })`);
  console.log('  阅后即焚:', ep.result.value);
  await screenshot('11-ephemeral');

  // ===== 12. 定时胶囊 =====
  console.log('\n=== 12. 定时胶囊 ===');
  await evalJs(`document.querySelector('#multiPlusBtn').click()`);
  await new Promise(r => setTimeout(r, 400));
  await evalJs(`document.querySelector('#mmCapsule').click()`);
  await new Promise(r => setTimeout(r, 400));
  await evalJs(`
    const t = new Date(Date.now() + 60000);
    const local = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.querySelector('#capsuleTime').value = local;
    window.__capTimeVal = document.querySelector('#capsuleTime').value;
    window.__capPickerVisible = !document.querySelector('#capsulePicker')?.hidden;
    window.__capConfirmExists = !!document.querySelector('#capsuleConfirm');
    document.querySelector('#capsuleConfirm').click();
  `);
  await new Promise(r => setTimeout(r, 500));
  const capPicker = await evalJs(`JSON.stringify({
    timeVal: window.__capTimeVal,
    pickerVisible: window.__capPickerVisible,
    confirmExists: window.__capConfirmExists,
    modeBarVisible: !document.querySelector('#composerModeBar')?.hidden,
    modeBarText: document.querySelector('#cmbText')?.textContent?.trim(),
  })`);
  console.log('  胶囊选择器:', capPicker.result.value);
  await evalJs(`
    try {
      const input = document.querySelector('#composerInput');
      input.textContent = '未来的消息';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.__capInputVal = input.textContent;
      window.__capSendDisabled = document.querySelector('#sendBtn').disabled;
      document.querySelector('#sendBtn').click();
      window.__capErr = null;
    } catch (e) { window.__capErr = e.message; }
  `);
  await new Promise(r => setTimeout(r, 1500));
  const cap = await evalJs(`JSON.stringify({
    orb: !!document.querySelector('.capsule-orb'),
    locked: !!document.querySelector('.capsule-locked'),
    msgCount: document.querySelectorAll('.msg-row').length,
    lastText: Array.from(document.querySelectorAll('.msg-text')).pop()?.textContent?.trim(),
    inputVal: window.__capInputVal,
    sendDisabled: window.__capSendDisabled,
    err: window.__capErr,
  })`);
  console.log('  定时胶囊:', cap.result.value);
  await screenshot('12-capsule');

  // ===== 汇总 =====
  console.log('\n\n========== 排查汇总 ==========');
  console.log('Console Errors (' + errors.length + '):');
  errors.forEach(e => console.log('  ❌', e.slice(0, 200)));
  console.log('\nConsole Warnings (' + warnings.length + '):');
  warnings.forEach(w => console.log('  ⚠️', w.slice(0, 150)));
  console.log('\nFailed API Requests (' + failedReqs.length + '):');
  failedReqs.forEach(f => console.log('  🔴', f));

  ws.close();
  proc.kill();
  process.exit(0);
}

run().catch(e => { console.error('FATAL:', e); proc.kill(); process.exit(1); });
