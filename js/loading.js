/* ============================================================
   Stating · 高级加载动效层 loading.js
   ------------------------------------------------------------
   对外只暴露一个全局 LP（Loading Progression），不改动
   script.js / data-cache.js / style.css 的任何既有逻辑。
   挂载方式：index.html 以 <script defer> 在 script.js 之前引入。

   能力：
     LP.top.start(weight) → 句柄 / LP.top.done(句柄)   顶部进度条
       （也支持 LP.top.done() 无参调用，按 FIFO 出队最早的一笔）
     LP.top.set(p)                             手动设置绝对进度
     LP.splash.boot() / step(id, label)        启动页（真实进度）
     LP.upload.begin() / set() / done() / fail() / close()
                                                  上传进度卡
     LP.watchFetch()                           给 window.fetch 挂进度条
     LP.watchMessages()                        给乐观消息气泡挂微状态

   全部动画在 prefers-reduced-motion: reduce 下降级为静态（见 loading.css）。
   代码中零 innerHTML（只用 createElement + textContent），不注入任何外部数据。
   ============================================================ */

(function (global) {
  'use strict';

  /* ---------------- 动效偏好探测 ---------------- */
  var reduceMotion = global.matchMedia
    ? global.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  /* ---------------- 小工具 ---------------- */
  function el(tag, cls, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (parent) parent.appendChild(node);
    return node;
  }

  /** 数字限幅 */
  function clamp01(n) {
    n = typeof n === 'number' && isFinite(n) ? n : 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  /** 时长档位（与 loading.css 的 --lp-d-* 变量一一对应，改一处要同步另一处） */
  var D = {
    micro: 150,      // 微交互
    ui: 200,         // 标准 UI
    page: 300,       // 整页级进入
    pageExit: 240,   // 整页级退出（比进入快约 20%）
    cardExit: 160    // 卡片退出（比 200ms 进入快约 20%）
  };

  /** 把进度 0~1 写进填充条的 transform: scaleX()。
   * 刻意不用 style.width —— 动画 width 会每帧触发重排，
   * 违反「只动画 transform / opacity」的动效规范（GPU 友好）。
   * @param {Element} node 填充条元素
   * @param {number} p 进度 0~1
   */
  function setScale(node, p) {
    if (!node || !node.style) return;
    node.style.transform = 'scaleX(' + clamp01(p).toFixed(4) + ')';
  }

  /** 字节数格式化 */
  function fmtBytes(n) {
    if (!n || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /**
   * 把原始请求的 body 换算成字节数。
   * 只做体积估算，不解析内容、不落盘。
   */
  function byteLengthOf(body) {
    if (body == null) return 0;
    if (typeof body === 'string') return body.length; // UTF-16 近似，够用于进度估算
    if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return body.byteLength;
    try {
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) return body.byteLength;
    } catch (e) { /* 忽略：老浏览器无 isView */ }
    return 0;
  }

  /* ============================================================
     ② 顶部进度条
     ------------------------------------------------------------
     用「加权计数」而非单条百分比：多条并发请求各自占一份权重，
     全部完成才到 100%。避免"一条慢请求把整条条拉满/拉空"。
     ============================================================ */

  var top = (function () {
    var root = null, fill = null;
    var pending = [];     // 在途请求的权重队列（FIFO，先进先出）
    var value = 0;       // 当前显示进度 0~1
    var shown = false;
    var hideTimer = 0;
    var indeterminateTimer = 0;
    var STALL_MS = 220;  // 超过该时长没有新事件则切到不确定扫动

    function ensure() {
      if (root) return;
      root = el('div', 'lp-topbar');
      root.setAttribute('role', 'progressbar');
      root.setAttribute('aria-label', '页面加载进度');
      root.setAttribute('aria-valuemin', '0');
      root.setAttribute('aria-valuemax', '100');
      fill = el('div', 'lp-topbar-fill', root);
      document.body.appendChild(root);
    }

    /** 把进度 0~1 写进填充条的 transform: scaleX()。
        刻意不用 style.width —— 动画 width 会每帧触发重排，不符合
        「只动画 transform / opacity」的动效规范。 */
    function render() {
      if (!root) return;
      setScale(fill, value);
      root.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    }

    /** 平滑逼近目标值，避免进度条一跳一跳 */
    function glide(target) {
      if (reduceMotion) { value = target; render(); return; }
      if (glide._raf) cancelAnimationFrame(glide._raf);
      glide._target = target;
      var step = function () {
        var diff = glide._target - value;   // 每帧基于当前值重算，不能用固定 from
        if (Math.abs(diff) < 0.002) {
          value = glide._target;
          glide._raf = 0;
          render();
          return;
        }
        value += diff * 0.22;
        if (value < 0) value = 0;
        if (value > 1) value = 1;
        render();
        glide._raf = requestAnimationFrame(step);
      };
      glide._raf = requestAnimationFrame(step);
    }

    function show() {
      ensure();
      shown = true;
      clearTimeout(hideTimer);
      root.classList.add('lp-on');
    }

    /** 开始一组加载。weight 越大在总进度里占比越高（默认 1）。
        返回一个句柄，交给 done(handle) 精确归还，避免多退/少退。 */
    function start(weight) {
      show();
      var w = (typeof weight === 'number' && weight > 0) ? weight : 1;
      var handle = { w: w, settled: false };
      pending.push(handle);
      root.classList.remove('lp-indeterminate');
      // 先回退一点，暗示"新的一段开始了"
      if (value > 0.35) glide(Math.max(0.12, value * 0.62));

      // 长时间无进展就切不确定态，而不是停在原地装死
      clearTimeout(indeterminateTimer);
      indeterminateTimer = setTimeout(function () {
        if (pending.length && value < 0.98) root.classList.add('lp-indeterminate');
      }, STALL_MS + 2600);
      return handle;
    }

    /** 手动设置绝对进度 0~1（用于已知总量的分片流程）。 */
    function set(p) {
      show();
      glide(clamp01(p));
    }

    /** 结束一组加载。可传start() 返回的句柄；不传则出队最早的。 */
    function done(handle) {
      if (handle && typeof handle === 'object' && !handle.settled) {
        handle.settled = true;
        var i = pending.indexOf(handle);
        if (i >= 0) pending.splice(i, 1);
      } else {
        // 无句柄时出队最早的一笔（保持与旧调用方式兼容）
        var first = pending.shift();
        if (first) first.settled = true;
      }

      clearTimeout(indeterminateTimer);
      if (pending.length) return;   // 还有在途，继续显示
      root.classList.remove('lp-indeterminate');
      glide(1);
      root.classList.add('lp-flash');
      hideTimer = setTimeout(function () {
        if (root) {
          root.classList.remove('lp-on', 'lp-flash');
          value = 0;   // 复位，供下次使用
          render();
        }
        shown = false;
      }, reduceMotion ? D.micro : D.micro + 150);
    }

    return {
      start: start,
      set: set,
      done: done,
      /** 供外部查询，供测试/调试用 */
      _state: function () { return { active: pending.length, value: value, shown: shown }; }
    };
  })();

  /* ============================================================
     ① 启动页 Splash
     ------------------------------------------------------------
     进度是「真实的」：由若干个可验证的里程碑驱动，
     每个里程碑对应一个真实的、可被观察到的事实：
       - DOM 已就绪
       - 关键样式表已加载（document.styleSheets 可见）
       - 关键脚本已就绪（window.renderMessages 等已挂上）
       - 应用外壳已可见（#mainApp 或 #auth 之一解除 hidden）
     不用定时器伪造百分比，只用 setTimeout 做「兜底超时退出」。
     会话内只显示一次（sessionStorage），避免每次刷新都闪。
     ============================================================ */

  var splash = (function () {
    var SESSION_KEY = 'stating_splash_seen';
    var root = null, fill = null, pctNode = null, subNode = null;
    var seen = false;
    var done = false;
    var STEPS = 5;          // 里程碑总数
    var reached = 0;        // 已达成的里程碑数
    var booted = false;     // 是否已经尝试过启动
    var listeners = [];

    function alreadySeen() {
      try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch (e) { return false; }
    }

    function markSeen() {
      try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) { /* 隐私模式下忽略 */ }
    }

    function build() {
      root = el('div', 'lp-splash');
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      root.setAttribute('aria-label', 'Stating 正在启动');

      var mark = el('div', 'lp-splash-mark', root);
      // 品牌字：取站点标题首字母，纯文本节点，无注入风险
      var brand = ((document.title || 'Stating').trim()[0] || 'S').toUpperCase();
      mark.textContent = brand;

      el('div', 'lp-splash-title', root).textContent = 'Stating';
      subNode = el('div', 'lp-splash-sub', root);

      var track = el('div', 'lp-splash-track', root);
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      fill = el('div', 'lp-splash-fill', track);

      pctNode = el('div', 'lp-splash-pct', root);
      pctNode.textContent = '0%';

      document.body.appendChild(root);
    }

    function paint() {
      if (!root || done) return;
      var p = clamp01(reached / STEPS);
      setScale(fill, p);
      pctNode.textContent = Math.round(p * 100) + '%';
      if (root) root.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    }

    /** 达成一个里程碑。可重复调用同一 id，只计一次。 */
    function step(id, label) {
      if (done) return;
      if (seen && seen.indexOf(id) >= 0) return;
      if (!seen) seen = [];
      seen.push(id);
      reached++;
      if (label) subNode.textContent = label;
      paint();
      if (reached >= STEPS) finish();
    }

    function finish() {
      if (done) return;
      done = true;
      if (!root) return;
      reached = STEPS;
      paint();
      subNode.textContent = '准备好了';
      markSeen();
      var wait = reduceMotion ? D.micro : D.pageExit;
      setTimeout(function () {
        root.classList.add('lp-leave');
        // 淡出结束后彻底摘除，避免残留在 DOM 里挡住点击
        setTimeout(function () {
          if (root && root.parentNode) root.parentNode.removeChild(root);
          root = fill = pctNode = subNode = null;
        }, reduceMotion ? D.micro : D.pageExit + 150);
      }, wait);
    }

    /**
     * 启动 splash 并开始观察真实里程碑。
     * 若本次会话已显示过，则完全跳过（连 DOM 都不建）。
     */
    function boot() {
      if (booted) return;
      booted = true;
      if (alreadySeen()) return; // 会话内只显示一次

      build();

      // 里程碑 1：DOM 就绪
      step('dom', '正在准备界面');

      // 里程碑 2：关键样式表已就绪
      (function waitStyles() {
        var tries = 0;
        var probe = function () {
          var ok = false;
          try {
            // 能读到 style.css 规则即视为已应用
            for (var i = 0; i < (document.styleSheets.length || 0); i++) {
              var href = document.styleSheets[i].href || '';
              if (href.indexOf('style.css') >= 0) { ok = true; break; }
            }
          } catch (e) { ok = true; } // 跨域表读不到规则，不阻塞启动
          if (ok || tries++ > 60) return step('style', '正在载入样式');
          requestAnimationFrame(probe);
        };
        probe();
      })();

      // 里程碑 3：核心脚本已执行（renderMessages 由 script.js 挂到 window）
      (function waitScript() {
        var tries = 0;
        var probe = function () {
          if (typeof global.renderMessages === 'function') return step('script', '正在启动模块');
          if (tries++ > 240) return step('script', '正在启动模块'); // 8s 兜底
          setTimeout(probe, 33);
        };
        probe();
      })();

      // 里程碑 4：应用外壳已可见（登录层 #auth 或主应用 #mainApp 之一）
      (function waitShell() {
        var tries = 0;
        var probe = function () {
          var auth = document.getElementById('auth');
          var app = document.getElementById('mainApp');
          var visible = (auth && !auth.hidden) || (app && !app.hidden);
          if (visible) return step('shell', '正在连接');
          if (tries++ > 300) return step('shell', '正在连接'); // 10s兜底
          setTimeout(probe, 33);
        };
        probe();
      })();

      // 里程碑 5：首帧已绘制
      (function waitPaint() {
        var tries = 0;
        var probe = function () {
          if (reached >= 4 || tries++ > 300) return step('paint', '正在渲染');
          requestAnimationFrame(function () { setTimeout(probe, 0); });
        };
        probe();
      })();

      // 兜底：无论里程碑是否全部达成，2.6s 后一定放行，绝不把用户卡在启动页
      listeners.push(setTimeout(function () {
        if (!done) { subNode.textContent = '正在进入'; finish(); }
      }, 2600));

      // 用户交互也可提前放行（点任意处即跳过）
      var skip = function () {
        if (!done) { subNode.textContent = '正在进入'; finish(); }
        document.removeEventListener('pointerdown', skip);
        document.removeEventListener('keydown', skip);
      };
      document.addEventListener('pointerdown', skip, { once: true });
      document.addEventListener('keydown', skip, { once: true });
    }

    return {
      boot: boot,
      step: step,
      finish: finish,
      _state: function () { return { booted: booted, done: done, reached: reached }; }
    };
  })();

  /* ============================================================
     ③ 上传进度卡
     ------------------------------------------------------------
     LP.upload 是纯 UI 层，不接管上传逻辑。真正的字节进度由
     uploadChunked（script.js 内）逐片调用 LP.upload.set 喂进来；
     未接入时也可只用作「上传中…」的轻量提示。
     ============================================================ */

  var upload = (function () {
    var stack = null;
    var items = {};   // id -> { node, ... }
    var seq = 0;

    function ensureStack() {
      if (stack && stack.parentNode) return;
      stack = el('div', 'lp-upload-stack');
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }

    /**
     * 开始一个上传任务并显示卡片。
     * @param {Object} opt
     *   id       可选，缺省自动生成
     *   name     文件名（文本节点写入，不做 HTML 注入）
     *   thumb    缩略图 URL（可选）
     *   total    总字节（可选，缺省走不确定态）
     *   onCancel 可选，返回 true 则允许点× 关闭
     * @returns {string} 任务 id；UI 层异常时返回 null（调用方须容忍）
     */
    function begin(opt) {
      opt = opt || {};
      // id 在此处生成（而非 build 内部），异常兜底才能定位并清掉半成品卡片
      var id = opt.id || ('up' + (++seq) + '_' + Date.now());
      try {
        return build(opt, id);
      } catch (e) {
        // 兜底：进度卡是纯增强层，建不出来绝不能连累上传主流程。
        // 这里必须把已插入 DOM 的半成品卡片清掉并注销 items，
        // 否则会留下一个永远不会被 close() 回收的孤儿节点（实测表现：
        // 卡片无 lp-on、textContent 为空、永久残留在页面里）。
        try {
          var orphan = null;
          if (stack) {
            for (var i = 0; i < stack.children.length; i++) {
              if (stack.children[i].dataset.lpUploadId === id) { orphan = stack.children[i]; break; }
            }
          }
          if (orphan && orphan.parentNode) orphan.parentNode.removeChild(orphan);
        } catch (e2) { /* 忽略 */ }
        try { delete items[id]; } catch (e3) { /* 忽略 */ }
        return null;
      }
    }

    function build(opt, id) {
      ensureStack();

      var card = el('div', 'lp-upload', stack);
      card.dataset.lpUploadId = id;
      if (typeof opt.total !== 'number' || opt.total <= 0) card.classList.add('lp-unknown');

      var thumbBox = el('div', 'lp-up-thumb', card);
      // 环形进度叠在缩略图外圈（先建，后续 textContent 赋值会清空子节点，故用文本节点占位）
      var ring = el('div', 'lp-up-ring', thumbBox);
      var thumbImg = el('img', null, thumbBox);
      thumbImg.alt = '';

      // 缩略图降级：没有 opt.thumb，或图片加载失败，都退回 emoji 占位。
      // 注意 removeChild 的第一个参数必须是待删节点自己的父节点（=== thumbBox）。
      // 写成 thumbBox.parentNode（=== card）会抛 NotFoundError，
      // 而此处若抛异常会连带把整张进度卡卡死在「建了一半」的状态。
      function dropThumb() {
        if (thumbImg.parentNode) thumbImg.parentNode.removeChild(thumbImg);
        thumbBox.insertBefore(document.createTextNode('🖼'), ring);
      }

      if (opt.thumb) {
        thumbImg.src = opt.thumb;
        thumbImg.addEventListener('error', dropThumb, { once: true });
      } else {
        dropThumb();
      }

      var body = el('div', 'lp-up-body', card);
      var name = el('div', 'lp-up-name', body);
      name.textContent = opt.name || '正在上传…';
      name.title = opt.name || '';

      var track = el('div', 'lp-up-track', body);
      var fill = el('div', 'lp-up-fill', track);

      var meta = el('div', 'lp-up-meta', body);
      var left = el('span', null, meta);       // 速度 / 剩余
      var pct = el('span', 'lp-up-pct', meta);
      pct.textContent = '0%';

      items[id] = {
        node: card, fill: fill, pct: pct, left: left,
        total: (typeof opt.total === 'number' && opt.total > 0) ? opt.total : 0,
        loaded: 0, startAt: Date.now(), onCancel: opt.onCancel || null, closed: false,
        lastAt: 0, lastLoaded: null   // 用于计算瞬时上传速度
      };

      // 强制回流后再上class，让 opacity 过渡真的生效
      requestAnimationFrame(function () { card.classList.add('lp-on'); });
      return id;
    }

    /**
     * 更新进度。
     * @param {string} id
     * @param {Object} opt { loaded, total, speed(字节/秒，可选) }
     */
    function set(id, opt) {
      var it = items[id];
      if (!it || it.closed) return;
      opt = opt || {};

      if (typeof opt.total === 'number' && opt.total > 0) it.total = opt.total;
      if (typeof opt.loaded === 'number' && opt.loaded >= 0) it.loaded = opt.loaded;

      var p = it.total > 0 ? clamp01(it.loaded / it.total) : 0;

      if (it.total > 0) {
        it.node.classList.remove('lp-unknown');
        it.node.classList.add('lp-has-pct');
        it.node.style.setProperty('--p', String(p));
        setScale(it.fill, p);
        it.pct.textContent = Math.round(p * 100) + '%';
      }

      // 剩余时间：用实测速度优先，否则用相邻两次进度事件之间的瞬时速度。
      // 不用「累计平均速度」——小文件往往 1 秒内就传完，平均速度要到
      // 很久之后才有意义，那时就只剩「剩余 0 秒」了，体验上等于没有。
      var speed = (typeof opt.speed === 'number' && opt.speed > 0) ? opt.speed : 0;

      var now = Date.now();
      if (!speed && it.lastAt && it.lastLoaded != null) {
        var dt = (now - it.lastAt) / 1000;
        // dt 太小（高频 progress 事件）时平滑合并，避免速度数字乱跳
        if (dt > 0.03) speed = (it.loaded - it.lastLoaded) / dt;
      }
      it.lastAt = now;
      it.lastLoaded = it.loaded;

      if (!speed && it.total > 0) {
        // 兜底：整个传输超过 0.5s 才用平均速度
        var secs = (now - it.startAt) / 1000;
        if (secs > 0.5) speed = it.loaded / secs;
      }

      if (it.total > 0 && speed > 1) {
        var remain = Math.max(0, (it.total - it.loaded) / speed);
        it.left.textContent = fmtBytes(speed) + '/s · 剩余 ' +
          (remain < 60 ? Math.ceil(remain) + ' 秒' : Math.ceil(remain / 60) + ' 分钟');
      } else if (it.loaded > 0) {
        it.left.textContent = fmtBytes(it.loaded);
      }
    }

    /** 完成：进度冲顶、变绿，停留 700ms 后自动收起 */
    function done(id, text) {
      var it = items[id];
      if (!it || it.closed) return;
      it.closed = true;
      it.node.classList.remove('lp-unknown', 'lp-error');
      it.node.classList.add('lp-done');
      it.node.style.setProperty('--p', '1');
      setScale(it.fill, 1);
      it.pct.textContent = '✓';
      it.left.textContent = text || '上传完成';
      setTimeout(function () { close(id); }, reduceMotion ? 600 : 900);
    }

    /** 失败：变红，多停留一些时间让用户看清 */
    function fail(id, msg) {
      var it = items[id];
      if (!it || it.closed) return;
      it.closed = true;
      it.node.classList.remove('lp-unknown', 'lp-done');
      it.node.classList.add('lp-error');
      it.pct.textContent = '!';
      it.left.textContent = msg || '上传失败';
      setTimeout(function () { close(id); }, reduceMotion ? 900 : 2000);
    }

    function close(id) {
      var it = items[id];
      if (!it) return;
      it.closed = true;
      var node = it.node;
      node.classList.remove('lp-on');
      delete items[id];
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
        // 栈空了连容器一起摘掉，保持 DOM 干净
        if (stack && !stack.children.length && stack.parentNode) {
          stack.parentNode.removeChild(stack);
          stack = null;
        }
      }, reduceMotion ? D.micro : D.cardExit + 100);
    }

    return {
      begin: begin,
      set: set,
      done: done,
      fail: fail,
      close: close
    };
  })();

  /* ============================================================
     真实上传进度（XHR 通道）
     ------------------------------------------------------------
     背景：script.js 的图片/文件上传走 I() → POST /upload，
     整包 base64 一次发出。fetch 没有上传进度事件，拿不到真实百分比。
     而 script.js 内已定义的 uploadChunked（分片）目前没有任何调用点，
     属于死代码，直接改它等于动核心上传逻辑，风险不可接受。

     方案：不动 script.js。在 fetch 包装层识别 /upload 与 /upload-chunk
     两个路径，改用 XMLHttpRequest 发送 —— XHR 的 upload.onprogress
     能给出真实的 loaded/total。响应再包成标准 Response 返回，
     上层（data-cache.js 的 res.json() / res.status）完全无感。
     ============================================================ */

  var uploadXhr = (function () {

    /*进度 UI 的安全调用包装：
      UI 层的任何异常都不允许影响上传主流程，故全部吞掉并降级为无 UI。*/
    function safe(fn) {
      return function () {
        try { return fn.apply(null, arguments); } catch (e) { return null; }
      };
    }
    var up = {
      begin: safe(upload.begin),
      set: safe(upload.set),
      done: safe(upload.done),
      fail: safe(upload.fail),
      close: safe(upload.close)
    };

    /**
     * 需要走 XHR 通道的路径。
     * 注意：data-cache.js 里是 fetch(cfg.base + path)，
     * base 配的是 '/api'，所以实际请求是 '/api/upload' 这类绝对路径 URL。
     * 这里做后缀匹配，兼容 base 被改成 '/api/v2' 或直接为 '' 的情况。
     */
    function isUploadPath(path) {
      var p = normalize(path);
      if (p === null) return false;
      return /\/upload(-chunk|-assemble)?$/.test(p);
    }

    /**
     * 把入参归一化成「以 / 开头的路径」，去掉 query / hash / origin。
     * 同源之外的地址返回 null（交给原生 fetch，不接管）。
     * @param {string} raw
     * @return {?string}
     */
    function normalize(raw) {
      if (typeof raw !== 'string' || !raw) return null;

      var s = raw;
      // 相对协议 //host/path 与绝对 URL 统一按 origin 剥离
      var origin = global.location && global.location.origin;
      if (origin && s.indexOf(origin) === 0) {
        s = s.slice(origin.length);
      } else if (/^https?:\/\//i.test(s)) {
        return null; // 跨源（CDN / 第三方），不接管
      }

      s = s.split('#')[0].split('?')[0];
      if (s.charAt(0) !== '/') return null;

      // 去掉结尾多余斜杠，统一小写（路径大小写不敏感更安全）
      s = s.replace(/\/+$/, '');
      return s.toLowerCase();
    }

    /**
     * 用 XHR 发送并回报真实上传进度，返回标准 Response。
     * @param {string} url
     * @param {Object} init  fetch 的 init（headers / body / signal）
     * @param {string} label 进度卡上显示的名称
     * @return {Promise<Response>}
     */
    function send(url, init, label) {
      init = init || {};

      var payload = init.body;
      var totalBytes = byteLengthOf(payload);
      // 进度卡建不出来（如 DOM 尚未就绪）时 taskId 为 null，上传照常进行
      var taskId = up.begin({
        name: label || '正在上传照片…',
        total: totalBytes
      });

      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        var settled = false;

        function cleanup() {
          if (init.signal) {
            try { init.signal.removeEventListener('abort', onAbort); } catch (e) { /* 忽略 */ }
          }
        }

        function onAbort() {
          if (settled) return;
          settled = true;
          try { xhr.abort(); } catch (e) { /* 忽略 */ }
          cleanup();
          up.fail(taskId, '已取消');
          reject(new DOMException('Aborted', 'AbortError'));
        }

        if (init.signal) {
          if (init.signal.aborted) { onAbort(); return; }
          init.signal.addEventListener('abort', onAbort);
        }

        xhr.open((init.method || 'GET').toUpperCase(), url, true);

        // 复制 headers（fetch init.headers 可能是普通对象或 Headers 实例）
        try {
          var h = init.headers;
          if (h && typeof h.forEach === 'function' && typeof h.get === 'function') {
            h.forEach(function (v, k) { xhr.setRequestHeader(k, v); });
          } else if (h) {
            for (var k in h) {
              if (Object.prototype.hasOwnProperty.call(h, k)) {
                xhr.setRequestHeader(k, h[k]);
              }
            }
          }
        } catch (e) { /* 忽略：非法 header 交给 XHR 自己报错 */ }

        /* ---- 真实上传进度 ---- */
        if (xhr.upload) {
          xhr.upload.onprogress = function (ev) {
            if (settled) return;
            if (ev.lengthComputable && ev.total > 0) {
              up.set(taskId, { loaded: ev.loaded, total: ev.total });
            }
          };
        }

        xhr.onload = function () {
          if (settled) return;
          settled = true;
          cleanup();

          // 组装标准 Response，让上层 res.json() / res.status 照常工作
          var headers = new Headers();
          try {
            var ct = xhr.getResponseHeader('Content-Type');
            if (ct) headers.set('Content-Type', ct);
          } catch (e) { /* 忽略 */ }

          var res = new Response(xhr.responseText, {
            status: xhr.status,
            statusText: xhr.statusText || '',
            headers: headers
          });

          if (xhr.status >= 200 && xhr.status < 300) {
            up.done(taskId, '上传完成');
          } else {
            up.fail(taskId, '上传失败（' + xhr.status + '）');
          }
          resolve(res);
        };

        xhr.onerror = function () {
          if (settled) return;
          settled = true;
          cleanup();
          up.fail(taskId, '网络错误');
          reject(new TypeError('Failed to fetch'));
        };

        xhr.ontimeout = function () {
          if (settled) return;
          settled = true;
          cleanup();
          up.fail(taskId, '上传超时');
          reject(new Error('上传超时'));
        };

        xhr.onabort = function () {
          if (settled) return;
          settled = true;
          cleanup();
          up.close(taskId);
          reject(new DOMException('Aborted', 'AbortError'));
        };

        try {
          xhr.send(payload == null ? null : payload);
        } catch (err) {
          if (settled) return;
          settled = true;
          cleanup();
          up.fail(taskId, '上传失败');
          reject(err);
        }
      });
    }

    return { isUploadPath: isUploadPath, normalize: normalize, send: send };
  })();

  /* ============================================================
     fetch 挂载：把顶部进度条接到所有 API 请求上
     ------------------------------------------------------------
     只做「计数 + 包裹 Promise」，不改动原请求的 URL / header /
     body / 返回值，也不吞异常——原 fetch 的 resolve/reject
     原样透传给调用方，对上层完全透明。
     ============================================================ */

  var fetchWatch = (function () {
    var installed = false;
    var rawFetch = null;

    /**
     * 是否值得计入顶部进度条。
     * 排除：跨域地址、SSE 实时流（走 EventSource 本就不经过 fetch）。
     * data-cache.js 传的是绝对 URL，这里用 normalize 归一后再判。
     */
    function worth(path) {
      var p = uploadXhr.normalize(path);
      if (p === null) return false;
      // SSE 实时流虽然不走 fetch，但排除掉以防将来改实现时误统计
      if (p.indexOf('/events') >= 0) return false;
      return true;
    }

    function install() {
      if (installed) return false;
      if (typeof global.fetch !== 'function') return false;
      installed = true;
      rawFetch = global.fetch.bind(global);

      global.fetch = function (input, init) {
        var url = '';
        var method = 'GET';
        try {
          if (typeof input === 'string') url = input;
          else if (input && typeof input.url === 'string') url = input.url;
          method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        } catch (e) { /* 忽略：入参异常交给原生 fetch 报错 */ }

        if (!worth(url)) return rawFetch(input, init);

        // 上传走 XHR 通道以取得真实字节进度（内部自带顶部进度条计数）
        if (method === 'POST' && uploadXhr.isUploadPath(url)) {
          var abs = toAbsolute(url);
          var hUp = top.start(2.4);
          var p;
          // send() 理论上不抛（内部已兜底），这里再兜一层：
          // 万一抛了必须把权重还回去，否则进度条会永远卡在加载中。
          try {
            p = uploadXhr.send(abs, init, guessLabel(init));
          } catch (err) {
            top.done(hUp);
            return Promise.reject(err);
          }
          return p.then(
            function (res) { top.done(hUp); return res; },
            function (err) { top.done(hUp); throw err; }
          );
        }

        // 写操作更重，给更高权重，进度条上"推一下"的幅度更明显
        var weight = method === 'GET' ? 1 : 1.6;
        var h = top.start(weight);

        return rawFetch(input, init).then(
          function (res) { top.done(h); return res; },
          function (err) { top.done(h); throw err; }
        );
      };

      return true;
    }

    /** 把相对路径还原成 XHR 需要的绝对 URL */
    function toAbsolute(url) {
      if (/^https?:\/\//i.test(url)) return url;
      var origin = (global.location && global.location.origin) || '';
      return origin + (url.charAt(0) === '/' ? url : '/' + url);
    }

    /** 从请求体里猜一个给进度卡用的名字（只读字符串，不注入 DOM） */
    function guessLabel(init) {
      try {
        var b = init && init.body;
        if (b && typeof b === 'object') {
          if (typeof b.name === 'string' && b.name) return b.name;
          if (typeof b.mimeType === 'string' && b.mimeType.indexOf('image/') === 0) {
            return '正在上传照片…';
          }
        }
      } catch (e) { /* 忽略 */ }
      return '正在上传…';
    }

    return {
      install: install,
      _installed: function () { return installed; }
    };
  })();

  /* ============================================================
     乐观消息气泡微状态
     ------------------------------------------------------------
     script.js 已经做了乐观渲染（本地先上屏 + _failed 回滚 +
     红色 "!" 重发按钮），这里**不重写**那套逻辑，只补一个
     "发送中"的微状态，并通过观察 data-msg-id 从 local_ 前缀
     变成真实 id 的那一刻，给一个"落地"高亮。
     判定失败态：script.js 失败时会挂 .recall-btn 且文案含"发送失败"。
     ============================================================ */

  var msgWatch = (function () {
    var started = false;
    var observer = null;

    function isFailed(row) {
      var btn = row.querySelector('.recall-btn');
      return !!(btn && (btn.title || '').indexOf('发送失败') >= 0);
    }

    /** 把所有乐观气泡刷新到正确状态 */
    function sweep() {
      var box = document.getElementById('messages');
      if (!box) return;
      var rows = box.querySelectorAll('.msg-row[data-msg-id]');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var id = row.dataset.msgId || '';
        var wasSending = row.classList.contains('lp-sending');

        if (id.indexOf('local_') === 0) {
          // 本地乐观气泡：仍在发送 / 已失败
          if (isFailed(row)) {
            row.classList.remove('lp-sending');
            row.classList.add('lp-failed');
          } else {
            row.classList.remove('lp-failed');
            row.classList.add('lp-sending');
          }
        } else if (wasSending) {
          // id 已换成服务端真实 id → 发送成功，做一次落地高亮后清理
          row.classList.remove('lp-sending');
          row.classList.add('lp-sent');
          (function (r) {
            setTimeout(function () { r.classList.remove('lp-sent'); },
              reduceMotion ? D.micro : D.ui + 120);
          })(row);
        }
      }
    }

    function start() {
      if (started) return;
      started = true;
      var box = document.getElementById('messages');
      if (!box) {
        // #messages 由 script.js 在登录后才可用，稍后重试挂载
        var tries = 0;
        var retry = function () {
          var b = document.getElementById('messages');
          if (b) { attach(b); return; }
          if (tries++ < 300) setTimeout(retry, 33);
        };
        retry();
        return;
      }
      attach(box);
    }

    function attach(box) {
      observer = new MutationObserver(function () { sweep(); });
      observer.observe(box, { childList: true, subtree: false });
      sweep();
    }

    return { start: start, sweep: sweep };
  })();

  /* ============================================================
     对外 API
     ============================================================ */

  var LP = {
    version: '1.0.0',
    reduceMotion: reduceMotion,
    top: top,
    splash: splash,
    upload: upload,
    watchFetch: fetchWatch.install,
    watchMessages: msgWatch.start,
    /** 手动扫一遍消息微状态（外部主动调用时用） */
    sweepMessages: msgWatch.sweep
  };

  global.LP = LP;

  /* ---------------- 自动启动 ---------------- */

  // fetch 包装必须最早生效（早于 DOMContentLoaded），
  // 否则 script.js 初始化阶段发出的首批请求会漏掉进度统计。
  LP.watchFetch();

  function autoStart() {
    LP.splash.boot();    // 启动页
    LP.watchMessages();  // 乐观气泡微状态
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStart, { once: true });
  } else {
    autoStart();
  }

})(window);
