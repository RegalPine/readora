# PRD-003：Readora 视觉设计规范

| 属性 | 内容 |
|---|---|
| 文档编号 | PRD-003 |
| 文档名称 | 视觉设计规范 |
| 文档版本 | 1.3.0 |
| 文档状态 | Draft |
| 所属产品 | Readora |
| 关联文档 | PRD-001、PRD-002 |
| 设计参考 | Obsidian、Minimal Reading UI |
| 设计体系 | Design Tokens + Tailwind Utilities + Component Styles |
| 主题模式 | Light / Dark |

---

## 1. 设计目标

### 1.1 核心目标

构建一套适用于 VS Code Markdown 阅读器的视觉设计系统。

重点解决：

1. Markdown 文档的阅读舒适度。
2. 长文档的信息层次。
3. 代码块和技术内容的视觉呈现。
4. Mermaid 图形与正文的视觉统一。
5. Light / Dark 双主题的一致性。
6. 组件之间的设计一致性。
7. 不同显示尺寸下的阅读体验。

### 1.2 设计理念

产品采用：

**Minimal Editorial + Technical Elegance**

即编辑出版物式的阅读排版与现代技术产品视觉风格相结合。

设计关键词：

- Elegant：优雅。
- Minimal：简洁。
- Calm：平静。
- Readable：易读。
- Structured：有序。
- Precise：精确。
- Consistent：一致。

### 1.3 视觉原则

| 原则 | 说明 |
|---|---|
| Typography First | 优先通过字体和排版建立视觉层次 |
| Content Dominance | 内容是界面主体 |
| Restrained Color | 克制使用强调色 |
| Consistent Rhythm | 统一间距和视觉节奏 |
| Subtle Separation | 使用轻量边界区分区域 |
| Semantic Color | 颜色表达语义而非装饰 |
| Theme Consistency | 所有模块遵循统一主题 |

---

## 2. 整体视觉方向

### 2.1 设计参考

参考 Obsidian 的阅读体验，但不直接复制其 UI。

重点借鉴：

- 正文居中布局。
- 清晰的标题层级。
- 低干扰界面。
- 舒适的正文行距。
- 轻量的代码块背景。
- 柔和的边框。
- 统一的主题变量。

### 2.2 不采用的设计方式

- 大面积高饱和度颜色。
- 过度使用阴影。
- 过多卡片容器。
- 高频渐变背景。
- 过度装饰性的图标。
- 过多圆角嵌套。
- 过多分割线。
- 过度紧凑的正文排版。

---

## 3. Design Token 架构

### 3.1 Token 分层

采用三级设计 Token 架构。

```mermaid
flowchart TB
    A[Design Tokens]
    A --> B[Primitive Tokens]
    A --> C[Semantic Tokens]
    A --> D[Component Tokens]

    B --> E[Color]
    B --> F[Typography]
    B --> G[Spacing]
    B --> H[Radius]
    B --> I[Shadow]

    C --> J[Surface]
    C --> K[Text]
    C --> L[Border]
    C --> M[Accent]
    C --> N[Status]

    D --> O[Markdown]
    D --> P[Code Block]
    D --> Q[Diagram]
    D --> R[Sidebar]
    D --> S[Toolbar]
```

### 3.2 Primitive Tokens

Primitive Token 表示基础设计值，不直接承担业务语义。

主要类别：

- Color Palette。
- Typography Scale。
- Spacing Scale。
- Radius Scale。
- Shadow Scale。
- Motion Scale。

### 3.3 Semantic Tokens

Semantic Token 将基础设计值映射为使用语义。

例如：

| Token | 作用 |
|---|---|
| color.surface.canvas | 阅读画布背景 |
| color.surface.panel | 侧栏背景 |
| color.text.primary | 正文主文字 |
| color.text.secondary | 辅助文字 |
| color.border.default | 默认边框 |
| color.accent.primary | 主要强调色 |
| color.status.success | 成功状态 |
| color.status.warning | 警告状态 |
| color.status.danger | 错误状态 |

### 3.4 Component Tokens

组件 Token 由 Semantic Token 派生。

例如：

- markdown.heading.color。
- markdown.paragraph.line-height。
- code.background。
- diagram.node.background。
- sidebar.item.active.background。
- toolbar.button.hover.background。

组件不得直接使用未经定义的颜色值。

---

## 4. 色彩系统

### 4.1 色彩设计原则

采用低饱和、中等对比度的阅读色彩体系。

避免将 VS Code 编辑器主题中的高对比色直接应用到阅读正文。

阅读器拥有独立的语义颜色体系，但可以继承 VS Code 的主题偏好。

### 4.2 Light Theme

基准取自 `docs/stitch_/serene_editorial_modern/DESIGN.md` 的机读 token（frontmatter 为准，其正文散文提到的暖白纸色 `#FBFBF9` 与之矛盾，不采用）。

