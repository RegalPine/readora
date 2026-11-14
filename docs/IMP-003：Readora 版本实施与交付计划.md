# IMP-003：Readora 版本实施与交付计划

| 文档属性 | 内容 |
|---|---|
| 文档编号 | IMP-003 |
| 文档名称 | Readora 版本实施与交付计划 |
| 文档版本 | 1.0.0 |
| 文档状态 | Draft |
| 所属阶段 | Implementation Planning |
| 上游文档 | PRD-001～003、ARC-001～008、IMP-001～002 |
| 适用产品 | Readora VS Code Extension |

---

## 1. 文档目的

本文档定义 Readora 从工程初始化到 MVP 正式交付的实施计划。

主要目标：

1. 最终确定 MVP 交付范围。
2. 确定开发里程碑和实施顺序。
3. 明确各阶段交付物。
4. 定义版本验收标准。
5. 定义发布准入条件。
6. 建立 MVP 完成后的版本演进边界。

本文档是实施规划的最后一篇，不再新增独立规划文档。

## 2. 版本规划

### 2.1 版本体系

采用以下版本划分：

| 版本 | 名称 | 定位 |
|---|---|---|
| V0.1.0 | Foundation | 工程基础与扩展启动 |
| V0.2.0 | Readora Core | 核心 Markdown 阅读 |
| V0.3.0 | Diagram Reader | Mermaid 与资源管理 |
| V0.4.0 | Reading Experience | 导航、布局、阅读交互 |
| V0.5.0 | Visual Polish | 主题和视觉完善 |
| V0.9.0 | Release Candidate | 功能冻结与发布候选 |
| V1.0.0 | Stable Release | 正式稳定版本 |

### 2.2 版本交付目标

<box>

| 版本 | 核心交付 | 验收结果 |
|---|---|---|
| V0.1.0 | 工程、Host、Webview | 扩展可启动 |
| V0.2.0 | Markdown 核心渲染 | 可以阅读 Markdown |
| V0.3.0 | Mermaid、图片、资源 | 可以阅读图文混合文档 |
| V0.4.0 | Outline、阅读交互 | 具备完整基础阅读流程 |
| V0.5.0 | 主题、视觉优化 | 达到设计规范 |
| V0.9.0 | 回归、安全、跨平台 | 可作为候选版本 |
| V1.0.0 | 正式打包发布 | 稳定可用 |

</box>

## 3. MVP 最终范围

### 3.1 MVP 必须交付

| 功能域 | 功能 | 验收要求 |
|---|---|---|
| F01 | Markdown 渲染 | 标题、段落、列表、引用、表格、链接、代码块 |
| F02 | 文档导航 | Outline、标题定位、活动标题同步 |
| F04 | Mermaid | 支持范围内的图表渲染、错误处理 |
| F05 | 阅读交互 | 代码复制、图片放大、图表缩放、专注阅读 |
| F06 | 资源管理 | 本地图片和附件解析 |
| F07 | 阅读布局 | 三栏布局、阅读画布、辅助面板 |
| F08 | 主题系统 | Light、Dark、VS Code 主题适配 |
| F10 | VS Code 集成 | 文档打开、会话管理、文档变更同步 |
| F11 | 安全与性能 | CSP、Sanitizer、路径边界、性能基线 |

### 3.2 MVP 可选增强

以下功能不作为 MVP 发布阻塞项：

- Wiki Link。
- Backlinks。
- Frontmatter 高级展示。
- 系统主题自动跟随。
- 更丰富的 Markdown 扩展语法。
- 更复杂的图表交互能力。

其中基础 Frontmatter 解析和 Wiki Link 跳转属于 V1.0 的增强范围，不应因为暂未完成而阻止核心阅读器发布。

### 3.3 MVP 明确排除

- 知识图谱。
- 云端同步。
- 用户账户。
- 多人协作。
- AI 内容处理。
- 独立 Markdown 编辑器。
- 插件市场。
- 自定义脚本执行。
- 完整 Obsidian 功能复刻。

产品始终定位为 VS Code 内的 Markdown 阅读器。

---

## 4. 实施里程碑

### 4.1 里程碑总览

| 里程碑 | 版本 | 主要工作 | 交付物 |
|---|---|---|---|
| M1 | V0.1.0 | 工程基础 | 可运行扩展 |
| M2 | V0.2.0 | Markdown 渲染 | 基础阅读器 |
| M3 | V0.3.0 | Mermaid 与资源 | 图文阅读器 |
| M4 | V0.4.0 | 导航与交互 | 完整阅读流程 |
| M5 | V0.5.0 | 主题与视觉 | 视觉验收版本 |
| M6 | V0.9.0 | 测试与冻结 | Release Candidate |
| M7 | V1.0.0 | 正式发布 | Stable Release |

