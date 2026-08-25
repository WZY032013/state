/* ============================================================
   Stating — 聊天应用（云端版）
   Cloudflare Pages Functions API + 轮询实时消息
   ============================================================ */
(function () {
'use strict';

// ============ 常量 ============
const API = '/api';
const AVATARS = ['😀','🐱','🦊','🐼','🐨','🦁','🐸','🐙','🦄','🐝','🌸','⭐️','🌈','🍀','🎮','🎵','🎨','🚀','🍑','🐧','🦋','🐳'];
const GROUP_AVATARS = ['💬','🔥','🎮','🎵','🎨','🚀','⭐️','🌈','🎯','🎪','🎭','🏆','☕️','🍕','🐱','🦊','🐼','🦁','🐸','🦄','🌸','🍀'];
const EMOJIS = ['😀','😂','😍','🥰','😎','🤔','😅','😴','🤩','🥳','😭','😡','👍','👎','👏','🙏','💪','✌️','🤝','👋','❤️','💔','💯','🔥','✨','🎉','🎊','🎁','🌹','🌸','🍀','⭐️','🌙','☀️','⚡️','🌈','☕️','🍕','🍔','🍟','🍦','🎂','🐱','🐶','🦊','🐼','🦁','🐸','🐙','🦄','🐝','🐧','🦋','🐳','🍑','🍓','🍉','🥑','🎮','🎵','🎨','🚀','💻','📱','📷','🎬','📚','✏️','🔒','🔑','💡','📌','📍','✅','❌','⚠️','❓','💬','💭','🗯️','📢','🔔','🎯','🏆','🥇','🎪','🎭','🎨','🎸','🎹','🎺','🎻','🚗','✈️','🚀','🏠','🌍','⏰','💰'];

const POLL_MSG = 1500;   // 消息轮询间隔(毫秒)
const POLL_PRES = 20000;  // 在线状态轮询间隔(毫秒)
const TYPING_TIMEOUT = 2500;

// ============ 非首屏 JS / CSS 懒加载（大幅降低 TTI）============
// Leaflet 地图库：首次用到地图时才注入（发送位置 / 共享实时位置 / 渲染位置消息预览）
let _leafletLoaded = null;
function loadLeaflet() {
    if (_leafletLoaded) return _leafletLoaded;
    if (typeof L !== 'undefined') { _leafletLoaded = Promise.resolve(); return _leafletLoaded; }
    _leafletLoaded = new Promise((resolve, reject) => {
        // 先注入 CSS
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'lib/leaflet/leaflet.css';
        css.onload = () => {
            const js = document.createElement('script');
            js.src = 'lib/leaflet/leaflet.js';
            js.defer = true;
            js.onload = resolve;
            js.onerror = reject;
            document.head.appendChild(js);
        };
        css.onerror = reject;
        document.head.appendChild(css);
    });
    return _leafletLoaded;
}
// jsQR：首次渲染图片消息时才注入（识别二维码用）
let _jsqrLoaded = null;
function loadJsQR() {
    if (_jsqrLoaded) return _jsqrLoaded;
    if (typeof jsQR !== 'undefined') { _jsqrLoaded = Promise.resolve(); return _jsqrLoaded; }
    _jsqrLoaded = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
        s.defer = true;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
    return _jsqrLoaded;
}

// ============ DOM 工具 ============
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ============ API 封装 + 缓存层（请求去重 + 短 TTL 内存缓存 + localStorage 乐观快照）===========
let token = localStorage.getItem('stating_token') || '';
let darkMode = localStorage.getItem('stating_dark') === '1';

// 初始化深色模式
if (darkMode) document.body.classList.add('dark');

// 登录页随机淡色主题（仅在未登录时应用）
const loginThemes = ['login-rose', 'login-lavender', 'login-peach', 'login-mint', 'login-sky'];
const randomTheme = loginThemes[Math.floor(Math.random() * loginThemes.length)];
document.body.classList.add(randomTheme);

// ---------- API 缓存配置（SWR 模式 + 长 TTL）----------
// 内存缓存：TTL 从 8s 提升到 25s，让 Tab 切换 / 频繁操作更少触网
// （SWR 策略会在后台静默刷新，所以用户感知不到数据陈旧，但首屏 / 切换 0ms 渲染）
const API_MEM_CACHE_TTL = 25000;
// SWR 陈旧但仍可用窗口：5 分钟内的缓存，都先返回再后台刷新
const SWR_STALE_TTL = 300000;
const API_DEDUP_WINDOW = 4000;
const LS_SNAPSHOT_KEY = 'stating_snap_v2';
// SWR + 乐观快照白名单（扩大到群信息、群列表等高频切换的路径）
// 匹配规则：精确匹配 或 前缀匹配
const SWR_WHITELIST_EXACT = new Set(['/users', '/my-groups', '/feedback', '/me']);
const SWR_WHITELIST_PREFIX = ['/groups/'];
function _isSwrPath(path) {
    if (SWR_WHITELIST_EXACT.has(path)) return true;
    for (const prefix of SWR_WHITELIST_PREFIX) if (path.startsWith(prefix)) return true;
    return false;
}

// 内存缓存：cacheKey -> { ts, data }
const _apiMemCache = new Map();
// 并发去重：cacheKey -> Promise
const _apiInflight = new Map();
// SWR 后台刷新锁：cacheKey -> Promise（同一时刻同一 key 不重复后台刷新）
const _swrRefreshLock = new Map();
// localStorage 快照
let _lsSnapshots = null;
function _getLsSnapshots() {
    if (_lsSnapshots) return _lsSnapshots;
    try { _lsSnapshots = JSON.parse(localStorage.getItem(LS_SNAPSHOT_KEY) || '{}'); }
    catch(e) { _lsSnapshots = {}; }
    return _lsSnapshots;
}
function _setLsSnapshot(path, data) {
    if (!_isSwrPath(path)) return;
    try {
        const snaps = _getLsSnapshots();
        snaps[path] = { ts: Date.now(), data };
        _lsSnapshots = snaps;
        localStorage.setItem(LS_SNAPSHOT_KEY, JSON.stringify(snaps));
    } catch(e) { /* quota 超限就默默忽略 */ }
}
function _getLsSnapshot(path) {
    if (!_isSwrPath(path)) return null;
    try {
        const snaps = _getLsSnapshots();
        return snaps && snaps[path] ? snaps[path] : null;
    } catch(e) { return null; }
}
// 定期清理过期内存缓存（TTL 的 1.5x 才清理，给 SWR 窗口保留余地）
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _apiMemCache.entries()) if (now - v.ts > SWR_STALE_TTL * 1.2) _apiMemCache.delete(k);
}, 30000);

function _cacheKey(path, options) {
    if (!options || !options.method || options.method === 'GET') return 'G:' + path;
    let bodyKey = '';
    if (options.body) {
        try { bodyKey = typeof options.body === 'string' ? options.body : JSON.stringify(options.body); }
        catch(e) { bodyKey = String(options.body); }
    }
    return (options.method || 'GET') + ':' + path + ':' + bodyKey;
}

/* SWR 后台静默刷新：返回旧缓存后，在空闲时异步拿最新数据写入缓存 + 可选回调通知 UI 增量更新 */
function _swrBackgroundRefresh(ckey, path, method, opts, onFresh) {
    if (_swrRefreshLock.has(ckey)) return; // 已经在刷新中，避免重复
    const doRefresh = async () => {
        try {
            const res = await fetch(API + path, opts);
            const data = await res.json().catch(() => null);
            if (!data || !data.ok) return;
            if (res.status === 401) return; // 不处理登出逻辑（前台请求会做）
            if (method === 'GET') _apiMemCache.set(ckey, { ts: Date.now(), data });
            _setLsSnapshot(path, data);
            if (typeof onFresh === 'function') {
                try { onFresh(data); } catch(e) {}
            }
        } catch(e) { /* 静默失败：下次再刷新 */ }
        finally { _swrRefreshLock.delete(ckey); }
    };
    // 用 requestIdleCallback 避免抢主线程时间；没有则 setTimeout 兜底
    const schedule = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb) => setTimeout(cb, 80);
    const p = new Promise(resolve => schedule(() => doRefresh().then(resolve)));
    _swrRefreshLock.set(ckey, p);
}

async function api(path, options = {}) {
    const method = options.method || 'GET';
    const ckey = _cacheKey(path, options);
    const isSwr = method === 'GET' && _isSwrPath(path);

    // 1) SWR: 命中陈旧但可用缓存 → 立即返回旧数据，后台异步刷新（切换 Tab 时 0ms）
    if (isSwr) {
        const hit = _apiMemCache.get(ckey);
        const age = hit ? Date.now() - hit.ts : Infinity;
        if (hit && age < SWR_STALE_TTL) {
            // 超过新鲜期但仍在陈旧窗口内 → 后台刷新
            if (age > API_MEM_CACHE_TTL) {
                const opts = {
                    method,
                    headers: { 'Content-Type': 'application/json' }
                };
                if (token) opts.headers['Authorization'] = 'Bearer ' + token;
                _swrBackgroundRefresh(ckey, path, method, opts);
            }
            return hit.data;
        }
    }

    // 2) 内存缓存命中：TTL 内新鲜缓存 → 直接返回
    if (method === 'GET' && !isSwr) {
        const hit = _apiMemCache.get(ckey);
        if (hit && Date.now() - hit.ts < API_MEM_CACHE_TTL) return hit.data;
    }

    // 3) 请求去重：同 key 正在飞行中，则共享 Promise
    const inflight = _apiInflight.get(ckey);
    if (inflight) return inflight;

    // 4) 真正发起请求
    const promise = (async () => {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (token) opts.headers['Authorization'] = 'Bearer ' + token;
        if (options.body) opts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);

        let res;
        try {
            res = await fetch(API + path, opts);
        } catch (e) {
            // 网络错误：若 SWR 路径有陈旧缓存，返回缓存而不是抛错（弱网更友好）
            if (isSwr) {
                const hit = _apiMemCache.get(ckey);
                if (hit) return hit.data;
                const lsHit = _getLsSnapshot(path);
                if (lsHit) return lsHit.data;
            }
            throw new Error('网络错误');
        }

        const data = await res.json().catch(() => ({ ok: false, error: '网络错误' }));
        if (!data.ok && res.status === 401) {
            token = '';
            localStorage.removeItem('stating_token');
            showAuth();
            throw new Error('登录已过期');
        }
        // 非 ok：若有 SWR 缓存，退化返回缓存，不中断 UI
        if (!data.ok && isSwr) {
            const hit = _apiMemCache.get(ckey);
            if (hit) return hit.data;
            const lsHit = _getLsSnapshot(path);
            if (lsHit) return lsHit.data;
            throw new Error(data.error || '请求失败');
        }
        if (!data.ok) throw new Error(data.error || '请求失败');

        // 写入缓存
        if (method === 'GET') _apiMemCache.set(ckey, { ts: Date.now(), data });
        _setLsSnapshot(path, data);

        return data;
    })();

    _apiInflight.set(ckey, promise);
    try { return await promise; }
    finally {
        setTimeout(() => _apiInflight.delete(ckey), API_DEDUP_WINDOW);
    }
}

/**
 * 获取某个路径的乐观快照（仅白名单路径），用于先显示旧数据再刷新
 * 返回 { data, ts } 或 null
 */
function apiSnapshot(path) { return _getLsSnapshot(path); }

/**
 * 主动失效 API 缓存：
 * - 不传参数：清 GET 请求内存缓存 + 全部乐观快照（写操作后强烈建议调用）
 * - 传字符串 path：只清该 path 的内存缓存 + 快照
 * - 传字符串数组：批量清理指定 path
 */
function apiInvalidate(paths) {
    const clearOne = (p) => {
        _apiMemCache.delete('G:' + p);
        try {
            const snaps = _getLsSnapshots();
            if (snaps && snaps[p]) {
                delete snaps[p];
                _lsSnapshots = snaps;
                localStorage.setItem(LS_SNAPSHOT_KEY, JSON.stringify(snaps));
            }
        } catch(e) {}
    };
    if (!paths) {
        // 清空 GET 内存缓存
        for (const k of Array.from(_apiMemCache.keys())) {
            if (k.startsWith('G:')) _apiMemCache.delete(k);
        }
        // 清空所有乐观快照
        try { _lsSnapshots = {}; localStorage.removeItem(LS_SNAPSHOT_KEY); } catch(e){}
    } else if (typeof paths === 'string') {
        clearOne(paths);
    } else if (Array.isArray(paths)) {
        paths.forEach(clearOne);
    }
}

// 上传媒体文件到服务器，返回URL
async function uploadMedia(base64Data, mimeType) {
    const data = await api('/upload', {
        method: 'POST',
        body: { data: base64Data, mimeType: mimeType }
    });
    return data.url;
}

// ============ 状态 ============
let me = null;
function isAdmin() { return me && (me.phone === '13385387338' || me.isAdmin === true); }
let group = null;
let activeView = 'home';
let selectedAvatar = AVATARS[0];
let selectedGroupAvatar = GROUP_AVATARS[0];
let lastRenderedDay = '';
let lastSender = '';
let unreadCount = 0;
let msgPollTimer = null;
let presPollTimer = null;
let sseSource = null;
let sseFailedCount = 0;
let typingTimer = null;
let knownMsgIds = new Set();
let confirmCallback = null;
let adminTargetUser = null;
let pendingLogin = null; // 存储待验证的管理员登录信息
let groupReadStatus = {};
let notifyEnabled = localStorage.getItem('stating_notify') === '1';
let bgPollTimer = null;
let lastMsgCache = {}; // groupCode -> lastMsgTs
let msgCache = []; // 当前群聊的消息缓存
let forceFullReload = true; // 是否强制全量拉取

// ============ 系统通知 ============
async function requestNotifyPermission() {
    if (!('Notification' in window)) { showToast('当前浏览器不支持系统通知'); return false; }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') { showToast('请在浏览器设置中开启通知权限'); return false; }
    // 兼容 Safari 回调式和标准 Promise 式
    try {
        if (Notification.requestPermission.length > 0) {
            // 旧版 Safari：回调形式
            return await new Promise(resolve => {
                Notification.requestPermission(result => resolve(result === 'granted'));
            });
        }
        const result = await Notification.requestPermission();
        return result === 'granted';
    } catch(e) {
        showToast('通知权限请求失败');
        return false;
    }
}

function showNotification(title, body, groupCode) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
        const opts = {
            body: body,
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📨</text></svg>',
            tag: groupCode || 'stating'
        };
        // Safari 不支持 renotify，仅在支持时添加
        try { opts.renotify = true; } catch(e) {}
        const n = new Notification(title, opts);
        n.onclick = () => {
            window.focus();
            if (groupCode) {
                switchView('chat');
                joinGroupByCode(groupCode);
            }
            n.close();
        };
        setTimeout(() => { try { n.close(); } catch(e) {} }, 8000);
    } catch(e) {
        // 通知创建失败时静默处理
    }
}

async function bgPollGroups() {
    if (!notifyEnabled || document.visibilityState === 'visible' || !me) return;
    try {
        const data = await api('/my-groups');
        for (const g of (data.groups || [])) {
            const lastTs = lastMsgCache[g.code] || 0;
            if (g.lastMsgTs && g.lastMsgTs > lastTs) {
                if (lastMsgCache[g.code] !== undefined) {
                    // 获取最新消息内容
                    try {
                        const gd = await api('/groups/' + g.code);
                        const msgs = (gd.messages || []).filter(m => m.senderPhone !== me.phone && m.ts > lastTs);
                        if (msgs.length > 0) {
                            const latest = msgs[msgs.length - 1];
                            showNotification(
                                g.name + ' · ' + (latest.senderNickname || '新消息'),
                                latest.text || '[图片]',
                                g.code
                            );
                        }
                    } catch(e) {}
                }
                lastMsgCache[g.code] = g.lastMsgTs;
            }
        }
    } catch(e) {}
}

function startBgPoll() {
    stopBgPoll();
    bgPollTimer = setInterval(bgPollGroups, 10000);
}

function stopBgPoll() {
    if (bgPollTimer) { clearInterval(bgPollTimer); bgPollTimer = null; }
}

// 通过邀请码进入群聊（通知点击时调用）
async function joinGroupByCode(code) {
    if (!code) return;
    try {
        const data = await api('/groups/' + code + '/join', { method: 'POST' });
        apiInvalidate(['/my-groups', '/me']);
        if (data.group) {
            group = data.group;
            renderChatGate();
            await enterGroupRoom(group);
        }
    } catch(e) {
        // 可能已经是成员，直接获取群信息进入
        try {
            const gd = await api('/groups/' + code);
            if (gd.group && gd.group.isMember) {
                group = gd.group;
                renderChatGate();
                await enterGroupRoom(group);
            }
        } catch(e2) {}
    }
}

async function toggleNotify(on) {
    notifyEnabled = on;
    localStorage.setItem('stating_notify', on ? '1' : '0');
    const toggle = $('#notifyToggle');
    if (toggle) toggle.checked = on;
    if (on) {
        const ok = await requestNotifyPermission();
        if (!ok) {
            notifyEnabled = false;
            localStorage.setItem('stating_notify', '0');
            if (toggle) toggle.checked = false;
            return;
        }
        try {
            const data = await api('/my-groups');
            for (const g of (data.groups || [])) {
                lastMsgCache[g.code] = g.lastMsgTs || Date.now();
            }
        } catch(e) {}
        startBgPoll();
    } else {
        stopBgPoll();
    }
}

// ============ 个人信息编辑 ============
function startEditProfile(field) {
    const rowId = field === 'nickname' ? 'profileNickRow' : field === 'email' ? 'profileEmail' : 'profileAvatarRow';
    const row = $('#' + rowId);
    if (!row) return;
    const parent = row.parentElement;
    const currentVal = field === 'nickname' ? me.nickname : field === 'email' ? (me.email || '') : me.avatar;

    if (field === 'avatar') {
        $('#avatarUploadInput').click();
        return;
    }

    const input = document.createElement('input');
    input.className = 'pr-edit-input';
    input.type = field === 'email' ? 'email' : 'text';
    input.value = currentVal;
    input.placeholder = field === 'email' ? '输入邮箱（可留空）' : '输入新昵称';
    input.maxLength = field === 'nickname' ? 20 : 50;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'pr-save-btn';
    saveBtn.textContent = '保存';

    row.style.display = 'none';
    parent.insertBefore(input, row);
    parent.insertBefore(saveBtn, row);
    input.focus();
    input.select();

    const finish = async () => {
        const newVal = input.value.trim();
        if (newVal === currentVal) {
            input.remove(); saveBtn.remove(); row.style.display = '';
            return;
        }
        try {
            const body = {};
            body[field] = newVal;
            const data = await api('/profile', { method: 'PATCH', body });
            me = data.user;
            updateProfileUI();
            showToast('修改成功');
        } catch(e) {
            showToast(e.message);
            input.remove(); saveBtn.remove(); row.style.display = '';
        }
    };
    saveBtn.onclick = finish;
    input.onkeydown = e => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') { input.remove(); saveBtn.remove(); row.style.display = ''; } };
}