| Token | 色值 | 用途 |
|---|---|---|
| canvas | #F8F9FF | 阅读画布 |
| surface | #EFF4FF | 卡片及面板 |
| surface-subtle | #E5EEFF | 次级表面 |
| surface-raised | #DCE9FF | 抬升表面（悬停、选中底色） |
| surface-sunken | #FFFFFF | 下沉表面（代码块、表格、数学块） |
| text-primary | #0B1C30 | 正文 |
| text-secondary | #4A4455 | 次级文字 |
| text-muted | #6B6478 | 弱化文字 |
| border | rgb(204 195 215 / 0.7) | 分隔边界 |
| border-strong | #CCC3D7 | 控件与容器边界 |
| accent | #6D28D9 | 强调填充（按钮、进度、选中轨） |
| accent-text | #5300B7 | 正文可读紫（链接、强调文字） |
| accent-on | #FFFFFF | 填充之上的文字 |
| accent-soft | rgb(109 40 217 / 0.08) | 强调背景 |
| link | #5300B7 | 链接 |
| info | #00645B | 信息提示（tertiary） |
| success | #0F6A43 | 成功 |
| warning | #8A5A00 | 警告 |
| danger | #BA1A1A | 错误 |
| glass | rgb(255 255 255 / 0.86) | 浮动件背景（配 `backdrop-filter`） |

`text-muted` 相对原型基准值 `#7B7486` 做了加深：`#7B7486` 在 `#F8F9FF` 上的对比度约 4.3:1，低于 §14.1 要求的 4.5:1，而该 token 用于 12–13px 的标签与元信息，属于小字号，必须过 AA。调整由 `apps/webview/src/styles/__tests__/contrast.spec.ts` 固化，回归即红灯。

### 4.3 Dark Theme

基准取自 `docs/stitch_/readora_webview_system/DESIGN.md` 与 `docs/stitch_/readora_1/code.html`。

| Token | 色值 | 用途 |
|---|---|---|
| canvas | #10141A | 阅读画布 |
| surface | #181C22 | 卡片及面板 |
| surface-subtle | #1C2026 | 次级表面 |
| surface-raised | #262A31 | 抬升表面（悬停、选中底色） |
| surface-sunken | #0A0E14 | 下沉表面（代码块、表格、数学块） |
| text-primary | #DFE2EB | 正文 |
| text-secondary | #CCC3D8 | 次级文字 |
| text-muted | #958DA1 | 弱化文字 |
| border | rgb(74 68 85 / 0.6) | 分隔边界 |
| border-strong | #4A4455 | 控件与容器边界 |
| accent | #7C3AED | 强调填充 |
| accent-text | #D2BBFF | 正文可读紫（链接、强调文字） |
| accent-on | #EDE0FF | 填充之上的文字 |
| accent-soft | rgb(124 58 237 / 0.2) | 强调背景 |
| link | #58A6FF | 链接 |
| info | #A2C9FF | 信息提示（tertiary） |
| success | #34D399 | 成功 |
| warning | #FBBF24 | 警告 |
| danger | #FFB4AB | 错误 |
| glass | rgb(49 53 60 / 0.9) | 浮动件背景 |

暗色块必须覆盖 §4.2 列出的**全部**语义 token，一个都不能漏：漏掉的那个会沿用亮色值，表现为"暗色里渗出一块亮色"。这条约束由 `design-tokens.spec.ts` 的必需清单逐名断言，扩充语义 token 时必须同步扩充清单。

原型 token 与本表命名不一致处见**附录 A**：本仓库一律使用 §13.1 的 `--readora-{category}-{name}` 命名，不照搬 Material 3 的 `surface-container-high` 一类名称。

### 4.4 色彩语义

| 语义 | 应用 |
|---|---|
| Primary | 主要操作和交互状态 |
| Secondary | 次要操作 |
| Success | 成功提示 |
| Warning | 警告提示 |
| Danger | 错误提示 |
| Info | 信息提示 |
| Neutral | 普通内容 |

强调色有两个值，不可混用：`accent` 是**填充色**，只出现在背景与进度条上，上面的文字必须是 `accent-on`；`accent-text` 是**文字色**，用于正文链接与强调文字，直接落在 `canvas`/`surface` 上。把 `accent`（暗色 `#7C3AED`）直接当文字色用，在 `#10141A` 上只有约 3.1:1，小字号不过 AA。

### 4.5 强调色规则

强调色不应大量出现在正文中。

主要应用于：

- 当前章节。
- 链接。
- 选中状态。
- 焦点状态。
- 关键交互。

### 4.6 区块渲染诚实性规则

本里程碑（V1.2.0）的验收口径：**任何区块只在有真实数据源时渲染；无数据源则整块不出现。**

原型 `docs/stitch_/readora_1/code.html` 是一张静态高保真稿，其中若干区块在真实运行时没有数据来源。它们不进入实现，也不允许用占位文案或写死的假数据"补齐视觉"——那会让读者把一个从未接入的能力当成已经存在。据此剔除：

| 原型区块 | 剔除理由 |
|---|---|
| 右侧 Document Inspector 多标签面板 | 反向链接 / 图谱 / 审计均无数据源；`App.tsx` 原有的 `Properties` 占位栏一并删除，其信息改由正文内的 frontmatter 卡片承载 |
| Graph View 标签 | 无图谱能力 |
| 反向链接、Outgoing links | 无链接图索引 |
| 安全 & CSP 审计面板 | 无审计器 |
| PDF / SVG 导出按钮 | 无导出实现 |
| 状态条 `Ln 142, Col 18`、`UTF-8` | webview 没有光标位置与文件编码信息 |
| 面包屑的"可点击目录段" | 无 reveal-in-explorer 能力，改为纯文本，不给假 affordance |

同一条规则也约束开关：Reader Settings 弹层不提供"代码行号 / 关闭 KaTeX / 平滑滚动"三项，因为当前没有对应实现，给了就是假开关。