### 4.2 M1：工程基础

<badge color="info">V0.1.0</badge> **目标：扩展可以在 VS Code 中正常启动。**

主要任务：

- 完成 pnpm Workspace。
- 完成 TypeScript 工程。
- 完成 Extension Host。
- 完成 React Webview。
- 完成 Host / Webview 消息协议。
- 完成 WebviewPanel 创建。
- 完成基础 CSP。
- 完成 VSIX 构建。

交付物：

```text
M1 Deliverables
├── Extension Host
├── React Webview
├── Shared Contracts
├── Build Configuration
├── VSIX Package
└── Basic Integration Tests
```

验收标准：

- Windows、macOS、Linux 可安装。
- 扩展可以正常激活。
- Webview 可以正常加载。
- Host 与 Webview 可以双向通信。
- 扩展关闭时能够正确释放资源。

### 4.3 M2：Markdown 核心渲染

<badge color="info">V0.2.0</badge> **目标：完成基本 Markdown 阅读能力。**

主要任务：

- markdown-it 初始化。
- 标题、段落、列表渲染。
- 引用和表格渲染。
- 链接渲染。
- 代码块渲染。
- HTML Sanitizer。
- 基础阅读画布。

交付物：

```text
M2 Deliverables
├── Markdown Parser
├── Renderer Registry
├── Basic Renderers
├── Code Block Renderer
├── HTML Sanitizer
└── Reading Canvas
```

验收标准：

- 常见 Markdown 文档可以正确展示。
- 标题层级符合设计规范。
- 代码块可以复制。
- 恶意 HTML 不会执行。
- 普通文档阅读体验稳定。

### 4.4 M3：图形与资源管理

<badge color="info">V0.3.0</badge> **目标：支持图文混合 Markdown 文档。**

主要任务：

- 验证 Pele 与目标 Webview 环境兼容性。
- 锁定 Pele 依赖。
- 完成 PeleAdapter。
- 实现 Mermaid 图表挂载。
- 实现图表更新和销毁。
- 实现图表错误状态。
- 实现本地图片资源解析。
- 实现图片展示和 Lightbox。
- 实现 SVG 安全处理。

交付物：

```text
M3 Deliverables
├── Diagram Core
├── Pele Adapter
├── Diagram Renderer
├── Resource Resolver
├── Image Renderer
└── SVG Security Tests
```

验收标准：

- 支持清单内的 Mermaid 图表可以渲染。
- 错误图表不会导致整篇文档崩溃。
- 本地图片能够正确加载。
- 图片可以放大查看。
- 图表和图片资源能够正确释放。

### 4.5 M4：导航与阅读交互

<badge color="info">V0.4.0</badge> **目标：形成完整的基础阅读流程。**

主要任务：

- Outline Tree。
- 标题 Anchor。
- 标题定位。
- 活动标题同步。
- 阅读位置恢复。
- 左右面板显隐。
- 专注阅读模式。
- 阅读宽度控制。
- 基础快捷键。

交付物：

```text
M4 Deliverables
├── Outline Navigation
├── Heading Anchor
├── Reading Position Manager
├── Reader Panel Controls
├── Focus Mode
└── Keyboard Interaction
```

验收标准：

- Outline 与文档标题一致。
- 点击标题可以定位。
- 阅读位置变化时活动标题同步。
- 阅读位置可以合理恢复。
- 三栏布局和专注模式正常工作。

范围登记（M6 补充）：本节主要任务清单在编写时未包含 PRD-001 F05-001/002/003（文档内搜索，P0）与 IMP-002 STORY-07-03，§3.1 的 F05 验收要求也只列出代码复制、图片放大、图表缩放和专注阅读，造成 M4、M5 均未交付该 P0 功能。该缺口在 M6 定性为发布阻塞缺陷，顺延到 M7 补齐，登记见 §7.5（DEFER-01）。

### 4.6 M5：主题与视觉完善

<badge color="info">V0.5.0</badge> **目标：达到 PRD-003 规定的视觉质量。**

主要任务：

- 完成 Design Tokens。
- 完成 Light Theme。
- 完成 Dark Theme。
- 完成 VS Code 主题适配。
- 完成 Mermaid 主题同步。
- 完成字体与排版细节。
- 完成响应式布局。
- 完成无障碍检查。

交付物：

```text
M5 Deliverables
├── Primitive Tokens
├── Semantic Tokens
├── Component Tokens
├── Light Theme
├── Dark Theme
├── VS Code Theme Adapter
└── Visual Regression Baseline
```

