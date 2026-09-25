# 蓝牙/近场通信 实施计划(执行版)

> 上游方案见 [bluetooth-offline-redesign.md](./bluetooth-offline-redesign.md)。本文件聚焦「改哪、怎么改、怎么验」,基于实读代码后给出的当前状态。

## 现状快照(2026-08-27 实读)

| 模块 | 文件 | 状态 |
|---|---|---|
| UI 骨架(三 tab + hero + RTT 面板 + QR/扫码区) | [index.html:670-760](../../index.html#L670-L760) | ✅ 已写 |
| UI 样式(`bt-hero`/`bt-seg`/`bt-rtt-panel`/`offline-qr-box`/`offline-scan-box`) | [style.css](../../style.css) | ❌ **完全缺失** → UI 不好看的直接原因 |
| `loadQRCode`/`loadLZ`/`loadJsQR`/`sdCompress`/`sdDecompress` 工具函数 | [script.js:44-93](../../script.js#L44-L93) | ✅ 已写 |
| 长轮询信令(190ms)+ BroadcastChannel 同标签零延迟 + sid 去重 | [script.js:4602+](../../script.js#L4602) | ✅ 已写 |
| `nearSetupPC` 预热 ICE / 批量打包 / reliable / 心跳 RTT | [script.js:4694](../../script.js#L4694) | ❌ 仍是老版 |
| 应用层 ACK + SDP 压缩接线到信令 | [script.js:4720](../../script.js#L4720) `nearBindDC` | ❌ 未写 |
| 离线 QR-SDP 完整业务流程 | script.js | ❌ **完全没写**,只有工具函数 |
| 三 tab 文案诚实化 | index.html / script.js | ❌ 待统一 |

---

## 任务 1 · UI 样式落地(style.css)

**目标**:让蓝牙对话框「好看 + 信息层次清晰」,复用现有 glass 设计系统。

**改动点**:在 [style.css](../../style.css) 末尾追加一段 `.bt-*` / `.offline-*` 命名空间样式,包含:

1. `.bt-hero` —— 顶部渐变 hero 条(品牌色 → 透明),`bt-hero-wave` 三个 `<span>` 做正弦波纹动效(`@keyframes` 平移 + 缩放,周期错开)。
2. `.bt-seg` 分段控件 —— 胶囊容器 + `.bt-seg-thumb` 滑块(`transform: translateX()` 切换,`transition: transform .25s cubic-bezier(.4,1.4,.6,1)`)。
3. `.bt-chip` 状态徽章 —— 三态颜色变量(`--chip-ok` 绿 / `--chip-wait` 橙 / `--chip-fail` 红),带脉冲点。
4. `.bt-rtt-panel` —— 玻璃面板,4 个 `.bt-rtt-item` 等宽,`.bt-rtt-ok` 永远绿色高亮「0 丢包」。
5. `.offline-qr-box` —— 居中白底圆角,内部 `canvas`/`img` 自适应;分片时下方显示进度 `2/5`。
6. `.offline-scan-box` —— `video` 全屏铺满,扫描框(四角 L 形 `::before/::after`)+ 红色扫描线 `@keyframes` 上下扫。
7. RSSI 信号强度条 `.bt-rssi` —— 5 段竖条,根据 dBm 值点亮不同数量。
8. 暗色模式 `body.dark` 下的对应色值覆盖。

**验收**:打开对话框,hero 波纹动效流畅,tab 切换滑块动画,状态 chip 颜色正确,RTT 面板对齐美观,扫描框 L 形角 + 扫描线动效可见。

---

## 任务 2 · 延迟压低(script.js 近场区段)

**改动点**:重写 [script.js:4694 `nearSetupPC`](../../script.js#L4694) 与 `nearBindDC`,新增状态变量。

1. **ICE 批量打包**:新增 `nearIceBatch = []` 和 50ms flush 定时器;`onicecandidate` 推入数组,定时器到点聚成一条 `{type:'ice-batch',items:[...]}` 信令发出。`nearHandleSignal` 加 `ice-batch` 分支,循环 `addIceCandidate`。
2. **预热 ICE**:offerer 在 `setLocalDescription` 后不立即发 SDP,等 `iceGatheringState === 'complete'` 或 800ms 超时再发(用 `nearPC.iceGatheringState` + `Promise.race`),减少对端半连接态等待。
3. **数据通道显式 reliable**:`createDataChannel('stating', { ordered: true, maxRetransmits: Infinity })` —— 0 丢包语义。
4. **心跳 RTT**:连接 open 后启动 `setInterval(2000)`,发 `{type:'ping', t:Date.now()}`;对端回 `{type:'pong', t}`;收到 pong 计算 RTT,更新 `#nearRttVal`。
5. **极弱网开关**:UI 加 checkbox「纯 host 模式(省流量,仅同局域网)」,勾选时 `iceTransportPolicy:'relay'`→ 改为仅 host 候选,跳过 STUN。

**验收**:同机两标签页建连,RTT 显示 <100ms;ICE 批量后控制台 Network 信令数减少 ≥60%。

---

## 任务 3 · 0 丢包 + 低带宽(script.js)

**改动点**:`nearBindDC` 的 `onmessage` 改造 + 信令发送走压缩。

1. **应用层 ACK**:每条业务消息带 `mid = Date.now()+rand`,发送方维护 `nearPendingAck = Map(mid → {payload, retries, nextTimer})`;接收方收到业务消息立即回 `{type:'ack',mid}`;发送方收 ACK 清除;2s 未收 ACK 重发(最多 3 次),UI `#nearSentCnt++`、`#nearAckCnt++`。
2. **SDP 压缩接线**:`nearSendSignal` 发 offer/answer 时 `payload = sdCompress(sdp)`,`nearHandleSignal` 收到时 `sdDecompress`。文本字段不变,仅压缩 `sdp` 字段。
3. **统计面板**:`#nearSentCnt`(累计发送业务消息数)、`#nearAckCnt`(累计已送达数)、`#nearRttVal`(最新 RTT)实时更新;0 丢包时 `.bt-rtt-ok` 绿色常亮,有未送达时变橙并显示「重传中」。

**验收**:10kbps 节流下,信令秒级完成;发送 100 条短文本,`#nearSentCnt === #nearAckCnt === 100`;断网模拟下重传触发,恢复后全送达。

---

## 任务 4 · 离线 QR-SDP 方案(script.js + 已就绪的 index.html)

**改动点**:新增 `offline*` 函数群,绑定到已存在的 DOM(`#offlineQRBox`/`#offlineScanBox`/`#offlineScanVideo` 等)。

1. `offlineStart(role)`:role ∈ {offerer, answerer};offerer 创建 `RTCPeerConnection({iceServers:[]})`(纯 host),`createDataChannel('stating', reliable)`,`setLocalDescription`,等 ICE complete,得 `offerSDP`。
2. `offlineEncodeSdp(sdp)`:调 `sdCompress`,得压缩字符串;按 `MAX_QR_LEN=800` 分片,每片包成 `{i,n,payload}` JSON;调 `loadQRCode()` 后逐片生成 QR 渲染到 `#offlineQRBox`,2s 自动翻页,显示 `i/n` 进度。
3. `offlineScanLoop()`:启动 `getUserMedia({video:{facingMode:'environment'}})`,`video` 实时帧每 200ms 送 `jsQR` 解码;成功一片 push 到 `offlinePieces[]`,n 片到齐后 `offlinePieces.sort((a,b)=>a.i-b.i).map(p=>JSON.parse(p.payload)).join('')` 得完整压缩串,`sdDecompress` 得 SDP。
4. answerer:`setRemoteDescription(offer)` → `createAnswer` → `setLocalDescription` → 等 ICE complete → 同样 QR 分片回传;offerer 扫码重组 answer → `setRemoteDescription` → 连接建立。
5. 数据通道复用任务 2/3 的 `nearBindDC`(心跳 + ACK),只是走 offline 上下文;RTT 更新到 `#offlineRttVal`,`#offlineSentCnt`/`#offlineAckCnt` 同步。
6. 错误路径:摄像头被拒/无 mDNS 候选时,`offlineSetStatus('需同局域网且无客户端隔离;浏览器无任何网络时无法直连')`。
7. tab 切换:`nearSwitchTab('offline')` 时 lazy `loadQRCode()` + `loadJsQR()` + `loadLZ()`,资源未就绪时按钮 disabled。

**验收**:同 WiFi 两台设备,A 出码 B 扫码 → 自动建连;互发文本双向收达;RTT 面板显示数值;切到真·离线(关 WiFi)后 status 提示「无可用通道」。

---

## 任务 5 · 文案诚实化(index.html + script.js)

- 蓝牙外设 tab:**「连接 BLE 传感器/外设。手机间直连请用『远程』或『离线直连』」**
- 远程 tab:**「经 WebRTC P2P 直连,信令仅 ~10KB,10kbps 极弱网可用,距离不限」**
- 离线 tab:**「无服务器、无流量,经 QR 码交换连接信息,限同局域网」**
- hero 副标题按当前 tab 切换;蓝牙 tab 不再宣称「手机间蓝牙组网」。

---

## 任务 6 · 验证

1. `node --check script.js`、`node --check functions/api/[[path]].js`、`node --check dev-server.js` —— 三文件语法零错。
2. 启 `node dev-server.js`,浏览器开 `http://localhost:8788`:
   - **UI 渲染**:对话框三 tab 切换,hero 波纹,滑块动画,RTT 面板对齐。
   - **远程建连**:两标签页同码建连,RTT <100ms,发 100 条文本 ACK 全绿。
   - **离线 QR**:A 出码、B 扫码建连,互发文本收达。
   - **极弱网**:Chrome DevTools throttle 10kbps,远程 tab 信令秒级完成。
3. 控制台 0 JS 运行时错误。

---

## 执行顺序与依赖

```
任务 1 (style.css)  ──┐
                      ├─► 任务 6 验证
任务 2 (延迟) ─┐      │
任务 3 (ACK)  ─┼─► 共享 nearBindDC ─► 任务 4 (offline 复用) ─┘
                      │
任务 5 (文案) ────────┘
```

任务 1/2/3 可并行,任务 4 依赖 2/3 的 `nearBindDC`,任务 5 任何时候都可穿插,任务 6 最后。