状态条只保留能自证的字段：`N 节`、`字数`、`文档版本 v{n}`、`缩放 z%`、`主题 light/dark`、`Bridge: Connected`（依据是收到过 `document.load`）。

---

## 5. 字体系统

### 5.1 字体设计目标

阅读字体需要满足：

- 长时间阅读舒适。
- 中文与英文混排自然。
- 数字和标点清晰。
- 代码与正文容易区分。

### 5.2 字体分类

三套字族，各自一个 token，跨主题统一（主题只改颜色不改字族）：

| Token | 字族栈 | 类别 |
|---|---|---|
| `--readora-font-family-display` | Newsreader, "Songti SC", "Noto Serif CJK SC", serif | 标题、文档大标题 |
| `--readora-font-family-body` | Geist, Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif | 正文、界面控件 |
| `--readora-font-family-mono` | "JetBrains Mono", --vscode-editor-font-family, ui-monospace, "SF Mono", Consolas, monospace | 代码、行内码、状态条 |

拉丁字形由 `@fontsource` 的** latin 子集**随扩展分发（`apps/webview/src/styles/fonts.css`），CJK 一律走系统回退栈。

**不打包 CJK 字库**，这是一条刻意的决策而不是待办：一套中文黑体子集常在数 MB 到数十 MB，会直接把 VSIX 体积推过市场建议上限，而 macOS 的 Songti SC / PingFang SC、Windows 的 Microsoft YaHei、Linux 的 Noto Serif CJK SC 已经提供了与设计意图接近的字形。后果是中文标题在部分环境下会落到系统字族，这被接受。写在这里是为了防止后来者"顺手补个中文字体"。

字族回退是设计的一部分，`font-display: swap`（由 fontsource 的 CSS 入口提供）意味着首帧可能先看到系统字形再替换；这是可用性优先于防抖动的取舍。

用户可在 Reader Settings 里把正文字族在 Newsreader / Geist / Inter 之间切换（`readora.typography`），该偏好落到 `document.body.dataset.readoraTypography`，由 `[data-readora-typography="…"]` 覆盖 display 与 body 两个字族 token。

### 5.3 字号体系

| Token | 字号 | 用途 |
|---|---:|---|
| font-xs | 12px | 辅助信息 |
| font-sm | 13px | 标签、元信息 |
| font-md | 14px | 辅助内容 |
| font-base | 16px | 正文 |
| font-lg | 18px | 大正文 |
| font-xl | 20px | 小标题 |
| font-2xl | 24px | H2 |
| font-3xl | 30px | H3 / H1（默认字号下） |
| font-4xl | 36px | 文档标题区主标题 |

字距 token：

| Token | 数值 | 用途 |
|---|---:|---|
| tracking-tight | -0.02em | 大字号标题（display 字族在 24px 以上需要收紧） |
| tracking-label | 0.04em | 全大写标签、状态条、表头 |

`font-xs` 至 `font-3xl` 的名称不可更改：`design-tokens.spec.ts` 按名断言其存在，它们是两套主题共同的排版基线。

### 5.4 标题排版

标题用 display 字族，字号相对正文（`--readora-font-size`）按比例给出：

| 元素 | 字号 | 字重 | 行高 | 字距 | 字族 |
|---|---:|---:|---:|---|---|
| 文档标题（标题区 H1） | 2.25em（= font-4xl @16px） | 500 | 1.15 | tracking-tight | display |
| H1 | 1.875em | 600 | 1.25 | tracking-tight | display |
| H2 | 1.5em | 600 | 1.3 | tracking-tight | display |
| H3 | 1.25em | 600 | 1.4 | — | display |
| H4 | 1.125em | 600 | 1.5 | — | body |
| H5 | 1em | 600 | 1.5 | — | body |
| H6 | 0.875em | 600 | 1.5 | tracking-label | body |

标题字重取 500–600 而非 700：Newsreader 是一支点阵较小的衬线阅读体，700 在大字号下会显得发闷。用 `em` 而不是绝对像素，是为了让 §11.4 的缩放能整体驱动标题——缩放改的是 `--readora-font-size` 一个变量。

### 5.5 正文排版

默认参数：

| 属性 | 默认值 |
|---|---|
| 字号 | 16px |
| 字重 | 400 |
| 行高 | 1.75 |
| 段落间距 | 1em |
| 字母间距 | Normal |
| 内容最大宽度 | 820px |

所有排版参数应支持用户自定义。

### 5.6 阅读时长口径

顶栏的 `N min read` pill 与状态条的字数共用一个计数函数 `apps/webview/src/app/text-metrics.ts`，规则是 CJK 感知的：

1. 每个 CJK 表意字符（含日文假名、CJK 扩展 A 区）计 **1 个单元**——中文一个字就是一个词。
2. 连续的非 CJK 字母数字序列按**词**计，一个序列 1 个单元。
3. 标点、空白、Markdown 语法字符不计。

时长换算：`minutes = max(1, ceil(units / 300))`。300 单元/分钟是中英混排文档的保守舒适读数，与主流技术博客的估算器一致取值。空文档返回 0 字、不显示 pill。

之所以要专门的计数函数：原先的 `text.split(/\s+/).length` 对中文按空白切分，一整段汉字算 1 个词，一篇 3000 字的中文笔记会被报成"1 min read"，属于可感知的错误而不是精度差异。