验收标准：

- Light / Dark 主题完整。
- VS Code 主题变化能够同步。
- Mermaid 图表与阅读器主题一致。
- 字体、间距、层级符合视觉规范。
- 主要界面满足可访问性要求。

### 4.7 M6：发布候选版本

<badge color="warning">V0.9.0</badge> **目标：冻结功能，完成质量验证。**

主要任务：

- 完成完整回归测试。
- 完成安全测试。
- 完成性能测试。
- 完成跨平台测试。
- 完成依赖漏洞检查。
- 完成许可证审查。
- 完成 VSIX 安装验证。
- 处理发布阻塞缺陷。

交付物：

```text
M6 Deliverables
├── Test Report
├── Security Report
├── Performance Report
├── Dependency Audit
├── Platform Verification
└── Release Candidate VSIX
```

验收标准：

- P0 缺陷为零。
- 核心功能测试全部通过。
- 安全测试全部通过。
- 三个平台安装和运行正常。
- 性能指标达到约定目标。
- 发布说明和使用文档完成。

### 4.8 M7：正式发布

<badge color="success">V1.0.0</badge> **目标：发布稳定版本。**

主要任务：

- 固定正式版本号。
- 生成正式 VSIX。
- 补齐 DEFER-01 文档内搜索。
- 关闭或明确 EXCP-01 数学公式范围。
- 完成发布说明。
- 完成扩展市场信息。
- 完成最终安装验证。
- 创建 Git Tag。
- 发布正式版本。

交付物：

```text
M7 Deliverables
├── readora-1.0.0.vsix
├── Release Notes
├── README
├── LICENSE
├── Dependency Notices
└── Git Release Tag
```

范围登记（M7 实施）：DEFER-01 文档内搜索已按 PRD-001 F05-001/002/003 与 ARC-007 §9 交付，EXCP-01 数学公式渲染按决策走实现分支，KaTeX 0.19.1 接入并完成 §5 门槛验证，DEFER-03 的 `katex` 关键字因此兑现。DEFER-02（`repository` 的 `<owner>` 占位符）按决策保留至发布市场信息时一并修正，不阻塞本地安装与 Git Tag；NOTE-01 的 dev-only 漏洞项每次发布复扫，未打包进 VSIX。

发布动作范围：本次交付到生成正式 VSIX 与本地 annotated tag 为止，不执行 Marketplace 发布与远端推送。

---

## 5. 关键技术验证门槛

以下技术验证必须在对应功能大规模开发前完成，避免技术风险后置。

| 验证项 | 最迟完成阶段 | 通过条件 |
|---|---|---|
| VS Code Webview 资源加载 | M1 | 本地 JS、CSS、字体可加载 |
| Host / Webview 通信 | M1 | 消息往返正常 |
| markdown-it 解析 | M2 | 核心 Markdown 样例通过 |
| DOMPurify 安全处理 | M2 | XSS 用例通过 |
| Pele 兼容性 | M3 开发前 | 核心图表可渲染 |
| KaTeX 兼容性 | M3 或 M4 | 公式显示正常 |
| 本地资源 URI | M3 | 图片路径正确且安全 |
| 主题联动 | M5 | Markdown 与 Mermaid 同步 |

KaTeX 兼容性门槛闭合记录（M7）：本门槛原定 M3 或 M4 完成，V0.9.0 冻结时仓库尚未引入 KaTeX，因此登记为门槛例外 EXCP-01（见 §7.5），当时不写入发布承诺。V1.0.0 按决策实现：KaTeX 0.19.1，行内与块级分别渲染、非法表达式局部降级、样式与 20 个 woff2 字体随 VSIX 本地打包且不依赖 CDN，实现落点见 IMP-001 §10.3，用例见 `packages/markdown-core/src/__tests__/math.spec.ts`。表格行状态维持 M3 或 M4 的原定要求，实际闭合阶段为 M7。

原例外说明（V0.9.0 冻结时）：本仓库未引入 KaTeX，数学公式渲染未实现，该门槛未在 M3 或 M4 闭合。定性与处理见 §7.5（EXCP-01）：PRD-001 F09 需求表未将数学公式列为 P0 条目，§3.1 MVP 必交付与 §3.2 非阻塞增强均不包含数学公式，因此不阻塞 V0.9.0，但不得将公式渲染写入发布承诺。

特别说明：

**Pele 必须先完成最小可运行验证，再进入完整图表功能开发。**

最小验证程序至少包含：