async function handleAvatarUpload(file) {
    if (!file || !file.type.startsWith('image/')) { showToast('请选择图片文件'); return; }
    if (file.size > 3 * 1024 * 1024) { showToast('图片过大（最大3MB）'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const data = await api('/profile', { method: 'PATCH', body: { avatar: reader.result } });
            me = data.user;
            updateProfileUI();
            showToast('头像修改成功');
        } catch(e) { showToast(e.message); }
    };
    reader.readAsDataURL(file);
}

// ============ 语音消息 ============
let mediaRecorder = null;
let audioChunks = [];
let recordStartTime = 0;
let recordTimer = null;

async function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        // 停止录音并发送
        const duration = Math.round((Date.now() - recordStartTime) / 1000);
        clearInterval(recordTimer);
        hideRecordingBar();

        if (duration < 1) {
            mediaRecorder.onstop = () => {
                mediaRecorder.stream.getTracks().forEach(t => t.stop());
                audioChunks = [];
                mediaRecorder = null;
            };
            mediaRecorder.stop();
            showToast('录音时间太短');
            return;
        }

        mediaRecorder.onstop = () => {
            mediaRecorder.stream.getTracks().forEach(t => t.stop());
            const mimeType = mediaRecorder.mimeType || 'audio/webm';
            const audioBlob = new Blob(audioChunks, { type: mimeType });
            audioChunks = [];
            mediaRecorder = null;
            const reader = new FileReader();
            reader.onload = async () => {
                const localMsg = {
                    id: 'local_' + uid(),
                    senderPhone: me.phone,
                    senderNickname: me.nickname,
                    senderAvatar: me.avatar,
                    type: 'voice',
                    content: reader.result,
                    voiceData: reader.result,
                    voiceDuration: duration,
                    ts: Date.now(),
                    readBy: [me.phone],
                    _local: true
                };
                msgCache.push(localMsg);
                msgCache.sort((a, b) => a.ts - b.ts);
                renderMessages(msgCache);

                try {
                    const voiceMime = audioBlob.type || 'audio/webm';
                    const mediaUrl = await uploadMedia(reader.result, voiceMime);
                    const data = await api('/groups/' + group.code + '/messages', {
                        method: 'POST',
                        body: { type: 'voice', mediaUrl, voiceDuration: duration }
                    });
                    replaceLocalMessage(localMsg.id, data.message);
                    lastMsgCache[group.code] = data.message.ts;
                } catch(e) {
                    removeLocalMessage(localMsg.id);
                    showToast(e.message);
                }
            };
            reader.readAsDataURL(audioBlob);
        };
        mediaRecorder.stop();
    } else {
        // 开始录音
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            let mimeType = 'audio/webm';
            if (typeof MediaRecorder.isTypeSupported === 'function') {
                if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
                else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
            }
            mediaRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
            audioChunks = [];
            recordStartTime = Date.now();
            mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
            mediaRecorder.start();
            showRecordingBar();
            recordTimer = setInterval(() => {
                const s = Math.round((Date.now() - recordStartTime) / 1000);
                const t = $('#recTime'); if (t) t.textContent = s + '"';
                if (s >= 60) toggleRecording();
            }, 1000);
        } catch(e) {
            showToast('无法访问麦克风，请检查权限');
        }
    }
}

function cancelRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        clearInterval(recordTimer);
        mediaRecorder.onstop = () => {
            mediaRecorder.stream.getTracks().forEach(t => t.stop());
            audioChunks = [];
            mediaRecorder = null;
        };
        mediaRecorder.stop();
        hideRecordingBar();
        showToast('已取消录音');
    }
}

function showRecordingBar() {
    const bar = $('#recordingBar'); if (bar) bar.hidden = false;
    const composer = $('.composer'); if (composer) composer.style.opacity = '0.4';
}
function hideRecordingBar() {
    const bar = $('#recordingBar'); if (bar) bar.hidden = true;
    const composer = $('.composer'); if (composer) composer.style.opacity = '1';
}

// 位置消息小地图：懒加载 Leaflet（首屏不用地图时节约 ~140KB JS + 40KB CSS）
let locMsgMaps = {};
// 待初始化队列：如果 Leaflet 正在加载中，把 init 任务排队，加载完成后统一执行
let _locMsgInitQueue = null;
function initLocMsgMap(id, lat, lng, avatarHtml) {
    const el = document.getElementById(id);
    if (!el || locMsgMaps[id]) return;

    const doInit = () => {
        if (locMsgMaps[id]) return;
        if (typeof L === 'undefined') {
            el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-3);font-size:12px;">地图加载失败</div>';
            return;
        }
        try {
            const map = L.map(el, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, preferCanvas: true }).setView([lat, lng], 15);
            L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 19, crossOrigin: true
            }).addTo(map);
            const icon = L.divIcon({
                className: 'loc-msg-marker',
                html: '<div style="width:24px;height:24px;border-radius:50%;background:#FF3B30;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;font-size:12px;">📍</div>',
                iconSize: [24, 24], iconAnchor: [12, 12]
            });
            L.marker([lat, lng], { icon }).addTo(map);
            locMsgMaps[id] = map;
            requestAnimationFrame(() => {
                map.invalidateSize();
                setTimeout(() => map.invalidateSize(), 180);
            });
        } catch(e) {
            el.innerHTML = '<div style="padding:20px;text-align:center;color:red;font-size:11px;">地图错误: ' + e.message + '</div>';
        }
    };

    if (typeof L !== 'undefined') { doInit(); return; }
    // 懒加载：首次渲染位置消息时才注入 Leaflet，加载完后初始化
    loadLeaflet().then(doInit).catch(() => {
        el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-3);font-size:12px;">地图加载失败</div>';
    });
}

function playVoice(dataUrl, btn) {
    if (!dataUrl) { showToast('语音数据无效'); return; }
    try {
        const audio = new Audio(dataUrl);
        const original = btn.textContent;
        btn.textContent = '⏸️';
        audio.onended = () => btn.textContent = original;
        audio.onerror = () => { btn.textContent = original; showToast('语音播放失败'); };
        audio.play().catch(() => { btn.textContent = original; showToast('语音播放失败'); });
    } catch(e) {
        showToast('语音播放失败');
    }
}

// ============ 文件消息 ============
async function handleFileSend(file) {
    if (!file || !group) return;
    if (file.size > 8 * 1024 * 1024) { showToast('文件过大（最大8MB）'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
        const localMsg = {
            id: 'local_' + uid(),
            senderPhone: me.phone,
            senderNickname: me.nickname,
            senderAvatar: me.avatar,
            type: 'file',
            content: reader.result,
            fileData: reader.result,
            fileName: file.name,
            fileSize: file.size,
            ts: Date.now(),
            readBy: [me.phone],
            _local: true
        };
        msgCache.push(localMsg);
        msgCache.sort((a, b) => a.ts - b.ts);
        renderMessages(msgCache);

        try {
            const fileMime = file.type || 'application/octet-stream';
            const mediaUrl = await uploadMedia(reader.result, fileMime);
            const data = await api('/groups/' + group.code + '/messages', {
                method: 'POST',
                body: { type: 'file', mediaUrl, fileName: file.name, fileSize: file.size }
            });
            replaceLocalMessage(localMsg.id, data.message);
            lastMsgCache[group.code] = data.message.ts;
        } catch(e) {
            removeLocalMessage(localMsg.id);
            showToast(e.message);
        }
    };
    reader.readAsDataURL(file);
}

function downloadFile(fileData, fileName) {
    const a = document.createElement('a');
    a.href = fileData;
    a.download = fileName;
    a.click();
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ============ 消息撤回 ============
async function recallMessage(msgId) {
    if (!confirm('确定撤回这条消息吗？')) return;
    try {
        await api('/groups/' + group.code + '/messages/' + msgId + '/recall', { method: 'POST' });
        knownMsgIds.delete(msgId);
        const row = document.querySelector(`.msg-row[data-msg-id="${msgId}"]`);
        if (row) row.remove();
        forceFullReload = true;
        await refreshGroupData();
        showToast('消息已撤回');
    } catch(e) { showToast(e.message); }
}

// ============ 二维码扫描 ============
function scanQRFromImage(imgEl) {
    // 懒加载：首次遇到图片消息才注入 jsQR（首屏 ~200KB 节约）
    const doScan = () => {
        if (typeof jsQR === 'undefined') return;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = imgEl.naturalWidth || imgEl.width;
        canvas.height = imgEl.naturalHeight || imgEl.height;
        if (!canvas.width || !canvas.height) return;
        ctx.drawImage(imgEl, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) showQRResult(code.data);
    };
    if (typeof jsQR !== 'undefined') { doScan(); return; }
    loadJsQR().then(doScan).catch(() => {});
}

function showQRResult(text) {
    $('#qrResultText').textContent = text;
    const actionBtn = $('#qrResultAction');
    if (/^https?:\/\//.test(text)) {
        actionBtn.hidden = false;
        actionBtn.onclick = () => { window.open(text, '_blank'); $('#qrResultDialog').hidden = true; };
    } else {
        actionBtn.hidden = true;
    }
    $('#qrResultDialog').hidden = false;
}

// ============ 管理员注销用户 ============
async function adminDeleteUser(phone) {
    if (!confirm('确定注销该用户吗？其创建的群聊也会被删除。')) return;
    try {
        await api('/admin/users/' + phone, { method: 'DELETE' });
        apiInvalidate('/users');
        showToast('用户已注销');
        renderUsers();
    } catch(e) { showToast(e.message); }
}

// ============ 图片保存 ============
function saveImage(dataUrl) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'stating_image_' + Date.now() + '.png';
    a.click();
}

// 判断消息是否被群内其他人已读
function isMsgReadByOthers(m) {
    if (!groupReadStatus || !group) return false;
    for (const phone of group.members) {
        if (phone !== m.senderPhone && groupReadStatus[phone] && groupReadStatus[phone] > m.ts) {
            return true;
        }
    }
    return false;
}

// 更新已有消息的已读状态
function updateReadReceipts() {
    $$('.msg-row.me').forEach(row => {
        const check = row.querySelector('.msg-checks');
        if (!check) return;
        const ts = parseInt(row.dataset.msgTs);
        const read = isMsgReadByOthers({ senderPhone: me.phone, ts });
        check.textContent = read ? '✓✓' : '✓';
        check.className = 'msg-checks ' + (read ? 'read' : 'delivered');
    });
}

// ============ 工具函数 ============
/* 节流：至少 wait 毫秒内只触发一次（尾部也触发） */
function throttle(fn, wait = 100) {
    let last = 0, timer = null;
    return function (...args) {
        const ctx = this;
        const now = Date.now();
        const remaining = wait - (now - last);
        if (remaining <= 0) {
            if (timer) { clearTimeout(timer); timer = null; }
            last = now;
            fn.apply(ctx, args);
        } else if (!timer) {
            timer = setTimeout(() => {
                last = Date.now();
                timer = null;
                fn.apply(ctx, args);
            }, remaining);
        }
    };
}
/* 防抖：wait 毫秒内不重复触发才执行 */
function debounce(fn, wait = 150) {
    let timer = null;
    return function (...args) {
        const ctx = this;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fn.apply(ctx, args); }, wait);
    };
}
/* rAF 合批：同一帧内多次 schedule 只执行一次 fn */
function rafBatch(fn) {
    let token = 0;
    const run = () => { token = 0; fn(); };
    return function () {
        if (!token) token = requestAnimationFrame(run);
    };
}

/* composer（contentEditable）自动高度：先清空 height 再按 scrollHeight 赋值，避免跳针 */
function resizeComposer() {
    const inp = $('#composerInput');
    if (!inp) return;
    // style.height 清空 → 让 scrollHeight 反映真实的最小高度
    inp.style.height = 'auto';
    const next = Math.max(38, Math.min(130, inp.scrollHeight));
    inp.style.height = next + 'px';
}
const scheduleResizeComposer = rafBatch(resizeComposer);

/* 玻璃按压态绑定：
   - pointerdown/pointermove → 加 is-pressed → 触发液态玻璃高亮扫光
   - pointerup/pointercancel/pointerleave → 移除
   - 支持"长按挪动"：只要 press 开始，移动仍保持 pressed */
function bindGlassPressState(el, opts = {}) {
    if (!el) return;
    const cls = opts.class || 'is-pressed';
    const pressTimer = (typeof opts.longPressMs === 'number') ? opts.longPressMs : 60; // iOS 26 手感：极短延迟即进入液态
    let pressT = 0;
    let pressedPtr = null; // pointerId

    const start = (e) => {
        // 过滤滚动触控（pointerType touch 时我们仍然加，因为拖拽顶部栏就是 touch）
        pressedPtr = e.pointerId;
        if (pressT) clearTimeout(pressT);
        pressT = setTimeout(() => {
            if (pressedPtr != null) el.classList.add(cls);
        }, pressTimer);
    };
    const move = (e) => {
        if (pressedPtr !== e.pointerId) return;
        // 只要 pointer 还在按住并移动，就维持液态玻璃态
        if (!el.classList.contains(cls)) el.classList.add(cls);
    };
    const end = (e) => {
        if (e && pressedPtr != null && e.pointerId !== pressedPtr) return;
        pressedPtr = null;
        if (pressT) { clearTimeout(pressT); pressT = 0; }
        el.classList.remove(cls);
    };

    try {
        el.style.touchAction = el.style.touchAction || 'manipulation';
    } catch (e) {}
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', (e) => {
        // 只有真正松开才完全解除（长按挪动时仍保持）
        if (pressedPtr == null) return;
        // pointerleave 但没 up？（比如移出顶栏还按着）保留液态玻璃直到 up
    });
    // 防止右键菜单干扰
    el.addEventListener('contextmenu', () => { el.classList.remove(cls); });
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}
function linkify(text) {
    const escaped = escapeHtml(text);
    return escaped
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/@(\d{6,15})/g, '<span class="msg-mention">@$1</span>');
}
function fmtTime(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}
function fmtDay(ts) {
    const d = new Date(ts), now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.floor((today - that) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff < 7) return diff + '天前';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
function fmtDateTime(ts) {
    const d = new Date(ts);
    return fmtDay(ts) + ' ' + fmtTime(ts);
}
function fmtLastSeen(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    return fmtDay(ts);
}
function phoneMask(p) {
    if (!p || p.length < 7) return p;
    return p.slice(0, 3) + '****' + p.slice(-4);
}
function avatarHtml(a) {
    if (!a) return '😀';
    if (a.startsWith('data:')) return '<img src="' + a + '" class="avatar-img">';
    return a;
}
function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

function toggleDarkMode(on) {
    darkMode = on;
    document.body.classList.toggle('dark', on);
    localStorage.setItem('stating_dark', on ? '1' : '0');
    const toggle = $('#darkModeToggle');
    if (toggle) toggle.checked = on;
}

// 计算网站运行时长（从2026-08-01 00:00起）
function calcUptime() {
    const start = new Date('2026-08-01T00:00:00+08:00').getTime();
    const now = Date.now();
    const diff = Math.max(0, now - start);
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    return days + '天 ' + hours + '小时 ' + mins + '分钟';
}

function showImsgInfo() {
    $('#imsgUptime').textContent = calcUptime();
    $('#imsgInfoDialog').hidden = false;
}

function hideImsgInfo() {
    $('#imsgInfoDialog').hidden = true;
}

// ============ 图片压缩 ============
function compressImage(file, maxW, maxH, quality, cb) {
    const URL = window.URL || window.webkitURL;
    const img = new Image();
    img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxW) { h = h * maxW / w; w = maxW; }
        if (h > maxH) { w = w * maxH / h; h = maxH; }
        // 使用整数尺寸避免亚像素渲染
        w = Math.floor(w); h = Math.floor(h);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(img, 0, 0, w, h);
        const url = canvas.toDataURL('image/jpeg', quality);
        try { URL.revokeObjectURL(img.src); } catch (e) {}
        cb(url);
    };
    img.onerror = () => {
        // 退化方案：用FileReader
        const reader = new FileReader();
        reader.onload = e => {
            cb(e.target.result);
        };
        reader.readAsDataURL(file);
    };
    try {
        img.src = URL.createObjectURL(file);
    } catch (e) {
        img.src = '';
        img.onerror();
    }
}

// ============ 认证界面 ============
function showAuth() {
    me = null; group = null;
    stopPolling();
    $('#authScreen').hidden = false;
    $('#adminKeyScreen').hidden = true;
    $('#mainApp').hidden = true;
    $('#authError').textContent = '';
}

function showMain() {
    // 移除登录页随机主题
    loginThemes.forEach(t => document.body.classList.remove(t));
    $('#authScreen').hidden = true;
    $('#mainApp').hidden = false;
    updateProfileUI();
    // 同步深色模式开关状态
    const dm = $('#darkModeToggle');
    if (dm) dm.checked = darkMode;
    // 同步通知开关状态
    const nt = $('#notifyToggle');
    if (nt) nt.checked = notifyEnabled;
    if (notifyEnabled) startBgPoll();
    // 请求通话通知权限
    if ('Notification' in window && Notification.permission === 'default') {
        setTimeout(() => Notification.requestPermission(), 2000);
    }
    // 普通用户隐藏"用户"标签
    const usersNav = document.querySelector('.nav-item[data-view="users"]');
    if (usersNav) usersNav.style.display = isAdmin() ? '' : 'none';
    switchView('home');
    if (isAdmin()) renderUsers();
}

async function handleLogin(e) {
    e.preventDefault();
    const phone = $('#loginPhone').value.trim();
    const password = $('#loginPassword').value;
    const errEl = $('#authError');
    if (!phone || !password) { errEl.textContent = '请输入手机号和密码'; return; }
    // 管理员手机号：先显示密钥验证界面
    if (phone === '13385387338') {
        pendingLogin = { phone, password };
        $('#authScreen').hidden = true;
        $('#adminKeyScreen').hidden = false;
        $('#adminKeyError').textContent = '';
        $$('#adminKeyInputs .otp-box').forEach(i => { i.value = ''; i.disabled = false; });
        const firstInput = $('#adminKeyInputs .otp-box');
        if (firstInput) setTimeout(() => firstInput.focus(), 100);
        return;
    }
    try {
        const data = await api('/login', { method: 'POST', body: { phone, password } });
        token = data.token;
        localStorage.setItem('stating_token', token);
        me = data.user;
        errEl.textContent = '';
        showMain();
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.add('shake');
        setTimeout(() => errEl.classList.remove('shake'), 500);
    }
}