---

## 6. 间距系统

### 6.1 Spacing Scale

采用 4px 基础间距单位。

| Token | 数值 |
|---|---:|
| space-1 | 4px |
| space-2 | 8px |
| space-3 | 12px |
| space-4 | 16px |
| space-5 | 20px |
| space-6 | 24px |
| space-8 | 32px |
| space-10 | 40px |
| space-12 | 48px |
| space-16 | 64px |

### 6.2 应用规则

| 场景 | 推荐间距 |
|---|---|
| 正文段落 | 16px |
| 标题与正文 | 12px |
| H2 章节前 | 40px |
| H3 章节前 | 28px |
| 代码块外边距 | 20px |
| 表格外边距 | 20px |
| 引用块内边距 | 16px |
| 卡片内部 | 16px |
| 工具栏按钮间距 | 4px |

---

## 7. 圆角与阴影

### 7.1 Radius Scale

| Token | 数值 | 应用 |
|---|---:|---|
| radius-none | 0 | 特殊边界 |
| radius-sm | 4px | 小型控件 |
| radius-md | 6px | 输入框、按钮 |
| radius-lg | 8px | 代码块、图片 |
| radius-xl | 12px | 浮层、弹窗、图表容器 |
| radius-full | 999px | 圆形按钮、pill |

### 7.2 Shadow Scale

阅读器应尽量减少阴影使用。

| Token | 应用 |
|---|---|
| shadow-none | 正文和普通组件 |
| shadow-sm | 浮动工具栏 |
| shadow-md | 弹出菜单 |
| shadow-lg | 模态预览 |
| shadow-pill | 浮动快速条、顶栏 pill（暗色 `0 8px 24px rgb(0 0 0 / .35)`，亮色 `0 4px 12px rgb(109 40 217 / .08)`） |

默认使用边框而不是阴影区分普通内容区域。亮色的阴影一律带品牌紫相而非纯黑，纯黑投影在蓝白底上发脏。

**hairline**：`--readora-hairline: 1px` 是所有分隔线的唯一来源，高对比模式下不提粗——提粗会让 3px 的 callout 左轨变成 7px 的色块。

**backdrop-filter 预算**：整个界面只在三处小面积使用毛玻璃——浮动快速条、Reader Settings 弹层、lightbox 工具条。三处都必须写 `@supports (backdrop-filter: blur(1px))` 与 `prefers-reduced-transparency: reduce` 双重回退到 `--readora-color-glass` 的实色形态。大面积毛玻璃在长文档滚动时会掉帧。

---

## 8. Markdown 元素视觉规范

### 8.1 标题

要求：

- 标题具有明显层级。
- H1 不需要额外装饰。
- H2 可以使用轻量分隔。
- H3-H6 逐步降低视觉权重。
- 标题与上下文间距合理。

### 8.2 正文

要求：

- 使用较高可读性的颜色。
- 不使用纯黑作为浅色主题正文默认值。
- 不使用纯白作为深色主题正文默认值。
- 链接与普通文字有清晰区分。
- 行长保持合理。

### 8.3 引用块

采用低对比背景与左侧强调边界。

不同引用层级不得出现过多装饰。

普通 `blockquote` 的左轨宽 3px，颜色 `--readora-color-border-strong`；嵌套引用不再增加装饰，仅缩进。

### 8.3.1 Obsidian callout

V1.2.0 起支持 `> [!TYPE]` 语法（NOTE / TIP / WARNING / DANGER / INFO 及 Obsidian 别名）。视觉规则：

| 要素 | 规则 |
|---|---|
| 容器 | `--readora-color-surface` 底 + 左轨 4px，轨色取该类型的语义色 |
| 标题 | `--readora-color-text-primary`，600 字重，前置图标 |
| 图标 | CSS `mask-image` 引 `src/assets/icons/callout-*.svg`，`background-color: currentColor` 上色 |
| 折叠标记 | `-` 默认折叠、`+` 默认展开，标题行整体可点 |

**图标不得使用内联 `<svg>`**：ARC-002 §11.4 规定 SVG 不进正文白名单，这是安全不变量，不得为一个图标破例。callout 的 DOM 只用 `div / span / p / strong` 加 `class` 属性，因此 sanitizer 白名单零改动。

### 8.4 列表

- 列表符号清晰。
- 嵌套层级间距统一。
- 有序列表数字对齐。
- 任务列表 Checkbox 与文字垂直居中。

### 8.5 表格

要求：

- 表头与正文具有层次区分。
- 单元格内边距统一。
- 边框颜色柔和。
- 支持长内容换行。
- 超宽表格支持横向滚动。
- 表格不应强制撑开阅读画布。

### 8.6 代码块

代码块是技术文档的重要视觉元素。

设计要求：

- 使用独立背景表面。
- 保留代码缩进。
- 语法高亮颜色适中。
- 代码字体使用等宽字体。
- 顶部显示语言标识。
- 复制按钮采用低干扰样式。
- 超长代码支持横向滚动。
- 可选行号。

### 8.7 图片

- 保持原始宽高比。
- 默认不超过正文宽度。
- 圆角统一。
- 不添加不必要阴影。
- 点击可进入 Lightbox。

---

## 9. Mermaid 图形视觉规范

### 9.1 设计目标

Mermaid 图表必须与阅读器整体设计体系保持一致。

不允许出现：