1. 在 VS Code Webview 中加载 Pele。
2. 渲染一个 Flowchart。
3. 渲染一个 Sequence Diagram。
4. 切换 Light / Dark 主题。
5. 更新图表源码。
6. 销毁图表实例。
7. 检查 SVG 安全处理。
8. 检查不同操作系统下的运行结果。

验证失败时，先评估依赖版本或适配方式，不得直接将未验证的兼容性写入产品承诺。

---

## 6. 版本验收矩阵

| 验收领域 | V0.1 | V0.2 | V0.3 | V0.4 | V0.5 | V0.9 | V1.0 |
|---|---|---|---|---|---|---|---|
| 扩展启动 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Markdown 渲染 | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 代码块 | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Mermaid | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| 本地图片 | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| Outline | — | — | — | ✓ | ✓ | ✓ | ✓ |
| 阅读交互 | — | — | 部分 | ✓ | ✓ | ✓ | ✓ |
| Light / Dark | 基础 | 基础 | 基础 | 基础 | ✓ | ✓ | ✓ |
| VS Code 主题适配 | — | — | — | — | ✓ | ✓ | ✓ |
| 安全测试 | 基础 | 基础 | ✓ | ✓ | ✓ | 完整 | 完整 |
| 跨平台测试 | 基础 | 基础 | 基础 | 基础 | 基础 | 完整 | 完整 |

---

## 7. 发布准入标准

V1.0.0 正式发布必须同时满足以下条件。

### 7.1 功能准入

- [ ] 所有 MVP P0 Story 已完成。
- [ ] 所有 P0 验收条件通过。
- [ ] Markdown 核心语法正确。
- [ ] Mermaid 支持范围明确。
- [ ] 本地图片加载正常。
- [ ] Outline 导航正常。
- [ ] Light / Dark 主题正常。
- [ ] 文档变化同步正常。

### 7.2 安全准入

- [ ] CSP 已配置。
- [ ] 不使用 `unsafe-eval`。
- [ ] HTML Sanitizer 测试通过。
- [ ] SVG Sanitizer 测试通过。
- [ ] URL Scheme 检查通过。
- [ ] 路径访问边界测试通过。
- [ ] Host 消息校验通过。
- [ ] 不存在已知未处理的严重安全漏洞。

### 7.3 性能准入

- [ ] 普通 Markdown 首次渲染达到目标。
- [ ] 中型文档首次渲染达到目标。
- [ ] 图表延迟渲染有效。
- [ ] 长文档没有明显卡顿。
- [ ] Webview 生命周期没有明显资源泄漏。
- [ ] 性能报告完成。

### 7.4 发布准入

- [ ] VSIX 可以正常安装。
- [ ] Windows 验证通过。
- [ ] macOS 验证通过。
- [ ] Linux 验证通过。
- [ ] 扩展 Manifest 信息完整。
- [ ] README 完整。
- [ ] License 文件完整。
- [ ] 第三方依赖许可证信息完整。
- [ ] Release Notes 完成。
- [ ] Git Tag 创建完成。

### 7.5 已知顺延项与门槛例外

V0.9.0（M6）冻结时统一登记，V1.0.0 发布准入必须逐项复核关闭。

| 编号 | 项 | 原定阶段 | 定性 | 处理 |
|---|---|---|---|---|
| DEFER-01 | F05-001/002/003 文档内搜索（P0） | M4（IMP-002 STORY-07-03） | 发布阻塞缺陷：计划遗漏，未进入 V0.9.0 | 已关闭（M7）：搜索面板与文内匹配按 ARC-007 §9 交付，见 §4.8 范围登记 |
| EXCP-01 | KaTeX 兼容性验证门槛 | M3 或 M4（§5） | 门槛例外：非 MVP 范围，不属于 P0 缺陷 | 已关闭（M7）：选择实现分支，门槛闭合记录见 §5，落点见 IMP-001 §10.3 |
| DEFER-02 | `repository` 字段的 `<owner>` 占位符 | M7（§7.4 Manifest 完整） | 发布元数据缺陷，不影响 VSIX 安装与运行 | 仍开放：V1.0.0 不做 Marketplace 发布，随市场信息一并修正；`scripts/verify-vsix.mjs` 每次校验都输出提醒 |
| DEFER-03 | Manifest `keywords` 含 `katex`（品牌规范 §2.2 建议值） | M7（§7.4 市场信息） | 能力声明尚未兑现：公式未渲染，市场搜索会误导用户 | 已关闭（M7）：随 EXCP-01 的实现分支兑现，关键字与规范 §2.2 无需修订 |
| NOTE-01 | dev-only 依赖漏洞（@eslint/plugin-kit、glob、minimatch） | M6（§7.2 安全准入） | 仅开发工具链引入，不打包进 VSIX，不进入产品运行时代码 | 等待上游 eslint / vsce 主版本修复，每次发布复扫 |