async function handleAdminKeySubmit() {
    const inputs = $$('#adminKeyInputs .otp-box');
    const adminKey = Array.from(inputs).map(i => i.value).join('');
    const errEl = $('#adminKeyError');
    if (adminKey.length !== 6) { errEl.textContent = '请输入6位管理员密钥'; return; }
    if (!pendingLogin) { errEl.textContent = '登录信息已过期，请重新登录'; return; }
    try {
        let data;
        if (pendingLogin.type === 'register') {
            data = await api('/register', { method: 'POST', body: {
                phone: pendingLogin.phone, password: pendingLogin.password,
                nickname: pendingLogin.nickname, email: pendingLogin.email,
                avatar: pendingLogin.avatar, adminKey
            }});
        } else {
            data = await api('/login', { method: 'POST', body: {
                phone: pendingLogin.phone, password: pendingLogin.password, adminKey
            }});
        }
        token = data.token;
        localStorage.setItem('stating_token', token);
        me = data.user;
        pendingLogin = null;
        inputs.forEach(i => i.value = '');
        errEl.textContent = '';
        $('#adminKeyScreen').hidden = true;
        showMain();
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.add('shake');
        setTimeout(() => errEl.classList.remove('shake'), 500);
    }
}

function cancelAdminKey() {
    pendingLogin = null;
    $$('#adminKeyInputs .otp-box').forEach(i => i.value = '');
    $('#adminKeyError').textContent = '';
    $('#adminKeyScreen').hidden = true;
    $('#authScreen').hidden = false;
}

async function handleRegister(e) {
    e.preventDefault();
    const phone = $('#regPhone').value.trim();
    const password = $('#regPassword').value;
    const email = $('#regEmail').value.trim() || '无';
    const nickname = $('#regNickname').value.trim();
    const errEl = $('#authError');
    if (!phone || !password || !nickname) { errEl.textContent = '请填写完整信息'; return; }
    if (!/^\d{6,15}$/.test(phone)) { errEl.textContent = '手机号格式不正确'; return; }
    if (password.length < 4) { errEl.textContent = '密码至少4位'; return; }
    // 管理员手机号注册也需要密钥
    if (phone === '13385387338') {
        pendingLogin = { type: 'register', phone, password, nickname, email, avatar: selectedAvatar };
        $('#authScreen').hidden = true;
        $('#adminKeyScreen').hidden = false;
        $('#adminKeyError').textContent = '';
        $$('#adminKeyInputs .otp-box').forEach(i => { i.value = ''; i.disabled = false; });
        const firstInput = $('#adminKeyInputs .otp-box');
        if (firstInput) setTimeout(() => firstInput.focus(), 100);
        return;
    }
    try {
        const data = await api('/register', { method: 'POST', body: { phone, password, nickname, email, avatar: selectedAvatar } });
        token = data.token;
        localStorage.setItem('stating_token', token);
        me = data.user;
        errEl.textContent = '';
        showMain();
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.add('shake');
        setTimeout(() => errEl.classList.remove('shake'), 500);
    }
}

async function checkSession() {
    if (!token) { showAuth(); return; }
    try {
        const data = await api('/me');
        me = data.user;
        showMain();
    } catch {
        showAuth();
    }
}

function logout() {
    token = '';
    localStorage.removeItem('stating_token');
    stopBgPoll();
    lastMsgCache = {};
    showAuth();
}

// ============ 头像选择 ============
function initAvatars() {
    const grid = $('#avatarGrid');
    AVATARS.forEach((a, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'avatar-opt' + (i === 0 ? ' selected' : '');
        btn.textContent = a;
        btn.onclick = () => {
            $$('.avatar-opt').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            selectedAvatar = a;
        };
        grid.appendChild(btn);
    });

    $('#avatarUploadBtn').onclick = () => $('#avatarUpload').click();
    $('#avatarUpload').onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        compressImage(file, 200, 200, 0.85, dataUrl => {
            selectedAvatar = dataUrl;
            $$('.avatar-opt').forEach(b => b.classList.remove('selected'));
            showToast('头像已选择');
        });
    };

    const gGrid = $('#groupAvatarGrid');
    GROUP_AVATARS.forEach((a, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'avatar-opt' + (i === 0 ? ' selected' : '');
        btn.textContent = a;
        btn.onclick = () => {
            $$('#groupAvatarGrid .avatar-opt').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            selectedGroupAvatar = a;
        };
        gGrid.appendChild(btn);
    });
}

// ============ 导航 ============
function switchView(view) {
    activeView = view;
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach(v => v.classList.remove('active'));
    $('#' + view + 'View').classList.add('active');
    // 切换模块颜色主题（保留深色模式类）
    document.body.classList.remove('theme-home', 'theme-chat', 'theme-users', 'theme-profile', 'theme-feedback');
    document.body.classList.add('theme-' + view);
    if (view === 'users' && isAdmin()) renderUsers();
    if (view === 'profile') renderMyGroups();
    if (view === 'chat') renderChatGate();
    if (view === 'feedback') loadFeedback();
}

function updateProfileUI() {
    if (!me) return;
    $('#heroAvatar').innerHTML = avatarHtml(me.avatar);
    const av = $('#profileAvatar');
    if (av) av.innerHTML = avatarHtml(me.avatar);
    const name = $('#profileNickname');
    if (name) name.textContent = me.nickname;
    const id = $('#profileId');
    if (id) id.textContent = 'ID: ' + phoneMask(me.phone);
    const phone = $('#profilePhone');
    if (phone) phone.textContent = phoneMask(me.phone);
    const email = $('#profileEmail');
    if (email) email.textContent = me.email || '无';
    const nickRow = $('#profileNickRow');
    if (nickRow) nickRow.textContent = me.nickname;
    const avRow = $('#profileAvatarRow');
    if (avRow) avRow.innerHTML = avatarHtml(me.avatar);
    const badge = $('#adminBadge');
    if (badge) badge.hidden = !isAdmin();
}

// ============ 群聊门（输入邀请码/创建） ============
function renderChatGate() {
    if (group) {
        $('#inviteGate').hidden = true;
        $('#chatRoom').hidden = false;
        enterGroupRoom(group);
    } else {
        $('#inviteGate').hidden = false;
        $('#chatRoom').hidden = true;
        // 清空邀请码输入框
        $$('#otpInputs .otp-box').forEach(i => { i.value = ''; i.disabled = false; });
        $('#inviteError').hidden = true;
        $('#createGroupCard').hidden = true;
        $('#inviteCard').hidden = false;
    }
}

async function handleJoinGroup() {
    const inputs = $$('#otpInputs .otp-box');
    const code = Array.from(inputs).map(i => i.value).join('').toUpperCase();
    const errEl = $('#inviteError');
    if (code.length !== 6) {
        errEl.textContent = '请输入6位邀请码';
        errEl.hidden = false;
        return;
    }
    try {
        const data = await api('/groups/' + code + '/join', { method: 'POST' });
        apiInvalidate(['/my-groups', '/me']);
        errEl.hidden = true;
        group = data.group;
        me = (await api('/me')).user;
        inputs.forEach(i => i.value = '');
        enterGroupRoom(group);
    } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
        errEl.classList.add('shake');
        setTimeout(() => errEl.classList.remove('shake'), 500);
    }
}

async function handleCreateGroup() {
    const name = $('#groupName').value.trim();
    const code = $('#groupCode').value.trim().toUpperCase();
    const errEl = $('#createError');
    if (!name || !code) { errEl.textContent = '请填写群名和邀请码'; return; }
    if (!/^[A-Za-z0-9]{6}$/.test(code)) { errEl.textContent = '邀请码必须是6位字母或数字'; return; }
    try {
        const data = await api('/groups', { method: 'POST', body: { name, code, avatar: selectedGroupAvatar } });
        apiInvalidate(['/my-groups', '/me']);
        errEl.textContent = '';
        group = data.group;
        me = (await api('/me')).user;
        $('#groupName').value = '';
        $('#groupCode').value = '';
        enterGroupRoom(group);
    } catch (err) {
        errEl.textContent = err.message;
    }
}

// ============ 聊天室 ============
async function enterGroupRoom(g) {
    group = g;
    $('#inviteGate').hidden = true;
    $('#chatRoom').hidden = false;

    $('#chatAvatar').textContent = g.avatar;
    $('#chatName').textContent = g.name;
    $('#opGroupAvatar').textContent = g.avatar;
    $('#opGroupName').textContent = g.name;
    $('#opGroupCode').textContent = '邀请码：' + g.code;

    // 群主：只显示注销；非群主管理员：退出+注销；普通成员：只显示退出
    updateGroupMenuVisibility();

    // 主动请求通知权限（用于通话提醒）
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
    }

    knownMsgIds.clear();
    lastRenderedDay = '';
    lastSender = '';
    $('#messages').innerHTML = '';

    // 先发送心跳，再刷新数据
    await api('/beat', { method: 'POST', body: { code: g.code } }).catch(() => {});
    msgCache = [];
    forceFullReload = true;
    await refreshGroupData();
    startPolling();
    // 检查是否有人共享位置
    pollLocations();
    if (!locPollInterval) locPollInterval = setInterval(pollLocations, 3000);
    // 检查是否有通话
    startCallPolling();
}

function exitGroup() {
    stopPolling();
    // 停止位置共享相关
    if (isSharingLocation) stopLiveLocation();
    if (locPollInterval) { clearInterval(locPollInterval); locPollInterval = null; }
    $('#locShareBanner').hidden = true;
    $('#locMapWrap').hidden = true;
    if (locMap) { locMap.remove(); locMap = null; locMarkers = {}; }
    // 停止通话轮询
    if (callPollInt) { clearInterval(callPollInt); callPollInt = null; }
    hideCallBanner();
    group = null;
    groupReadStatus = {};
    $('#groupMenu').hidden = true;
    $('#chatRoom').hidden = true;
    $('#inviteGate').hidden = false;
    const mobBar = $('#mobileOnlineBar');
    if (mobBar) mobBar.hidden = true;
    // 清空邀请码输入框
    $$('#otpInputs .otp-box').forEach(i => { i.value = ''; i.disabled = false; });
    $('#inviteError').hidden = true;
    // 确保创建群聊卡片隐藏，邀请码卡片显示
    $('#createGroupCard').hidden = true;
    $('#inviteCard').hidden = false;
}

async function refreshGroupData() {
    if (!group) return;
    try {
        let url = '/groups/' + group.code;
        if (!forceFullReload && msgCache.length > 0) {
            url += '?since=' + msgCache[msgCache.length - 1].ts;
        }
        const data = await api(url);
        group = data.group;
        if (!group.isMember && !isAdmin()) {
            showToast('你已不在该群聊中');
            exitGroup();
            return;
        }
        updateGroupMenuVisibility();
        groupReadStatus = data.group.readStatus || {};
        // 公告横幅
        const banner = $('#announcementBanner');
        if (banner) {
            if (group.announcement && group.announcement.content) {
                $('#annText').textContent = group.announcement.content;
                banner.hidden = false;
            } else {
                banner.hidden = true;
            }
        }
        // 置顶/免打扰按钮文字
        const gmPin = $('#gmPin');
        if (gmPin) gmPin.innerHTML = '<span class="gm-icon" data-icon="pin"></span> ' + (group.userSettings?.pinned ? '取消置顶' : '置顶群聊');
        const gmMute = $('#gmMute');
        if (gmMute) gmMute.innerHTML = '<span class="gm-icon" data-icon="' + (group.userSettings?.muted ? 'bell' : 'bellOff') + '"></span> ' + (group.userSettings?.muted ? '取消免打扰' : '消息免打扰');
        injectIcons(gmPin?.parentElement);

        if (forceFullReload) {
            msgCache = data.messages || [];
            forceFullReload = false;
            // 首次进入群聊加载草稿和置顶
            loadDraft();
            loadPinnedMessages();
        } else if (data.messages && data.messages.length > 0) {
            const existingIds = new Set(msgCache.map(m => m.id));
            for (const m of data.messages) {
                if (!existingIds.has(m.id)) msgCache.push(m);
            }
            msgCache.sort((a, b) => a.ts - b.ts);
        }

        if (notifyEnabled && document.visibilityState === 'hidden') {
            const newMsgs = (data.messages || []).filter(m =>
                m.senderPhone !== me.phone && m.ts > (lastMsgCache[group.code] || 0)
            );
            if (newMsgs.length > 0) {
                const latest = newMsgs[newMsgs.length - 1];
                showNotification(
                    group.name + ' · ' + (latest.senderNickname || '新消息'),
                    latest.text || '[图片]',
                    group.code
                );
            }
        }
        if (msgCache.length > 0) {
            lastMsgCache[group.code] = msgCache[msgCache.length - 1].ts;
        }

        const wasFull = msgCache.length <= 1 || knownMsgIds.size === 0 || Math.abs(knownMsgIds.size - msgCache.length) > Math.max(5, msgCache.length * 0.2);
        renderMessages(msgCache, wasFull);
        updateReadReceipts();
        // 安全兜底：onlineMembers 必须是对象，避免 Object.keys 抛错导致整条链路断掉
        const onlineMembers = (data.onlineMembers && typeof data.onlineMembers === 'object') ? data.onlineMembers : {};
        renderOnlineList(onlineMembers);
        const count = Object.keys(onlineMembers).length;
        const chatStatus = $('#chatStatus');
        if (chatStatus) chatStatus.textContent = count + ' 人在线';
        const onlineCount = $('#onlineCount');
        if (onlineCount) onlineCount.textContent = count;
    } catch (err) {
        if (err.message.includes('登录已过期')) return;
        console.error('刷新失败:', err);
    }
}

function updateGroupMenuVisibility() {
    if (!group) return;
    const isOwner = group.owner === me.phone || group.createdBy === me.phone || isAdmin();
    // 只有群主可见注销；群主不可见退出（只能注销）；普通成员可见退出
    $('#gmDismissGroup').hidden = !isOwner;
    $('#gmLeaveGroup').hidden = isOwner;
    // 群主专属菜单项
    const editBtn = $('#gmEditGroup');
    if (editBtn) editBtn.hidden = !isOwner;
    const menu = $('#groupMenu');
    if (menu) menu.classList.toggle('show-owner', isOwner);
}