- 图表采用独立的高饱和度主题。
- 深色阅读器搭配浅色图表。
- 节点颜色与文字对比不足。
- 不同图表使用完全不同的视觉语言。

### 9.2 图形语义 Token

| Token | 用途 |
|---|---|
| diagram.canvas | 图表背景 |
| diagram.node.surface | 节点背景 |
| diagram.node.text | 节点文字 |
| diagram.node.border | 节点边框 |
| diagram.edge | 连接线 |
| diagram.edge.label | 连线标签 |
| diagram.accent | 重点节点 |
| diagram.success | 成功节点 |
| diagram.warning | 警告节点 |
| diagram.danger | 错误节点 |

### 9.3 图表类型视觉规则

| 类型 | 视觉重点 |
|---|---|
| Flowchart | 节点层次与连接关系 |
| Sequence | 生命线与消息区分 |
| Class | 属性与方法层级 |
| ER | 实体和关系清晰 |
| State | 状态与转换明确 |
| Gantt | 时间和任务层次 |
| Mindmap | 中心节点与分支层级 |

### 9.4 Pele 集成要求

- 使用 Pele 输出 SVG。
- 使用统一的 CSS Variables。
- 支持 Light / Dark。
- 支持自适应宽度。
- 保持图表文字清晰。
- 主题变化不应要求用户修改 Mermaid 源码。
- 图表缩放时文字与线条保持合理表现。

---

## 10. 组件视觉规范

### 10.1 按钮

按钮分为：

- Primary。
- Secondary。
- Ghost。
- Icon Button。

阅读器工具栏默认使用 Ghost 和 Icon Button。

Primary 仅用于明确的主要操作。

### 10.2 标签

标签用于：

- 文件类型。
- 文档属性。
- 标签分类。
- 图表类型。
- 状态信息。

避免大量彩色标签。

### 10.3 Tooltip

要求：

- 简洁。
- 延迟显示。
- 不遮挡核心内容。
- 支持键盘焦点触发。

### 10.4 面板

面板通过背景和轻量边框区分。

不采用大量卡片嵌套。

### 10.5 外壳布局组件（V1.2.0）

外壳纵向四段，尺寸由组件 token 固定：

| 组件 | 类名 | 高度/宽度 | 内容 |
|---|---|---|---|
| TopBar | `.readora-topbar` | `--readora-topbar-height`（44px） | 大纲开合、面包屑、阅读时长 pill、模式标签、Reader Settings、缩放组、搜索、专注模式、Export 下拉（M11） |
| 搜索行 | `.readora-searchbar` | 随内容 | 搜索面板整行展开（原型的 `doc-search-toolbar`） |
| 主体 | `.readora-body` | flex row | 大纲（`--readora-outline-width`，256px，可关）+ 唯一滚动容器 `main.readora-canvas-scroll` |
| StatusBar | `.readora-statusbar` | `--readora-statusbar-height`（24px） | 见 §4.6 的诚实字段清单 |

- **面包屑**：从 `documentUri` 去 scheme 后取末 3 段，目录段 `text-muted`、文件名 `text-primary`，**纯文本不可点**。
- **pill**：`radius-full` + `shadow-pill` + `font-xs` + `tracking-label`，用于阅读时长与模式标签。
- **缩放组**：`−` `100%` `+` 三枚连排，点百分号复位；字号 50%–200%，步长 10%。
- **Reader Settings 触发器**：它是弹层触发器不是路由，`aria-haspopup="dialog"` + `aria-expanded`。
- **Export 下拉（M11）**：动作区里排在缩放组之后、Reader Settings 之前（导出是动作，
  Settings 恒为末位）。触发器复用同一枚 `.readora-toolbar-button`，额外带
  `.readora-toolbar-export` 与 `data-readora-export-menu="true"`，`aria-haspopup="menu"` +
  `aria-expanded` + `aria-label="Export document"`；与它同包在一个
  `.readora-toolbar-export-group`（`position: relative`，菜单面板的唯一定位锚）里。
  菜单面板是 `role="menu"` + 三枚 `role="menuitem"`（Export as HTML / PDF / PNG），
  项上带 `data-readora-export-format`；外观与定位一律走 Token 变量（色、间距、圆角），
  不新增颜色常量。键盘与 Esc 行为与 Reader Settings 弹层同一口径（焦点环、
  click-outside、焦点归还触发器）。**专注模式下不可达**：专注模式的早退分支只渲染
  一枚 Exit，整个动作区不渲染，本控件随之消失（不另做一套专注模式的导出入口）。
- **浮动快速条**：`position: sticky; bottom`，显示当前活动标题 + 进度百分比 + 回到顶部；专注模式下额外出现"展开大纲"按钮。
- **不实现的外壳**：VS Code 标题栏、活动栏、编辑器标签栏、窗口控制按钮属于装饰外壳，不在 webview 内（原型自身注释 `READORA WEBVIEW ROOT SHELL (STRICTLY EMBEDDED INSIDE THIS EDITOR TAB)` 已划定边界）。

### 10.6 图标

图标一律是内联 SVG React 组件（`apps/webview/src/app/Icon.tsx`），统一 24 viewBox、`stroke="currentColor"`、`stroke-width: 1.5`、`aria-hidden="true"`。