M6 已补齐的 P0 缺口：F01-016 任务列表（自研 AST 处理器，展示态，不可交互）与 F01-009 代码块语法高亮（highlight.js，见 IMP-001 §3.3）。

---

## 8. 发布后的版本演进

V1.0.0 发布后，只有明确具有产品价值的能力才进入后续版本。

### V1.1.x：阅读体验增强

候选范围：

- 更完整的 Wiki Link。
- Backlinks。
- Frontmatter Properties。
- 阅读历史。
- 更完善的快捷键。

### V1.2.x：内容导航增强

候选范围：

- 当前工作区 Markdown 搜索。
- 文档间链接导航。
- 更完善的资源预览。
- 文档关联状态提示。

### V1.3.x：渲染能力增强

候选范围：

- 更多 Markdown 扩展语法。
- Mermaid 图表体验增强。
- 大型文档性能优化。
- 更完善的渲染诊断信息。

上述是候选演进方向，不构成已经承诺的需求。具体版本仍需经过需求评审。

---

## 9. 项目完成定义

Readora V1.0.0 的最终完成定义：

**产品层面**

- 是一个稳定的 VS Code Markdown 阅读扩展。
- 具有完整的基础 Markdown 阅读体验。
- 能够展示图表、数学公式和本地图片。
- 具有清晰、优雅的阅读界面。
- 与 VS Code 主题和工作区自然集成。

**技术层面**

- Host 与 Webview 运行时隔离。
- Markdown 渲染管线稳定。
- Pele 通过 Adapter 接入。
- HTML、SVG、资源访问均经过安全控制。
- 构建和测试流程可重复。

**交付层面**

- 提供正式 VSIX。
- 支持 Windows、macOS、Linux。
- 提供完整 README 和发布说明。
- 有可追溯的测试结果。
- 不存在阻塞发布的 P0 缺陷。

---

## 10. 规范体系最终收敛

本项目规范体系至此完成。

### 10.1 产品需求规范

| 编号 | 文档名称 | 状态 |
|---|---|---|
| PRD-001 | 产品需求规格 | 已完成 |
| PRD-002 | 用户体验与交互规范 | 已完成 |
| PRD-003 | 视觉设计规范 | 已完成 |

### 10.2 技术架构规范

| 编号 | 文档名称 | 状态 |
|---|---|---|
| ARC-001 | 总体架构设计 | 已完成 |
| ARC-002 | Markdown 渲染架构 | 已完成 |
| ARC-003 | 图形渲染引擎架构 | 已完成 |
| ARC-004 | VS Code 扩展集成架构 | 已完成 |
| ARC-005 | 前端应用架构 | 已完成 |
| ARC-006 | 主题系统架构 | 已完成 |
| ARC-007 | 文档导航架构 | 已完成 |
| ARC-008 | 资源与安全架构 | 已完成 |

### 10.3 实施规范

| 编号 | 文档名称 | 状态 |
|---|---|---|
| IMP-001 | 技术实现规范 | 已完成 |
| IMP-002 | 开发任务分解规范 | 已完成 |
| IMP-003 | 版本实施与交付计划 | 已完成 |

### 10.4 最终文档规模

<box border radius="lg" padding={3} gap={3}>
  <grid columns={3} gap={2}>
    <grid-item>
      <title size="2xl" color="success" tabularNums>3</title>
      <text color="secondary" size="xs">PRD 文档</text>
    </grid-item>
    <grid-item>
      <title size="2xl" color="success" tabularNums>8</title>
      <text color="secondary" size="xs">ARC 文档</text>
    </grid-item>
    <grid-item>
      <title size="2xl" color="success" tabularNums>3</title>
      <text color="secondary" size="xs">IMP 文档</text>
    </grid-item>
  </grid>
  <divider color="subtle" />
  <row align="center" justify="between">
    **规范文档总数**
    <title size="2xl" tabularNums>14</title>
  </row>
  <badge color="success">规范编写阶段完成</badge>
</box>

### 10.5 后续工作边界

从本篇完成开始：

- 不再新增 PRD。
- 不再新增 ARC。
- 不再新增 IMP。
- 不再重复讨论已经确定的技术选型。
- 不再扩大 MVP 功能范围。

后续工作直接进入工程初始化、代码实现、测试和迭代交付。

---

**文档结束**

**版本：1.0.0**
**状态：Draft**