function renderMessages(msgs, forceFull = false) {
    const container = $('#messages');
    if (!container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;

    // 场景：knownMsgIds 和输入量偏差大（说明有撤回/服务器重排），或者强制重建
    //       → 完整重建：清容器、清缓存、重置分隔/发送者
    if (forceFull || Math.abs(knownMsgIds.size - msgs.length) > Math.max(5, msgs.length * 0.25)) {
        // 清理旧的位置消息地图
        Object.values(locMsgMaps).forEach(m => { try { m.remove(); } catch(e) {} });
        locMsgMaps = {};
        knownMsgIds.clear();
        lastRenderedDay = '';
        lastSender = '';
        container.innerHTML = '';
    }

    msgs.forEach(m => {
        if (knownMsgIds.has(m.id)) return;
        knownMsgIds.add(m.id);

        // 日期分隔
        const day = fmtDay(m.ts);
        if (day !== lastRenderedDay) {
            lastRenderedDay = day;
            lastSender = '';
            const sep = document.createElement('div');
            sep.className = 'day-sep';
            sep.innerHTML = '<span>' + day + '</span>';
            container.appendChild(sep);
        }

        const isMe = m.senderPhone === me.phone;
        const showAvatar = lastSender !== m.senderPhone;
        lastSender = m.senderPhone;

        const wrap = document.createElement('div');
        wrap.className = 'msg-row ' + (isMe ? 'me' : 'other');
        wrap.dataset.msgId = m.id;
        wrap.dataset.msgTs = m.ts;

        if (!isMe) {
            const av = document.createElement('div');
            av.className = 'msg-avatar' + (showAvatar ? '' : ' transparent');
            av.innerHTML = avatarHtml(m.senderAvatar);
            av.style.cursor = 'pointer';
            av.onclick = (e) => { e.stopPropagation(); showUserProfile(m.senderPhone); };
            wrap.appendChild(av);
        }

        const bubbleCol = document.createElement('div');
        bubbleCol.className = 'msg-bubble-col';

        if (!isMe && showAvatar) {
            const name = document.createElement('div');
            name.className = 'msg-sender';
            name.textContent = m.senderNickname;
            bubbleCol.appendChild(name);
        }

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble ' + (isMe ? 'mine' : 'theirs');

        // 引用消息
        if (m.replyToId) {
            const quoted = msgCache.find(x => x.id === m.replyToId);
            if (quoted) {
                const q = document.createElement('div');
                q.className = 'msg-quote';
                const qName = quoted.senderPhone === me.phone ? '我' : (quoted.senderNickname || quoted.senderPhone);
                let qText = quoted.content || '';
                if (quoted.type === 'image') qText = '[图片]';
                else if (quoted.type === 'voice') qText = '[语音]';
                else if (quoted.type === 'file') qText = '[文件]';
                else if (quoted.type === 'location') qText = '[位置]';
                q.innerHTML = '<span class="q-name">' + escapeHtml(qName) + '</span>' + escapeHtml(qText);
                bubble.appendChild(q);
            }
        }

        const imgSrc = m.imageData || (m.type === 'image' ? m.content : null);
        if (m.type === 'image' && imgSrc) {
            const img = document.createElement('img');
            img.src = imgSrc;
            img.className = 'msg-image';
            img.onclick = () => showImageViewer(imgSrc);
            img.decoding = 'async';
            img.loading = 'lazy';
            img.onload = () => scanQRFromImage(img);
            bubble.appendChild(img);
        } else if (m.type === 'voice' && (m.voiceData || m.content)) {
            const voiceSrc = m.voiceData || m.content;
            const voice = document.createElement('div');
            voice.className = 'voice-msg';
            const playBtn = document.createElement('button');
            playBtn.className = 'voice-play-btn';
            playBtn.textContent = '▶️';
            playBtn.onclick = () => playVoice(voiceSrc, playBtn);
            const wave = document.createElement('div');
            wave.className = 'voice-wave';
            const bars = Math.min(20, Math.max(5, Math.round(m.voiceDuration || 1) * 2));
            for (let i = 0; i < bars; i++) {
                const bar = document.createElement('span');
                bar.style.height = (8 + Math.random() * 14) + 'px';
                wave.appendChild(bar);
            }
            const dur = document.createElement('span');
            dur.className = 'voice-duration';
            dur.textContent = (m.voiceDuration || 0) + '"';
            voice.appendChild(playBtn);
            voice.appendChild(wave);
            voice.appendChild(dur);
            bubble.appendChild(voice);
        } else if (m.type === 'file' && (m.fileData || m.content)) {
            const fileSrc = m.fileData || m.content;
            const file = document.createElement('div');
            file.className = 'file-msg';
            file.onclick = () => downloadFile(fileSrc, m.fileName);
            file.innerHTML = '<div class="file-icon">📄</div>' +
                '<div class="file-info"><div class="file-name">' + escapeHtml(m.fileName || '文件') + '</div>' +
                '<div class="file-size">' + formatFileSize(m.fileSize || 0) + '</div></div>';
            bubble.appendChild(file);
        } else if (m.type === 'location' && m.lat != null) {
            const loc = document.createElement('div');
            loc.className = 'loc-msg';
            const senderAv = m.senderAvatar?.startsWith('data:')
                ? '<img src="' + m.senderAvatar + '" style="width:100%;height:100%;object-fit:cover;">'
                : (m.senderAvatar || '📍');
            // 计算高德瓦片坐标，z=15（高德支持高缩放）
            const z = 15;
            const n = Math.pow(2, z);
            const x = Math.floor((m.lng + 180) / 360 * n);
            const latRad = m.lat * Math.PI / 180;
            const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1/Math.cos(latRad)) / Math.PI) / 2 * n);
            const tileUrl = 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=' + x + '&y=' + y + '&z=' + z;
            loc.innerHTML =
                '<div class="loc-map-preview" style="background-image:url(\'' + tileUrl + '\');">' +
                    '<div class="loc-map-pin"></div>' +
                '</div>' +
                '<div class="loc-map-avatar-float">' + senderAv + '</div>' +
                '<div class="loc-coord">' + m.lat.toFixed(4) + ', ' + m.lng.toFixed(4) + '</div>';
            loc.onclick = () => window.open('https://www.openstreetmap.org/?mlat=' + m.lat + '&mlon=' + m.lng + '#map=15/' + m.lat + '/' + m.lng, '_blank');
            bubble.appendChild(loc);
        } else {
            bubble.innerHTML = linkify(m.content || m.text || '');
        }

        // 撤回按钮（仅自己的消息，2分钟内）
        if (isMe && !m._failed && Date.now() - m.ts < 120000) {
            const recallBtn = document.createElement('button');
            recallBtn.className = 'recall-btn';
            recallBtn.textContent = '×';
            recallBtn.title = '撤回';
            recallBtn.onclick = (e) => { e.stopPropagation(); recallMessage(m.id); };
            wrap.style.position = 'relative';
            wrap.appendChild(recallBtn);
        }
        // 本地失败的消息：视觉区分 + 点击重发
        if (m._failed) {
            const failBadge = document.createElement('button');
            failBadge.className = 'recall-btn';
            failBadge.textContent = '!';
            failBadge.title = '发送失败，点击重发';
            failBadge.style.background = 'rgba(255,59,48,.18)';
            failBadge.style.color = '#FF3B30';
            failBadge.onclick = (e) => {
                e.stopPropagation();
                resendFailedMessage(m);
            };
            wrap.style.position = 'relative';
            wrap.appendChild(failBadge);
            bubble.style.opacity = '.7';
            bubble.style.filter = 'grayscale(.2)';
        }

        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        const time = document.createElement('span');
        time.className = 'msg-time';
        time.textContent = fmtTime(m.ts);
        meta.appendChild(time);

        // 自己的消息显示已读回执（失败消息不显示）
        if (isMe && !m._failed) {
            const check = document.createElement('span');
            const read = isMsgReadByOthers(m);
            check.className = 'msg-checks ' + (read ? 'read' : 'delivered');
            check.innerHTML = (typeof svgIcon === 'function') ? svgIcon(read ? 'checkDouble' : 'check', 14) : (read ? '✓✓' : '✓');
            meta.appendChild(check);
        }

        // 已编辑标记
        if (m.edited) {
            const editedTag = document.createElement('span');
            editedTag.className = 'msg-edited';
            editedTag.textContent = '(已编辑)';
            meta.appendChild(editedTag);
        }

        bubble.appendChild(meta);

        // reactions
        if (m.reactions && m.reactions.length > 0) {
            const rx = document.createElement('div');
            rx.className = 'msg-reactions';
            for (const r of m.reactions) {
                const rb = document.createElement('span');
                rb.className = 'msg-reaction';
                rb.textContent = r.emoji + ' ' + r.count;
                rb.onclick = (e) => { e.stopPropagation(); reactToMessage(m.id, r.emoji); };
                rx.appendChild(rb);
            }
            bubbleCol.appendChild(rx);
        }

        bubbleCol.appendChild(bubble);
        wrap.appendChild(bubbleCol);

        // 右键/长按菜单
        wrap.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showMsgContextMenu(e.clientX, e.clientY, m, isMe);
        });
        // 移动端长按
        let longPressTimer;
        wrap.addEventListener('touchstart', () => {
            longPressTimer = setTimeout(() => showMsgContextMenu(0, 0, m, isMe), 500);
        });
        wrap.addEventListener('touchend', () => clearTimeout(longPressTimer));
        wrap.addEventListener('touchmove', () => clearTimeout(longPressTimer));

        container.appendChild(wrap);
    });

    if (atBottom) {
        // 使用 rAF 确保布局后再滚动，避免输入时跳针
        requestAnimationFrame(() => {
            container.scrollTop = container.scrollHeight;
        });
    }
}

// 缓存在线列表 key -> DOM 引用，用于增量 diff
const _onlineCache = new Map();
const _onlineMobCache = new Map();

function renderOnlineList(rawOnlineMembers) {
    const onlineMembers = (rawOnlineMembers && typeof rawOnlineMembers === 'object') ? rawOnlineMembers : {};
    const list = $('#onlineList');
    if (!list) return;
    const mobList = $('#mobileOnlineList');
    const mobBar = $('#mobileOnlineBar');

    const ensured = { ...onlineMembers };
    if (group && me && me.phone && !ensured[me.phone]) {
        ensured[me.phone] = {
            nickname: me.nickname,
            avatar: me.avatar,
            owner: group.owner === me.phone || group.createdBy === me.phone
        };
    }

    const phones = Object.keys(ensured);
    const count = phones.length;
    if (mobBar) mobBar.hidden = count === 0;

    // 建立新集合，快速判重
    const targetSet = new Set(phones);

    // 1) 移除已不在在线集合中的 DOM
    for (const phone of _onlineCache.keys()) {
        if (!targetSet.has(phone)) {
            const node = _onlineCache.get(phone);
            if (node && node.parentNode) node.parentNode.removeChild(node);
            _onlineCache.delete(phone);
            const mobNode = _onlineMobCache.get(phone);
            if (mobNode && mobNode.parentNode) mobNode.parentNode.removeChild(mobNode);
            _onlineMobCache.delete(phone);
        }
    }

    // 2) 新增 / 更新 DOM：按 phones 顺序保证排序
    // 使用文档片段一次性插入，减少回流次数
    const frag = document.createDocumentFragment();
    const mobFrag = mobList ? document.createDocumentFragment() : null;
    let pendingNew = false;

    phones.forEach((phone) => {
        const info = ensured[phone] || {};
        const isOwner = group && (group.owner === phone || group.createdBy === phone || info.owner);
        const roleLabel = isOwner ? '群主' : '群成员';
        const avatarContent = info.avatar?.startsWith('data:')
            ? '<img src="' + info.avatar + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;">'
            : avatarHtml(info.avatar || info.nickname?.[0] || '😀');
        const nickHtml = escapeHtml(info.nickname || phoneMask(phone));

        // 侧边栏
        let item = _onlineCache.get(phone);
        if (item) {
            // 增量更新：只更新必要的 innerHTML（避免重建节点）
            const nameEl = item.querySelector('.oi-name');
            if (nameEl) nameEl.innerHTML = nickHtml +
                '<span class="oi-role ' + (isOwner ? 'owner' : 'member') + '">' + roleLabel + '</span>';
            const avEl = item.querySelector('.oi-avatar');
            if (avEl) avEl.innerHTML = avatarContent;
            // 同步"我"标签（与创建时保持同级，不重复）
            let meTag = item.querySelector(':scope > .oi-me');
            if (phone === me.phone && !meTag) {
                meTag = document.createElement('span');
                meTag.className = 'oi-me';
                meTag.textContent = '我';
                item.appendChild(meTag);
            } else if (phone !== me.phone && meTag) {
                meTag.remove();
            }
        } else {
            item = document.createElement('div');
            item.className = 'online-item';
            item.innerHTML = '<div class="oi-avatar">' + avatarContent + '</div>' +
                '<div class="oi-name">' + nickHtml +
                '<span class="oi-role ' + (isOwner ? 'owner' : 'member') + '">' + roleLabel + '</span></div>' +
                (phone === me.phone ? '<span class="oi-me">我</span>' : '');
            _onlineCache.set(phone, item);
            pendingNew = true;
        }
        frag.appendChild(item);

        // 手机端
        if (mobList) {
            let mob = _onlineMobCache.get(phone);
            if (mob) {
                const avEl = mob.querySelector('.mob-online-avatar');
                const nmEl = mob.querySelector('.mob-online-name');
                if (avEl) avEl.innerHTML = avatarContent;
                if (nmEl) nmEl.textContent = info.nickname || phoneMask(phone);
            } else {
                mob = document.createElement('div');
                mob.className = 'mob-online-item';
                mob.innerHTML = '<div class="mob-online-avatar">' + avatarContent + '</div>' +
                    '<div class="mob-online-name">' + nickHtml + '</div>';
                _onlineMobCache.set(phone, mob);
            }
            mobFrag.appendChild(mob);
        }
    });

    // 一次性挂载到文档：只触发 1 次回流（而非 phones 次）
    list.appendChild(frag);
    if (mobList) mobList.appendChild(mobFrag);
}

function replaceLocalMessage(localId, serverMsg) {
    const container = $('#messages');
    if (container) {
        const oldEl = container.querySelector('[data-msg-id="' + localId + '"]');
        if (oldEl) oldEl.remove();
    }
    knownMsgIds.delete(localId);
    const idx = msgCache.findIndex(m => m.id === localId);
    if (idx >= 0) {
        msgCache[idx] = serverMsg;
    } else {
        msgCache.push(serverMsg);
    }
    msgCache.sort((a, b) => a.ts - b.ts);
    // 个别替换：不需要整体重建
    renderMessages(msgCache, false);
}

function removeLocalMessage(localId) {
    const container = $('#messages');
    if (container) {
        const oldEl = container.querySelector('[data-msg-id="' + localId + '"]');
        if (oldEl) oldEl.remove();
    }
    knownMsgIds.delete(localId);
    const idx = msgCache.findIndex(m => m.id === localId);
    if (idx >= 0) msgCache.splice(idx, 1);
    // 个别删除：不整体重建；若偏差大 renderMessages 内部会自动完整重建
    renderMessages(msgCache, false);
}

async function sendMessage() {
    const input = $('#composerInput');
    if (!input || !group) return;
    const text = input.textContent.trim();
    if (!text) return;
    input.textContent = '';
    const sendBtn = $('#sendBtn');
    if (sendBtn) sendBtn.disabled = true;

    const localMsg = {
        id: 'local_' + uid(),
        senderPhone: me.phone,
        senderNickname: me.nickname,
        senderAvatar: me.avatar,
        type: 'text',
        content: text,
        text: text,
        ts: Date.now(),
        readBy: [me.phone],
        _local: true
    };
    if (replyToMsg) localMsg.replyToId = replyToMsg.id;
    msgCache.push(localMsg);
    msgCache.sort((a, b) => a.ts - b.ts);
    renderMessages(msgCache, false);
    // 输入框立即缩回到最小高度
    requestAnimationFrame(() => resizeComposer());

    try {
        const body = { text };
        if (replyToMsg) body.replyToId = replyToMsg.id;
        const data = await api('/groups/' + group.code + '/messages', { method: 'POST', body });
        replaceLocalMessage(localMsg.id, data.message);
        lastMsgCache[group.code] = data.message.ts;
        if (replyToMsg) { replyToMsg = null; $('#replyBar').hidden = true; }
    } catch (err) {
        // 不要真的删除：视觉上标记为"失败可重发"，更符合人类预期
        markLocalMessageFailed(localMsg.id, text);
        showToast((err && err.message ? err.message : '发送失败') + '，可点击!重发');
    } finally {
        if (sendBtn) sendBtn.disabled = false;
        // 让输入框重新获得焦点（回车发送之后不用再点一次）
        try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    }
}

function markLocalMessageFailed(localId, text) {
    const idx = msgCache.findIndex(m => m.id === localId);
    if (idx >= 0) {
        msgCache[idx]._failed = true;
        msgCache[idx]._rawText = text;
    }
    const container = $('#messages');
    const oldEl = container ? container.querySelector('[data-msg-id="' + localId + '"]') : null;
    // 简单重建整条消息以显示失败标记
    if (oldEl) knownMsgIds.delete(localId);
    if (oldEl) oldEl.remove();
    renderMessages(msgCache, false);
}

function resendFailedMessage(msgObj) {
    if (!msgObj || !group) return;
    const text = (msgObj._rawText || msgObj.text || msgObj.content || '').trim();
    if (!text) return;
    // 先把旧的失败条目从缓存和 DOM 去掉
    removeLocalMessage(msgObj.id);
    // 重新走标准发送流程（先插入本地新消息，再请求）
    const sendBtn = $('#sendBtn');
    if (sendBtn) sendBtn.disabled = true;
    const newLocal = {
        id: 'local_' + uid(),
        senderPhone: me.phone,
        senderNickname: me.nickname,
        senderAvatar: me.avatar,
        type: 'text',
        content: text,
        text: text,
        ts: Date.now(),
        readBy: [me.phone],
        _local: true
    };
    msgCache.push(newLocal);
    msgCache.sort((a, b) => a.ts - b.ts);
    renderMessages(msgCache, false);

    (async () => {
        try {
            const data = await api('/groups/' + group.code + '/messages', { method: 'POST', body: { text } });
            replaceLocalMessage(newLocal.id, data.message);
            lastMsgCache[group.code] = data.message.ts;
        } catch (err) {
            markLocalMessageFailed(newLocal.id, text);
            showToast((err && err.message ? err.message : '重发失败') + '，可点击!再次重发');
        } finally {
            if (sendBtn) sendBtn.disabled = false;
        }
    })();
}

async function sendImage(file) {
    compressImage(file, 1000, 1000, 0.7, async dataUrl => {
        const localMsg = {
            id: 'local_' + uid(),
            senderPhone: me.phone,
            senderNickname: me.nickname,
            senderAvatar: me.avatar,
            type: 'image',
            content: dataUrl,
            imageData: dataUrl,
            ts: Date.now(),
            readBy: [me.phone],
            _local: true
        };
        msgCache.push(localMsg);
        msgCache.sort((a, b) => a.ts - b.ts);
        renderMessages(msgCache);

        try {
            const mediaUrl = await uploadMedia(dataUrl, 'image/jpeg');
            const data = await api('/groups/' + group.code + '/messages', { method: 'POST', body: { type: 'image', mediaUrl } });
            replaceLocalMessage(localMsg.id, data.message);
            lastMsgCache[group.code] = data.message.ts;
        } catch (err) {
            removeLocalMessage(localMsg.id);
            showToast(err.message);
        }
    });
}

// ============ 轮询 ============
function startSSE() {
    stopSSE();
    if (!group || !token) return;
    try {
        const since = msgCache.length > 0 ? msgCache[msgCache.length - 1].ts : 0;
        const url = API + '/events?code=' + encodeURIComponent(group.code) + '&since=' + since + '&token=' + encodeURIComponent(token);
        sseSource = new EventSource(url);
        // 缩短默认重连时间到1秒
        sseSource.retryTime = 1000;

        sseSource.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg && msg.id) {
                    const existingIdx = msgCache.findIndex(m => m.id === msg.id);
                    if (existingIdx >= 0) {
                        msgCache[existingIdx] = msg;
                        renderMessages(msgCache);
                    } else {
                        const localIdx = msgCache.findIndex(m =>
                            m._local && m.senderPhone === msg.senderPhone &&
                            m.type === msg.type && Math.abs(m.ts - msg.ts) < 10000
                        );
                        if (localIdx >= 0) {
                            replaceLocalMessage(msgCache[localIdx].id, msg);
                        } else {
                            msgCache.push(msg);
                            msgCache.sort((a, b) => a.ts - b.ts);
                            renderMessages(msgCache);
                        }
                    }
                    lastMsgCache[group.code] = msg.ts;
                    updateReadReceipts();
                    if (notifyEnabled && document.visibilityState === 'hidden' && msg.senderPhone !== me.phone) {
                        showNotification(group.name + ' · ' + (msg.senderNickname || '新消息'), msg.content || '[新消息]', group.code);
                    }
                }
            } catch(err) {}
        };

        sseSource.addEventListener('presence', (e) => {
            try {
                const onlineMembers = JSON.parse(e.data);
                renderOnlineList(onlineMembers);
                const count = Object.keys(onlineMembers).length;
                $('#chatStatus').textContent = count + ' 人在线';
                $('#onlineCount').textContent = count;
            } catch(err) {}
        });

        sseSource.addEventListener('readstatus', (e) => {
            try {
                groupReadStatus = JSON.parse(e.data);
                updateReadReceipts();
            } catch(err) {}
        });

        sseSource.addEventListener('reconnect', (e) => {
            try {
                const ts = parseInt(e.data, 10);
                if (!isNaN(ts) && ts > (msgCache.length > 0 ? msgCache[msgCache.length - 1].ts : 0)) {
                    // 更新lastMsgCache避免丢失
                    lastMsgCache[group.code] = ts;
                }
            } catch(_) {}
            stopSSE();
            setTimeout(startSSE, 50);
        });

        sseSource.onerror = () => {
            stopSSE();
            sseFailedCount++;
            if (!token) return;
            if (sseFailedCount <= 5) {
                // 快速重连，前3次间隔短
                const delay = sseFailedCount <= 2 ? 300 : sseFailedCount === 3 ? 800 : 1500;
                setTimeout(startSSE, delay);
            } else {
                // 超过5次则回退轮询 + 30秒后重试SSE
                if (!msgPollTimer) {
                    msgPollTimer = setInterval(refreshGroupData, POLL_MSG);
                }
                setTimeout(() => {
                    sseFailedCount = 0;
                    if (group && token && activeView === 'chat') {
                        if (msgPollTimer) { clearInterval(msgPollTimer); msgPollTimer = null; }
                        startSSE();
                    }
                }, 30000);
            }
        };

        sseSource.onopen = () => {
            sseFailedCount = 0;
            if (msgPollTimer) {
                clearInterval(msgPollTimer);
                msgPollTimer = null;
            }
        };
    } catch(e) {
        msgPollTimer = setInterval(refreshGroupData, POLL_MSG);
    }
}