不引入图标字体：Material Symbols 全量 woff2 是 MB 级且需要 CI 增加 fonttools 子集化这一原生工具依赖，codicons 的字形与原型不符。内联 SVG 组件的代价只是几百行 JSX，且随 tree-shaking 只打包用到的部分。

### 10.7 大纲面板

在既有的树/折叠/active 之上扩展三块，全部有真实数据源（1.2.0 起进度块与源行号
标签下线，阅读进度只由 §10.5 的浮动快速条一处报告）：

| 区块 | 数据源 |
|---|---|
| 头部（展开全部 / 过滤）+ heading 过滤输入框 | 本地状态；过滤按 `title` 子串并自动展开命中项，`Escape` 清空 |
| 行内标签 | 只给 H1 显示分节字数（`840w`，`section-metrics.ts`）。`position` 缺失则不显示该标签；更深层级不配标签——源行号是编辑器坐标而不是阅读信息，读者据此无法定位自己在正文里的位置 |
| 底部 | `N Sections` + `Depth: H1–H{max}` |

分节字数按 outline 顺序取相邻标题之间的源行区间计数，`useMemo` 依赖 `[text, outline]`——每次渲染一次，不是每次滚动一次。行号不上 UI，但 `OutlineItem.position.startLine` 仍是切区间的边界，继续在数据结构里。区间按 **0 基**行号算（与 `docs/ARC-002` §4.3 的 `SourcePosition` 同基），左闭右开：第 i 节是 `[startLine_i, startLine_{i+1})`，最后一节到文件末尾——把行号当 1 基算会把首行的 H1 整条判成没有区间而丢标签。

---

## 11. Light / Dark 主题规范

### 11.1 Light Theme

视觉特点：

- 柔和背景。
- 深色正文。
- 轻量边框。
- 克制强调色。
- 清晰的层次关系。

### 11.2 Dark Theme

视觉特点：

- 深灰而非纯黑背景。
- 灰白正文。
- 柔和边界。
- 适度提高辅助文字亮度。
- 避免高饱和颜色刺激。

### 11.3 主题切换

必须同步：

- 正文。
- 标题。
- 链接。
- 代码块。
- 表格。
- 引用块。
- 图片容器。
- Mermaid 图表。
- 交互控件。

切换由 `document.body.dataset.readoraTheme` 驱动单个属性选择器，不做逐组件的类名增删，因此不存在"某块没跟上"的中间态。主题变量都是自定义属性，替换不触发布局重排，唯一要保证的是**不闪白**：初始值必须在首帧 paint 之前写入，这由 Host 在 HTML 内联脚本里预置 `data-readora-theme` 完成（ARC-006 §5）。

### 11.4 缩放

缩放实现为 `--readora-font-size: round(prefs.fontSize × zoom)`，**不用 `transform: scale`**——后者会破坏锚点滚动定位、lightbox 的 `position: fixed` 计算和文字次像素渲染。缩放是 webview 会话内状态，不写入 `readora.*` 配置。

`Ctrl/Cmd` + `=`/`-`/`0` 在页面内响应，沿用 `Ctrl+F` 的既有策略：仅在画面上有文档时接管按键，否则把键还给宿主。

---

## 12. Motion 设计

### 12.1 动效原则

动效应辅助理解，不应干扰阅读。

### 12.2 时间规范

| Token | 时间 | 用途 |
|---|---:|---|
| motion-fast | 100ms | Hover |
| motion-normal | 160ms | 按钮状态 |
| motion-slow | 220ms | 面板切换 |
| motion-dialog | 260ms | 弹窗 |

### 12.3 动效约束

- 避免大幅位移动画。
- 避免长时间过渡。
- 支持减少动态效果。
- 不在正文阅读过程中自动播放装饰动画。

---

## 13. CSS Variables 规范

### 13.1 Token 命名

统一使用：

```css
--readora-{category}-{name}
```

示例：

```css
:root {
  --readora-color-canvas: var(--readora-palette-light-canvas);
  --readora-color-surface: var(--readora-palette-light-surface);
  --readora-color-text-primary: var(--readora-palette-light-text-primary);
  --readora-color-border: var(--readora-palette-light-border);
  --readora-color-accent: var(--readora-palette-light-accent);

  --readora-font-xs: 12px;
  --readora-font-base: 16px;
  --readora-font-4xl: 36px;
  --readora-tracking-tight: -0.02em;
  --readora-font-family-display: Newsreader, "Songti SC", serif;

  --readora-space-1: 4px;
  --readora-space-2: 8px;
  --readora-space-3: 12px;
  --readora-space-4: 16px;

  --readora-radius-sm: 4px;
  --readora-radius-md: 6px;
  --readora-radius-lg: 8px;

  --readora-topbar-height: 44px;
  --readora-statusbar-height: 24px;
  --readora-outline-width: 256px;
  --readora-hairline: 1px;
}
```

语义层的颜色**必须引用 Primitive 层的 `--readora-palette-` 前缀变量**，不得直接写十六进制：`design-tokens.spec.ts` 断言 `--readora-color-canvas` 的值包含 `--readora-palette-`。亮暗两套分别落在 `--readora-palette-light-*` 与 `--readora-palette-dark-*` 两组。

组件层（`--readora-panel-background`、`--readora-code-background` 等）只能引用语义层，即值里必须出现 `var(--readora-color-`；这条同样被测试断言。新增外壳尺寸类组件 token：`--readora-topbar-height`、`--readora-statusbar-height`、`--readora-outline-width`、`--readora-shadow-pill`、`--readora-hairline`。（原列于此的 `--readora-progress-fill-start/end` 随大纲进度块下线一并移除，见 §10.7 与附录 B。）

