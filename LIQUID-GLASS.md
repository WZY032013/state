# Stating · Liquid Glass 材质与动效层

本目录记录本轮新增的「材质层」与「动效层」实现依据、参数来源与验证方式。
面向后续维护者，重点说明**为什么这样分层**以及**哪些地方容易改坏**。

---

## 1. 交付物

| 文件 | 行数量级 | 职责 |
|---|---|---|
| `css/lg-material.css` | ~430 | 只管**材质**：厚度分层、边缘、光斑、降级、无障碍 |
| `css/lg-motion.css` | ~250 | 只管**动效**：弹簧曲线、按压反馈、入场、减弱动效 |
| `js/lg-spring.js` | ~230 | 弹簧引擎：可打断动画 + 速度交接 |
| `test/gen-spring.js` | ~80 | 弹簧曲线生成器（CSS `linear()` 的数据来源） |
| `test/liquid-glass.test.js` | 76 断言 | 材质层 / 动效层静态校验 |
| `test/lg-spring.test.js` | 34 断言 | 弹簧物理正确性 |
| `test/css-cascade.test.js` | 41 断言 | 真实层叠计算，验证覆盖是否生效 |

**载入顺序**（`index.html`）：

```
style.css → lg.css → css/loading.css → css/lg-material.css → css/lg-motion.css
```

新两层必须在 `lg.css` 之后，否则覆盖不生效。

---

## 2. 材质分层：为什么不是「所有东西都玻璃」

HIG 的硬规则是 **材质只给功能层**，玻璃不进内容层。原因是工程性的，不是审美偏好：

1. **对比度**：正文压在毛玻璃上，文字对比度不可控，浅色主题下尤其明显。
2. **合成成本**：`backdrop-filter` 每个表面一次全屏采样回读，浮层数量直接决定掉帧率。
3. **轻材质不叠轻材质**：玻璃里再套玻璃会糊成一片，反而丢掉层次。

所以本项目分三层，**厚度编码层级**（越靠上的越"实"，因为背后内容越杂乱）：

| 层 | 表面 | 不透明度（浅色） | 模糊 | 依据 |
|---|---|---|---|---|
| `clear` | 菜单、上下文菜单、反应条、输入胶囊 | `.52` | 20px | 体积小，背后不杂乱，可以更透 |
| `regular` | 顶栏、聊天头部、在线面板 | `.64` | 26px | 常驻导航，需看清但不刺眼 |
| `thick` | 弹窗、抽屉、生物门禁、通话面板 | `.74` | 32px | 背后最杂乱，必须压得住 |
| **内容层** | 个人卡、我的群聊、反馈区、列表头 | `.97` 实色 | **无** | 正文可读性优先，玻璃不进内容层 |

> 反直觉但正确的一点：**越大的浮层，玻璃越"实"**，不是越透。
> 大面积透明会让杂乱背景直接透进来，反而更乱。

---

## 3. 与 `lg.css` Part 9 的关系（改这里之前先读）

`lg.css` Part 9 曾把 `.glass` 系列整体压平成"纯白 + 细线"，**浮层也被一起压平了**。
浮层属于控件层，本应有玻璃 —— 这就是本轮要修的主要问题。

### 特异性陷阱（本轮实际踩到并修复）

`lg.css` Part 9 的深色段选择器是：

```css
body.dark .glass:not(.home-hero):not(.feature-card):not(.glass-pill) { … }
```

其特异性为 **(0,5,1)**（`body` 与 `.dark` 各计入类列）。
而材质层若只写 4 个 `:not` 守卫，是 **(0,5,0)** —— **深色模式下会输，玻璃静默消失**。

**修复方式**：材质层为每个分层补一份 `body.dark` 变体，取得 (0,6,1)。已加回归断言锁死。

同理 `style.css` 里的 `body.dark .topbar{…}` 是 (0,2,1)，控件层浅色段只有 (0,1,0)，也必须补深色段。

### 两条不要改的规则

1. **不要对已定位元素强设 `position: relative`**
   `.online-panel`(absolute)、`.group-menu`(absolute)、`.msg-ctx-menu`(fixed) 等本就靠定位锚定，
   覆盖会把菜单从锚点拽走。本文件只在 `.confirm-card / .admin-panel / .reply-bar` 三个
   **确实缺定位**的表面兜底。

2. **不要用伪元素 `padding` 做描边**
   `lg.css` 里 `.glass::before{padding:2px}` 曾导致圆角变形（非 HiDPI 屏子像素抗锯齿）。
   边缘一律用 `inset box-shadow`，高光层显式 `padding:0 !important` 覆盖。

---

## 4. 弹簧曲线：从物理算出来，不靠手感调

`lg.css` 原先用的是拍脑袋的 `cubic-bezier(.34,1.56,.64,1)`（等价 damping≈0.55），
过冲明显，与 Apple "UI 默认临界阻尼" 的原则冲突。

`test/gen-spring.js` 按**阻尼谐振子解析解**采样生成 `linear()`：