function stopSSE() {
    if (sseSource) {
        sseSource.close();
        sseSource = null;
    }
}

function startPolling() {
    stopPolling();
    // SSE负责消息推送，心跳负责在线状态
    startSSE();
    presPollTimer = setInterval(() => {
        api('/beat', { method: 'POST', body: { code: group ? group.code : null } }).catch(() => {});
        if (activeView === 'users') renderUsers();
    }, POLL_PRES);
    // 立即发送一次心跳
    api('/beat', { method: 'POST', body: { code: group ? group.code : null } }).catch(() => {});
}

function stopPolling() {
    stopSSE();
    if (msgPollTimer) { clearInterval(msgPollTimer); msgPollTimer = null; }
    if (presPollTimer) { clearInterval(presPollTimer); presPollTimer = null; }
}

// ============ 用户列表（乐观渲染：先显示本地快照再后台刷新） ============
function _renderUsersInternal(data, fromCache) {
    const list = $('#usersList');
    if (!list) return;
    list.innerHTML = '';
    const snapHint = fromCache && fromCache.ts
        ? '<span style="opacity:.6;margin-left:6px;font-size:12px;">（缓存 ' + fmtTime(fromCache.ts/1000) + '，刷新中…）</span>'
        : '';
    $('#usersSubtitle').innerHTML = '共 ' + data.users.length + ' 位用户' + snapHint;

    data.users.forEach(u => {
        const card = document.createElement('div');
        card.className = 'user-card';
        if (isAdmin() && me && u.phone !== me.phone) card.classList.add('clickable');

        const onlineDot = u.online ? '<span class="uc-dot online"></span>' : '<span class="uc-dot offline"></span>';
        const statusText = u.online ? '在线' : '上次在线 ' + fmtLastSeen(u.lastSeen);
        const adminIcon = (typeof svgIcon === 'function') ? svgIcon('crown', 12) : '👑';
        const phoneIcon = (typeof svgIcon === 'function') ? svgIcon('phone', 12) : '📱';
        const chatIcon = (typeof svgIcon === 'function') ? svgIcon('chat', 12) : '💬';
        const adminTag = u.isAdmin ? '<span class="uc-admin-tag">' + adminIcon + ' 管理员</span>' : '';
        const meTag = (me && u.phone === me.phone) ? '<span class="uc-me-tag">（我）</span>' : '';

        card.innerHTML =
            '<div class="uc-avatar">' + avatarHtml(u.avatar) + onlineDot + '</div>' +
            '<div class="uc-info">' +
                '<div class="uc-name">' + escapeHtml(u.nickname) + meTag + adminTag + '</div>' +
                '<div class="uc-meta">' + phoneIcon + ' ' + phoneMask(u.phone) + ' · ' + chatIcon + ' ' + (u.joinedGroups?.length || 0) + ' 个群聊</div>' +
                '<div class="uc-status">' + statusText + '</div>' +
            '</div>' +
            (isAdmin() && me && u.phone !== me.phone ? '<div class="uc-arrow">›</div>' : '');

        if (isAdmin() && me && u.phone !== me.phone) {
            card.onclick = () => openAdminPanel(u);
        }
        list.appendChild(card);
    });
}
async function renderUsers() {
    // 0ms 乐观渲染：有本地快照则直接显示
    const snap = apiSnapshot('/users');
    let renderedFromCache = false;
    if (snap && snap.data && Array.isArray(snap.data.users)) {
        try {
            _renderUsersInternal(snap.data, snap);
            renderedFromCache = true;
        } catch(e) { renderedFromCache = false; }
    }
    try {
        const data = await api('/users');
        _renderUsersInternal(data, null);
    } catch (err) {
        console.error('加载用户列表失败:', err);
        if (!renderedFromCache) {
            $('#usersSubtitle').textContent = '加载失败：' + (err.message || '未知错误');
            const list = $('#usersList');
            if (list) list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--ink-3);">加载失败，请刷新重试</div>';
        } else {
            $('#usersSubtitle').textContent = ($('#usersSubtitle').textContent || '').replace(/（缓存[^）]*，刷新中…）/, '（刷新失败，显示缓存）');
        }
    }
}

// ============ 我的群聊（乐观渲染：先显示本地快照再后台刷新） ============
function _renderMyGroupsInternal(data, fromCache) {
    const list = $('#myGroupsList');
    if (!list) return;
    list.innerHTML = '';
    if (data.groups.length === 0) {
        list.innerHTML = '<div class="mg-empty">还没有加入任何群聊</div>';
        return;
    }
    // 给 mg-head 加个小提示（如果存在容器）
    const hintEl = document.getElementById('myGroupsCacheHint');
    if (hintEl) {
        if (fromCache && fromCache.ts) hintEl.innerHTML = '缓存 ' + fmtTime(fromCache.ts/1000) + '，刷新中…';
        else hintEl.innerHTML = '';
    }
    data.groups.forEach(g => {
        const item = document.createElement('div');
        item.className = 'mg-item' + (g.pinned ? ' pinned' : '') + (g.muted ? ' muted' : '');
        item.innerHTML =
            '<div class="mg-avatar">' + g.avatar + '</div>' +
            '<div class="mg-info">' +
                '<div class="mg-name">' + escapeHtml(g.name) + (g.isOwner ? ' 👑' : '') + (g.pinned ? ' 📌' : '') + (g.muted ? ' 🔕' : '') + '</div>' +
                '<div class="mg-code">邀请码：' + g.code + '</div>' +
            '</div>' +
            '<div class="mg-time">' + fmtDateTime(g.lastMsgTs) + '</div>';
        item.onclick = () => {
            group = { code: g.code, name: g.name, avatar: g.avatar, owner: g.owner };
            switchView('chat');
        };
        list.appendChild(item);
    });
}
async function renderMyGroups() {
    const snap = apiSnapshot('/my-groups');
    let renderedFromCache = false;
    if (snap && snap.data && Array.isArray(snap.data.groups)) {
        try { _renderMyGroupsInternal(snap.data, snap); renderedFromCache = true; } catch(e) { renderedFromCache = false; }
    }
    try {
        const data = await api('/my-groups');
        _renderMyGroupsInternal(data, null);
    } catch (err) {
        console.error('加载群聊列表失败:', err);
        if (!renderedFromCache) {
            const list = $('#myGroupsList');
            if (list) list.innerHTML = '<div class="mg-empty" style="color:var(--ink-3)">加载失败，请刷新重试</div>';
        } else {
            const hintEl = document.getElementById('myGroupsCacheHint');
            if (hintEl) hintEl.innerHTML = '刷新失败，显示缓存';
        }
    }
}

// ============ 群设置菜单 ============
function initGroupMenu() {
    const menu = $('#groupMenu');
    $('#groupMenuBtn').onclick = e => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
    };
    document.addEventListener('click', e => {
        if (!menu.hidden && !menu.contains(e.target) && e.target.id !== 'groupMenuBtn') {
            menu.hidden = true;
        }
    });

    $('#gmCopyCode').onclick = () => {
        if (!group) return;
        navigator.clipboard.writeText(group.code).then(() => showToast('邀请码已复制：' + group.code));
        menu.hidden = true;
    };

    $('#gmLeaveGroup').onclick = () => {
        menu.hidden = true;
        showConfirm('leave', '退出群聊', '确定要退出「' + group.name + '」吗？', async () => {
            try {
                await api('/groups/' + group.code + '/leave', { method: 'POST' });
                apiInvalidate(['/my-groups', '/me']);
                showToast('已退出群聊');
                me = (await api('/me')).user;
                exitGroup();
            } catch (err) { showToast(err.message); }
        });
    };

    $('#gmDismissGroup').onclick = () => {
        menu.hidden = true;
        showConfirm('dismiss', '注销群聊', '确定要注销「' + group.name + '」吗？所有消息和成员关联将被清除，此操作不可恢复。', async () => {
            try {
                await api('/groups/' + group.code + '/delete', { method: 'DELETE' });
                apiInvalidate(['/my-groups', '/me']);
                showToast('群聊已注销');
                me = (await api('/me')).user;
                exitGroup();
            } catch (err) { showToast(err.message); }
        });
    };
}

// ============ 管理员面板 ============
async function openAdminPanel(u) {
    adminTargetUser = u;
    try {
        const data = await api('/admin/users/' + u.phone + '/groups');
        $('#apAvatar').innerHTML = avatarHtml(u.avatar);
        $('#apName').textContent = u.nickname;
        $('#apPhone').textContent = phoneMask(u.phone);
        $('#apEmail').textContent = (data.user && data.user.email) || u.email || '无';
        $('#apGroupCount').textContent = (data.groups ? data.groups.length : 0) + ' 个';
        $('#apCreated').textContent = fmtDateTime((data.user && data.user.createdAt) || u.createdAt || Date.now());

        const list = $('#apGroups');
        list.innerHTML = '';
        const groups = Array.isArray(data.groups) ? data.groups : [];
        if (groups.length === 0) {
            list.innerHTML = '<div class="ap-empty">该用户暂无群聊</div>';
        } else {
            groups.forEach(g => {
                const item = document.createElement('div');
                item.className = 'ap-group';
                item.innerHTML =
                    '<div class="ap-group-info">' +
                        '<div class="ap-group-avatar">' + g.avatar + '</div>' +
                        '<div class="ap-group-meta">' +
                            '<div class="ap-group-name">' + escapeHtml(g.name) + '</div>' +
                            '<div class="ap-group-code">邀请码：' + g.code + ' · ' + g.msgCount + ' 条消息 · 最后 ' + fmtDateTime(g.lastMsgTs) + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="ap-group-actions">' +
                        '<button class="ap-btn-view">查看消息</button>' +
                        '<button class="ap-btn-clear">清空消息</button>' +
                        '<button class="ap-btn-delete">删除群聊</button>' +
                    '</div>';
                item.querySelector('.ap-btn-view').onclick = () => openMsgViewer(g);
                item.querySelector('.ap-btn-clear').onclick = () => {
                    showConfirm('🗑️', '清空消息', '确定要清空「' + g.name + '」的所有聊天记录吗？', async () => {
                        await api('/groups/' + g.code + '/messages', { method: 'DELETE' });
                        forceFullReload = true;
                        msgCache = [];
                        showToast('消息已清空');
                        openAdminPanel(u);
                    });
                };
                item.querySelector('.ap-btn-delete').onclick = () => {
                    showConfirm('dismiss', '删除群聊', '确定要删除群聊「' + g.name + '」吗？所有消息和成员关联将被清除。', async () => {
                        await api('/groups/' + g.code + '/delete', { method: 'DELETE' });
                        apiInvalidate(['/my-groups', '/me', '/users']);
                        showToast('群聊已删除');
                        openAdminPanel(u);
                    });
                };
                list.appendChild(item);
            });
        }

        // 管理员注销用户按钮（不能注销自己）
        const existingDel = $('#apDeleteUserBtn');
        if (existingDel) existingDel.remove();
        if (u.phone !== me.phone) {
            const delBtn = document.createElement('button');
            delBtn.id = 'apDeleteUserBtn';
            delBtn.className = 'admin-delete-user-btn';
            delBtn.textContent = '🗑️ 注销该用户';
            delBtn.onclick = () => adminDeleteUser(u.phone);
            list.parentElement.appendChild(delBtn);
        }

        $('#adminPanel').hidden = false;
    } catch (err) {
        showToast(err.message);
    }
}

async function openMsgViewer(g) {
    try {
        const data = await api('/groups/' + g.code);
        $('#amAvatar').textContent = g.avatar;
        $('#amName').textContent = g.name;
        $('#amCode').textContent = '邀请码：' + g.code;

        const container = $('#adminMessages');
        container.innerHTML = '';
        let day = '';
        if (data.messages.length === 0) {
            container.innerHTML = '<div class="ap-empty">该群暂无消息</div>';
        } else {
            data.messages.forEach(m => {
                const d = fmtDay(m.ts);
                if (d !== day) {
                    day = d;
                    const sep = document.createElement('div');
                    sep.className = 'day-sep';
                    sep.innerHTML = '<span>' + d + '</span>';
                    container.appendChild(sep);
                }
                const isMe = m.senderPhone === me.phone;
                const wrap = document.createElement('div');
                wrap.className = 'msg-row ' + (isMe ? 'me' : 'other');
                if (!isMe) {
                    wrap.innerHTML += '<div class="msg-avatar">' + avatarHtml(m.senderAvatar) + '</div>';
                }
                const col = document.createElement('div');
                col.className = 'msg-bubble-col';
                if (!isMe) {
                    col.innerHTML += '<div class="msg-sender">' + escapeHtml(m.senderNickname) + '</div>';
                }
                const bubble = document.createElement('div');
                bubble.className = 'msg-bubble ' + (isMe ? 'mine' : 'theirs');
                const aImgSrc = m.imageData || (m.type === 'image' ? m.content : null);
                if (m.type === 'image' && aImgSrc) {
                    bubble.innerHTML = '<img src="' + aImgSrc + '" class="msg-image" onclick="event.stopPropagation()">';
                } else if (m.type === 'voice' && (m.voiceData || m.content)) {
                    bubble.innerHTML = '🎵 语音 ' + (m.voiceDuration || 0) + '"';
                } else if (m.type === 'file' && (m.fileData || m.content)) {
                    bubble.innerHTML = '📄 ' + escapeHtml(m.fileName || '文件');
                } else {
                    bubble.innerHTML = linkify(m.content || m.text || '');
                }
                bubble.innerHTML += '<span class="msg-time">' + fmtTime(m.ts) + '</span>';
                col.appendChild(bubble);
                wrap.appendChild(col);
                container.appendChild(wrap);
            });
        }
        $('#adminMsgViewer').hidden = false;
    } catch (err) {
        showToast(err.message);
    }
}

// ============ 确认对话框 ============
function showConfirm(icon, title, msg, cb) {
    confirmCallback = cb;
    const iconEl = $('#confirmIcon');
    if (typeof svgIcon === 'function' && ICONS && ICONS[icon]) {
        iconEl.innerHTML = svgIcon(icon, 32);
    } else {
        iconEl.textContent = icon;
    }
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = msg;
    $('#confirmDialog').hidden = false;
}

function initConfirmDialog() {
    $('#confirmCancel').onclick = () => { $('#confirmDialog').hidden = true; confirmCallback = null; };
    $('#confirmOk').onclick = () => {
        $('#confirmDialog').hidden = true;
        if (confirmCallback) confirmCallback();
        confirmCallback = null;
    };
}

// ============ 注销账号 ============
function deleteAccount() {
    showConfirm('trash', '注销账号', '确定要注销账号吗？你的所有数据将被永久删除，此操作不可恢复。', async () => {
        try {
            await api('/delete-account', { method: 'POST' });
            token = '';
            localStorage.removeItem('stating_token');
            showAuth();
            showToast('账号已注销');
        } catch (err) {
            showToast(err.message);
        }
    });
}

// ============ 图片查看器 ============
function showImageViewer(src) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out;backdrop-filter:blur(10px);';
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'max-width:95%;max-height:90%;border-radius:12px;';
    overlay.appendChild(img);
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '💾 保存图片';
    saveBtn.style.cssText = 'position:absolute;bottom:30px;left:50%;transform:translateX(-50%);padding:12px 28px;border-radius:999px;background:rgba(0,0,0,.6);backdrop-filter:blur(10px);color:#fff;border:1px solid rgba(255,255,255,.2);font-size:15px;font-weight:600;cursor:pointer;z-index:10;';
    saveBtn.onclick = (e) => { e.stopPropagation(); saveImage(src); };
    overlay.appendChild(saveBtn);
    overlay.onclick = () => overlay.remove();
    document.body.appendChild(overlay);
}

// ============ Emoji 选择器 ============
function initEmojiPicker() {
    const grid = $('#emojiGrid');
    EMOJIS.forEach(e => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'emoji-btn';
        btn.textContent = e;
        btn.onclick = () => {
            const input = $('#composerInput');
            input.textContent += e;
            $('#emojiPanel').hidden = true;
            input.focus();
            $('#sendBtn').disabled = false;
        };
        grid.appendChild(btn);
    });
}

// ============ OTP 输入 ============
function initOtpInputs() {
    const inputs = $$('#otpInputs .otp-box');
    inputs.forEach((inp, i) => {
        inp.addEventListener('input', e => {
            const val = e.target.value;
            if (val && i < inputs.length - 1) inputs[i + 1].focus();
            if (val.length > 1) e.target.value = val.slice(-1);
            $('#inviteError').hidden = true;
        });
        inp.addEventListener('keydown', e => {
            if (e.key === 'Backspace' && !e.target.value && i > 0) inputs[i - 1].focus();
            if (e.key === 'Enter') handleJoinGroup();
            if (e.key === 'ArrowLeft' && i > 0) inputs[i - 1].focus();
            if (e.key === 'ArrowRight' && i < inputs.length - 1) inputs[i + 1].focus();
        });
        inp.addEventListener('paste', e => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData('text').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
            text.split('').forEach((c, j) => { if (inputs[j]) inputs[j].value = c; });
            if (text.length === 6) handleJoinGroup();
        });
    });
}

// ============ 管理员密钥输入 ============
function initAdminKeyInputs() {
    const inputs = $$('#adminKeyInputs .otp-box');
    inputs.forEach((inp, i) => {
        inp.addEventListener('input', e => {
            const val = e.target.value.replace(/[^0-9]/g, '');
            e.target.value = val;
            if (val && i < inputs.length - 1) inputs[i + 1].focus();
            $('#adminKeyError').textContent = '';
        });
        inp.addEventListener('keydown', e => {
            if (e.key === 'Backspace' && !e.target.value && i > 0) inputs[i - 1].focus();
            if (e.key === 'Enter') handleAdminKeySubmit();
            if (e.key === 'ArrowLeft' && i > 0) inputs[i - 1].focus();
            if (e.key === 'ArrowRight' && i < inputs.length - 1) inputs[i + 1].focus();
        });
        inp.addEventListener('paste', e => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '').slice(0, 6);
            text.split('').forEach((c, j) => { if (inputs[j]) inputs[j].value = c; });
            if (text.length === 6) handleAdminKeySubmit();
        });
    });
}

// ============ 初始化 ============
// SVG图标注入：将所有[data-icon]元素替换为内联SVG
function injectIcons(root = document) {
    if (typeof svgIcon !== 'function') return;
    root.querySelectorAll('[data-icon]').forEach(el => {
        if (el.dataset.iconInjected) return;
        const name = el.dataset.icon;
        const size = parseInt(el.dataset.iconSize) || 20;
        el.innerHTML = svgIcon(name, size).replace(/^<span[^>]*>|<\/span>$/g, '');
        el.dataset.iconInjected = '1';
        el.style.display = 'inline-flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
    });
}