### 13.2 Dark Theme

```css
[data-readora-theme="dark"] {
  --readora-color-canvas: var(--readora-palette-dark-canvas);
  --readora-color-surface: var(--readora-palette-dark-surface);
  --readora-color-text-primary: var(--readora-palette-dark-text-primary);
  --readora-color-border: var(--readora-palette-dark-border);
  --readora-color-accent: var(--readora-palette-dark-accent);
}
```

选择器是 `[data-readora-theme="dark"]`，不是 `[data-theme="dark"]`——带产品前缀是为了不与宿主页面上可能存在的同名属性打架。该块必须覆盖 §4.2 全部语义 token（含 §4.3 新增的 `surface-raised`、`surface-sunken`、`border-strong`、`accent-text`、`accent-on`、`link`、`info`、`glass`）。

### 13.3 VS Code 主题适配

允许将 VS Code 主题变量映射到阅读器语义 Token。

例如：

```css
--readora-host-editor-background: var(--vscode-editor-background);
--readora-host-editor-foreground: var(--vscode-editor-foreground);
--readora-host-focus-border: var(--vscode-focusBorder);
```

但不直接将宿主变量全部暴露为阅读器设计 Token。

### 13.4 样式文件划分

V1.2.0 起 `styles/global.css`（1511 行）拆为六个文件，按 `main.tsx` 的固定顺序引入：

```
katex/dist/katex.min.css
  → styles/fonts.css        @font-face
  → styles/tokens.css       三层 token + 主题覆盖 + a11y 媒体查询
  → styles/base.css         body / reset / 滚动条
  → styles/markdown.css     .readora-content 文档内容
  → styles/components.css   按钮 / 输入 / chip / tooltip / focus ring
  → styles/shell.css        外壳布局与新组件
  → styles/lightbox-search.css  预览与搜索
```

KaTeX 样式必须在最前、阅读器覆盖在后，这是既有不变量（IMP-001 §10.2）：阅读器要改的是 display 公式的垂直节奏而非引擎本身，覆盖只有排在后面才生效。

拆分不夹带语义变更——内容是迁移，不是重写。`design-tokens.spec.ts` 相应改为读取 `styles/` 目录下全部 `.css` 拼接后断言，保持"从源码文本断言 token"的既有做法。

---

## 14. 视觉质量验收

| 编号 | 验收项目 | 验收要求 |
|---|---|---|
| VIS-001 | 正文 | 长时间阅读舒适 |
| VIS-002 | 标题 | 层级清晰 |
| VIS-003 | 代码块 | 视觉统一且易读 |
| VIS-004 | 表格 | 信息结构清晰 |
| VIS-005 | 图片 | 不失真、不溢出 |
| VIS-006 | Mermaid | 与主题一致 |
| VIS-007 | Light Theme | 对比度合格 |
| VIS-008 | Dark Theme | 对比度合格 |
| VIS-009 | 组件 | Token 使用一致 |
| VIS-010 | 响应式 | 不同尺寸下布局合理 |
| VIS-011 | 动效 | 低干扰 |
| VIS-012 | 无障碍 | 关键内容可访问 |

### 14.1 对比度要求

参考 WCAG 2.2：

- 普通正文对比度至少 4.5:1。
- 大字号文字对比度至少 3:1。
- 重要 UI 边界和控件状态应满足相应非文本对比度要求。

---

## 15. 视觉设计交付物

后续设计和开发必须形成以下成果：

| 编号 | 交付物 |
|---|---|
| VD-001 | Light Theme 色板 |
| VD-002 | Dark Theme 色板 |
| VD-003 | Design Token 定义 |
| VD-004 | Typography 规范 |
| VD-005 | Spacing 规范 |
| VD-006 | Markdown 元素样式 |
| VD-007 | Code Block 样式 |
| VD-008 | Diagram Theme |
| VD-009 | Component Styles |
| VD-010 | Responsive Guidelines |

---

## 16. 文档结论

Readora 采用 Minimal Editorial + Technical Elegance 作为视觉设计方向。

通过统一的 Design Tokens 管理颜色、字体、间距、边框和组件视觉。

Light / Dark 两套主题共享同一套语义结构。

Markdown、代码块、Mermaid 图表和辅助面板必须使用统一的设计语言。

**文档状态：Draft。**

---

## 附录 A：原型 token 映射表

原型（`docs/stitch_/`）沿用 Material 3 的命名，本仓库沿用 §13.1 的 `--readora-{category}-{name}`。两套名称**不通用**：照搬 M3 名会违反 §13.1，并使 `design-tokens.spec.ts` 的按名断言失去意义。实现时按下表逐个换算，色值取 §4.2 / §4.3。

