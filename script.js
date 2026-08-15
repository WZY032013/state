/* ============================================================
   Stating — 聊天应用逻辑（多群聊 + 管理员 + 用户列表）
   ============================================================ */
(function () {
    'use strict';

    /* ---------- 常量 ---------- */
    const STORE = {
        USERS:     'stating_users',
        GROUPS:    'stating_groups',
        MSG_PRE:   'stating_msgs_',
        PRES_PRE:  'stating_pres_',
        USERPRES:  'stating_userpres',
        SESSION:   'stating_session'
    };
    const ADMIN_PHONE = '13385387338';
    const ADMIN_KEY = '032013';
    const MSG_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天

    const AVATARS = ['😀','🐱','🦊','🐼','🐨','🦁','🐸','🐙','🦄','🐝','🌸','⭐️','🌈','🍀','🎮','🎵','🎨','🚀','🍑','🐧','🦋','🐳'];
    const GROUP_AVATARS = ['💬','🔥','🎮','🎵','🎨','🚀','⭐️','🌈','🎯','🎪','🎭','🏆','☕️','🍕','🐱','🦊','🐼','🦁','🐸','🦄','🌸','🍀'];
    const EMOJIS = [
        '😀','😂','🥰','😎','🤔','😴','🥺','😢','😡','🤩',
        '👍','👏','🙏','💪','✌️','🤝','👀','💯','✨','🔥',
        '❤️','💔','💕','💖','💙','💚','💛','💜','🧡','🖤',
        '🎉','🎊','🎁','🎂','🍰','☕️','🍺','🍻','🍕','🍔',
        '🍣','🍜','🍩','🍪','🍎','🍇','🍓','🍑','🥑','🍿',
        '🐱','🐶','🦊','🐼','🐨','🦁','🐸','🐙','🦄','🐝',
        '🌸','🌈','⭐️','🌙','☀️','⚡️','❄️','🌊','🍀','🌺',
        '🚀','✈️','🏠','📱','💻','🎮','🎵','🎨','📚','⚽️',
        '✅','❌','❗️','❓','💤','💡','🔔','📌','📎','🔗'
    ];
    const HEARTBEAT_MS = 3000;
    const PRESENCE_TIMEOUT = 10000;
    const TYPING_TIMEOUT = 2500;

    /* ---------- 工具 ---------- */
    const $  = (s, el = document) => el.querySelector(s);
    const $$ = (s, el = document) => [...el.querySelectorAll(s)];

    const store = {
        get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
        set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
        del(k) { localStorage.removeItem(k); }
    };
    const session = {
        get(k, d) { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } },
        set(k, v) { sessionStorage.setItem(k, JSON.stringify(v)); },
        del(k)    { sessionStorage.removeItem(k); }
    };

    const msgKey  = code => STORE.MSG_PRE + code.toUpperCase();
    const presKey = code => STORE.PRES_PRE + code.toUpperCase();

    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

    function fmtTime(ts) {
        const d = new Date(ts);
        return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }
    function fmtDay(ts) {
        const d = new Date(ts), now = new Date();
        if (d.toDateString() === now.toDateString()) return '今天';
        const yest = new Date(now); yest.setDate(now.getDate() - 1);
        if (d.toDateString() === yest.toDateString()) return '昨天';
        return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
    }
    function fmtDateTime(ts) {
        return fmtDay(ts) + ' ' + fmtTime(ts);
    }
    const isSameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function avatarHtml(avatar) {
        if (avatar && typeof avatar === 'string' && avatar.startsWith('data:')) {
            return '<img src="' + avatar + '" alt="">';
        }
        return escapeHtml(avatar || '😀');
    }

    function linkify(text) {
        const escaped = escapeHtml(text);
        return escaped
            .replace(/(https?:\/\/[^\s<>"'）)】]+|www\.[^\s<>"'）)】]+)/gi, (url) => {
                let tail = '';
                let clean = url;
                const m = clean.match(/[.,;:!?，。；：！？、）)】]+$/);
                if (m) { tail = m[0]; clean = clean.slice(0, -tail.length); }
                const href = clean.toLowerCase().startsWith('www.') ? 'http://' + clean : clean;
                return '<a href="' + href + '" target="_blank" rel="noopener noreferrer" class="msg-link">' + clean + '</a>' + tail;
            })
            .replace(/\n/g, '<br>');
    }

    function phoneMask(p) { return p.slice(0, 3) + '****' + p.slice(7); }

    /* ---------- 状态 ---------- */
    let me = null;
    let group = null;
    let channel = null;
    let heartbeatTimer = null;
    let presenceTimer = null;
    let globalPresTimer = null;
    let typingTimer = null;
    let selectedAvatar = AVATARS[0];
    let selectedGroupAvatar = GROUP_AVATARS[0];
    let lastRenderedDay = null;
    let lastSender = null;
    let unreadCount = 0;
    let activeView = 'home';
    let pendingAdminPhone = null;  // 登录后等待密钥验证的手机号

    /* ============================================================
       初始化
       ============================================================ */
    function init() {
        buildAvatarGrids();
        buildEmojiGrid();
        bindAuth();
        bindNav();
        bindChat();
        bindProfile();
        bindAdminKey();
        bindAdminPanel();
        bindConfirm();

        try {
            channel = new BroadcastChannel('stating_chat');
            channel.onmessage = onChannelMessage;
        } catch (e) { /* 老浏览器用 storage 事件降级 */ }
        window.addEventListener('storage', onStorage);

        cleanupOldMessages();

        const sess = session.get(STORE.SESSION, null);
        if (sess && sess.phone) {
            const users = store.get(STORE.USERS, []);
            const u = users.find(x => x.phone === sess.phone);
            if (u) {
                me = u;
                me.isAdmin = (u.phone === ADMIN_PHONE);
                if (sess.groupCode) {
                    const groups = store.get(STORE.GROUPS, []);
                    const g = groups.find(x => x.code.toUpperCase() === sess.groupCode.toUpperCase());
                    if (g) { group = g; }
                }
                enterApp();
                return;
            }
        }
        showAuth();
    }

    /* ============================================================
       注册 / 登录
       ============================================================ */
    function buildAvatarGrids() {
        const grid = $('#avatarGrid');
        grid.innerHTML = '';
        AVATARS.forEach((a, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'avatar-opt' + (i === 0 ? ' selected' : '');
            b.textContent = a;
            b.onclick = () => {
                selectedAvatar = a;
                $$('.avatar-opt', grid).forEach(x => x.classList.remove('selected'));
                b.classList.add('selected');
                $('#avatarUploadBtn').textContent = '📷 上传本地照片';
                $('#avatarUploadBtn').classList.remove('has-photo');
            };
            grid.appendChild(b);
        });

        const ggrid = $('#groupAvatarGrid');
        ggrid.innerHTML = '';
        GROUP_AVATARS.forEach((a, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'avatar-opt' + (i === 0 ? ' selected' : '');
            b.textContent = a;
            b.onclick = () => {
                selectedGroupAvatar = a;
                $$('.avatar-opt', ggrid).forEach(x => x.classList.remove('selected'));
                b.classList.add('selected');
            };
            ggrid.appendChild(b);
        });
    }

    function buildEmojiGrid() {
        const grid = $('#emojiGrid');
        EMOJIS.forEach(e => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = e;
            b.onclick = () => insertEmoji(e);
            grid.appendChild(b);
        });
    }

    function insertEmoji(e) {
        const input = $('#composerInput');
        input.focus();
        const sel = window.getSelection();
        if (sel.rangeCount > 0 && input.contains(sel.anchorNode)) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(document.createTextNode(e));
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        } else {
            input.textContent += e;
        }
        $('#sendBtn').disabled = !input.textContent.trim();
        broadcastTyping(true);
    }

    function showAuth() {
        $('#authScreen').style.display = 'flex';
        $('#adminScreen').hidden = true;
        $('#mainApp').hidden = true;
    }

    function showAdminKeyScreen(phone) {
        pendingAdminPhone = phone;
        $('#authScreen').style.display = 'none';
        $('#adminScreen').hidden = false;
        $('#mainApp').hidden = true;
        clearAdminOtp();
        setTimeout(() => $('.admin-otp').focus(), 100);
    }

    function bindAuth() {
        $$('.auth-tab').forEach(tab => {
            tab.onclick = () => {
                $$('.auth-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const t = tab.dataset.tab;
                $('#loginForm').classList.toggle('active', t === 'login');
                $('#registerForm').classList.toggle('active', t === 'register');
                $('#authError').textContent = '';
            };
        });

        // 登录
        $('#loginForm').onsubmit = (e) => {
            e.preventDefault();
            const phone = $('#loginPhone').value.trim();
            if (!/^1\d{10}$/.test(phone)) return authErr('请输入正确的 11 位手机号');
            const users = store.get(STORE.USERS, []);
            let u = users.find(x => x.phone === phone);
            if (!u) {
                u = {
                    phone, email: '无',
                    nickname: '用户' + phone.slice(-4),
                    avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
                    joinedGroups: [],
                    createdAt: Date.now()
                };
                users.push(u);
                store.set(STORE.USERS, users);
            }
            // 管理员需要密钥验证
            if (phone === ADMIN_PHONE) {
                showAdminKeyScreen(phone);
                return;
            }
            me = u;
            me.isAdmin = false;
            session.set(STORE.SESSION, { phone });
            enterApp();
        };

        // 注册
        $('#registerForm').onsubmit = (e) => {
            e.preventDefault();
            const phone = $('#regPhone').value.trim();
            const email = $('#regEmail').value.trim() || '无';
            const nickname = $('#regNickname').value.trim();
            if (!/^1\d{10}$/.test(phone)) return authErr('请输入正确的 11 位手机号');
            if (!nickname) return authErr('请输入昵称');
            const users = store.get(STORE.USERS, []);
            if (users.find(x => x.phone === phone)) return authErr('该手机号已注册，请直接登录');
            const u = {
                phone, email, nickname,
                avatar: selectedAvatar,
                joinedGroups: [],
                createdAt: Date.now()
            };
            users.push(u);
            store.set(STORE.USERS, users);
            if (phone === ADMIN_PHONE) {
                showAdminKeyScreen(phone);
                return;
            }
            me = u;
            me.isAdmin = false;
            session.set(STORE.SESSION, { phone });
            enterApp();
        };

        // 头像上传
        $('#avatarUploadBtn').onclick = () => $('#avatarUpload').click();
        $('#avatarUpload').onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            compressImage(file, 200, 200, 0.85, (dataUrl) => {
                selectedAvatar = dataUrl;
                $$('.avatar-opt', '#avatarGrid').forEach(x => x.classList.remove('selected'));
                const btn = $('#avatarUploadBtn');
                btn.textContent = '✓ 已选择照片（点击更换）';
                btn.classList.add('has-photo');
            });
            e.target.value = '';
        };
    }

    /* ---------- 管理员密钥验证 ---------- */
    function bindAdminKey() {
        const boxes = $$('.admin-otp');
        boxes.forEach((box, i) => {
            box.addEventListener('input', () => {
                box.value = box.value.replace(/\D/g, '').slice(-1);
                if (box.value) {
                    box.classList.add('filled');
                    if (i < boxes.length - 1) boxes[i + 1].focus();
                } else {
                    box.classList.remove('filled');
                }
                $('#adminError').textContent = '';
                $('#adminError').hidden = true;
                if (boxes.every(b => b.value)) submitAdminKey();
            });
            box.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !box.value && i > 0) {
                    boxes[i - 1].focus();
                    boxes[i - 1].value = '';
                    boxes[i - 1].classList.remove('filled');
                }
                if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
                if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
            });
            box.addEventListener('paste', (e) => {
                e.preventDefault();
                const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
                [...text].forEach((ch, j) => {
                    if (boxes[j]) { boxes[j].value = ch; boxes[j].classList.add('filled'); }
                });
                if (text.length === 6) submitAdminKey();
                else if (boxes[text.length]) boxes[text.length].focus();
            });
            box.addEventListener('focus', () => box.select());
        });
        $('#adminSubmit').onclick = submitAdminKey;
        $('#adminBack').onclick = () => {
            pendingAdminPhone = null;
            $('#adminScreen').hidden = true;
            $('#authScreen').style.display = 'flex';
            clearAdminOtp();
        };
    }

    function clearAdminOtp() {
        $$('.admin-otp').forEach(b => { b.value = ''; b.classList.remove('filled'); });
        $('#adminError').textContent = '';
        $('#adminError').hidden = true;
    }

    function submitAdminKey() {
        const code = $$('.admin-otp').map(b => b.value).join('');
        if (code.length !== 6) return;
        if (code !== ADMIN_KEY) {
            $('#adminError').textContent = '密钥错误，请重新输入';
            $('#adminError').hidden = false;
            const wrap = $('#adminOtpInputs');
            wrap.classList.add('shake');
            setTimeout(() => wrap.classList.remove('shake'), 500);
            setTimeout(() => {
                $$('.admin-otp').forEach(b => { b.value = ''; b.classList.remove('filled'); });
                $$('.admin-otp')[0].focus();
            }, 500);
            return;
        }
        // 验证通过
        const users = store.get(STORE.USERS, []);
        let u = users.find(x => x.phone === pendingAdminPhone);
        if (!u) {
            u = {
                phone: pendingAdminPhone, email: '无',
                nickname: '管理员',
                avatar: '👑',
                joinedGroups: [],
                createdAt: Date.now()
            };
            users.push(u);
            store.set(STORE.USERS, users);
        }
        me = u;
        me.isAdmin = true;
        session.set(STORE.SESSION, { phone: pendingAdminPhone });
        pendingAdminPhone = null;
        enterApp();
    }

    function compressImage(file, maxW, maxH, quality, cb) {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if (maxW === maxH) {
                    const size = Math.min(w, h);
                    canvas.width = maxW; canvas.height = maxH;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, (w - size) / 2, (h - size) / 2, size, size, 0, 0, maxW, maxH);
                } else {
                    if (w > maxW) { h = h * maxW / w; w = maxW; }
                    if (h > maxH) { w = w * maxH / h; h = maxH; }
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                }
                cb(canvas.toDataURL('image/jpeg', quality));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    }

    function authErr(msg) { $('#authError').textContent = msg; }

    /* ============================================================
       进入主应用
       ============================================================ */
    function enterApp() {
        $('#authScreen').style.display = 'none';
        $('#adminScreen').hidden = true;
        $('#mainApp').hidden = false;

        // 确保 joinedGroups 字段存在
        if (!me.joinedGroups) me.joinedGroups = [];

        fillProfile();
        startGlobalPresence();
        renderUsers();

        if (group) {
            enterGroupUI();
        } else {
            showInviteGate();
        }
        renderOnline();
        if (group) renderMessages();
    }

    function fillProfile() {
        const isImg = me.avatar && me.avatar.startsWith('data:');
        $('#heroAvatar').innerHTML = avatarHtml(me.avatar);
        $('#profileAvatar').innerHTML = avatarHtml(me.avatar);
        $('#profileNickname').textContent = me.nickname;
        $('#profileId').textContent = 'ID: ' + me.phone;
        $('#profilePhone').textContent = phoneMask(me.phone);
        $('#profileEmail').textContent = me.email || '无';
        $('#profileNickRow').textContent = me.nickname;
        $('#profileAvatarRow').innerHTML = isImg
            ? '<img src="' + me.avatar + '" alt="">'
            : '<span class="pr-avatar-emoji">' + escapeHtml(me.avatar) + '</span>';
        $('#adminBadge').hidden = !me.isAdmin;
        renderMyGroups();
    }

    /* ============================================================
       导航
       ============================================================ */
    function bindNav() {
        $$('.nav-item').forEach(item => {
            item.onclick = () => switchView(item.dataset.view);
        });
        $$('[data-goto]').forEach(b => {
            b.onclick = () => switchView(b.dataset.goto);
        });
    }

    function switchView(name) {
        activeView = name;
        $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === name));
        $$('.view').forEach(v => v.classList.toggle('active', v.id === name + 'View'));
        if (name === 'chat') {
            unreadCount = 0;
            updateBadge();
            if (group) {
                markAllRead();
                setTimeout(scrollMessages, 100);
            }
        }
        if (name === 'users') {
            renderUsers();
        }
        if (name === 'profile') {
            renderMyGroups();
        }
    }

    /* ============================================================
       邀请码 / 创建群聊 / 进入群聊
       ============================================================ */
    function bindChat() {
        setupOtp();

        $('#showCreateGroup').onclick = () => {
            $('#inviteCard').hidden = true;
            $('#createGroupCard').hidden = false;
            $('#createError').textContent = '';
            $('#groupName').focus();
        };
        $('#backToInvite').onclick = () => {
            $('#createGroupCard').hidden = true;
            $('#inviteCard').hidden = false;
            clearOtp();
            $('.otp-box').focus();
        };

        $('#createGroupBtn').onclick = createGroup;
        $('#groupCode').addEventListener('keydown', e => { if (e.key === 'Enter') createGroup(); });

        $('#backToGate').onclick = leaveGroup;

        const input = $('#composerInput');
        input.addEventListener('input', () => {
            $('#sendBtn').disabled = !input.textContent.trim();
            broadcastTyping(true);
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendText();
            }
        });
        $('#sendBtn').onclick = sendText;

        $('#imgBtn').onclick = () => $('#imgInput').click();
        $('#imgInput').onchange = (e) => {
            const file = e.target.files[0];
            if (file) sendImage(file);
            e.target.value = '';
        };

        $('#emojiBtn').onclick = (e) => {
            e.stopPropagation();
            $('#emojiPanel').hidden = !$('#emojiPanel').hidden;
        };
        document.addEventListener('click', (e) => {
            const panel = $('#emojiPanel');
            if (!panel.hidden && !panel.contains(e.target) && e.target !== $('#emojiBtn')) {
                panel.hidden = true;
            }
        });

        $('#onlineToggle').onclick = () => $('#onlinePanel').classList.toggle('show');
        $('#lightbox').onclick = () => $('#lightbox').hidden = true;
    }

    function setupOtp() {
        const boxes = $$('.otp-box');
        boxes.forEach((box, i) => {
            box.addEventListener('input', () => {
                box.value = box.value.slice(-1);
                if (box.value) {
                    box.classList.add('filled');
                    if (i < boxes.length - 1) boxes[i + 1].focus();
                } else {
                    box.classList.remove('filled');
                }
                $('#inviteError').textContent = '';
                $('#inviteError').hidden = true;
                boxes.forEach(b => b.classList.remove('error'));
                if (boxes.every(b => b.value)) submitInvite();
            });
            box.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !box.value && i > 0) {
                    boxes[i - 1].focus();
                    boxes[i - 1].value = '';
                    boxes[i - 1].classList.remove('filled');
                }
                if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
                if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
            });
            box.addEventListener('paste', (e) => {
                e.preventDefault();
                const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\s/g, '').slice(0, 6);
                [...text].forEach((ch, j) => {
                    if (boxes[j]) {
                        boxes[j].value = ch;
                        boxes[j].classList.add('filled');
                    }
                });
                if (text.length === 6) submitInvite();
                else if (boxes[text.length]) boxes[text.length].focus();
            });
            box.addEventListener('focus', () => box.select());
        });
        $('#inviteSubmit').onclick = submitInvite;
    }

    function getOtpCode() {
        return $$('.otp-box').map(b => b.value).join('').toUpperCase();
    }
    function clearOtp() {
        $$('.otp-box').forEach(b => { b.value = ''; b.classList.remove('filled', 'error'); });
        $('#inviteError').textContent = '';
        $('#inviteError').hidden = true;
    }

    function submitInvite() {
        const code = getOtpCode();
        if (code.length !== 6) return;
        const groups = store.get(STORE.GROUPS, []);
        const g = groups.find(x => x.code.toUpperCase() === code);
        if (!g) {
            $('#inviteError').textContent = '未找到该群聊，请检查邀请码后重新输入';
            $('#inviteError').hidden = false;
            const wrap = $('#otpInputs');
            wrap.classList.add('shake');
            setTimeout(() => wrap.classList.remove('shake'), 500);
            setTimeout(() => {
                $$('.otp-box').forEach(b => { b.value = ''; b.classList.remove('filled', 'error'); });
                $$('.otp-box')[0].focus();
            }, 500);
            return;
        }
        enterGroup(g);
    }

    function createGroup() {
        const name = $('#groupName').value.trim();
        const code = $('#groupCode').value.trim().toUpperCase();
        if (!name) return createErr('请输入群聊名称');
        if (!/^[A-Z0-9]{6}$/.test(code)) return createErr('邀请码须为 6 位字母或数字');
        const groups = store.get(STORE.GROUPS, []);
        if (groups.find(x => x.code.toUpperCase() === code)) return createErr('该邀请码已被使用，请换一个');
        const g = {
            code,
            name,
            avatar: selectedGroupAvatar,
            createdBy: me.phone,
            createdAt: Date.now()
        };
        groups.push(g);
        store.set(STORE.GROUPS, groups);
        enterGroup(g);
    }
    function createErr(msg) { $('#createError').textContent = msg; }

    function enterGroup(g) {
        group = g;
        // 记录用户加入的群
        addJoinedGroup(g.code);
        session.set(STORE.SESSION, { phone: me.phone, groupCode: g.code });
        enterGroupUI();
        startPresence();
        cleanupGroupMessages(g.code);
        renderMessages();
        renderOnline();
        markAllRead();
        setTimeout(scrollMessages, 150);
    }

    function addJoinedGroup(code) {
        if (!me.joinedGroups) me.joinedGroups = [];
        const upper = code.toUpperCase();
        if (!me.joinedGroups.includes(upper)) {
            me.joinedGroups.push(upper);
            const users = store.get(STORE.USERS, []);
            const idx = users.findIndex(x => x.phone === me.phone);
            if (idx >= 0) {
                users[idx].joinedGroups = me.joinedGroups;
                store.set(STORE.USERS, users);
            }
        }
    }

    function enterGroupUI() {
        $('#inviteGate').style.display = 'none';
        $('#chatRoom').hidden = false;
        $('#createGroupCard').hidden = true;
        $('#inviteCard').hidden = false;

        $('#chatAvatar').textContent = group.avatar;
        $('#chatName').textContent = group.name;
        $('#opGroupAvatar').textContent = group.avatar;
        $('#opGroupName').textContent = group.name;
        $('#opGroupCode').textContent = '邀请码：' + group.code;
    }

    function showInviteGate() {
        $('#inviteGate').style.display = 'flex';
        $('#chatRoom').hidden = true;
        stopPresence();
        clearOtp();
    }

    function leaveGroup() {
        stopPresence();
        if (group) {
            const p = store.get(presKey(group.code), {});
            delete p[me.phone];
            store.set(presKey(group.code), p);
        }
        group = null;
        session.set(STORE.SESSION, { phone: me.phone });
        showInviteGate();
    }

    /* ============================================================
       30 天消息过期
       ============================================================ */
    function cleanupGroupMessages(code) {
        const key = msgKey(code);
        const msgs = store.get(key, []);
        const cutoff = Date.now() - MSG_TTL;
        const filtered = msgs.filter(m => m.ts > cutoff);
        if (filtered.length !== msgs.length) {
            store.set(key, filtered);
        }
    }

    function cleanupOldMessages() {
        const groups = store.get(STORE.GROUPS, []);
        groups.forEach(g => cleanupGroupMessages(g.code));
    }

    function getGroupMessages(code) {
        cleanupGroupMessages(code);
        return store.get(msgKey(code), []);
    }

    /* ============================================================
       消息：发送
       ============================================================ */
    function sendText() {
        const input = $('#composerInput');
        const text = input.textContent.trim();
        if (!text || !group) return;
        pushMessage({ type: 'text', content: text });
        input.textContent = '';
        $('#sendBtn').disabled = true;
        broadcastTyping(false);
    }

    function sendImage(file) {
        if (!file.type.startsWith('image/') || !group) return;
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let { width, height } = img;
                const max = 1000;
                if (width > max || height > max) {
                    if (width > height) { height = height * max / width; width = max; }
                    else { width = width * max / height; height = max; }
                }
                canvas.width = width; canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                pushMessage({ type: 'image', content: canvas.toDataURL('image/jpeg', 0.75) });
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    }

    function pushMessage(partial) {
        const msg = Object.assign({
            id: uid(),
            groupCode: group.code,
            phone: me.phone,
            nickname: me.nickname,
            avatar: me.avatar,
            ts: Date.now(),
            readBy: []
        }, partial);

        const msgs = getGroupMessages(group.code);
        msgs.push(msg);
        store.set(msgKey(group.code), msgs);

        appendMessage(msg, true);
        scrollMessages();
        postMessage({ kind: 'msg', msg });
    }

    /* ============================================================
       消息：渲染
       ============================================================ */
    function renderMessages() {
        const box = $('#messages');
        box.innerHTML = '';
        lastRenderedDay = null;
        lastSender = null;
        if (!group) return;
        const msgs = getGroupMessages(group.code);
        msgs.forEach(m => appendMessage(m, false));
        updateReadReceipts();
    }

    function appendMessage(m, scroll) {
        const box = $('#messages');

        if (!lastRenderedDay || !isSameDay(lastRenderedDay, m.ts)) {
            lastRenderedDay = m.ts;
            lastSender = null;
            const sep = document.createElement('div');
            sep.className = 'day-sep';
            sep.innerHTML = '<span>' + fmtDay(m.ts) + '</span>';
            box.appendChild(sep);
        }

        const isMe = m.phone === me.phone;
        const grouped = lastSender === m.phone;
        lastSender = m.phone;

        const row = document.createElement('div');
        row.className = 'msg-row ' + (isMe ? 'me' : 'other') + (grouped ? ' grouped' : '');
        row.dataset.id = m.id;

        let bubbleHtml;
        if (m.type === 'image') {
            bubbleHtml = '<div class="bubble image"><img src="' + m.content + '" alt="图片" loading="lazy"></div>';
        } else {
            bubbleHtml = '<div class="bubble ' + (isMe ? 'out' : 'in') + '">' + linkify(m.content) + '</div>';
        }

        row.innerHTML =
            '<div class="msg-avatar">' + avatarHtml(m.avatar) + '</div>' +
            '<div class="msg-body">' +
                (!isMe ? '<div class="msg-sender">' + escapeHtml(m.nickname) + '</div>' : '') +
                bubbleHtml +
                '<div class="msg-time">' + fmtTime(m.ts) + '</div>' +
                (isMe ? '<div class="read-receipt" data-id="' + m.id + '">送达</div>' : '') +
            '</div>';

        const img = row.querySelector('.bubble.image img');
        if (img) img.onclick = () => {
            $('#lightboxImg').src = m.content;
            $('#lightbox').hidden = false;
        };

        box.appendChild(row);
        if (scroll) scrollMessages();

        if (!isMe && activeView !== 'chat') {
            unreadCount++;
            updateBadge();
        }
    }

    function scrollMessages() {
        const box = $('#messages');
        box.scrollTop = box.scrollHeight;
    }

    /* ============================================================
       已读回执
       ============================================================ */
    function markAllRead() {
        if (!group) return;
        const key = msgKey(group.code);
        const msgs = store.get(key, []);
        let changed = false;
        msgs.forEach(m => {
            if (m.phone !== me.phone && !m.readBy.includes(me.phone)) {
                m.readBy.push(me.phone);
                changed = true;
            }
        });
        if (changed) {
            store.set(key, msgs);
            postMessage({ kind: 'read', groupCode: group.code, phone: me.phone });
        }
        updateReadReceipts();
    }

    function updateReadReceipts() {
        if (!group) return;
        const msgs = store.get(msgKey(group.code), []);
        const myMsgs = msgs.filter(m => m.phone === me.phone);
        if (!myMsgs.length) return;
        const last = myMsgs[myMsgs.length - 1];
        const readers = last.readBy.filter(p => p !== me.phone);

        $$('.read-receipt').forEach(el => {
            if (el.dataset.id === last.id) {
                if (readers.length > 0) {
                    el.className = 'read-receipt read';
                    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 12 7 17 14 7"/><polyline points="10 17 22 7"/></svg> 已读' + (readers.length > 1 ? ' (' + readers.length + ')' : '');
                } else {
                    el.className = 'read-receipt';
                    el.textContent = '送达';
                }
            } else {
                el.textContent = '';
            }
        });
    }

    /* ============================================================
       在线状态（群内）
       ============================================================ */
    function startPresence() {
        stopPresence();
        beat();
        heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
        presenceTimer = setInterval(() => {
            renderOnline();
            cleanupPresence();
        }, 2000);
        window.addEventListener('beforeunload', onUnload);
    }

    function stopPresence() {
        clearInterval(heartbeatTimer);
        clearInterval(presenceTimer);
        heartbeatTimer = null;
        presenceTimer = null;
        window.removeEventListener('beforeunload', onUnload);
    }

    function onUnload() {
        if (!me) return;
        // 清除群内在线状态
        if (group) {
            const p = store.get(presKey(group.code), {});
            delete p[me.phone];
            store.set(presKey(group.code), p);
        }
        // 更新全局最后在线时间（不删除，保留"上次在线"记录）
        const up = store.get(STORE.USERPRES, {});
        if (up[me.phone]) {
            up[me.phone].lastSeen = Date.now();
            store.set(STORE.USERPRES, up);
        }
    }

    function beat() {
        if (!group) return;
        const key = presKey(group.code);
        const p = store.get(key, {});
        p[me.phone] = {
            nickname: me.nickname,
            avatar: me.avatar,
            lastSeen: Date.now(),
            typing: !!(p[me.phone] && p[me.phone].typing)
        };
        store.set(key, p);
    }

    function cleanupPresence() {
        if (!group) return;
        const key = presKey(group.code);
        const p = store.get(key, {});
        const now = Date.now();
        let changed = false;
        Object.keys(p).forEach(k => {
            if (now - p[k].lastSeen > PRESENCE_TIMEOUT) {
                delete p[k]; changed = true;
            }
        });
        if (changed) store.set(key, p);
    }

    function getOnlineUsers() {
        if (!group) return [];
        cleanupPresence();
        const p = store.get(presKey(group.code), {});
        return Object.entries(p)
            .map(([phone, v]) => ({ phone, ...v }))
            .sort((a, b) => a.phone === me.phone ? -1 : b.phone === me.phone ? 1 : a.nickname.localeCompare(b.nickname));
    }

    function renderOnline() {
        if (!group) return;
        const users = getOnlineUsers();
        const list = $('#onlineList');
        list.innerHTML = '';

        users.forEach(u => {
            const row = document.createElement('div');
            row.className = 'online-user';
            row.innerHTML =
                '<div class="ou-avatar">' + avatarHtml(u.avatar) + '<span class="ou-dot"></span></div>' +
                '<div class="ou-info">' +
                    '<div class="ou-name">' + escapeHtml(u.nickname) + (u.phone === me.phone ? ' <span class="ou-self">（我）</span>' : '') + '</div>' +
                    '<div class="ou-status">' + (u.typing && u.phone !== me.phone ? '输入中…' : '在线') + '</div>' +
                '</div>';
            list.appendChild(row);
        });

        $('#onlineCount').textContent = users.length;
        $('#chatStatus').textContent = users.length + ' 人在线';

        const ha = $('#headerAvatars');
        ha.innerHTML = '';
        users.slice(0, 4).forEach(u => {
            const d = document.createElement('div');
            d.className = 'ha';
            d.innerHTML = avatarHtml(u.avatar);
            d.title = u.nickname;
            ha.appendChild(d);
        });

        const typers = users.filter(u => u.typing && u.phone !== me.phone);
        const wrap = $('#typingWrap');
        if (typers.length) {
            wrap.hidden = false;
            $('#typingName').textContent = typers.map(t => t.nickname).join('、') + ' 正在输入…';
        } else {
            wrap.hidden = true;
        }
    }

    /* ============================================================
       全局用户在线状态（用于用户列表）
       ============================================================ */
    function startGlobalPresence() {
        globalBeat();
        if (globalPresTimer) clearInterval(globalPresTimer);
        globalPresTimer = setInterval(globalBeat, HEARTBEAT_MS);
        window.addEventListener('beforeunload', onUnload);
    }

    function globalBeat() {
        if (!me) return;
        const up = store.get(STORE.USERPRES, {});
        up[me.phone] = {
            nickname: me.nickname,
            avatar: me.avatar,
            lastSeen: Date.now()
        };
        store.set(STORE.USERPRES, up);
    }

    function isUserOnline(phone) {
        const up = store.get(STORE.USERPRES, {});
        return up[phone] && (Date.now() - up[phone].lastSeen < PRESENCE_TIMEOUT);
    }

    function getUserLastSeen(phone) {
        const up = store.get(STORE.USERPRES, {});
        return up[phone] ? up[phone].lastSeen : 0;
    }

    /* ============================================================
       输入中
       ============================================================ */
    function broadcastTyping(typing) {
        if (!group) return;
        const key = presKey(group.code);
        const p = store.get(key, {});
        if (p[me.phone]) {
            p[me.phone].typing = typing;
            p[me.phone].lastSeen = Date.now();
            store.set(key, p);
        }
        postMessage({ kind: 'typing', groupCode: group.code, phone: me.phone, nickname: me.nickname, typing });

        clearTimeout(typingTimer);
        if (typing) {
            typingTimer = setTimeout(() => broadcastTyping(false), TYPING_TIMEOUT);
        }
    }

    /* ============================================================
       跨标签通信
       ============================================================ */
    function postMessage(data) {
        if (channel) channel.postMessage(data);
    }

    function onChannelMessage(e) { handleRemote(e.data); }

    function onStorage(e) {
        if (!me) return;
        if (e.key === STORE.USERS || e.key === STORE.USERPRES) {
            if (activeView === 'users') renderUsers();
            return;
        }
        if (!group) return;
        if (e.key === msgKey(group.code)) {
            const msgs = store.get(msgKey(group.code), []);
            const box = $('#messages');
            const existing = new Set([...box.querySelectorAll('.msg-row')].map(r => r.dataset.id));
            msgs.forEach(m => { if (!existing.has(m.id)) onRemoteMessage(m); });
            updateReadReceipts();
        } else if (e.key === presKey(group.code)) {
            renderOnline();
            updateReadReceipts();
        }
    }

    function handleRemote(data) {
        if (!data || !me) return;
        if (data.groupCode && group && data.groupCode.toUpperCase() !== group.code.toUpperCase()) return;
        switch (data.kind) {
            case 'msg':
                onRemoteMessage(data.msg);
                break;
            case 'typing':
                onRemoteTyping(data);
                break;
            case 'read':
                updateReadReceipts();
                break;
        }
    }

    function onRemoteMessage(m) {
        if (m.phone === me.phone) return;
        if (group && m.groupCode && m.groupCode.toUpperCase() !== group.code.toUpperCase()) return;
        appendMessage(m, true);
        if (activeView === 'chat') markAllRead();
    }

    function onRemoteTyping(data) {
        if (!group) return;
        const key = presKey(group.code);
        const p = store.get(key, {});
        if (p[data.phone]) {
            p[data.phone].typing = data.typing;
            store.set(key, p);
        }
        renderOnline();
    }

    /* ============================================================
       用户列表
       ============================================================ */
    function renderUsers() {
        const users = store.get(STORE.USERS, []);
        const list = $('#usersList');
        list.innerHTML = '';

        const sorted = [...users].sort((a, b) => {
            const ao = isUserOnline(a.phone) ? 1 : 0;
            const bo = isUserOnline(b.phone) ? 1 : 0;
            if (ao !== bo) return bo - ao;
            return (getUserLastSeen(b.phone) || 0) - (getUserLastSeen(a.phone) || 0);
        });

        $('#usersSubtitle').textContent = '共 ' + users.length + ' 位用户' + (me.isAdmin ? '（点击用户可管理）' : '');

        sorted.forEach(u => {
            const online = isUserOnline(u.phone);
            const lastSeen = getUserLastSeen(u.phone);
            const groupCount = (u.joinedGroups || []).length;
            const isMe = u.phone === me.phone;
            const isAdminUser = u.phone === ADMIN_PHONE;

            const card = document.createElement('div');
            card.className = 'user-card glass' + (me.isAdmin && !isMe ? ' clickable' : '');

            let lastSeenText = '从未上线';
            if (online) {
                lastSeenText = '在线';
            } else if (lastSeen) {
                lastSeenText = '上次在线 ' + fmtDateTime(lastSeen);
            }

            card.innerHTML =
                '<div class="uc-avatar">' + avatarHtml(u.avatar) +
                    '<span class="uc-dot ' + (online ? 'online' : 'offline') + '"></span>' +
                '</div>' +
                '<div class="uc-info">' +
                    '<div class="uc-name">' + escapeHtml(u.nickname) +
                        (isMe ? ' <span class="ou-self">（我）</span>' : '') +
                        (isAdminUser ? '<span class="uc-admin-tag">管理员</span>' : '') +
                    '</div>' +
                    '<div class="uc-meta">📱 ' + phoneMask(u.phone) + ' · 💬 ' + groupCount + ' 个群聊</div>' +
                    '<div class="uc-status ' + (online ? 'online' : 'offline') + '">' + lastSeenText + '</div>' +
                '</div>' +
                (me.isAdmin && !isMe ? '<div class="uc-arrow">›</div>' : '');

            if (me.isAdmin && !isMe) {
                card.onclick = () => openAdminPanel(u);
            }
            list.appendChild(card);
        });
    }

    /* ============================================================
       我的群聊
       ============================================================ */
    function renderMyGroups() {
        const list = $('#myGroupsList');
        list.innerHTML = '';
        const codes = me.joinedGroups || [];
        const groups = store.get(STORE.GROUPS, []);

        if (!codes.length) {
            list.innerHTML = '<div class="mg-empty">还没有加入任何群聊，去聊天页输入邀请码吧</div>';
            return;
        }

        const items = codes.map(code => {
            const g = groups.find(x => x.code.toUpperCase() === code.toUpperCase());
            if (!g) return null;
            const msgs = store.get(msgKey(g.code), []);
            const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
            return { g, lastMsg };
        }).filter(Boolean).sort((a, b) => {
            const ta = a.lastMsg ? a.lastMsg.ts : 0;
            const tb = b.lastMsg ? b.lastMsg.ts : 0;
            return tb - ta;
        });

        if (!items.length) {
            list.innerHTML = '<div class="mg-empty">还没有加入任何群聊</div>';
            return;
        }

        items.forEach(({ g, lastMsg }) => {
            const item = document.createElement('div');
            item.className = 'mg-item';
            const timeText = lastMsg ? fmtDateTime(lastMsg.ts) : '暂无消息';
            item.innerHTML =
                '<div class="mg-avatar">' + avatarHtml(g.avatar) + '</div>' +
                '<div class="mg-info">' +
                    '<div class="mg-name">' + escapeHtml(g.name) + '</div>' +
                    '<div class="mg-code">邀请码：' + escapeHtml(g.code) + '</div>' +
                '</div>' +
                '<div class="mg-time">' + timeText + '</div>';
            item.onclick = () => {
                switchView('chat');
                enterGroup(g);
            };
            list.appendChild(item);
        });
    }

    /* ============================================================
       管理员面板
       ============================================================ */
    let adminTargetUser = null;

    function bindAdminPanel() {
        $('#apClose').onclick = closeAdminPanel;
        $('#apBack').onclick = closeAdminPanel;
        $('#amClose').onclick = closeMsgViewer;
        $('#amBack').onclick = closeMsgViewer;
        $('#adminPanel').onclick = (e) => {
            if (e.target === $('#adminPanel')) closeAdminPanel();
        };
        $('#adminMsgViewer').onclick = (e) => {
            if (e.target === $('#adminMsgViewer')) closeMsgViewer();
        };
    }

    function openAdminPanel(u) {
        adminTargetUser = u;
        const users = store.get(STORE.USERS, []);
        const fresh = users.find(x => x.phone === u.phone) || u;

        $('#apAvatar').innerHTML = avatarHtml(fresh.avatar);
        $('#apName').textContent = fresh.nickname;
        $('#apPhone').textContent = phoneMask(fresh.phone);
        $('#apEmail').textContent = fresh.email || '无';
        $('#apCreated').textContent = fresh.createdAt ? fmtDateTime(fresh.createdAt) : '未知';

        const groups = store.get(STORE.GROUPS, []);
        const userGroups = (fresh.joinedGroups || [])
            .map(code => groups.find(g => g.code.toUpperCase() === code.toUpperCase()))
            .filter(Boolean);

        // 也包含该用户创建但不在 joinedGroups 中的群
        groups.forEach(g => {
            if (g.createdBy === fresh.phone && !userGroups.find(ug => ug.code === g.code)) {
                userGroups.push(g);
            }
        });

        $('#apGroupCount').textContent = userGroups.length + ' 个';

        const list = $('#apGroups');
        list.innerHTML = '';

        if (!userGroups.length) {
            list.innerHTML = '<div class="ap-empty">该用户暂无群聊</div>';
        } else {
            userGroups.forEach(g => {
                const msgs = store.get(msgKey(g.code), []);
                const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
                const div = document.createElement('div');
                div.className = 'ap-group';
                div.innerHTML =
                    '<div class="ap-group-head">' +
                        '<div class="apg-avatar">' + avatarHtml(g.avatar) + '</div>' +
                        '<div class="apg-info">' +
                            '<div class="apg-name">' + escapeHtml(g.name) + '</div>' +
                            '<div class="apg-meta">邀请码：' + escapeHtml(g.code) + ' · ' + msgs.length + ' 条消息' +
                                (lastMsg ? ' · 最后 ' + fmtDateTime(lastMsg.ts) : '') +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="ap-group-actions">' +
                        '<button class="ap-btn ap-btn-view" data-act="view" data-code="' + g.code + '">查看消息</button>' +
                        '<button class="ap-btn ap-btn-clear" data-act="clear" data-code="' + g.code + '">清空消息</button>' +
                        '<button class="ap-btn ap-btn-delete" data-act="delete" data-code="' + g.code + '">删除群聊</button>' +
                    '</div>';
                list.appendChild(div);
            });

            list.onclick = (e) => {
                const btn = e.target.closest('.ap-btn');
                if (!btn) return;
                const code = btn.dataset.code;
                const act = btn.dataset.act;
                const g = groups.find(x => x.code.toUpperCase() === code.toUpperCase());
                if (!g) return;

                if (act === 'view') {
                    openMsgViewer(g);
                } else if (act === 'clear') {
                    showConfirm('⚠️', '清空消息', '确定要清空「' + g.name + '」的所有聊天记录吗？此操作不可恢复。', () => {
                        store.del(msgKey(g.code));
                        openAdminPanel(adminTargetUser);
                        renderUsers();
                    });
                } else if (act === 'delete') {
                    showConfirm('🗑️', '删除群聊', '确定要删除群聊「' + g.name + '」吗？所有消息和成员关联将被清除，此操作不可恢复。', () => {
                        deleteGroup(g.code);
                        openAdminPanel(adminTargetUser);
                        renderUsers();
                        renderMyGroups();
                    });
                }
            };
        }

        $('#adminPanel').hidden = false;
    }

    function closeAdminPanel() {
        $('#adminPanel').hidden = true;
        adminTargetUser = null;
    }

    function deleteGroup(code) {
        const upper = code.toUpperCase();
        // 删除群
        let groups = store.get(STORE.GROUPS, []);
        groups = groups.filter(g => g.code.toUpperCase() !== upper);
        store.set(STORE.GROUPS, groups);
        // 删除消息和在线状态
        store.del(msgKey(upper));
        store.del(presKey(upper));
        // 从所有用户的 joinedGroups 中移除
        const users = store.get(STORE.USERS, []);
        users.forEach(u => {
            if (u.joinedGroups) {
                u.joinedGroups = u.joinedGroups.filter(c => c.toUpperCase() !== upper);
            }
        });
        store.set(STORE.USERS, users);
        me.joinedGroups = (me.joinedGroups || []).filter(c => c.toUpperCase() !== upper);
        // 如果当前正在这个群里，退出
        if (group && group.code.toUpperCase() === upper) {
            group = null;
            session.set(STORE.SESSION, { phone: me.phone });
            showInviteGate();
        }
    }

    /* ---------- 管理员消息查看器 ---------- */
    function openMsgViewer(g) {
        $('#amAvatar').textContent = g.avatar;
        $('#amName').textContent = g.name;
        $('#amCode').textContent = '邀请码：' + g.code;

        const box = $('#adminMessages');
        box.innerHTML = '';
        const msgs = getGroupMessages(g.code);

        if (!msgs.length) {
            box.innerHTML = '<div class="ap-empty">该群暂无消息</div>';
        } else {
            let lastDay = null, lastSnd = null;
            msgs.forEach(m => {
                if (!lastDay || !isSameDay(lastDay, m.ts)) {
                    lastDay = m.ts;
                    lastSnd = null;
                    const sep = document.createElement('div');
                    sep.className = 'day-sep';
                    sep.innerHTML = '<span>' + fmtDay(m.ts) + '</span>';
                    box.appendChild(sep);
                }
                const isMe = m.phone === me.phone;
                const grouped = lastSnd === m.phone;
                lastSnd = m.phone;

                const row = document.createElement('div');
                row.className = 'msg-row ' + (isMe ? 'me' : 'other') + (grouped ? ' grouped' : '');

                let bubbleHtml;
                if (m.type === 'image') {
                    bubbleHtml = '<div class="bubble image"><img src="' + m.content + '" alt="图片" loading="lazy"></div>';
                } else {
                    bubbleHtml = '<div class="bubble ' + (isMe ? 'out' : 'in') + '">' + linkify(m.content) + '</div>';
                }

                row.innerHTML =
                    '<div class="msg-avatar">' + avatarHtml(m.avatar) + '</div>' +
                    '<div class="msg-body">' +
                        (!isMe ? '<div class="msg-sender">' + escapeHtml(m.nickname) + '</div>' : '') +
                        bubbleHtml +
                        '<div class="msg-time">' + fmtTime(m.ts) + '</div>' +
                    '</div>';

                const img = row.querySelector('.bubble.image img');
                if (img) img.onclick = () => {
                    $('#lightboxImg').src = m.content;
                    $('#lightbox').hidden = false;
                };

                box.appendChild(row);
            });
        }

        $('#adminPanel').hidden = true;
        $('#adminMsgViewer').hidden = false;
        setTimeout(() => box.scrollTop = box.scrollHeight, 50);
    }

    function closeMsgViewer() {
        $('#adminMsgViewer').hidden = true;
        if (adminTargetUser) {
            $('#adminPanel').hidden = false;
        }
    }

    /* ============================================================
       确认对话框
       ============================================================ */
    let confirmCallback = null;

    function bindConfirm() {
        $('#confirmCancel').onclick = () => {
            $('#confirmDialog').hidden = true;
            confirmCallback = null;
        };
        $('#confirmOk').onclick = () => {
            $('#confirmDialog').hidden = true;
            if (confirmCallback) confirmCallback();
            confirmCallback = null;
        };
    }

    function showConfirm(icon, title, msg, cb) {
        $('#confirmIcon').textContent = icon;
        $('#confirmTitle').textContent = title;
        $('#confirmMsg').textContent = msg;
        confirmCallback = cb;
        $('#confirmDialog').hidden = false;
    }

    /* ============================================================
       我的 / 退出 / 注销
       ============================================================ */
    function bindProfile() {
        $('#logoutBtn').onclick = () => {
            cleanupOnExit();
            session.del(STORE.SESSION);
            me = null;
            group = null;
            location.reload();
        };

        $('#deleteAccountBtn').onclick = () => {
            showConfirm('⚠️', '注销账号', '确定要注销账号「' + me.nickname + '」吗？\n你的账号信息将被永久删除，群聊消息会保留但不再关联你的账号。此操作不可恢复。', () => {
                deleteAccount();
            });
        };
    }

    function cleanupOnExit() {
        if (group) {
            const p = store.get(presKey(group.code), {});
            delete p[me.phone];
            store.set(presKey(group.code), p);
        }
        // 更新最后在线时间（不删除，保留"上次在线"记录）
        const up = store.get(STORE.USERPRES, {});
        if (up[me.phone]) {
            up[me.phone].lastSeen = Date.now();
            store.set(STORE.USERPRES, up);
        }
        stopPresence();
        if (globalPresTimer) { clearInterval(globalPresTimer); globalPresTimer = null; }
    }

    function deleteAccount() {
        const phone = me.phone;
        // 从用户列表删除
        let users = store.get(STORE.USERS, []);
        users = users.filter(u => u.phone !== phone);
        store.set(STORE.USERS, users);
        // 从所有群的在线状态删除
        const groups = store.get(STORE.GROUPS, []);
        groups.forEach(g => {
            const p = store.get(presKey(g.code), {});
            delete p[phone];
            store.set(presKey(g.code), p);
        });
        // 从全局在线状态删除
        const up = store.get(STORE.USERPRES, {});
        delete up[phone];
        store.set(STORE.USERPRES, up);
        // 清除会话
        cleanupOnExit();
        session.del(STORE.SESSION);
        me = null;
        group = null;
        location.reload();
    }

    /* ============================================================
       未读角标
       ============================================================ */
    function updateBadge() {
        const b = $('#navBadge');
        if (unreadCount > 0) {
            b.hidden = false;
            b.textContent = unreadCount > 99 ? '99+' : unreadCount;
        } else {
            b.hidden = true;
        }
    }

    /* ---------- 启动 ---------- */
    document.addEventListener('DOMContentLoaded', init);
})();