function init() {
    injectIcons();
    initAvatars();
    initEmojiPicker();
    initOtpInputs();
    initAdminKeyInputs();
    initGroupMenu();
    initConfirmDialog();

    // Auth tabs
    $$('.auth-tab').forEach(tab => {
        tab.onclick = () => {
            $$('.auth-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            $$('.auth-form').forEach(f => f.classList.remove('active'));
            $('#' + tab.dataset.tab + 'Form').classList.add('active');
            $('#authError').textContent = '';
        };
    });

    // Forms
    $('#loginForm').onsubmit = handleLogin;
    $('#registerForm').onsubmit = handleRegister;

    // Nav
    $$('.nav-item').forEach(btn => {
        btn.onclick = () => switchView(btn.dataset.view);
    });
    $$('[data-goto]').forEach(btn => {
        btn.onclick = () => switchView(btn.dataset.goto);
    });

    // Chat gate
    $('#inviteSubmit').onclick = handleJoinGroup;
    $('#showCreateGroup').onclick = () => { $('#inviteCard').hidden = true; $('#createGroupCard').hidden = false; };
    $('#backToInvite').onclick = () => { $('#createGroupCard').hidden = true; $('#inviteCard').hidden = false; };
    $('#createGroupBtn').onclick = handleCreateGroup;

    // Chat room
    $('#backToGate').onclick = exitGroup;
    $('#sendBtn').onclick = sendMessage;
    $('#composerInput').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    $('#composerInput').addEventListener('input', () => {
        const val = $('#composerInput').textContent;
        const trimmed = (val || '').trim();
        $('#sendBtn').disabled = !trimmed;
        // rAF 节流：避免每个字都触发布局
        scheduleResizeComposer();
    });
    // 初始化 composer 高度（粘贴/刷新后内容可能有字）
    scheduleResizeComposer();

    // iOS 26 液态玻璃按压态：顶栏 / 聊天顶栏 / 胶囊级玻璃
    bindGlassPressState($('.topbar'));
    bindGlassPressState($('.chat-header'));
    // Nav item 的按压态（选中时的流动高光已在 CSS，这里加按下缩放手感）
    $$('.nav-item').forEach(el => bindGlassPressState(el, { class: 'is-pressed', scaleOnPress: false }));

    // window resize 节流（避免移动端缩放/PC 拉窗口触发大量重布局）
    window.addEventListener('resize', throttle(() => {
        scheduleResizeComposer();
    }, 120), { passive: true });

    // API 内存缓存定期清理（防止长开内存泄漏）
    setInterval(() => {
        if (typeof _apiMemCache !== 'undefined' && _apiMemCache.clear) {
            try { _apiMemCache.clear(); } catch (e) {}
        }
    }, 1000 * 60 * 5); // 每 5 分钟清一次

    // Emoji
    $('#emojiBtn').onclick = e => {
        e.stopPropagation();
        $('#emojiPanel').hidden = !$('#emojiPanel').hidden;
    };
    document.addEventListener('click', e => {
        if (!e.target.closest('.emoji-panel') && !e.target.closest('#emojiBtn')) {
            $('#emojiPanel').hidden = true;
        }
    });

    // Image upload (通过多功能键触发)
    $('#imgInput').onchange = e => {
        const file = e.target.files[0];
        if (file) sendImage(file);
        e.target.value = '';
    };

    // Online panel toggle
    $('#onlineToggle').onclick = () => $('#onlinePanel').classList.toggle('open');

    // Admin panel
    $('#apBack').onclick = () => $('#adminPanel').hidden = true;
    $('#apClose').onclick = () => $('#adminPanel').hidden = true;
    $('#amBack').onclick = () => { $('#adminMsgViewer').hidden = true; };
    $('#amClose').onclick = () => { $('#adminMsgViewer').hidden = true; };

    // Profile
    $('#logoutBtn').onclick = logout;
    $('#deleteAccountBtn').onclick = deleteAccount;
    $('#darkModeToggle').onchange = e => toggleDarkMode(e.target.checked);
    $('#notifyToggle').onchange = e => toggleNotify(e.target.checked);
    $('#editNickBtn').onclick = () => startEditProfile('nickname');
    $('#editEmailBtn').onclick = () => startEditProfile('email');
    $('#editAvatarBtn').onclick = () => startEditProfile('avatar');
    $('#avatarUploadInput').onchange = e => handleAvatarUpload(e.target.files[0]);
    $('#qrResultClose').onclick = () => $('#qrResultDialog').hidden = true;
    $('#qrResultDialog').onclick = e => { if (e.target.id === 'qrResultDialog') $('#qrResultDialog').hidden = true; };
    $('#lightboxSaveBtn').onclick = () => saveImage($('#lightboxImg').src);

    // 多功能+键
    if ($('#multiPlusBtn')) $('#multiPlusBtn').onclick = toggleMultiMenu;
    if ($('#mmImage')) $('#mmImage').onclick = () => { closeMultiMenu(); $('#imgInput').click(); };
    if ($('#mmFile')) $('#mmFile').onclick = () => { closeMultiMenu(); $('#fileInput').click(); };
    if ($('#mmVoice')) $('#mmVoice').onclick = () => { closeMultiMenu(); toggleRecording(); };
    if ($('#recStopBtn')) $('#recStopBtn').onclick = () => toggleRecording();
    if ($('#recCancelBtn')) $('#recCancelBtn').onclick = () => cancelRecording();
    if ($('#fbReplyCancel')) $('#fbReplyCancel').onclick = () => closeFbReplyModal();
    if ($('#fbReplySubmit')) $('#fbReplySubmit').onclick = () => { if (replyingFbId) submitFeedbackReply(replyingFbId, $('#fbReplyInput').value); };
    if ($('#mmVoiceCall')) $('#mmVoiceCall').onclick = () => { closeMultiMenu(); startCall('voice'); };
    if ($('#mmVideoCall')) $('#mmVideoCall').onclick = () => { closeMultiMenu(); startCall('video'); };
    if ($('#fileInput')) $('#fileInput').onchange = e => handleFileSend(e.target.files[0]);

    // 长按发送键=位置菜单
    if ($('#sendBtn')) setupSendLongPress();
    if ($('#locSendOnce')) $('#locSendOnce').onclick = () => { closeLocMenu(); sendLocationOnce(); };
    if ($('#locShareLive')) $('#locShareLive').onclick = () => { closeLocMenu(); startLiveLocation(); };

    // 位置共享
    if ($('#lsbJoinBtn')) $('#lsbJoinBtn').onclick = toggleJoinLocation;
    if ($('#lsbCloseBtn')) $('#lsbCloseBtn').onclick = stopLiveLocation;

    // 博采
    if ($$('.fb-star').length) setupFeedbackStars();
    if ($('#fbSubmitBtn')) $('#fbSubmitBtn').onclick = submitFeedback;

    // 通话
    if ($('#callHangupBtn')) $('#callHangupBtn').onclick = endCall;
    if ($('#callMuteBtn')) $('#callMuteBtn').onclick = toggleCallMute;
    if ($('#callCameraBtn')) $('#callCameraBtn').onclick = toggleCallCamera;
    if ($('#callSpeakerBtn')) $('#callSpeakerBtn').onclick = toggleCallSpeaker;
    if ($('#callPipBtn')) $('#callPipBtn').onclick = toggleCallPip;
    if ($('#callBannerJoin')) $('#callBannerJoin').onclick = () => { if (currentCallData) joinCall(currentCallData); };
    if ($('#callBanner')) $('#callBanner').onclick = (e) => { if (e.target.id !== 'callBannerJoin' && currentCallData) joinCall(currentCallData); };

    // 首页磁贴按钮
    $('#devTileBtn').onclick = () => window.open('https://wzy03.pages.dev', '_blank');
    $('#imsgTileBtn').onclick = showImsgInfo;
    $('#iosTileBtn').onclick = () => window.open('https://developer.apple.com', '_blank');
    $('#imsgInfoClose').onclick = hideImsgInfo;
    $('#imsgInfoDialog').onclick = e => { if (e.target.id === 'imsgInfoDialog') hideImsgInfo(); };

    // Admin key
    $('#adminKeySubmit').onclick = handleAdminKeySubmit;
    $('#adminKeyCancel').onclick = cancelAdminKey;

    // Check session
    checkSession();
}

// ============ 博采反馈 ============
let fbRating = 0;

function setupFeedbackStars() {
    $$('.fb-star').forEach(s => {
        s.onclick = () => {
            fbRating = parseInt(s.dataset.v);
            $$('.fb-star').forEach((st, i) => {
                st.classList.toggle('active', i < fbRating);
                st.textContent = i < fbRating ? '★' : '☆';
            });
        };
    });
}

async function submitFeedback() {
    const text = $('#fbInput').value.trim();
    if (!text) { showToast('请输入建议内容'); return; }
    if (fbRating === 0) { showToast('请选择评分'); return; }
    try {
        // 提交反馈后清空对应缓存（下一次 loadFeedback 必走网络）
        _apiMemCache.delete('G:/feedback');
        const snaps = _getLsSnapshots();
        if (snaps && snaps['/feedback']) delete snaps['/feedback'];
        try { localStorage.setItem(LS_SNAPSHOT_KEY, JSON.stringify(snaps)); } catch(e){}
        await api('/feedback', { method: 'POST', body: { content: text, rating: fbRating } });
        showToast('提交成功，感谢反馈！');
        $('#fbInput').value = '';
        fbRating = 0;
        $$('.fb-star').forEach(st => { st.classList.remove('active'); st.textContent = '☆'; });
        await loadFeedback();
    } catch(e) { showToast(e.message); }
}

// 反馈列表渲染（共享给快照渲染/网络渲染用）
function _renderFeedbackInternal(data, fromCache) {
    const list = $('#fbList');
    if (!list) return;
    const countHint = fromCache && fromCache.ts
        ? ' <span style="opacity:.55;font-size:12px;">（缓存 ' + fmtTime(fromCache.ts/1000) + '，刷新中…）</span>'
        : '';
    const countEl = $('#fbCount');
    if (countEl) countEl.innerHTML = (data.list?.length || 0) + ' 条' + countHint;

    if (!Array.isArray(data.list) || data.list.length === 0) {
        list.innerHTML = '<div class="fb-empty">还没有建议，来做第一个吧 ✨</div>';
    } else {
        list.innerHTML = data.list.map(f => {
            try {
                const av = (f.avatar && typeof f.avatar === 'string' && f.avatar.startsWith('data:'))
                    ? '<img src="' + f.avatar + '" alt="">'
                    : (f.avatar || '😀');
                const repliesHtml = Array.isArray(f.replies) ? f.replies.map(r =>
                    '<div class="fb-reply"><div class="fb-reply-avatar">👨‍💼</div><div class="fb-reply-body"><div class="fb-reply-name">管理员回复<span class="fb-reply-time">' + fmtTime(r.ts || Date.now()) + '</span></div><div class="fb-reply-text">' + escapeHtml(r.content || '') + '</div></div></div>'
                ).join('') : '';
                const replyBtn = (me && isAdmin()) ? '<button class="fb-reply-btn" data-id="' + f.id + '">回复</button>' : '';
                return '<div class="fb-item">' +
                    '<div class="fb-item-avatar">' + av + '</div>' +
                    '<div class="fb-item-body">' +
                        '<div class="fb-item-top">' +
                            '<span class="fb-item-name">' + escapeHtml(f.nickname || '匿名') + '</span>' +
                            '<span class="fb-item-rating">' + '★'.repeat(f.rating || 0) + '☆'.repeat(5-(f.rating||0)) + '</span>' +
                            '<span class="fb-item-time">' + fmtTime(f.ts) + '</span>' +
                        '</div>' +
                        '<div class="fb-item-text">' + escapeHtml(f.content || '') + '</div>' +
                        repliesHtml + replyBtn +
                    '</div></div>';
            } catch(e) {
                return '<div class="fb-item"><div class="fb-item-avatar">😀</div><div class="fb-item-body"><div class="fb-item-text">（加载失败）</div></div></div>';
            }
        }).join('');
        list.querySelectorAll('.fb-reply-btn').forEach(btn => {
            btn.onclick = () => showFeedbackReply(btn.dataset.id);
        });
    }
    // 管理员面板
    const adminPanel = $('#fbAdminPanel');
    if (adminPanel) {
        if (me && isAdmin()) {
            adminPanel.hidden = false;
            const avgEl = $('#fbAvgRating');
            if (avgEl) avgEl.textContent = data.avg || 0;
            const totalEl = $('#fbTotalCount');
            if (totalEl) totalEl.textContent = data.list?.length || 0;
            const adminList = $('#fbAdminList');
            if (adminList) adminList.innerHTML = data.list.map(f =>
                '<div class="fb-item">' +
                    '<div class="fb-item-avatar">' + (f.avatar?.startsWith('data:') ? '<img src="'+f.avatar+'">' : (f.avatar||'😀')) + '</div>' +
                    '<div class="fb-item-body">' +
                        '<div class="fb-item-top"><span class="fb-item-name">' + escapeHtml(f.nickname) + '</span>' +
                        '<span class="fb-item-rating">★' + (f.rating || 0) + '</span>' +
                        '<span class="fb-item-time">' + fmtTime(f.ts) + '</span></div>' +
                        '<div class="fb-item-text">' + escapeHtml(f.content || '') + '</div>' +
                    '</div></div>'
            ).join('');
        } else {
            adminPanel.hidden = true;
        }
    }
}

async function loadFeedback() {
    // 0ms 乐观渲染：先上本地缓存
    const snap = apiSnapshot('/feedback');
    let renderedFromCache = false;
    if (snap && snap.data && Array.isArray(snap.data.list)) {
        try { _renderFeedbackInternal(snap.data, snap); renderedFromCache = true; } catch(e) { renderedFromCache = false; }
    }
    try {
        const data = await api('/feedback');
        _renderFeedbackInternal(data, null);
    } catch(e) {
        if (!renderedFromCache) showToast(e.message);
        else {
            const countEl = $('#fbCount');
            if (countEl) countEl.innerHTML = (countEl.innerHTML || '').replace(/（缓存[^）]*，刷新中…）/, '（刷新失败，显示缓存）');
        }
    }
}

// 反馈回复 - 使用网页内对话框
let replyingFbId = null;
function showFeedbackReply(fbId) {
    replyingFbId = fbId;
    const modal = $('#fbReplyModal');
    if (modal) {
        modal.hidden = false;
        $('#fbReplyInput').value = '';
        $('#fbReplyInput').focus();
    } else {
        // fallback
        const content = prompt('请输入管理员回复内容：');
        if (!content) return;
        submitFeedbackReply(fbId, content);
    }
}
function closeFbReplyModal() {
    const modal = $('#fbReplyModal');
    if (modal) modal.hidden = true;
    replyingFbId = null;
}
function submitFeedbackReply(fbId, content) {
    if (!content || !content.trim()) { showToast('回复内容不能为空'); return; }
    api('/feedback/' + fbId + '/reply', { method: 'POST', body: { content: content.trim() } })
        .then(() => {
            apiInvalidate('/feedback');
            showToast('回复成功'); closeFbReplyModal(); loadFeedback();
        })
        .catch(e => showToast(e.message));
}

// ============ 多功能+键 ============
function toggleMultiMenu() {
    const menu = $('#multiMenu');
    const btn = $('#multiPlusBtn');
    const isOpen = !menu.hidden;
    closeMultiMenu();
    if (!isOpen) {
        menu.hidden = false;
        btn.classList.add('open');
    }
}
function closeMultiMenu() {
    const m = $('#multiMenu'); if (m) m.hidden = true;
    const b = $('#multiPlusBtn'); if (b) b.classList.remove('open');
}
function closeLocMenu() { const m = $('#locMenu'); if (m) m.hidden = true; }
document.addEventListener('click', e => {
    if (!e.target.closest('.multi-btn-wrap') && !e.target.closest('#multiMenu')) closeMultiMenu();
    if (!e.target.closest('.send-btn') && !e.target.closest('#locMenu')) closeLocMenu();
});

// ============ 长按发送键=位置菜单 ============
let sendPressTimer = null;
let sendLongPressed = false;

function setupSendLongPress() {
    const btn = $('#sendBtn');
    const start = (e) => {
        sendLongPressed = false;
        sendPressTimer = setTimeout(() => {
            sendLongPressed = true;
            const menu = $('#locMenu');
            menu.hidden = false;
            if (navigator.vibrate) navigator.vibrate(50);
        }, 500);
    };
    const end = (e) => {
        clearTimeout(sendPressTimer);
        if (sendLongPressed) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    btn.addEventListener('mousedown', start);
    btn.addEventListener('mouseup', end);
    btn.addEventListener('mouseleave', () => clearTimeout(sendPressTimer));
    btn.addEventListener('touchstart', start, { passive: true });
    btn.addEventListener('touchend', end);
}
function closeLocMenu() { $('#locMenu').hidden = true; }

// ============ 位置共享 ============
let locWatchId = null;
let locShareInterval = null;
let locPollInterval = null;
let locMap = null;
let locMarkers = {};
let isSharingLocation = false;
let lastLoc = null;

function sendLocationOnce() {
    if (!navigator.geolocation) { showToast('浏览器不支持定位'); return; }
    showToast('正在获取高精度位置，请稍候...');
    let attempts = 0;
    let bestPos = null;
    let bestAccuracy = Infinity;
    let watchId = null;
    let resolved = false;
    let timeoutTimer = null;

    const sendIt = (lat, lng) => {
        if (resolved) return;
        resolved = true;
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }

        const localMsg = {
            id: 'local_' + uid(),
            senderPhone: me.phone,
            senderNickname: me.nickname,
            senderAvatar: me.avatar,
            type: 'location',
            content: '',
            lat: lat,
            lng: lng,
            ts: Date.now(),
            readBy: [me.phone],
            _local: true
        };
        msgCache.push(localMsg);
        msgCache.sort((a, b) => a.ts - b.ts);
        renderMessages(msgCache);

        api('/groups/' + group.code + '/messages', {
            method: 'POST',
            body: { type: 'location', lat: lat, lng: lng, text: '' }
        }).then(data => {
            replaceLocalMessage(localMsg.id, data.message);
            lastMsgCache[group.code] = data.message.ts;
            showToast('位置已发送');
        }).catch(e => {
            removeLocalMessage(localMsg.id);
            showToast(e.message);
        });
    };

    const tryBestOrSend = () => {
        if (resolved) return;
        if (bestPos && bestAccuracy <= 50) {
            sendIt(bestPos.coords.latitude, bestPos.coords.longitude);
            return;
        }
        attempts++;
        if (attempts >= 10) {
            if (bestPos) {
                sendIt(bestPos.coords.latitude, bestPos.coords.longitude);
            } else {
                showToast('无法获取位置，请检查权限和GPS');
            }
        }
    };

    try {
        watchId = navigator.geolocation.watchPosition(
            pos => {
                const acc = pos.coords.accuracy;
                if (acc < bestAccuracy) {
                    bestAccuracy = acc;
                    bestPos = pos;
                }
                if (acc <= 25) {
                    sendIt(pos.coords.latitude, pos.coords.longitude);
                } else if (acc <= 50) {
                    setTimeout(() => {
                        if (bestAccuracy <= 50 && bestPos === pos && !resolved) {
                            sendIt(pos.coords.latitude, pos.coords.longitude);
                        } else {
                            tryBestOrSend();
                        }
                    }, 1500);
                } else {
                    tryBestOrSend();
                }
            },
            err => {
                if (bestPos) {
                    sendIt(bestPos.coords.latitude, bestPos.coords.longitude);
                } else {
                    if (!resolved) {
                        resolved = true;
                        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
                        showToast('获取位置失败，请检查权限');
                    }
                }
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
        );
        timeoutTimer = setTimeout(() => {
            if (bestPos && !resolved) {
                sendIt(bestPos.coords.latitude, bestPos.coords.longitude);
            } else if (!resolved) {
                resolved = true;
                if (watchId !== null) {
                    navigator.geolocation.clearWatch(watchId);
                    watchId = null;
                }
                showToast('获取位置超时，请重试');
            }
        }, 20000);
    } catch (e) {
        showToast('定位功能异常');
    }
}

function startLiveLocation() {
    if (!navigator.geolocation) { showToast('浏览器不支持定位'); return; }
    if (isSharingLocation) { stopLiveLocation(); return; }
    showToast('正在开启实时位置共享...');
    navigator.geolocation.getCurrentPosition(async pos => {
        lastLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        isSharingLocation = true;
        await updateMyLocation();
        // 持续监听位置变化
        locWatchId = navigator.geolocation.watchPosition(p => {
            lastLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
        }, null, { enableHighAccuracy: true, maximumAge: 3000 });
        // 每3秒上报一次
        locShareInterval = setInterval(updateMyLocation, 10000);
        // 每3秒拉取其他人位置
        locPollInterval = setInterval(pollLocations, 3000);
        showLocUI();
        showToast('实时位置共享已开启');
    }, () => showToast('获取位置失败'), { enableHighAccuracy: true });
}

async function updateMyLocation() {
    if (!lastLoc || !group) return;
    try {
        await api('/groups/' + group.code + '/location', {
            method: 'POST',
            body: { lat: lastLoc.lat, lng: lastLoc.lng, sharing: true }
        });
    } catch(e) {}
}

async function pollLocations() {
    if (!group) return;
    try {
        const data = await api('/groups/' + group.code + '/locations');
        const locs = data.locations;
        const phones = Object.keys(locs);
        // 更新横幅头像
        const avBox = $('#lsbAvatars');
        avBox.innerHTML = phones.map(p => {
            const l = locs[p];
            const av = l.avatar?.startsWith('data:') ? '<img src="'+l.avatar+'">' : (l.avatar || '📍');
            return '<div class="lsb-av" title="'+escapeHtml(l.nickname)+'">'+av+'</div>';
        }).join('');
        // 更新加入按钮
        const joinBtn = $('#lsbJoinBtn');
        if (isSharingLocation) {
            joinBtn.textContent = '你正在共享位置（点击退出）';
            joinBtn.classList.add('joined');
        } else if (phones.length > 0) {
            joinBtn.textContent = phones.length + '人正在共享位置，点击加入';
            joinBtn.classList.remove('joined');
        }
        // 显示/隐藏横幅和地图
        if (phones.length > 0) {
            $('#locShareBanner').hidden = false;
            $('#locMapWrap').hidden = false;
            initLocMap();
            updateMapMarkers(locs);
        } else {
            $('#locShareBanner').hidden = true;
            $('#locMapWrap').hidden = true;
        }
    } catch(e) {}
}

// initLocMap 懒加载：首次出现位置共享横幅时才注入 Leaflet
let _locMapInitPending = false;
function initLocMap() {
    const el = $('#locMap');
    if (!el) return;
    if (locMap) {
        requestAnimationFrame(() => locMap.invalidateSize());
        setTimeout(() => locMap && locMap.invalidateSize(), 200);
        return;
    }
    if (typeof L === 'undefined') {
        if (_locMapInitPending) return;
        _locMapInitPending = true;
        loadLeaflet().then(() => {
            _locMapInitPending = false;
            _initLocMapInternal(el);
        }).catch(() => { _locMapInitPending = false; });
        return;
    }
    _initLocMapInternal(el);
}
function _initLocMapInternal(el) {
    if (locMap || typeof L === 'undefined') return;
    locMap = L.map(el, { zoomControl: false, attributionControl: false, preferCanvas: true }).setView([39.9, 116.4], 13);
    L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
        subdomains: '1234',
        maxZoom: 18,
        crossOrigin: true
    }).addTo(locMap);
    requestAnimationFrame(() => {
        locMap.invalidateSize();
        setTimeout(() => locMap && locMap.invalidateSize(), 200);
    });
}