```
ζ ≥ 1：x(t) = (x₀ + Bt)·e^(−ζωₙt)，  B = v₀ + ζωₙx₀
ζ < 1：x(t) = e^(−ζωₙt)(A·cos ω_d t + B·sin ω_d t)，ω_d = ωₙ√(1−ζ²)
ωₙ = 2π / response
```

改参数后重新生成：

```bash
node test/gen-spring.js
```

### 四个档位

| Token | response | damping | 过冲 | 用途 |
|---|---|---|---|---|
| `--lgx-spring` | 0.35s | 1.0 | 0% | UI 默认，**不过冲不回摆** |
| `--lgx-press` | 0.22s | 1.0 | 0% | 按压反馈 |
| `--lgx-sheet` | 0.38s | 0.8 | 1.49% | 抽屉/浮层，有动量来源 |
| `--lgx-momentum` | 0.45s | 0.7 | 4.55% | 拖拽甩动（预留） |

> **注意**：`--lgx-spring` 与 `--lgx-press` 的曲线**数值完全相同**。
> 这不是复制粘贴失误 —— 临界阻尼曲线是自相似的，`response` 只改变时长、不改变形状。
> 测试里有断言锁住这个事实（`临界阻尼两档曲线一致`）。

### 浏览器兼容

`linear()` 需要 Chrome 113+ / Safari 17.2+ / Firefox 112+。
`@supports not (transition-timing-function: linear(0,1))` 里给了 `cubic-bezier` 兜底。

---

## 5. 可打断性：为什么需要 `lg-spring.js`

CSS `transition` 无法"中断后从当前屏幕值反向起播" —— 它只能从**声明值**重新开始。
菜单开了又关、开关快速连点，会出现肉眼可见的跳变。

`js/lg-spring.js` 提供：

- `setTarget(v)` —— 保留当前速度继续演进，**这就是可打断**
- `setTarget(v, {velocity})` —— 速度交接（甩得快就弹得远）
- `jump(v)` —— 直接落位，`prefers-reduced-motion` 走这条
- `projectVelocity(x, v, d)` —— WWDC 甩动落点投射公式

两条分支都**已与数值积分对照验证**（误差 < 0.1%）。

### 已修复的真实 Bug

初版临界阻尼分支写错了速度更新式（多了一个 `+ c2` 项且 `c1` 系数错误），
导致**数值发散**：目标 100 时峰值飙到 182877。
`test/lg-spring.test.js` 的"不过冲 / 单调性"断言当场抓到，改正后全绿。

> `dt` 已钳位到 64ms —— 标签页切后台再回来时，不会因单帧 dt 过大而发散。

### 启用条件（性能分级）

仅在**桌面 + 精细指针 + ≥4 核 + 非 reduced-motion** 下启用；
触屏交给 `:active`（触屏没有连续按压时长的概念）。
DOM 移除的元素会自动从内部 Map 清理，防止泄漏。

---

## 6. 动效属性预算

**只动画 `transform` 和 `opacity`** —— 两者能被合成器接管，不触发布局与重绘。

已从 `lg.css` 的 `lg-fuse` 中移除 `filter: blur(8px)`：
大面积模糊每帧都要重新合成纹理，是玻璃入场动画最大的掉帧来源。

一次性动画不使用 `will-change` 常驻，避免长期占用合成层。

---

## 7. 无障碍与降级（五条路径）

| 场景 | 行为 |
|---|---|
| `prefers-reduced-motion` | 位移动画 → **纯交叉淡化**；停用所有 transform 反馈；关闭指针跟随的动态镜面 |
| `prefers-reduced-transparency` | 材质 → 实色（对比度优先于风格） |
| `prefers-contrast: more` | 近实色 + 2px 明确边框；关闭高光层 |
| `forced-colors: active` | 交由系统配色接管（Windows 高对比度） |
| 不支持 `backdrop-filter` | → 高不透明度实色，并移除高光层省合成 |
| `@media print` | 去材质、去装饰 |

> **减弱动效不能用 `.001ms` 秒杀**（`lg.css` 原写法）。
> 那会让所有元素瞬时跳变，反而造成不适 —— 正确做法是**换成交叉淡化**。

---

## 8. 验证

```bash
node test/lg-spring.test.js      # 34 断言：弹簧物理 / 可打断 / 降级
node test/liquid-glass.test.js   # 76 断言：分层 / 无障碍 / 挂载 / 性能约束
node test/css-cascade.test.js    # 41 断言：真实层叠计算（深浅双主题）
```

`css-cascade.test.js` 不只做字符串匹配，它实现了**迷你 CSS 匹配器 + 特异性计算**，
按 `!important → 特异性 → 源序` 算出最终胜出规则，并解引用 `var(--lgm-*)`。
深色模式玻璃丢失的缺陷就是它跑出来的。

**全量回归：7 个测试文件、198 条断言、0 失败**（改动前基线 70 条）。

---

## 9. 后续可做

- [ ] `projectVelocity` 已导出但项目暂无拖拽类手势，接抽屉拖拽时可直接用
- [ ] `lens-manager.js` 的 WebGL 真折射目前是 `?lens=1` opt-in，可考虑接入本层弹簧做 tilt 跟随
- [ ] 消息气泡玻璃款未分层处理，若要更通透可加 `clear` 档