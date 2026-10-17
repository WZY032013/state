/* ============================================================\r\n   Stating · 高级加载动效层 loading.js\r\n   ------------------------------------------------------------\r\n   对外只暴露一个全局 LP（Loading Progression），不改动\r\n   script.js / data-cache.js / style.css 的任何既有逻辑。\r\n   挂载方式：index.html 以 <script defer> 在 script.js 之前引入。\r\n\r\n   能力：\r\n     LP.top.start(weight) → 句柄 / LP.top.done(句柄)   顶部进度条\r\n       （也支持 LP.top.done() 无参调用，按 FIFO 出队最早的一笔）\r\n     LP.top.set(p)                             手动设置绝对进度\r\n     LP.splash.boot() / step(id, label)        启动页（真实进度）\r\n     LP.upload.begin() / set() / done() / fail() / close()\r\n                                                  上传进度卡\r\n     LP.watchFetch()                           给 window.fetch 挂进度条\r\n     LP.watchMessages()                        给乐观消息气泡挂微状态\r\n\r\n   全部动画在 prefers-reduced-motion: reduce 下降级为静态（见 loading.css）。\r\n   代码中零 innerHTML（只用 createElement + textContent），不注入任何外部数据。\r\n   ============================================================ */\r\n\r\n(function (global) {\r\n  'use strict';\r\n\r\n  /* ---------------- 动效偏好探测 ---------------- */\r\n  var reduceMotion = global.matchMedia\r\n    ? global.matchMedia('(prefers-reduced-motion: reduce)').matches\r\n    : false;\r\n\r\n  /* ---------------- 小工具 ---------------- */\r\n  function el(tag, cls, parent) {\r\n    var node = document.createElement(tag);\r\n    if (cls) node.className = cls;\r\n    if (parent) parent.appendChild(node);\r\n    return node;\r\n  }\r\n\r\n  /** 数字限幅 */\r\n  function clamp01(n) {\r\n    n = typeof n === 'number' && isFinite(n) ? n : 0;\r\n    return n < 0 ? 0 : n > 1 ? 1 : n;\r\n  }\r\n\r\n  /** 时长档位（与 loading.css 的 --lp-d-* 变量一一对应，改一处要同步另一处） */\r\n  var D = {\r\n    micro: 150,      // 微交互\r\n    ui: 200,         // 标准 UI\r\n    page: 300,       // 整页级进入\r\n    pageExit: 240,   // 整页级退出（比进入快约 20%）\r\n    cardExit: 160    // 卡片退出（比 200ms 进入快约 20%）\r\n  };\r\n\r\n  /** 把进度 0~1 写进填充条的 transform: scaleX()。\r\n   * 刻意不用 style.width —— 动画 width 会每帧触发重排，\r\n   * 违反「只动画 transform / opacity」的动效规范（GPU 友好）。\r\n   * @param {Element} node 填充条元素\r\n   * @param {number} p 进度 0~1\r\n   */\r\n  function setScale(node, p) {\r\n    if (!node || !node.style) return;\r\n    node.style.transform = 'scaleX(' + clamp01(p).toFixed(4) + ')';\r\n  }\r\n\r\n  /** 字节数格式化 */\r\n  function fmtBytes(n) {\r\n    if (!n || n < 0) return '';\r\n    if (n < 1024) return n + ' B';\r\n    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';\r\n    return (n / 1048576).toFixed(1) + ' MB';\r\n  }\r\n\r\n  /**\r\n   * 把原始请求的 body 换算成字节数。\r\n   * 只做体积估算，不解析内容、不落盘。\r\n   */\r\n  function byteLengthOf(body) {\r\n    if (body == null) return 0;\r\n    if (typeof body === 'string') return body.length; // UTF-16 近似，够用于进度估算\r\n    if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;\r\n    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return body.byteLength;\r\n    try {\r\n      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) return body.byteLength;\r\n    } catch (e) { /* 忽略：老浏览器无 isView */ }\r\n    return 0;\r\n  }\r\n\r\n  /* ============================================================\r\n     ② 顶部进度条\r\n     ------------------------------------------------------------\r\n     用「加权计数」而非单条百分比：多条并发请求各自占一份权重，\r\n     全部完成才到 100%。避免"一条慢请求把整条条拉满/拉空"。\r\n     ============================================================ */\r\n\r\n  var top = (function () {\r\n    var root = null, fill = null;\r\n    var pending = [];     // 在途请求的权重队列（FIFO，先进先出）\r\n    var value = 0;       // 当前显示进度 0~1\r\n    var shown = false;\r\n    var hideTimer = 0;\r\n    var indeterminateTimer = 0;\r\n    var STALL_MS = 220;  // 超过该时长没有新事件则切到不确定扫动\r\n\r\n    function ensure() {\r\n      if (root) return;\r\n      root = el('div', 'lp-topbar');\r\n      root.setAttribute('role', 'progressbar');\r\n      root.setAttribute('aria-label', '页面加载进度');\r\n      root.setAttribute('aria-valuemin', '0');\r\n      root.setAttribute('aria-valuemax', '100');\r\n      fill = el('div', 'lp-topbar-fill', root);\r\n      document.body.appendChild(root);\r\n    }\r\n\r\n    /** 把进度 0~1 写进填充条的 transform: scaleX()。\r\n        刻意不用 style.width —— 动画 width 会每帧触发重排，不符合\r\n        「只动画 transform / opacity」的动效规范。 */\r\n    function render() {\r\n      if (!root) return;\r\n      setScale(fill, value);\r\n      root.setAttribute('aria-valuenow', String(Math.round(value * 100)));\r\n    }\r\n\r\n    /** 平滑逼近目标值，避免进度条一跳一跳 */\r\n    function glide(target) {\r\n      if (reduceMotion) { value = target; render(); return; }\r\n      if (glide._raf) cancelAnimationFrame(glide._raf);\r\n      glide._target = target;\r\n      var step = function () {\r\n        var diff = glide._target - value;   // 每帧基于当前值重算，不能用固定 from\r\n        if (Math.abs(diff) < 0.002) {\r\n          value = glide._target;\r\n          glide._raf = 0;\r\n          render();\r\n          return;\r\n        }\r\n        value += diff * 0.22;\r\n        if (value < 0) value = 0;\r\n        if (value > 1) value = 1;\r\n        render();\r\n        glide._raf = requestAnimationFrame(step);\r\n      };\r\n      glide._raf = requestAnimationFrame(step);\r\n    }\r\n\r\n    function show() {\r\n      ensure();\r\n      shown = true;\r\n      clearTimeout(hideTimer);\r\n      root.classList.add('lp-on');\r\n    }\r\n\r\n    /** 开始一组加载。weight 越大在总进度里占比越高（默认 1）。\r\n        返回一个句柄，交给 done(handle) 精确归还，避免多退/少退。 */\r\n    function start(weight) {\r\n      show();\r\n      var w = (typeof weight === 'number' && weight > 0) ? weight : 1;\r\n      var handle = { w: w, settled: false };\r\n      pending.push(handle);\r\n      root.classList.remove('lp-indeterminate');\r\n      // 先回退一点，暗示"新的一段开始了"\r\n      if (value > 0.35) glide(Math.max(0.12, value * 0.62));\r\n\r\n      // 长时间无进展就切不确定态，而不是停在原地装死\r\n      clearTimeout(indeterminateTimer);\r\n      indeterminateTimer = setTimeout(function () {\r\n        if (pending.length && value < 0.98) root.classList.add('lp-indeterminate');\r\n      }, STALL_MS + 2600);\r\n      return handle;\r\n    }\r\n\r\n    /** 手动设置绝对进度 0~1（用于已知总量的分片流程）。 */\r\n    function set(p) {\r\n      show();\r\n      glide(clamp01(p));\r\n    }\r\n\r\n    /** 结束一组加载。可传start() 返回的句柄；不传则出队最早的。 */\r\n    function done(handle) {\r\n      if (handle && typeof handle === 'object' && !handle.settled) {\r\n        handle.settled = true;\r\n        var i = pending.indexOf(handle);\r\n        if (i >= 0) pending.splice(i, 1);\r\n      } else {\r\n        // 无句柄时出队最早的一笔（保持与旧调用方式兼容）\r\n        var first = pending.shift();\r\n        if (first) first.settled = true;\r\n      }\r\n\r\n      clearTimeout(indeterminateTimer);\r\n      if (pending.length) return;   // 还有在途，继续显示\r\n      root.classList.remove('lp-indeterminate');\r\n      glide(1);\r\n      root.classList.add('lp-flash');\r\n      hideTimer = setTimeout(function () {\r\n        if (root) {\r\n          root.classList.remove('lp-on', 'lp-flash');\r\n          value = 0;   // 复位，供下次使用\r\n          render();\r\n        }\r\n        shown = false;\r\n      }, reduceMotion ? D.micro : D.micro + 150);\r\n    }\r\n\r\n    return {\r\n      start: start,\r\n      set: set,\r\n      done: done,\r\n      /** 供外部查询，供测试/调试用 */\r\n      _state: function () { return { active: pending.length, value: value, shown: shown }; }\r\n    };\r\n  })();\r\n\r\n  /* ============================================================\r\n     ① 启动页 Splash\r\n     ------------------------------------------------------------\r\n     进度是「真实的」：由若干个可验证的里程碑驱动，\r\n     每个里程碑对应一个真实的、可被观察到的事实：\r\n       - DOM 已就绪\r\n       - 关键样式表已加载（document.styleSheets 可见）\r\n       - 关键脚本已就绪（window.renderMessages 等已挂上）\r\n       - 应用外壳已可见（#mainApp 或 #auth 之一解除 hidden）\r\n     不用定时器伪造百分比，只用 setTimeout 做「兜底超时退出」。\r\n     会话内只显示一次（sessionStorage），避免每次刷新都闪。\r\n     ============================================================ */\r\n\r\n  var splash = (function () {\r\n    var SESSION_KEY = 'stating_splash_seen';\r\n    var root = null, fill = null, pctNode = null, subNode = null;\r\n    var seen = false;\r\n    var done = false;\r\n    var STEPS = 5;          // 里程碑总数\r\n    var reached = 0;        // 已达成的里程碑数\r\n    var booted = false;     // 是否已经尝试过启动\r\n    var listeners = [];\r\n\r\n    function alreadySeen() {\r\n      try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch (e) { return false; }\r\n    }\r\n\r\n    function markSeen() {\r\n      try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) { /* 隐私模式下忽略 */ }\r\n    }\r\n\r\n    function build() {\r\n      root = el('div', 'lp-splash');\r\n      root.setAttribute('role', 'status');\r\n      root.setAttribute('aria-live', 'polite');\r\n      root.setAttribute('aria-label', 'Stating 正在启动');\r\n\r\n      var mark = el('div', 'lp-splash-mark', root);\r\n      // 品牌字：取站点标题首字母，纯文本节点，无注入风险\r\n      var brand = ((document.title || 'Stating').trim()[0] || 'S').toUpperCase();\r\n      mark.textContent = brand;\r\n\r\n      el('div', 'lp-splash-title', root).textContent = 'Stating';\r\n      subNode = el('div', 'lp-splash-sub', root);\r\n\r\n      var track = el('div', 'lp-splash-track', root);\r\n      track.setAttribute('role', 'progressbar');\r\n      track.setAttribute('aria-valuemin', '0');\r\n      track.setAttribute('aria-valuemax', '100');\r\n      fill = el('div', 'lp-splash-fill', track);\r\n\r\n      pctNode = el('div', 'lp-splash-pct', root);\r\n      pctNode.textContent = '0%';\r\n\r\n      document.body.appendChild(root);\r\n    }\r\n\r\n    function paint() {\r\n      if (!root || done) return;\r\n      var p = clamp01(reached / STEPS);\r\n      setScale(fill, p);\r\n      pctNode.textContent = Math.round(p * 100) + '%';\r\n      if (root) root.setAttribute('aria-valuenow', String(Math.round(p * 100)));\r\n    }\r\n\r\n    /** 达成一个里程碑。可重复调用同一 id，只计一次。 */\r\n    function step(id, label) {\r\n      if (done) return;\r\n      if (seen && seen.indexOf(id) >= 0) return;\r\n      if (!seen) seen = [];\r\n      seen.push(id);\r\n      reached++;\r\n      if (label) subNode.textContent = label;\r\n      paint();\r\n      if (reached >= STEPS) finish();\r\n    }\r\n\r\n    function finish() {\r\n      if (done) return;\r\n      done = true;\r\n      if (!root) return;\r\n      reached = STEPS;\r\n      paint();\r\n      subNode.textContent = '准备好了';\r\n      markSeen();\r\n      var wait = reduceMotion ? D.micro : D.pageExit;\r\n      setTimeout(function () {\r\n        root.classList.add('lp-leave');\r\n        // 淡出结束后彻底摘除，避免残留在 DOM 里挡住点击\r\n        setTimeout(function () {\r\n          if (root && root.parentNode) root.parentNode.removeChild(root);\r\n          root = fill = pctNode = subNode = null;\r\n        }, reduceMotion ? D.micro : D.pageExit + 150);\r\n      }, wait);\r\n    }\r\n\r\n    /**\r\n     * 启动 splash 并开始观察真实里程碑。\r\n     * 若本次会话已显示过，则完全跳过（连 DOM 都不建）。\r\n     */\r\n    function boot() {\r\n      if (booted) return;\r\n      booted = true;\r\n      if (alreadySeen()) return; // 会话内只显示一次\r\n\r\n      build();\r\n\r\n      // 里程碑 1：DOM 就绪\r\n      step('dom', '正在准备界面');\r\n\r\n      // 里程碑 2：关键样式表已就绪\r\n      (function waitStyles() {\r\n        var tries = 0;\r\n        var probe = function () {\r\n          var ok = false;\r\n          try {\r\n            // 能读到 style.css 规则即视为已应用\r\n            for (var i = 0; i < (document.styleSheets.length || 0); i++) {\r\n              var href = document.styleSheets[i].href || '';\r\n              if (href.indexOf('style.css') >= 0) { ok = true; break; }\r\n            }\r\n          } catch (e) { ok = true; } // 跨域表读不到规则，不阻塞启动\r\n          if (ok || tries++ > 60) return step('style', '正在载入样式');\r\n          requestAnimationFrame(probe);\r\n        };\r\n        probe();\r\n      })();\r\n\r\n      // 里程碑 3：核心脚本已执行（renderMessages 由 script.js 挂到 window）\r\n      (function waitScript() {\r\n        var tries = 0;\r\n        var probe = function () {\r\n          if (typeof global.renderMessages === 'function') return step('script', '正在启动模块');\r\n          if (tries++ > 240) return step('script', '正在启动模块'); // 8s 兜底\r\n          setTimeout(probe, 33);\r\n        };\r\n        probe();\r\n      })();\r\n\r\n      // 里程碑 4：应用外壳已可见（登录层 #auth 或主应用 #mainApp 之一）\r\n      (function waitShell() {\r\n        var tries = 0;\r\n        var probe = function () {\r\n          var auth = document.getElementById('auth');\r\n          var app = document.getElementById('mainApp');\r\n          var visible = (auth && !auth.hidden) || (app && !app.hidden);\r\n          if (visible) return step('shell', '正在连接');\r\n          if (tries++ > 300) return step('shell', '正在连接'); // 10s兜底\r\n          setTimeout(probe, 33);\r\n        };\r\n        probe();\r\n      })();\r\n\r\n      // 里程碑 5：首帧已绘制\r\n      (function waitPaint() {\r\n        var tries = 0;\r\n        var probe = function () {\r\n          if (reached >= 4 || tries++ > 300) return step('paint', '正在渲染');\r\n          requestAnimationFrame(function () { setTimeout(probe, 0); });\r\n        };\r\n        probe();\r\n      })();\r\n\r\n      // 兜底：无论里程碑是否全部达成，2.6s 后一定放行，绝不把用户卡在启动页\r\n      listeners.push(setTimeout(function () {\r\n        if (!done) { subNode.textContent = '正在进入'; finish(); }\r\n      }, 2600));\r\n\r\n      // 用户交互也可提前放行（点任意处即跳过）\r\n      var skip = function () {\r\n        if (!done) { subNode.textContent = '正在进入'; finish(); }\r\n        document.removeEventListener('pointerdown', skip);\r\n        document.removeEventListener('keydown', skip);\r\n      };\r\n      document.addEventListener('pointerdown', skip, { once: true });\r\n      document.addEventListener('keydown', skip, { once: true });\r\n    }\r\n\r\n    return {\r\n      boot: boot,\r\n      step: step,\r\n      finish: finish,\r\n      _state: function () { return { booted: booted, done: done, reached: reached }; }\r\n    };\r\n  })();\r\n\r\n  /* ============================================================\r\n     ③ 上传进度卡\r\n     ------------------------------------------------------------\r\n     LP.upload 是纯 UI 层，不接管上传逻辑。真正的字节进度由\r\n     uploadChunked（script.js 内）逐片调用 LP.upload.set 喂进来；\r\n     未接入时也可只用作「上传中…」的轻量提示。\r\n     ============================================================ */\r\n\r\n  var upload = (function () {\r\n    var stack = null;\r\n    var items = {};   // id -> { node, ... }\r\n    var seq = 0;\r\n\r\n    function ensureStack() {\r\n      if (stack && stack.parentNode) return;\r\n      stack = el('div', 'lp-upload-stack');\r\n      stack.setAttribute('role', 'status');\r\n      stack.setAttribute('aria-live', 'polite');\r\n      document.body.appendChild(stack);\r\n    }\r\n\r\n    /**\r\n     * 开始一个上传任务并显示卡片。\r\n     * @param {Object} opt\r\n     *   id       可选，缺省自动生成\r\n     *   name     文件名（文本节点写入，不做 HTML 注入）\r\n     *   thumb    缩略图 URL（可选）\r\n     *   total    总字节（可选，缺省走不确定态）\r\n     *   onCancel 可选，返回 true 则允许点× 关闭\r\n     * @returns {string} 任务 id；UI 层异常时返回 null（调用方须容忍）\r\n     */\r\n    function begin(opt) {\r\n      opt = opt || {};\r\n      // id 在此处生成（而非 build 内部），异常兜底才能定位并清掉半成品卡片\r\n      var id = opt.id || ('up' + (++seq) + '_' + Date.now());\r\n      try {\r\n        return build(opt, id);\r\n      } catch (e) {\r\n        // 兜底：进度卡是纯增强层，建不出来绝不能连累上传主流程。\r\n        // 这里必须把已插入 DOM 的半成品卡片清掉并注销 items，\r\n        // 否则会留下一个永远不会被 close() 回收的孤儿节点（实测表现：\r\n        // 卡片无 lp-on、textContent 为空、永久残留在页面里）。\r\n        try {\r\n          var orphan = null;\r\n          if (stack) {\r\n            for (var i = 0; i < stack.children.length; i++) {\r\n              if (stack.children[i].dataset.lpUploadId === id) { orphan = stack.children[i]; break; }\r\n            }\r\n          }\r\n          if (orphan && orphan.parentNode) orphan.parentNode.removeChild(orphan);\r\n        } catch (e2) { /* 忽略 */ }\r\n        try { delete items[id]; } catch (e3) { /* 忽略 */ }\r\n        return null;\r\n      }\r\n    }\r\n\r\n    function build(opt, id) {\r\n      ensureStack();\r\n\r\n      var card = el('div', 'lp-upload', stack);\r\n      card.dataset.lpUploadId = id;\r\n      if (typeof opt.total !== 'number' || opt.total <= 0) card.classList.add('lp-unknown');\r\n\r\n      var thumbBox = el('div', 'lp-up-thumb', card);\r\n      // 环形进度叠在缩略图外圈（先建，后续 textContent 赋值会清空子节点，故用文本节点占位）\r\n      var ring = el('div', 'lp-up-ring', thumbBox);\r\n      var thumbImg = el('img', null, thumbBox);\r\n      thumbImg.alt = '';\r\n\r\n      // 缩略图降级：没有 opt.thumb，或图片加载失败，都退回 emoji 占位。\r\n      // 注意 removeChild 的第一个参数必须是待删节点自己的父节点（=== thumbBox）。\r\n      // 写成 thumbBox.parentNode（=== card）会抛 NotFoundError，\r\n      // 而此处若抛异常会连带把整张进度卡卡死在「建了一半」的状态。\r\n      function dropThumb() {\r\n        if (thumbImg.parentNode) thumbImg.parentNode.removeChild(thumbImg);\r\n        thumbBox.insertBefore(document.createTextNode('🖼'), ring);\r\n      }\r\n\r\n      if (opt.thumb) {\r\n        thumbImg.src = opt.thumb;\r\n        thumbImg.addEventListener('error', dropThumb, { once: true });\r\n      } else {\r\n        dropThumb();\r\n      }\r\n\r\n      var body = el('div', 'lp-up-body', card);\r\n      var name = el('div', 'lp-up-name', body);\r\n      name.textContent = opt.name || '正在上传…';\r\n      name.title = opt.name || '';\r\n\r\n      var track = el('div', 'lp-up-track', body);\r\n      var fill = el('div', 'lp-up-fill', track);\r\n\r\n      var meta = el('div', 'lp-up-meta', body);\r\n      var left = el('span', null, meta);       // 速度 / 剩余\r\n      var pct = el('span', 'lp-up-pct', meta);\r\n      pct.textContent = '0%';\r\n\r\n      items[id] = {\r\n        node: card, fill: fill, pct: pct, left: left,\r\n        total: (typeof opt.total === 'number' && opt.total > 0) ? opt.total : 0,\r\n        loaded: 0, startAt: Date.now(), onCancel: opt.onCancel || null, closed: false,\r\n        lastAt: 0, lastLoaded: null   // 用于计算瞬时上传速度\r\n      };\r\n\r\n      // 强制回流后再上class，让 opacity 过渡真的生效\r\n      requestAnimationFrame(function () { card.classList.add('lp-on'); });\r\n      return id;\r\n    }\r\n\r\n    /**\r\n     * 更新进度。\r\n     * @param {string} id\r\n     * @param {Object} opt { loaded, total, speed(字节/秒，可选) }\r\n     */\r\n    function set(id, opt) {\r\n      var it = items[id];\r\n      if (!it || it.closed) return;\r\n      opt = opt || {};\r\n\r\n      if (typeof opt.total === 'number' && opt.total > 0) it.total = opt.total;\r\n      if (typeof opt.loaded === 'number' && opt.loaded >= 0) it.loaded = opt.loaded;\r\n\r\n      var p = it.total > 0 ? clamp01(it.loaded / it.total) : 0;\r\n\r\n      if (it.total > 0) {\r\n        it.node.classList.remove('lp-unknown');\r\n        it.node.classList.add('lp-has-pct');\r\n        it.node.style.setProperty('--p', String(p));\r\n        setScale(it.fill, p);\r\n        it.pct.textContent = Math.round(p * 100) + '%';\r\n      }\r\n\r\n      // 剩余时间：用实测速度优先，否则用相邻两次进度事件之间的瞬时速度。\r\n      // 不用「累计平均速度」——小文件往往 1 秒内就传完，平均速度要到\r\n      // 很久之后才有意义，那时就只剩「剩余 0 秒」了，体验上等于没有。\r\n      var speed = (typeof opt.speed === 'number' && opt.speed > 0) ? opt.speed : 0;\r\n\r\n      var now = Date.now();\r\n      if (!speed && it.lastAt && it.lastLoaded != null) {\r\n        var dt = (now - it.lastAt) / 1000;\r\n        // dt 太小（高频 progress 事件）时平滑合并，避免速度数字乱跳\r\n        if (dt > 0.03) speed = (it.loaded - it.lastLoaded) / dt;\r\n      }\r\n      it.lastAt = now;\r\n      it.lastLoaded = it.loaded;\r\n\r\n      if (!speed && it.total > 0) {\r\n        // 兜底：整个传输超过 0.5s 才用平均速度\r\n        var secs = (now - it.startAt) / 1000;\r\n        if (secs > 0.5) speed = it.loaded / secs;\r\n      }\r\n\r\n      if (it.total > 0 && speed > 1) {\r\n        var remain = Math.max(0, (it.total - it.loaded) / speed);\r\n        it.left.textContent = fmtBytes(speed) + '/s · 剩余 ' +\r\n          (remain < 60 ? Math.ceil(remain) + ' 秒' : Math.ceil(remain / 60) + ' 分钟');\r\n      } else if (it.loaded > 0) {\r\n        it.left.textContent = fmtBytes(it.loaded);\r\n      }\r\n    }\r\n\r\n    /** 完成：进度冲顶、变绿，停留 700ms 后自动收起 */\r\n    function done(id, text) {\r\n      var it = items[id];\r\n      if (!it || it.closed) return;\r\n      it.closed = true;\r\n      it.node.classList.remove('lp-unknown', 'lp-error');\r\n      it.node.classList.add('lp-done');\r\n      it.node.style.setProperty('--p', '1');\r\n      setScale(it.fill, 1);\r\n      it.pct.textContent = '✓';\r\n      it.left.textContent = text || '上传完成';\r\n      setTimeout(function () { close(id); }, reduceMotion ? 600 : 900);\r\n    }\r\n\r\n    /** 失败：变红，多停留一些时间让用户看清 */\r\n    function fail(id, msg) {\r\n      var it = items[id];\r\n      if (!it || it.closed) return;\r\n      it.closed = true;\r\n      it.node.classList.remove('lp-unknown', 'lp-done');\r\n      it.node.classList.add('lp-error');\r\n      it.pct.textContent = '!';\r\n      it.left.textContent = msg || '上传失败';\r\n      setTimeout(function () { close(id); }, reduceMotion ? 900 : 2000);\r\n    }\r\n\r\n    function close(id) {\r\n      var it = items[id];\r\n      if (!it) return;\r\n      it.closed = true;\r\n      var node = it.node;\r\n      node.classList.remove('lp-on');\r\n      delete items[id];\r\n      setTimeout(function () {\r\n        if (node.parentNode) node.parentNode.removeChild(node);\r\n        // 栈空了连容器一起摘掉，保持 DOM 干净\r\n        if (stack && !stack.children.length && stack.parentNode) {\r\n          stack.parentNode.removeChild(stack);\r\n          stack = null;\r\n        }\r\n      }, reduceMotion ? D.micro : D.cardExit + 100);\r\n    }\r\n\r\n    return {\r\n      begin: begin,\r\n      set: set,\r\n      done: done,\r\n      fail: fail,\r\n      close: close\r\n    };\r\n  })();\r\n\r\n  /* ============================================================\r\n     真实上传进度（XHR 通道）\r\n     ------------------------------------------------------------\r\n     背景：script.js 的图片/文件上传走 I() → POST /upload，\r\n     整包 base64 一次发出。fetch 没有上传进度事件，拿不到真实百分比。\r\n     而 script.js 内已定义的 uploadChunked（分片）目前没有任何调用点，\r\n     属于死代码，直接改它等于动核心上传逻辑，风险不可接受。\r\n\r\n     方案：不动 script.js。在 fetch 包装层识别 /upload 与 /upload-chunk\r\n     两个路径，改用 XMLHttpRequest 发送 —— XHR 的 upload.onprogress\r\n     能给出真实的 loaded/total。响应再包成标准 Response 返回，\r\n     上层（data-cache.js 的 res.json() / res.status）完全无感。\r\n     ============================================================ */\r\n\r\n  var uploadXhr = (function () {\r\n\r\n    /*进度 UI 的安全调用包装：\r\n      UI 层的任何异常都不允许影响上传主流程，故全部吞掉并降级为无 UI。*/\r\n    function safe(fn) {\r\n      return function () {\r\n        try { return fn.apply(null, arguments); } catch (e) { return null; }\r\n      };\r\n    }\r\n    var up = {\r\n      begin: safe(upload.begin),\r\n      set: safe(upload.set),\r\n      done: safe(upload.done),\r\n      fail: safe(upload.fail),\r\n      close: safe(upload.close)\r\n    };\r\n\r\n    /**\r\n     * 需要走 XHR 通道的路径。\r\n     * 注意：data-cache.js 里是 fetch(cfg.base + path)，\r\n     * base 配的是 '/api'，所以实际请求是 '/api/upload' 这类绝对路径 URL。\r\n     * 这里做后缀匹配，兼容 base 被改成 '/api/v2' 或直接为 '' 的情况。\r\n     */\r\n    function isUploadPath(path) {\r\n      var p = normalize(path);\r\n      if (p === null) return false;\r\n      return /\/upload(-chunk|-assemble)?$/.test(p);\r\n    }\r\n\r\n    /**\r\n     * 把入参归一化成「以 / 开头的路径」，去掉 query / hash / origin。\r\n     * 同源之外的地址返回 null（交给原生 fetch，不接管）。\r\n     * @param {string} raw\r\n     * @return {?string}\r\n     */\r\n    function normalize(raw) {\r\n      if (typeof raw !== 'string' || !raw) return null;\r\n\r\n      var s = raw;\r\n      // 相对协议 //host/path 与绝对 URL 统一按 origin 剥离\r\n      var origin = global.location && global.location.origin;\r\n      if (origin && s.indexOf(origin) === 0) {\r\n        s = s.slice(origin.length);\r\n      } else if (/^https?:\/\//i.test(s)) {\r\n        return null; // 跨源（CDN / 第三方），不接管\r\n      }\r\n\r\n      s = s.split('#')[0].split('?')[0];\r\n      if (s.charAt(0) !== '/') return null;\r\n\r\n      // 去掉结尾多余斜杠，统一小写（路径大小写不敏感更安全）\r\n      s = s.replace(/\/+$/, '');\r\n      return s.toLowerCase();\r\n    }\r\n\r\n    /**\r\n     * 用 XHR 发送并回报真实上传进度，返回标准 Response。\r\n     * @param {string} url\r\n     * @param {Object} init  fetch 的 init（headers / body / signal）\r\n     * @param {string} label 进度卡上显示的名称\r\n     * @return {Promise<Response>}\r\n     */\r\n    function send(url, init, label) {\r\n      init = init || {};\r\n\r\n      var payload = init.body;\r\n      var totalBytes = byteLengthOf(payload);\r\n      // 进度卡建不出来（如 DOM 尚未就绪）时 taskId 为 null，上传照常进行\r\n      var taskId = up.begin({\r\n        name: label || '正在上传照片…',\r\n        total: totalBytes\r\n      });\r\n\r\n      return new Promise(function (resolve, reject) {\r\n        var xhr = new XMLHttpRequest();\r\n        var settled = false;\r\n\r\n        function cleanup() {\r\n          if (init.signal) {\r\n            try { init.signal.removeEventListener('abort', onAbort); } catch (e) { /* 忽略 */ }\r\n          }\r\n        }\r\n\r\n        function onAbort() {\r\n          if (settled) return;\r\n          settled = true;\r\n          try { xhr.abort(); } catch (e) { /* 忽略 */ }\r\n          cleanup();\r\n          up.fail(taskId, '已取消');\r\n          reject(new DOMException('Aborted', 'AbortError'));\r\n        }\r\n\r\n        if (init.signal) {\r\n          if (init.signal.aborted) { onAbort(); return; }\r\n          init.signal.addEventListener('abort', onAbort);\r\n        }\r\n\r\n        xhr.open((init.method || 'GET').toUpperCase(), url, true);\r\n\r\n        // 复制 headers（fetch init.headers 可能是普通对象或 Headers 实例）\r\n        try {\r\n          var h = init.headers;\r\n          if (h && typeof h.forEach === 'function' && typeof h.get === 'function') {\r\n            h.forEach(function (v, k) { xhr.setRequestHeader(k, v); });\r\n          } else if (h) {\r\n            for (var k in h) {\r\n              if (Object.prototype.hasOwnProperty.call(h, k)) {\r\n                xhr.setRequestHeader(k, h[k]);\r\n              }\r\n            }\r\n          }\r\n        } catch (e) { /* 忽略：非法 header 交给 XHR 自己报错 */ }\r\n\r\n        /* ---- 真实上传进度 ---- */\r\n        if (xhr.upload) {\r\n          xhr.upload.onprogress = function (ev) {\r\n            if (settled) return;\r\n            if (ev.lengthComputable && ev.total > 0) {\r\n              up.set(taskId, { loaded: ev.loaded, total: ev.total });\r\n            }\r\n          };\r\n        }\r\n\r
        xhr.onload = function () {\r\n          if (settled) return;\r\n          settled = true;\r\n          cleanup();\r\n\r\n          // 组装标准 Response，让上层 res.json() / res.status 照常工作\r\n          var headers = new Headers();\r\n          try {\r\n            var ct = xhr.getResponseHeader('Content-Type');\r\n            if (ct) headers.set('Content-Type', ct);\r\n          } catch (e) { /* 忽略 */ }\r\n\r
          var res = new Response(xhr.responseText, {\r\n            status: xhr.status,\r\n            statusText: xhr.statusText || '',\r\n            headers: headers\r\n          });\r\n\r
          if (xhr.status >= 200 && xhr.status < 300) {\r\n            up.done(taskId, '上传完成');\r\n          } else {\r\n            up.fail(taskId, '上传失败（' + xhr.status + '）');\r\n          }\r\n          resolve(res);\r\n        };\n\r
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