function updateMapMarkers(locs) {
    if (!locMap) return;
    const phones = Object.keys(locs);
    // 移除不存在的
    for (const p of Object.keys(locMarkers)) {
        if (!locs[p]) { locMap.removeLayer(locMarkers[p]); delete locMarkers[p]; }
    }
    const bounds = [];
    for (const p of phones) {
        const l = locs[p];
        const icon = L.divIcon({
            className: 'loc-user-marker',
            html: '<div style="width:36px;height:36px;border-radius:50%;background:'+(p===me.phone?'#34C759':'#5B8DEF')+';border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,.3);overflow:hidden;">'+(l.avatar?.startsWith('data:')?'<img src="'+l.avatar+'" style="width:100%;height:100%;object-fit:cover;">':(l.avatar||'📍'))+'</div>',
            iconSize: [36, 36], iconAnchor: [18, 18]
        });
        if (locMarkers[p]) {
            locMarkers[p].setLatLng([l.lat, l.lng]);
        } else {
            locMarkers[p] = L.marker([l.lat, l.lng], { icon }).addTo(locMap);
        }
        bounds.push([l.lat, l.lng]);
    }
    if (bounds.length > 0) {
        if (bounds.length === 1) locMap.setView(bounds[0], 15);
        else locMap.fitBounds(bounds, { padding: [40, 40] });
    }
}

function toggleJoinLocation() {
    if (isSharingLocation) stopLiveLocation();
    else startLiveLocation();
}

function stopLiveLocation() {
    isSharingLocation = false;
    if (locWatchId !== null) { navigator.geolocation.clearWatch(locWatchId); locWatchId = null; }
    if (locShareInterval) { clearInterval(locShareInterval); locShareInterval = null; }
    if (group) {
        api('/groups/' + group.code + '/location', { method: 'DELETE' }).catch(()=>{});
    }
    showToast('已停止共享位置');
    pollLocations();
}

function showLocUI() {
    $('#locShareBanner').hidden = false;
    $('#locMapWrap').hidden = false;
    pollLocations();
}

// ============ 语音/视频通话 ============
let callType = 'voice';
let callStream = null;
let callMuted = false;
let callCameraOff = false;
let callSpeakerOn = false;
let callPip = false;
let callTimerInt = null;
let callSeconds = 0;
let callPollInt = null;
let currentCallData = null;
let notifiedCallId = null;

async function startCall(type) {
    callType = type;
    try {
        const constraints = type === 'video' ? { audio: true, video: true } : { audio: true };
        callStream = await navigator.mediaDevices.getUserMedia(constraints);
        $('#callModal').hidden = false;
        if (group) {
            $('#callGroupAvatar').textContent = group.avatar || '💬';
            $('#callGroupName').textContent = group.name;
        }
        $('#callName').textContent = me.nickname;
        $('#callAvatar').innerHTML = avatarHtml(me.avatar);
        $('#callStatus').textContent = '正在呼叫...';
        renderCallMembers();
        const video = $('#callVideo');
        if (type === 'video') {
            video.hidden = false;
            video.srcObject = callStream;
        } else {
            video.hidden = true;
        }
        $('#callCameraBtn').style.display = type === 'video' ? 'flex' : 'none';
        // 同步到后端
        if (group) {
            try { await api('/groups/' + group.code + '/call', { method: 'POST', body: { type } }); } catch(e) {}
        }
        setTimeout(() => { $('#callStatus').textContent = '通话中 00:00'; startCallTimer(); }, 1500);
        startCallPolling();
    } catch(e) {
        showToast('无法访问' + (type==='video'?'摄像头和麦克风':'麦克风') + '：' + e.message);
    }
}

function joinCall(callData) {
    currentCallData = callData;
    callType = callData.type || 'voice';
    startCall(callType);
}

function renderCallMembers() {
    const box = $('#callMembers');
    if (!box) return;
    let members = [me];
    if (currentCallData && currentCallData.participants) {
        members = currentCallData.participants.map(p => ({ nickname: p.nickname, avatar: p.avatar }));
        if (!members.find(m => m.nickname === me.nickname)) members.push(me);
    }
    box.innerHTML = members.map(m => {
        const av = m.avatar?.startsWith('data:') ? '<img src="'+m.avatar+'">' : (m.avatar || '😀');
        return '<div class="call-member"><div class="call-member-av">'+av+'</div>'+escapeHtml(m.nickname)+'</div>';
    }).join('');
}

function toggleCallPip() {
    callPip = !callPip;
    const overlay = $('#callModal');
    const panel = $('#callPanel');
    overlay.classList.toggle('pip-mode', callPip);
    if (callPip) {
        panel.style.position = 'fixed';
        panel.style.right = '16px';
        panel.style.bottom = '16px';
        panel.style.left = 'auto';
        panel.style.top = 'auto';
        panel.style.margin = '0';
        $('#callPipBtn').textContent = '⛶';
        makeCallDraggable(panel);
    } else {
        panel.style.position = '';
        panel.style.right = '';
        panel.style.bottom = '';
        panel.style.left = '';
        panel.style.top = '';
        panel.style.margin = '';
        $('#callPipBtn').textContent = '⤢';
    }
}

function makeCallDraggable(el) {
    let sx, sy, ox, oy, dragging = false, moved = false;
    const onDown = e => {
        if (e.target.closest('.call-btn') || e.target.closest('.call-pip-btn')) return;
        dragging = true; moved = false;
        const touch = e.touches ? e.touches[0] : e;
        sx = touch.clientX; sy = touch.clientY;
        const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
        e.preventDefault();
    };
    const onMove = e => {
        if (!dragging) return;
        moved = true;
        const touch = e.touches ? e.touches[0] : e;
        let nx = ox + touch.clientX - sx;
        let ny = oy + touch.clientY - sy;
        const maxX = window.innerWidth - el.offsetWidth - 8;
        const maxY = window.innerHeight - el.offsetHeight - 8;
        nx = Math.max(8, Math.min(nx, maxX));
        ny = Math.max(8, Math.min(ny, maxY));
        el.style.left = nx + 'px';
        el.style.top = ny + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    };
    const onUp = () => { dragging = false; };
    el.addEventListener('mousedown', onDown);
    el.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
}

function startCallTimer() {
    callSeconds = 0;
    callTimerInt = setInterval(() => {
        callSeconds++;
        const m = String(Math.floor(callSeconds/60)).padStart(2,'0');
        const s = String(callSeconds%60).padStart(2,'0');
        $('#callStatus').textContent = '通话中 ' + m + ':' + s;
        const bt = $('#callBannerTimer');
        if (bt) bt.textContent = m + ':' + s;
    }, 1000);
}

function endCall() {
    if (callStream) { callStream.getTracks().forEach(t => t.stop()); callStream = null; }
    if (callTimerInt) { clearInterval(callTimerInt); callTimerInt = null; }
    if (callPollInt) { clearInterval(callPollInt); callPollInt = null; }
    $('#callModal').hidden = true;
    $('#callModal').classList.remove('pip-mode');
    callPip = false;
    const panel = $('#callPanel');
    if (panel) {
        panel.style.position = ''; panel.style.left = ''; panel.style.top = '';
        panel.style.right = ''; panel.style.bottom = ''; panel.style.margin = '';
    }
    $('#callVideo').srcObject = null;
    callMuted = false; callCameraOff = false; callSpeakerOn = false;
    $('#callMuteBtn').classList.remove('muted');
    $('#callCameraBtn').classList.remove('off');
    $('#callSpeakerBtn').classList.remove('on');
    $('#callPipBtn').textContent = '⤢';
    // 同步到后端
    if (group) {
        try { api('/groups/' + group.code + '/call', { method: 'DELETE' }); } catch(e) {}
    }
    currentCallData = null;
    hideCallBanner();
}

function toggleCallMute() {
    if (!callStream) return;
    callMuted = !callMuted;
    callStream.getAudioTracks().forEach(t => t.enabled = !callMuted);
    $('#callMuteBtn').classList.toggle('muted', callMuted);
}

function toggleCallCamera() {
    if (!callStream) return;
    callCameraOff = !callCameraOff;
    callStream.getVideoTracks().forEach(t => t.enabled = !callCameraOff);
    $('#callCameraBtn').classList.toggle('off', callCameraOff);
}

function toggleCallSpeaker() {
    callSpeakerOn = !callSpeakerOn;
    $('#callSpeakerBtn').classList.toggle('on', callSpeakerOn);
    const video = $('#callVideo');
    if (video) video.volume = callSpeakerOn ? 1 : 0.5;
}

// ============ 通话横幅与轮询 ============
function showCallBanner(callData) {
    const banner = $('#callBanner');
    if (!banner) return;
    const isSharingLoc = !$('#locShareBanner')?.hidden;
    banner.classList.toggle('compact', isSharingLoc);
    const starter = callData.participants?.find(p => p.phone === callData.startedBy);
    $('#callBannerAvatar').innerHTML = starter?.avatar ? (starter.avatar.startsWith('data:') ? '<img src="'+starter.avatar+'">' : starter.avatar) : ((typeof svgIcon === 'function') ? svgIcon('phone', 28) : '📞');
    $('#callBannerTitle').textContent = (callData.type === 'video' ? '视频' : '语音') + '通话中 · ' + (callData.participants?.length || 1) + '人';
    $('#callBannerSub').textContent = callData.participants?.map(p=>p.nickname).join('、') || '';
    banner.hidden = false;
    // 系统通知（仅当我不在通话中时）
    const callId = callData.startedBy + '_' + callData.startedAt;
    if (notifiedCallId !== callId && $('#callModal').hidden) {
        notifiedCallId = callId;
        showCallNotification(callData);
    }
}

function hideCallBanner() {
    const banner = $('#callBanner');
    if (banner) banner.hidden = true;
}

function showCallNotification(callData) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
        try {
            const n = new Notification('Stating 通话邀请', {
                body: (callData.type === 'video' ? '视频' : '语音') + '通话 · ' + (callData.participants?.map(p=>p.nickname).join('、') || ''),
                icon: '',
                tag: 'stating-call',
                requireInteraction: true
            });
            n.onclick = () => { window.focus(); n.close(); };
        } catch(e) {}
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission();
    }
}

function startCallPolling() {
    if (callPollInt) clearInterval(callPollInt);
    callPollInt = setInterval(async () => {
        if (!group) return;
        // 如果正在通话中，发送心跳保持活跃
        if (!$('#callModal').hidden) {
            try { await api('/groups/' + group.code + '/call', { method: 'POST', body: { type: callType } }); } catch(e) {}
        }
        try {
            const data = await api('/groups/' + group.code + '/call', { method: 'GET' });
            if (data.active && data.call) {
                currentCallData = data.call;
                // 如果我不在通话中，显示横幅
                if ($('#callModal').hidden) {
                    showCallBanner(data.call);
                } else {
                    renderCallMembers();
                }
            } else {
                currentCallData = null;
                hideCallBanner();
                if (!$('#callModal').hidden) {
                    // 通话已结束
                    showToast('通话已结束');
                    endCall();
                }
            }
        } catch(e) {}
    }, 3000);
}

// ============ 新功能：消息上下文菜单 ============
let ctxMsgId = null, ctxMsgIsMe = false;

function showMsgContextMenu(x, y, m, isMe) {
    const menu = $('#msgContextMenu');
    ctxMsgId = m.id;
    ctxMsgIsMe = isMe;
    menu.classList.toggle('show-own', isMe);
    menu.classList.toggle('show-owner', group?.isOwner || isAdmin());
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - rect.width - 10);
    const py = Math.min(y, window.innerHeight - rect.height - 10);
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';
}

function closeMsgContextMenu() {
    $('#msgContextMenu').hidden = true;
    $('#reactionPicker').hidden = true;
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('#msgContextMenu') && !e.target.closest('#reactionPicker')) {
        closeMsgContextMenu();
    }
});

// 上下文菜单点击
$('#msgContextMenu')?.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item || !ctxMsgId) return;
    const action = item.dataset.action;
    const msg = msgCache.find(m => m.id === ctxMsgId);
    closeMsgContextMenu();
    if (!msg) return;
    if (action === 'reply') replyToMessage(msg);
    else if (action === 'react') showReactionPicker(msg);
    else if (action === 'forward') showForwardDialog(msg);
    else if (action === 'save') saveMessage(msg);
    else if (action === 'pin') pinMessage(msg.id);
    else if (action === 'edit') editMessage(msg);
    else if (action === 'recall') recallMessage(msg.id);
});

// ============ 表情回复 ============
function showReactionPicker(m) {
    const picker = $('#reactionPicker');
    const wrap = document.querySelector(`[data-msg-id="${m.id}"]`);
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    picker.hidden = false;
    picker.style.left = Math.min(rect.left, window.innerWidth - 280) + 'px';
    picker.style.top = Math.max(rect.top - 50, 10) + 'px';
    picker.dataset.msgId = m.id;
}

$('#reactionPicker')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.rp-emoji');
    if (!btn) return;
    const msgId = $('#reactionPicker').dataset.msgId;
    const emoji = btn.dataset.emoji;
    reactToMessage(msgId, emoji);
    $('#reactionPicker').hidden = true;
});

async function reactToMessage(msgId, emoji) {
    if (!group) return;
    try {
        await api('/groups/' + group.code + '/messages/' + msgId + '/react', { method: 'POST', body: { emoji } });
        forceFullReload = true;
        refreshGroupData();
    } catch(e) { showToast('表情回复失败'); }
}

// ============ 引用回复 ============
let replyToMsg = null;

