# Stating 全面 Bug 修复报告

> 测试时间：2026-09-25 | 测试工具：Edge Headless CDP + dev-server:8788

## 一、已修复 Bug

### Bug 1：dev-server 缺少 `/events` SSE 实时推送路由
- **现象**：进入群聊后控制台报 6 次 `401 Unauthorized`，实时消息推送不工作
- **根因**：`script.js` 用 `EventSource('/events?code=...&token=...')` 建立 SSE 连接，但 `dev-server.js` 没有实现该路由，`authUser` 只认 `Authorization` header 不认 query token
- **修复**：在 `dev-server.js` 的 API 分发层添加 `/events` GET 特殊分支，支持 query token 鉴权、成员校验、初始消息+在线状态+已读状态推送、2s 轮询新消息（55s 超时）
- **验证**：0 failed API requests，0 console errors

### Bug 2：定时胶囊默认时间时区错误（UTC vs 本地时间）
- **现象**：点击"定时胶囊"后直接点确认，提示"解锁时间需晚于当前"，胶囊消息无法发送
- **根因**：`openCapsulePicker()` 和快捷时间按钮用 `t.toISOString().slice(0,16)`（UTC 时间）给 `datetime-local` 输入框赋值，但 `confirmCapsule()` 用 `new Date(v)` 解析为**本地时间**。UTC+8 时区下默认时间会变成过去时间
- **修复**：`script.js` 两处改为本地时间格式：
  ```js
  const local = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $('#capsuleTime').value = local;
  ```
- **影响范围**：`openCapsulePicker()`（默认1分钟后）、快捷时间按钮（.cp-quick）
- **验证**：模式条显示"定时胶囊 · 09/25 12:05"，冰封球 `.capsule-orb` 渲染成功，`.capsule-locked` 锁定状态正确

### 历史已修复 Bug（前序会话）
3. `/me` 路由未限制 `parts.length === 1`，吞掉 `/me/chat-stats`、`/me/sessions` → 已加长度判断
4. `/bioroom/:code` GET 未排除子路径，吞掉 `/bioroom/messages` 等 → 已加排除列表
5. CSS 批次3重复块 → 已清理
6. 情绪头像 `applyMoodGlow` 未挂钩渲染 → 已接入 `renderMessages`
7. 审计脚本 token key 错误（`'token'` 应为 `'stating_token'`）→ 已修正

## 二、全量功能验证结果（12 项全部通过）

| # | 功能 | 结果 | 关键指标 |
|---|------|------|----------|
| 1 | SIM 一键登录+注册 | ✅ | token 写入成功 |
| 2 | 个人菜单三入口 | ✅ | heatmap/yearReport/bioRoom 均存在 |
| 3 | 聊天热力图 | ✅ | 365 cells 渲染 |
| 4 | 年度聊天报告 | ✅ | 5 张卡片 |
| 5 | 双人生物房间 | ✅ | 创建按钮+加入输入框 |
| 6 | 建群（UI流程） | ✅ | 进入聊天室，群名正确 |
| 7 | + 菜单四项 | ✅ | ephemeral/capsule/whisper/bioSign |
| 8 | 普通消息发送 | ✅ | msgCount=1 |
| 9 | 右键菜单 | ✅ | 9 项（回复/表情/转发/收藏/翻译/多选/置顶/编辑/撤回） |
| 10 | 文字动效（生日快乐） | ✅ | layer 可见，40 particles |
| 11 | 阅后即焚（5秒） | ✅ | `.ephemeral-tag` 显示，倒计时 5s |
| 12 | 定时胶囊（60秒后） | ✅ | `.capsule-orb` 冰封球，`.capsule-locked` 锁定 |

**Console Errors: 0 | Console Warnings: 0 | Failed API Requests: 0**

## 三、明日待办（未完成项）

1. **截图视觉审查**：各步骤截图已保存至 `audit2_shots/`，需人工检查液态玻璃风格在深色模式下的表现
2. **移动端响应式**：需在 390×844 视口下测试布局
3. **悄悄话 N4 完整流程**：发送方/接收方 UV 解锁查看即焚
4. **生物签名 N5**：发送时指纹/面容确认流程
5. **N2 融化撤回**：撤回消息的融化动画 `meltAndRemove`
6. **多选模式 P4**：批量删除/转发
7. **表情 Reaction Q5**：消息下方表情条
8. **双人生物房间 N6**：创建→加入→消息→关闭全链路
9. **Q1 伪登录警告**：异地登录检测
10. **生产环境凭证**：微信 `WX_APPID/WX_SECRET`、SIM `SIM_PROVIDER/APPID/APPKEY`、短信 SDK 凭证

## 四、修改的文件

- `dev-server.js` — 新增 `/events` SSE 路由（约 45 行）
- `script.js` — 修复胶囊时间时区 bug（2 处，各 1 行）
- `audit2.mjs` — 审计脚本迭代（群列表刷新、网络拦截、消息调试）