| 语义 | Stitch / M3 名 | 本仓库 token | Dark | Light |
|---|---|---|---|---|
| 画布 | `background` / `surface` / `surface-dim` | `--readora-color-canvas` | `#10141a` | `#f8f9ff` |
| 面板 | `surface-container-low` | `--readora-color-surface` | `#181c22` | `#eff4ff` |
| 次级面 | `surface-container` | `--readora-color-surface-subtle` | `#1c2026` | `#e5eeff` |
| 抬升面 | `surface-container-high` | `--readora-color-surface-raised`（新） | `#262a31` | `#dce9ff` |
| 最高实面 | `surface-container-highest` | `--readora-color-surface-highest`（新） | `#31353c` | `#d3e4fe` |
| 下沉面 | `surface-container-lowest` | `--readora-color-surface-sunken`（新） | `#0a0e14` | `#ffffff` |
| 浮动面 | （原型 `surface-container-highest/90`） | `--readora-color-glass`（新，仅浮动件） | `rgb(49 53 60 / .9)` | `rgb(255 255 255 / .86)` |
| 主文字 | `on-surface` | `--readora-color-text-primary` | `#dfe2eb` | `#0b1c30` |
| 次文字 | `on-surface-variant` | `--readora-color-text-secondary` | `#ccc3d8` | `#4a4455` |
| 弱文字 | `outline` | `--readora-color-text-muted` | `#958da1` | `#6b6478`（原型 `#7b7486` 加深以过 AA） |
| 边界 | `outline-variant` | `--readora-color-border` | `rgb(74 68 85 / .6)` | `rgb(204 195 215 / .7)` |
| 强边界 | `outline` | `--readora-color-border-strong`（新） | `#4a4455` | `#ccc3d7` |
| 主色填充 | `primary-container` | `--readora-color-accent` | `#7c3aed` | `#6d28d9` |
| 主色文字 | `primary` | `--readora-color-accent-text`（新） | `#d2bbff` | `#5300b7` |
| 填充上文字 | `on-primary-container` | `--readora-color-accent-on`（新） | `#ede0ff` | `#ffffff` |
| 主色淡底 | （原型自算） | `--readora-color-accent-soft` | `rgb(124 58 237 / .2)` | `rgb(109 40 217 / .08)` |
| 链接 | `link` | `--readora-color-link`（新） | `#58a6ff` | `#5300b7` |
| 信息 | `tertiary` | `--readora-color-info`（新） | `#a2c9ff` | `#00645b` |
| 成功 | `tertiary-fixed-dim` | `--readora-color-success` | `#34d399` | `#0f6a43` |
| 警告 | — | `--readora-color-warning` | `#fbbf24` | `#8a5a00` |
| 错误 | `error` | `--readora-color-danger` | `#ffb4ab` | `#ba1a1a` |

字族映射：原型的 `Instrument_Serif` / `Geist` / `JetBrains Mono` 对应本仓库的 display / body / mono 三个字族 token（§5.2）；`serene_editorial_modern` 正文散文里提到的 Plus Jakarta Sans 不采用，它与该文档 frontmatter 的 Geist 冲突，且会多出一套字形要打包。

原型 Tailwind 类名（`h-11`、`text-xs`、`tracking-tight`、`rounded-xl` 等）作为尺寸与层级的意图来源，换算结果写进 §10.5 与 §13.1 的 token。

**Tailwind 裁决变更（1.1.0，选型变更见 IMP-001 §21）**：原「Tailwind 类名不作为实现依据」的裁决调整为——引入**构建期 Tailwind CSS v4** 作为样式 utility 层，与 `stitch_` 原型的 utility 表达方式对齐，但以下边界不变：

1. **Token 仍是视觉值唯一来源**：utility 的主题色必须经 `@theme` 映射引用本附录换算后的 `--readora-*` token（如 `--color-canvas: var(--readora-color-canvas)`），不得照搬原型 tailwind.config 中的 M3 色值或写死任意色值；上表映射关系继续有效。
2. **禁止原型的 CDN 运行时方案**：`cdn.tailwindcss.com` 依赖外部网络与运行时编译，违反 ARC-008 §11 CSP 基线与 VSIX 离线要求；必须经 `@tailwindcss/vite` 构建期编译为静态 CSS（IMP-001 §3.3 / §7.4）。
3. **暗色机制不采用原型的 `darkMode: "class"`**：主题切换仍由 `[data-readora-theme]` + CSS Variables 注入完成（ARC-006 §8.1），不使用 `dark:` 变体。
4. 尺寸类意图（间距、圆角、字号）继续按 §10.5 / §13.1 换算为 token 后供 utility 消费；utility 层架构与迁移策略见 ARC-005 §11.3。

## 附录 B：修订记录

| 版本 | 说明 |
|---|---|
| 1.0.0 | 初始视觉设计规范基线 |
| 1.1.0 | 附录 A Tailwind 裁决变更：引入构建期 Tailwind utility 层（用户决策，IMP-001 §21 登记），Token 映射、色值基准与 CSP 约束不变；元数据设计体系同步更新 |
| 1.2.0 | §10.7 大纲面板去进度块与源行号标签（用户要求，进度只留 §10.5 快速条一处）；§13.1 随之移除无消费方的 `--readora-progress-fill-start/end`；`docs/ARC-006` §4 示例同步；§10.7 补写分节的 0 基行号口径（去行号后字数成了唯一行内标签，旧实现的 1 基误读会让首行 H1 静默不显示） |
| 1.3.0 | §10.5 顶栏控件清单新增 Export 下拉（M11 导出链路）：位置、类名、`data-readora-export-menu` 探针、`aria-haspopup="menu"` 与三枚 `role="menuitem"`，并记明专注模式下不可达。未新增任何颜色 Token 与尺寸变量，44px 顶栏高度不变（10 档视觉基线因此只改像素不改取值） |
