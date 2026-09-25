# 蓝牙/近场通信 重做方案

## ⚠️ 可行性裁决（必须先读）

用户目标:「纯浏览器 + 无硬件 + 无 WiFi/无流量 + >10km + 蓝牙双方案 + 0 丢包 + 低延迟」。**这组要求在物理上不可能同时成立**,原因:

1. **>10km 在纯浏览器无硬件下无法实现**:浏览器唯一的离线无线电 API 是 Web Bluetooth(蓝牙),而蓝牙法规上限 ~100m(手机 Class 2 仅 ~10m)。浏览器**无 LoRa/SX1278 等远距离电台 API**,>10km 离线只能靠硬件中继或 LoRa,而用户已选「纯浏览器不要硬件」。
2. **纯浏览器无法做手机间蓝牙组网**:Web Bluetooth 只能当**主机(Central)**,浏览器**不能当从机广播**(无 Peripheral/Advertise API),故「手机 A ↔ 手机 B」直连 BLE 与 BLE 网状中继在浏览器里都不成立。BLE 只能连**外设硬件**(传感器/ESP32),而用户不要硬件。
3. **绝对气隙(无网 + 无局域网)下纯浏览器没有任何设备到设备通道**:WebRTC 要 IP 路由,Web NFC 仅 ~5cm,WebUSB 要线。

### 现实可达成上限（本方案据此设计）

用户补充:「可以有支持打开网站的最低流量(10kbps)」。据此:
- **远距离(>10km、甚至全球)可达成**:经 WebRTC over 互联网,信令(<10KB)在 10kbps 下秒级完成,数据通道直连 P2P。**这才是真正的 >10km 方案,只是用「最低流量」而非「纯蓝牙」**。
- **纯离线可达成**:仅限**同局域网**场景,用 QR 码交换 SDP(无服务器信令),WebRTC 走 host 候选直连。无局域网则无路可走(物理墙)。
- **0 丢包**:WebRTC 数据通道默认 reliable+ordered,已天然 0 丢包;补应用层 ACK 显式反馈。
- **低延迟**:P2P 直连 + 预热 ICE + 降 STUN 流量。

**诚实结论**:不假装 10km 蓝牙。把「双方案」做成「远距离(最低流量 WebRTC)」+「离线(同局域网 QR-SDP WebRTC)」,UI 重做,延迟/丢包压到最低。蓝牙 tab 保留为「连 BLE 外设」,明确标注**不支持手机间直连**。

---

## 现状分析（基于实读代码）

