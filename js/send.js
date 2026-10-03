/* Stating · send */
'use strict';

/* ============================================================
   12 · 发送：文字 / 图片 / 语音
   ============================================================ */
function autoGrow() {
  const t = $('#msgInput');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 120) + 'px';
  const has = t.value.trim().length > 0;
  $('#sendBtn').hidden = !has;
  $('#micBtn').hidden = has;
}

async function sendText() {
  const t = $('#msgInput');
  const content = t.value.trim();
  if (!content) return;
  const body = { type: 'text', text: content, content };
  if (Store.replyTo) { body.replyToId = Store.replyTo.id; const bar = $('#replyPreview'); if (bar) bar.hidden = true; Store.replyTo = null; }
  t.value = ''; autoGrow();
  try {
    const r = await api(`groups/${Store.activeCode}/messages`, { method: 'POST', body });
    appendMessage(r.message);
  } catch (err) { toast(err.message, 'error'); }
}

async function uploadFile() {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
  });
  const r = await api('upload', { method: 'POST', body: { data: dataUrl, mimeType: file.type || 'application/octet-stream' } });
  return r.url;
}

async function sendImageFile(file) {
  if (!file) return;
  toast('上传中…');
  try {
    const url = await uploadFile(file);
    const r = await api(`groups/${Store.activeCode}/messages`, { method: 'POST', body: { type: 'image', mediaUrl: url } });
    appendMessage(r.message);
  } catch (err) { toast(err.message, 'error'); }
}

/* 语音录制 */
let recorder = null, recChunks = [], recTimer = null, recSeconds = 0, recStream = null;
function pickMime() {
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('当前浏览器不支持语音录制', 'error');
  try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { return toast('无法使用麦克风', 'error'); }

  recChunks = []; recSeconds = 0;
  recorder = new MediaRecorder(recStream, pickMime() ? { mimeType: pickMime() } : undefined);
  recorder.ondataavailable = e => e.data.size && recChunks.push(e.data);
  recorder.onstop = onRecordStop;
  recorder.start();

  // 录音 UI
  const sheet = $('#composerSheet');
  sheet.classList.add('is-recording');
  if (!$('#recordingBar')) {
    const bar = h('div', 'recording-bar');
    bar.id = 'recordingBar';
    bar.innerHTML = `<button class="rec-cancel" id="recCancel" aria-label="取消">${icon('trash')}</button>
      <span class="rec-dot"></span><span class="rec-time tabular">0:00</span>
      <span class="rec-wave">${Array.from({ length: 40 }, (_, i) => `<i style="height:${6 + (i % 9) * 2}px"></i>`).join('')}</span>
      <button class="icon-btn" id="recStop" style="color:var(--primary)" aria-label="停止">${icon('send')}</button>`;
    sheet.insertBefore(bar, sheet.firstChild);
    bar.querySelector('#recCancel').addEventListener('click', cancelRecording);
    bar.querySelector('#recStop').addEventListener('click', () => recorder && recorder.stop());
  }
  $('#recordingBar').hidden = false;
  sheet.querySelectorAll('.composer-input,#plusBtn,#micBtn,#sendBtn').forEach(x => x.style.display = 'none');
  recTimer = setInterval(() => { recSeconds++; const el = $('.rec-time'); if (el) el.textContent = fmtDur(recSeconds); }, 1000);
}
function cancelRecording() {
  if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
  finishRecordingUI();
}
function finishRecordingUI() {
  clearInterval(recTimer);
  if (recStream) recStream.getTracks().forEach(t => t.stop());
  recStream = null; recorder = null;
  const bar = $('#recordingBar'); if (bar) bar.hidden = true;
  const sheet = $('#composerSheet');
  sheet.classList.remove('is-recording');
  sheet.querySelectorAll('.composer-input,#plusBtn,#micBtn,#sendBtn').forEach(x => x.style.display = '');
  autoGrow();
}
async function onRecordStop() {
  const dur = recSeconds;
  finishRecordingUI();
  const blob = new Blob(recChunks, { type: recorder && recorder.mimeType ? recorder.mimeType : 'audio/webm' });
  if (!blob.size) return;
  const file = new File([blob], 'voice.' + (blob.type.includes('mp4') ? 'm4a' : 'webm'), { type: blob.type });
  toast('语音上传中…');
  try {
    const url = await uploadFile(file);
    const r = await api(`groups/${Store.activeCode}/messages`, {
      method: 'POST',
      body: { type: 'voice', mediaUrl: url, voiceDuration: dur },
    });
    appendMessage(r.message);
  } catch (err) { toast(err.message, 'error'); }
}

/* ============================================================
   13 · SSE 实时
   ============================================================ */
function connectSSE(code) {
  closeSSE();
  const url = `/api/events?code=${code}&token=${encodeURIComponent(Store.token)}&since=${Store.esSince}`;
  const es = new EventSource(url);
  Store.es = es;

  es.onmessage = e => {
    try { appendMessage(JSON.parse(e.data)); } catch (err) {};
  };
  es.addEventListener('presence', e => {
    try {
      const p = JSON.parse(e.data);
      Store.room.presence = p;
      updateOnlineCount(p);
    } catch (err) {};
  });
  es.addEventListener('readstatus', e => {
    try { Store.room.readStatus = JSON.parse(e.data); refreshReadLabels(); } catch (err) {};
  });
  es.addEventListener('reconnect', e => {
    Store.esSince = parseInt(e.data, 10) || Store.esSince;
    closeSSE();
    if (Store.activeCode) connectSSE(Store.activeCode);
  });
  es.onerror = () => { /* 浏览器自动重连；reconnect 事件负责滚动 since */ };
}
function closeSSE() {
  if (Store.es) { Store.es.close(); Store.es = null; }
}
function refreshReadLabels() {
  // 重新渲染自己最新消息的已读
  const mine = Store.room.messages.filter(x => x.senderPhone === Store.me.phone);
  const last = mine[mine.length - 1];
  if (last) refreshMessageNode(last);
}