function replyToMessage(m) {
    replyToMsg = m;
    const bar = $('#replyBar');
    $('#replyTargetName').textContent = m.senderPhone === me.phone ? '我' : (m.senderNickname || m.senderPhone);
    let preview = m.content || '';
    if (m.type === 'image') preview = '[图片]';
    else if (m.type === 'voice') preview = '[语音]';
    else if (m.type === 'file') preview = '[文件]';
    else if (m.type === 'location') preview = '[位置]';
    $('#replyPreview').textContent = preview;
    bar.hidden = false;
    $('#composerInput').focus();
}

$('#replyCancel')?.addEventListener('click', () => {
    replyToMsg = null;
    $('#replyBar').hidden = true;
});

// ============ 编辑消息 ============
function editMessage(m) {
    const newText = prompt('编辑消息：', m.content);
    if (newText === null || newText.trim() === '') return;
    api('/groups/' + group.code + '/messages/' + m.id + '/edit', { method: 'POST', body: { content: newText.trim() } })
        .then(() => { forceFullReload = true; refreshGroupData(); })
        .catch(() => showToast('编辑失败'));
}

// ============ 转发消息 ============
async function showForwardDialog(m) {
    const dialog = $('#forwardDialog');
    const list = $('#forwardList');
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-3);">加载中...</div>';
    dialog.hidden = false;
    try {
        const data = await api('/my-groups', { method: 'GET' });
        list.innerHTML = '';
        (data.groups || []).forEach(g => {
            if (g.code === group.code) return; // 不转发到当前群
            const item = document.createElement('div');
            item.className = 'forward-item';
            item.innerHTML = '<span class="forward-avatar">' + (g.avatar || '💬') + '</span><span class="forward-name">' + escapeHtml(g.name) + '</span>';
            item.onclick = () => {
                api('/groups/' + group.code + '/messages/' + m.id + '/forward', { method: 'POST', body: { targetCode: g.code } })
                    .then(() => { showToast('转发成功'); dialog.hidden = true; })
                    .catch(() => showToast('转发失败'));
            };
            list.appendChild(item);
        });
        if ((data.groups || []).filter(g => g.code !== group.code).length === 0) {
            list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-3);">没有其他群聊</div>';
        }
    } catch(e) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-3);">加载失败</div>';
    }
}

$('#forwardCancel')?.addEventListener('click', () => { $('#forwardDialog').hidden = true; });

// ============ 输入中状态 ============
function sendTyping() {
    if (!group) return;
    api('/groups/' + group.code + '/typing', { method: 'POST' }).catch(() => {});
}

$('#composerInput')?.addEventListener('input', () => {
    clearTimeout(typingTimer);
    sendTyping();
    typingTimer = setTimeout(sendTyping, 2000);
});

async function pollTyping() {
    if (!group) return;
    try {
        const data = await api('/groups/' + group.code + '/typing', { method: 'GET' });
        const indicator = $('#typingIndicator');
        if (data.typers && data.typers.length > 0) {
            const names = data.typers.map(t => t.nickname || t.phone).join('、');
            $('#typingText').textContent = names + ' 正在输入...';
            indicator.hidden = false;
        } else {
            indicator.hidden = true;
        }
    } catch(e) {}
}

// ============ 用户资料卡 ============
async function showUserProfile(phone) {
    try {
        const data = await api('/users/' + phone, { method: 'GET' });
        const p = data.profile;
        $('#pcAvatar').innerHTML = p.avatar?.startsWith('data:') ? '<img src="' + p.avatar + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">' : (p.avatar || '😀');
        $('#pcNickname').textContent = p.nickname || '用户';
        $('#pcPhone').textContent = p.phone;
        $('#pcEmail').textContent = p.email || '未设置';
        $('#pcGroupCount').textContent = p.groupCount;
        $('#pcCreatedAt').textContent = p.createdAt ? new Date(p.createdAt).toLocaleDateString('zh-CN') : '未知';
        const groupsEl = $('#pcGroups');
        groupsEl.innerHTML = '';
        (p.groups || []).forEach(g => {
            const tag = document.createElement('span');
            tag.className = 'pc-group-tag';
            tag.textContent = g.name + (g.isOwner ? ' 👑' : '');
            groupsEl.appendChild(tag);
        });
        $('#profileCard').hidden = false;
    } catch(e) { showToast('获取资料失败'); }
}

$('#pcClose')?.addEventListener('click', () => { $('#profileCard').hidden = true; });

// ============ 搜索消息 ============
$('#gmSearch')?.addEventListener('click', () => {
    $('#groupMenu').hidden = true;
    $('#searchPanel').hidden = false;
    $('#searchInput').focus();
});

$('#searchClose')?.addEventListener('click', () => { $('#searchPanel').hidden = true; });

let searchTimer;
$('#searchInput')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = $('#searchInput').value.trim();
    if (!q) { $('#searchResults').innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
        if (!group) return;
        try {
            const data = await api('/groups/' + group.code + '/search?q=' + encodeURIComponent(q), { method: 'GET' });
            const list = $('#searchResults');
            list.innerHTML = '';
            (data.results || []).forEach(m => {
                const item = document.createElement('div');
                item.className = 'sp-result-item';
                item.innerHTML = '<div class="sp-result-sender">' + escapeHtml(m.senderNickname || m.senderPhone) + '</div>' +
                    '<div class="sp-result-content">' + escapeHtml(m.content) + '</div>' +
                    '<div class="sp-result-time">' + fmtTime(m.ts) + '</div>';
                item.onclick = () => {
                    $('#searchPanel').hidden = true;
                    const el = document.querySelector(`[data-msg-id="${m.id}"]`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                };
                list.appendChild(item);
            });
            if (data.results.length === 0) list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-3);">无结果</div>';
        } catch(e) {}
    }, 300);
});

// ============ 群公告 ============
$('#gmAnnouncement')?.addEventListener('click', () => {
    $('#groupMenu').hidden = true;
    if (group && (group.isOwner || isAdmin())) {
        $('#announcementInput').value = group.announcement?.content || '';
        $('#announcementDialog').hidden = false;
    } else {
        showToast('只有群主可以编辑公告');
    }
});

$('#annSave')?.addEventListener('click', async () => {
    if (!group) return;
    const content = $('#announcementInput').value.trim();
    try {
        await api('/groups/' + group.code + '/announcement', { method: 'POST', body: { content } });
        $('#announcementDialog').hidden = true;
        forceFullReload = true;
        refreshGroupData();
        showToast('公告已保存');
    } catch(e) { showToast('保存失败'); }
});

$('#annCancel')?.addEventListener('click', () => { $('#announcementDialog').hidden = true; });

$('#annClear')?.addEventListener('click', async () => {
    if (!group) return;
    try {
        await api('/groups/' + group.code + '/announcement', { method: 'POST', body: { content: '' } });
        $('#announcementDialog').hidden = true;
        forceFullReload = true;
        refreshGroupData();
    } catch(e) {}
});

$('#annClose')?.addEventListener('click', () => { $('#announcementBanner').hidden = true; });

// ============ 群二维码 ============
$('#gmQR')?.addEventListener('click', async () => {
    $('#groupMenu').hidden = true;
    if (!group) return;
    try {
        const data = await api('/groups/' + group.code + '/qr', { method: 'GET' });
        $('#qrGroupName').textContent = data.name;
        $('#qrCodeText').textContent = data.code;
        $('#qrDisplay').innerHTML = '<img src="' + data.qr + '" alt="QR">';
        $('#qrDialog').hidden = false;
    } catch(e) { showToast('获取二维码失败'); }
});

$('#qrClose')?.addEventListener('click', () => { $('#qrDialog').hidden = true; });

// ============ 导出聊天 ============
$('#gmExport')?.addEventListener('click', () => {
    $('#groupMenu').hidden = true;
    if (!group) return;
    window.open('/api/groups/' + group.code + '/export', '_blank');
});

// ============ 置顶/免打扰 ============
$('#gmPin')?.addEventListener('click', async () => {
    $('#groupMenu').hidden = true;
    if (!group) return;
    const newPinned = !group.userSettings?.pinned;
    try {
        await api('/groups/' + group.code + '/settings', { method: 'POST', body: { pinned: newPinned } });
        showToast(newPinned ? '已置顶' : '取消置顶');
        renderMyGroups();
    } catch(e) { showToast('操作失败'); }
});

$('#gmMute')?.addEventListener('click', async () => {
    $('#groupMenu').hidden = true;
    if (!group) return;
    const newMuted = !group.userSettings?.muted;
    try {
        await api('/groups/' + group.code + '/settings', { method: 'POST', body: { muted: newMuted } });
        showToast(newMuted ? '已免打扰' : '取消免打扰');
    } catch(e) { showToast('操作失败'); }
});

// ============ 会话管理 ============
$('#sessionsBtn')?.addEventListener('click', async () => {
    try {
        const data = await api('/sessions', { method: 'GET' });
        const list = $('#sessionsList');
        list.innerHTML = '';
        (data.sessions || []).forEach(s => {
            const item = document.createElement('div');
            item.className = 'session-item';
            const time = new Date(s.lastActive).toLocaleString('zh-CN');
            item.innerHTML = '<div class="session-info">' +
                '<span class="session-device">' + (s.userAgent || 'Web 浏览器') + (s.isCurrent ? ' <span class="session-current">当前设备</span>' : '') + '</span>' +
                '<span class="session-time">最后活跃：' + time + '</span></div>';
            if (!s.isCurrent) {
                const kick = document.createElement('button');
                kick.className = 'session-kick';
                kick.textContent = '下线';
                kick.onclick = async () => {
                    try {
                        await api('/sessions/' + s.id, { method: 'DELETE' });
                        item.remove();
                        showToast('已下线');
                    } catch(e) { showToast('操作失败'); }
                };
                item.appendChild(kick);
            }
            list.appendChild(item);
        });
        $('#sessionsDialog').hidden = false;
    } catch(e) { showToast('获取会话失败'); }
});

$('#sessionsClose')?.addEventListener('click', () => { $('#sessionsDialog').hidden = true; });

// ============ 第二批新功能JS ============

// 收藏消息
async function saveMessage(m) {
    if (!group) return;
    try {
        const r = await api('/saved/' + m.id, { method: 'POST', body: { groupCode: group.code } });
        showToast(r.saved ? '已收藏' : '已取消收藏');
    } catch(e) { showToast('操作失败'); }
}

// 置顶消息
async function pinMessage(msgId) {
    if (!group) return;
    try {
        const r = await api('/groups/' + group.code + '/messages/' + msgId + '/pin', { method: 'POST' });
        showToast(r.pinned ? '已置顶' : '已取消置顶');
        loadPinnedMessages();
    } catch(e) { showToast('操作失败'); }
}

// 加载置顶消息
async function loadPinnedMessages() {
    if (!group) return;
    try {
        const data = await api('/groups/' + group.code + '/pinned', { method: 'GET' });
        if (data.pinned && data.pinned.length > 0) {
            const latest = data.pinned[0];
            let text = latest.content || '[消息]';
            if (latest.type === 'image') text = '[图片]';
            else if (latest.type === 'voice') text = '[语音]';
            else if (latest.type === 'file') text = '[文件]';
            $('#pinnedText').textContent = (latest.senderNickname || '群成员') + ': ' + text;
            $('#pinnedBanner').hidden = false;
            $('#pinnedBanner').dataset.msgId = latest.id;
        } else {
            $('#pinnedBanner').hidden = true;
        }
    } catch(e) {}
}

$('#pinnedClose')?.addEventListener('click', (e) => { e.stopPropagation(); $('#pinnedBanner').hidden = true; });
$('#pinnedBanner')?.addEventListener('click', () => {
    const msgId = $('#pinnedBanner').dataset.msgId;
    if (msgId) {
        const el = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
});

// 群成员
async function showMembersDialog() {
    if (!group) return;
    try {
        const data = await api('/groups/' + group.code + '/members', { method: 'GET' });
        $('#membersCount').textContent = '(' + data.members.length + ')';
        const list = $('#membersList');
        list.innerHTML = '';
        data.members.forEach(m => {
            const item = document.createElement('div');
            item.className = 'member-item';
            item.innerHTML =
                '<span class="member-avatar">' + (m.avatar || '😀') + '</span>' +
                '<div class="member-info">' +
                    '<div class="member-name">' + escapeHtml(m.nickname) + (m.isOwner ? ' <span class="owner-tag">群主</span>' : '') + '</div>' +
                    '<div class="member-status">' + (m.online ? '在线' : '离线') + '</div>' +
                '</div>' +
                '<span class="' + (m.online ? 'member-online' : 'member-offline') + '"></span>';
            if (data.isOwner && !m.isOwner && m.phone !== me.phone) {
                const kick = document.createElement('button');
                kick.className = 'member-kick';
                kick.textContent = '踢出';
                kick.onclick = async () => {
                    if (confirm('确定踢出 ' + m.nickname + '？')) {
                        try {
                            await api('/groups/' + group.code + '/members/' + m.phone, { method: 'DELETE' });
                            showToast('已踢出');
                            showMembersDialog();
                            forceFullReload = true;
                            refreshGroupData();
                        } catch(e) { showToast('操作失败'); }
                    }
                };
                item.appendChild(kick);
            }
            list.appendChild(item);
        });
        $('#membersDialog').hidden = false;
    } catch(e) { showToast('加载失败'); }
}

$('#membersClose')?.addEventListener('click', () => { $('#membersDialog').hidden = true; });
$('#gmMembers')?.addEventListener('click', () => { $('#groupMenu').hidden = true; showMembersDialog(); });

// 编辑群信息
$('#gmEditGroup')?.addEventListener('click', () => {
    $('#groupMenu').hidden = true;
    $('#editGroupName').value = group?.name || '';
    $('#editGroupAvatar').value = group?.avatar || '💬';
    $('#editGroupDialog').hidden = false;
});
$('#editGroupCancel')?.addEventListener('click', () => { $('#editGroupDialog').hidden = true; });
$('#editGroupSave')?.addEventListener('click', async () => {
    if (!group) return;
    const name = $('#editGroupName').value.trim();
    const avatar = $('#editGroupAvatar').value.trim();
    if (!name) { showToast('群名不能为空'); return; }
    try {
        await api('/groups/' + group.code, { method: 'PATCH', body: { name, avatar } });
        group.name = name;
        group.avatar = avatar;
        $('#chatName').textContent = name;
        $('#chatAvatar').textContent = avatar;
        $('#editGroupDialog').hidden = true;
        showToast('已保存');
        renderMyGroups();
    } catch(e) { showToast('保存失败'); }
});

// 置顶消息列表
$('#gmPinned')?.addEventListener('click', async () => {
    $('#groupMenu').hidden = true;
    if (!group) return;
    try {
        const data = await api('/groups/' + group.code + '/pinned', { method: 'GET' });
        const list = $('#pinnedList');
        list.innerHTML = '';
        if (data.pinned.length === 0) {
            list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-3);">暂无置顶消息</div>';
        } else {
            data.pinned.forEach(m => {
                const item = document.createElement('div');
                item.className = 'pinned-item';
                let text = m.content || '[消息]';
                if (m.type === 'image') text = '[图片]';
                else if (m.type === 'voice') text = '[语音]';
                else if (m.type === 'file') text = '[文件]';
                item.innerHTML =
                    '<div class="pinned-sender">' + escapeHtml(m.senderNickname || m.senderPhone) + '</div>' +
                    '<div class="pinned-content">' + escapeHtml(text) + '</div>' +
                    '<div class="pinned-time">' + fmtTime(m.ts) + '</div>';
                item.onclick = () => {
                    $('#pinnedDialog').hidden = true;
                    const el = document.querySelector(`[data-msg-id="${m.id}"]`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                };
                list.appendChild(item);
            });
        }
        $('#pinnedDialog').hidden = false;
    } catch(e) { showToast('加载失败'); }
});
$('#pinnedClose')?.addEventListener('click', () => { $('#pinnedDialog').hidden = true; });

// 我的收藏
$('#savedBtn')?.addEventListener('click', async () => {
    try {
        const data = await api('/saved', { method: 'GET' });
        const list = $('#savedList');
        list.innerHTML = '';
        if (data.saved.length === 0) {
            list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-3);">暂无收藏</div>';
        } else {
            data.saved.forEach(m => {
                const item = document.createElement('div');
                item.className = 'saved-item';
                let text = m.content || '[消息]';
                if (m.type === 'image') text = '[图片]';
                else if (m.type === 'voice') text = '[语音]';
                else if (m.type === 'file') text = '[文件]';
                item.innerHTML =
                    '<div class="saved-sender">' + escapeHtml(m.senderNickname || m.senderPhone) + '</div>' +
                    '<div class="saved-content">' + escapeHtml(text) + '</div>' +
                    '<div class="saved-time">' + fmtTime(m.savedAt || m.ts) + '</div>';
                list.appendChild(item);
            });
        }
        $('#savedDialog').hidden = false;
    } catch(e) { showToast('加载失败'); }
});
$('#savedClose')?.addEventListener('click', () => { $('#savedDialog').hidden = true; });

// @提及功能
let mentionMode = false;
$('#composerInput')?.addEventListener('input', (e) => {
    const text = $('#composerInput').textContent;
    const lastAt = text.lastIndexOf('@');
    if (lastAt !== -1 && lastAt === text.length - 1) {
        showMentionPicker();
    } else {
        $('#mentionPicker').hidden = true;
    }
});

function showMentionPicker() {
    if (!group) return;
    api('/groups/' + group.code + '/members', { method: 'GET' }).then(data => {
        const list = $('#mentionList');
        list.innerHTML = '';
        data.members.filter(m => m.phone !== me.phone).forEach(m => {
            const item = document.createElement('div');
            item.className = 'mp-item';
            item.innerHTML = '<span class="mp-avatar">' + (m.avatar || '😀') + '</span><span>' + escapeHtml(m.nickname) + '</span>';
            item.onclick = () => {
                const input = $('#composerInput');
                input.textContent = input.textContent.replace(/@$/, '@' + m.phone + ' ');
                $('#mentionPicker').hidden = true;
                input.focus();
            };
            list.appendChild(item);
        });
        $('#mentionPicker').hidden = false;
    }).catch(() => {});
}

// 草稿自动保存
let draftSaveTimer;
$('#composerInput')?.addEventListener('input', () => {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(saveDraft, 1000);
});

async function saveDraft() {
    if (!group) return;
    const content = $('#composerInput').textContent;
    try {
        await api('/groups/' + group.code + '/draft', { method: 'PUT', body: { content } });
    } catch(e) {}
}

async function loadDraft() {
    if (!group) return;
    try {
        const data = await api('/groups/' + group.code + '/draft', { method: 'GET' });
        if (data.content) {
            $('#composerInput').textContent = data.content;
            $('#sendBtn').disabled = false;
        }
    } catch(e) {}
}

// 输入中轮询
setInterval(pollTyping, 3000);

document.addEventListener('DOMContentLoaded', init);
})();