- 对话框:[index.html:670-716](file:///c:/Users/zhang/Desktop/WZY/github%20files/stating.pages.dev/index.html#L670-L716),两 tab:「📡 蓝牙」+「🌐 近场 P2P」
- 蓝牙 tab:[script.js:4306+ btScan](file:///c:/Users/zhang/Desktop/WZY/github%20files/stating.pages.dev/script.js) 用 `requestDevice({acceptAllDevices,optionalServices:BT_OPTIONAL_SERVICES})`,只能连外设,无法手机间。
- 近场 tab:`nearSetupPC`(script.js:4657) 用 Google STUN,数据通道 `createDataChannel('stating')` 默认可靠有序;信令走已建的长轮询(190ms)。
- UI 样式:[style.css:3800-3834](file:///c:/Users/zhang/Desktop/WZY/github%20files/stating.pages.dev/style.css#L3800-L3834),朴素平铺,缺视觉层次。
- 已加载 `jsQR` 扫码库([script.js:49](file:///c:/Users/zhang/Desktop/WZY/github%20files/stating.pages.dev/script.js#L49)),但**无 QR 生成器**。

---

## 改动清单

### 1. UI 重做（`index.html` + `style.css`）

**对话框重构**为三 tab,语义诚实:
- `📡 蓝牙外设`(原蓝牙 tab,改文案明确「连接 BLE 传感器/设备,不支持手机间直连」)
- `🌍 远程`(原近场 P2P,改名,主打「最低流量·全球直连」)
- `📶 离线直连`(新增,QR-SDP 同局域网无服务器方案)

**视觉**:在 [style.css](file:///c:/Users/zhang/Desktop/WZY/github%20files/stating.pages.dev/style.css) 复用现有 glass 设计系统(`--glass-*` token,130-258 行),给蓝牙对话框升级:
- 顶部加渐变 hero 条(信号波纹动效),显示当前方案 + 距离/状态徽章
- tab 改胶囊分段控件(`.bt-seg`)带滑块动效
- 状态用彩色 chip(绿=已连/橙=握手/红=失败),替代纯文字
- 设备/接收列表用卡片 + 信号强度条(RSSI 可视化)
- 连接成功后展示「延迟 XX ms · 0 丢包 · 距离评估」实时面板

### 2. 延迟压低（`script.js` 近场区段 4457-4705）

- **预热 ICE**:`nearSetupPC` 里 `onicecandidate` 改为 `gatherIce` 缓冲,SDP 用 `RTCRtpSender.transceiver` 的待 trickle;首条信令一到立即 flush。当前每条 ICE 单发一次 POST(多往返),改为**批量打包**(50ms 窗口聚成一条信令)。
- **降 STUN 流量**:近场同网段优先 host 候选;`iceServers` 加 `iceTransportPolicy:'all'` 但 UI 提示「极弱网可关 STUN」开关(纯 host 模式,省流量)。
- **数据通道调优**:`createDataChannel('stating',{ordered:true,maxRetransmits:Infinity})` 显式 reliable;`maxPacketLifeTime` 不设(默认无限重传=0 丢包)。
- **心跳 + RTT**:每 2s 发 `ping`,对端回 `pong`,UI 实时显示 RTT。

### 3. 0 丢包 + 低带宽（`script.js`）

- 数据通道天然 reliable;补**应用层 ACK**:每条消息带 `mid`,接收方回 `ack:{mid}`;发送方 2s 未收 ACK 重发(最多 3 次),UI 标「已送达」。
- **信令瘦身**:SDP 用 `JSON.stringify` 后 ` LZString` 压缩(引入 cdn `lz-string`,~4KB→~1KB),适配 10kbps。
- 长轮询已 190ms,保留;POST 信令后立即触发对端长轮询命中(已由 300ms 内部轮询保证)。

### 4. 离线 QR-SDP 方案（新增 `script.js` 区段 + `index.html`）

- 引入 QR 生成器:`qrcodejs` cdn(`<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js">`),复用已加载 `jsQR` 扫码。
- 流程:A 生成 offer → 压缩 → 若 ≤1 个 QR 则单码,否则**分片**成 N 个 QR(每片带 `{i,n,payload}`),轮播显示;B 用 `jsQR` 逐片扫码重组 → setRemoteDescription → 生成 answer → 同样 QR 回传 → A 扫码 → 建连。
- 无服务器、无流量,仅靠同局域网 host 候选(`xxx.local` mDNS)。诚实标注:「需双方在同一 WiFi/局域网,且无网络隔离」。
- 真正气隙(无局域网)时 UI 显示「无可用通道:浏览器在无任何网络时无法直连,请进入同局域网或开启最低流量」。

### 5. 文案诚实化（`index.html` + `script.js`）

- 蓝牙外设 tab 文案改:「连接 BLE 传感器/外设。**手机间直连请用「远程」或「离线直连」**」。
- 远程 tab 文案改:「经 WebRTC P2P 直连,信令仅 ~10KB,**10kbps 极弱网可用**,距离不限(需能打开本站)」。
- 离线 tab 文案:「无服务器、无流量,经 QR 码交换连接信息,**限同局域网**」。

---

## 假设与决定

- 不假装 10km 蓝牙(物理不可能),用「最低流量 WebRTC」实现真实远距离。
- 不做手机间 BLE(浏览器 API 不支持),蓝牙 tab 仅留外设用途。
- 离线方案限同局域网;真正气隙无解,UI 明示。
- 引入两个 CDN:`qrcodejs`(生成)+ `lz-string`(SDP 压缩);均为零依赖小库。
- 复用现有 glass 设计系统与长轮询信令,不重造基础设施。

## 验证步骤

1. `node --check script.js` + 三文件语法零错。
2. 启 dev-server,headless Chromium(puppeteer)跑:
   - UI 截图对比:新对话框 hero/分段控件/状态 chip/RTT 面板渲染正常。
   - 远程 tab:两标签页建连,测 RTT(<500ms 同机)、发文本双向收达、0 丢包(ACK 全绿)。
   - 离线 tab:A 出 QR、B 扫码重组 SDP、建连成功、互发消息。
   - 极弱网模拟:Chrome DevTools throttle 10kbps,信令仍秒级完成、连接成功。
3. 控制台 0 JS 运行时错误。
4. 蓝牙外设 tab:无设备时文案正确,不报错。
