# AUD-001：Readora 完成进度评估报告

| 文档属性 | 内容 |
|---|---|
| 文档编号 | AUD-001 |
| 文档名称 | Readora 完成进度评估报告 |
| 文档版本 | 1.0.0 |
| 文档状态 | Final |
| 评估对象 | `docs/` 全部 15 篇规范 + 仓库实现 |
| 代码基线 | `main` @ `c9275b8`（2026-11-12 16:01:58 +0800，工作区干净） |
| 声明版本 | 1.0.0（5 个 package.json 一致） |
| 评估方式 | 文档条款逐条对照代码 + 本地门禁实测（只读，未修改任何实现） |
| 评估日期 | 2026-11-12 |

> 本篇是审计记录，不是新的 PRD / ARC / IMP，不改变任何需求、架构或范围定义（IMP-003 §10.5 的收敛约束维持有效）。所有结论以可复核证据为准；判定分为 **阻塞 / 高 / 中 / 低** 四级。

---

## 1. 结论摘要

| 维度 | 判定 | 一句话结论 |
|---|---|---|
| 规范内容完备性 | **通过** | 14 篇规范 + 1 篇品牌治理齐备，共 12,125 行，IMP-003 §10 声明的编写阶段确实收敛 |
| 规范进度治理 | **不通过** | 文档自身的进度载体全部失效：15 篇状态字段仍为 `Draft`，111 项验收清单 0 项回填，2 处后续文档表仍写"待编写" |
| 功能实施进度 | **基本通过（M1–M7 主线已交付）** | 渲染 / 图表 / 资源 / 导航 / 主题 / 搜索 / 数学七条主线均有实现与用例；核定发现 2 条 P0 需求未实现且未登记 |
| 质量门禁 | **不通过** | HEAD 上 `pnpm lint` 有 2 处 error，直接违反 IMP-002 §18 DoD 第 3 条，CI Lint job 必红 |
| V1.0.0 发布准入 | **不通过（有条件）** | IMP-003 §7.4 十条中至少 4 条不满足：Git Tag、Release Notes、Manifest 完整、三平台验证证据 |

**总体判断：** 把 `c9275b8` 称为"功能层面的 V1.0.0"是成立的，但按项目自己定义的标准，它还不是"已完成的 V1.0.0"。距离真正可发布只差一次 lint 修复 + 一轮发布元数据与登记表的收敛，不属于结构性返工。

---

## 2. 门禁实测结果（本报告全部结论的证据基线）

在本机 macOS 对 HEAD 全量重跑，逐命令取实际退出码：

| 命令 | 结果 | 实测数据 |
|---|---|---|
| `pnpm lint` | **✗ EXIT=1** | 2 error，均在 `packages/markdown-core/src/sanitizer.ts:259` 与 `:267`，规则 `@typescript-eslint/no-dynamic-delete` |
| `pnpm typecheck` | ✓ EXIT=0 | 4 包 strict 全 Done |
| `pnpm test` | ✓ EXIT=0 | 42 文件 / **574 用例全绿**：contracts 37、extension 55、markdown-core 234、webview 248 |
| `pnpm test:coverage` | ✓ EXIT=0 | lines：contracts 100%、markdown-core 95.63%、extension 94.77%、webview **89.01%**（≥80% 门禁通过，但较 M6 的 94.49% 下滑 5.48pt） |
| `pnpm build` | ✓ EXIT=0 | contracts → markdown-core → webview → host，extension.js 778.2 KB |
| `pnpm verify` | ✓ EXIT=0 | 31 条目 / 20 个 KaTeX woff2；**输出 `repository` 占位符提醒**（DEFER-02 仍开放） |
| `pnpm audit` | **✗ EXIT=1** | `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`，请求打到 `registry.npmmirror.com`；根脚本的 `--registry=` 覆盖未生效 |
| `pnpm notices` + `git diff --exit-code`（CI L116-119） | **✗**（复核补充） | `THIRD_PARTY_NOTICES.md` 的 `katex@0.19.1` 前言与 `scripts/release-assets.mjs:377-381` 的生成文案不一致，CI 的"许可证副本新鲜度"步骤必红。该步骤不在首轮评估的检查清单内，处置过程中才暴露，详见 §13 |
| `pnpm package` | 未执行 | 避免覆盖既有 `readora-1.0.0.vsix`；改用已存在产物做 `verify` |

判定：

- **阻塞-1（高）**：lint 红灯由 `c9275b8` 引入（`git log -1 -- packages/markdown-core/src/sanitizer.ts` 即 HEAD）。数学公式的 DOMPurify 钩子用 `delete event.allowedTags[tag]` 回收白名单项，功能正确但触碰项目自己的规则。CI（`.github/workflows/ci.yml` L60-61）在三个平台都跑 `pnpm lint`，因此 **当前 main 分支的 CI 必然是红的**。按 IMP-002 §18，M7 交付的所有 Story 此刻都不满足"代码通过 Lint"，不能标记 Done。
- **中**：`pnpm audit` 的根脚本写法在镜像源环境下无效（`--registry` 不被 `pnpm audit` 采纳），导致 §7.2「依赖漏洞检查」在开发机上不可复现。CI 里显式带官方 registry 可跑，但 CHANGELOG §复现方式 把 `pnpm audit` 列为标准复现步骤，该步骤当前不可用。NOTE-01 的三项 dev advisory 因此无法本机复扫。
- **低**：webview 覆盖率跌破 M6 记录值但仍在门槛内，建议确认新增 `search-engine.ts`（483 行）与 `SearchPanel.tsx`（225 行）的分支是否已被后续补测覆盖（当前 89.01% 主要来自这两个模块的未覆盖分支）。

---

## 3. 里程碑完成度（对照 IMP-003 §4）

| 里程碑 | 版本 | commit | 门禁当时记录 | 本次复核结论 |
|---|---|---|---|---|
| M1 工程基础 | V0.1.0 | `8844d94` 之前（基线并入） | 扩展可启动 | ✓ workspace / host / webview / contracts / VSIX 链路可用 |
| M2 Markdown 渲染 | V0.2.0 | 同上 | 182 用例 | ✓ markdown-core 八段管线 + 画布接入 |
| M3 图形与资源 | V0.3.0 | `8844d94` | 415 用例 | ✓ Pele 适配、图表挂载、资源策略与 Lightbox 全部落地 |
| M4 导航与交互 | V0.4.0 | `c2a6133` | 423 用例 | ✓ Outline 树 / 活动标题 / 专注模式 / 宽度控制 / 会话内位置恢复 |
| M5 主题与视觉 | V0.5.0 | `5eb090c` | 436 用例 | ✓ 三级 Design Token、VS Code 主题适配、无障碍与响应式 |
| M6 发布候选 | V0.9.0 | `238ec6c` | 480 用例 | ✓ 高亮 / 任务列表 / 安全·性能·可移植套件 / 许可证自动化 / CI 矩阵 |
| M7 正式发布 | V1.0.0 | `c9275b8` | 574 用例 | **部分**：搜索与数学已交付，但 §7.4 发布动作未闭合（见 §5、§6） |

M7 与 IMP-003 §4.8 的逐条对照：

| §4.8 任务 | 状态 | 证据 |
|---|---|---|
| 固定正式版本号 | ✓ | 5 个 package.json 均为 `1.0.0` |
| 生成正式 VSIX | ✓ | `readora-1.0.0.vsix` 964,836 字节，`pnpm verify` OK |
| 补齐 DEFER-01 文档内搜索 | ✓ | `apps/webview/src/search/{search-engine.ts,SearchPanel.tsx}` + 2 个 spec（440 / 428 行），覆盖 ARC-007 §9.1 全部首期能力：输入、防抖 250 ms、计数、上/下一个、大小写切换、高亮标记、Escape 关闭、文档版本失效（`SEARCH_HIT_VERSION_ATTRIBUTE`） |
| 关闭或明确 EXCP-01 数学公式 | ✓ | `packages/markdown-core/src/math.ts` + `parser.ts` 自定义规则 + `__tests__/math.spec.ts`；KaTeX 0.19.1，20 个 woff2 随包，不依赖 CDN |
| 完成发布说明 | **✗** | `CHANGELOG.md` 最后一次改动是 `238ec6c`，**没有 `[1.0.0]` 段落**；`git show --stat HEAD` 里根本没有 CHANGELOG.md |
| 完成扩展市场信息 | **✗** | 无 `icon` 字段与 `assets/icon.png`；`publisher` = `readora-dev`（BRAND-001 §2.2 明确"待注册确认"，且不得把未验证建议值当作正式结果）；`repository.url` 仍含 `<owner>`；无 `homepage` / `bugs` |
| 完成最终安装验证 | **部分** | `verify` 只校验包内容结构，不是 VS Code 内实际安装运行；三平台运行证据仍只有 macOS 本机 |
| 创建 Git Tag | **✗** | `git tag` 输出为空。IMP-003 §4.8 写的是"交付到生成正式 VSIX 与本地 annotated tag 为止"，该声明与仓库现状不符 |
| 发布正式版本 | ✓（按声明范围） | §4.8 明确不执行 Marketplace 与远端推送 |

**阻塞-2（高）**：Git Tag 缺失 + CHANGELOG 缺 `[1.0.0]`，意味着"已发布 V1.0.0"这句话在仓库里没有任何可追溯锚点。这两项都是一次提交可以闭合的。

---

## 4. 需求完成度（对照 PRD-001 需求 ID）

PRD-001 共 **184 条需求 ID**：P0 110 条、P1 59 条、P2 15 条。分布：F01 20（P0 16）、F02 10（P0 6）、F03 10（P0 0）、F04 63（P0 37）、F05 10（P0 6）、F06 10（P0 7）、F07 10（P0 7）、F08 13（P0 11）、F09 10（P0 1）、F10 14（P0 10）、F11 14（P0 9）。

核实口径说明：本次对 **全部 P0** 做了落点核对，其中 F04 的 37 条 P0 里，布局类（F04-021～029）由 Pele 引擎承担、项目侧仅在 `pele-compat.spec.ts` 对 7 类图表做渲染/错误/主题/净化验证，未逐条断言布局指标；交互类（F04-031～036）实测由引擎提供、项目侧无断言（见 §7）。

### 4.1 P0 明确未实现（2 条，均未登记在 IMP-003 §7.5）

| 编号 | 需求 | 优先级 | 实测证据 | 判定 |
|---|---|---|---|---|
| **F10-002** | 编辑器右键菜单 | **P0** | `apps/extension/package.json` 的 `contributes` 只有 `commands` / `keybindings` / `configuration` 三个键，**没有 `menus`**，`editor/context` 无注册项；命令面板入口 `readora.openReader` / `openToSide` 存在 | **阻塞-3（高）**：F10 域 10 条 P0 中唯一完全缺失项，且不在任何顺延登记表中，属于 §7.1「所有 P0 验收条件通过」未闭合 |
| **F06-008** | 文件变化监听 | **P0** | 全仓 `grep createFileSystemWatcher` 命中 0 处（生产代码）。实际只有 `application.ts:41`（`onDidChangeTextDocument`）与 `:45`（`onDidSaveTextDocument`），两者都只覆盖"在 VS Code 内打开的文档" | **高**：ARC-004 §9 明确"对于工作区内文件，优先使用 `createFileSystemWatcher`"，IMP-002 TASK-02-04-02「监听文件系统变化」与验收标准「外部文件变化能够被检测」未达成（git pull / 外部编辑器改动的场景不会刷新） |

### 4.2 P0 已实现但验收口径未闭合（1 条）

| 编号 | 需求 | 证据 | 判定 |
|---|---|---|---|
| F11-002 / F11-005 | 首次渲染与文档规模性能目标 | `perf-baseline.spec.ts` 断言的是 **2 倍放宽预算**：小文档 `<600ms`（产品目标 300ms）、中文档 `<1600ms`（目标 800ms）、Outline 抽取 `<200ms`（目标 100ms） | **中**：IMP-003 §7.3「首次渲染达到目标」在自动化层面未被直接验证；当前只能证明"在 2 倍预算内"。建议增加一条以真实目标为断言、允许在慢机跳过的基准，或在 §7.3 明确记录 2 倍口径为约定工程实践 |

### 4.3 P0 已完成且有用例支撑（抽样确认）

| 域 | 已核实项 | 关键证据 |
|---|---|---|
| F01 | 标题/段落/列表/嵌套/引用/表格/行内代码/分割线/代码块高亮/代码复制/链接/任务列表/图片/渲染错误隔离/HTML 安全 | `parser.ts`、`renderers/*`（含 `highlight.ts`）、`tasks.ts`、`security-suite.spec.ts`、`registry.spec.ts`（不支持语法诊断降级）、`clipboard.ts` |
| F02 | Outline 生成、层级、点击定位、活动标题、折叠展开、祖先展开、位置恢复 | `markdown-core` `extractOutline`/`slugifyHeading`、`OutlinePanel.tsx`、`useActiveHeading.ts`、`outline-panel.spec.tsx` |
| F04 | 5 类 P0 图表（Flowchart / Sequence / Class / State / ER）+ Gantt、Pie 兼容验证；错误隔离；输入上限；SVG 安全 | `pele-compat.spec.ts`（P0_SOURCES 七类）、`diagram-error.ts`（`readora.diagram.over-limit`）、`diagram.ts:36` `MAX_DIAGRAM_SOURCE_CHARACTERS = 50_000`（对应 ARC-003 §9.2 与 F04-058）、`svg.ts` |
| F05 | 搜索三项（DEFER-01 已关闭）、文本选择、文本复制、外链跳转、Escape 关闭浮层 | `search/*`、`global.css:534/1312` 仅对任务标记与灯箱图片禁用选择（正文可选）、`link-opener.ts` + `link-policy.ts` |
| F06 | 本地图片、相对路径、工作区边界、图片缺失提示、文件链接跳转、多文档、图片放大 | `resource-policy.ts` / `resource-resolver.ts` / `resource-service.ts`、`images.ts`（惰性 `data-readora-image-src` 双重校验）、`image-layer.ts:277` `missing-base`、`webview-manager.ts:32-47`（`sessions` + `byDocument`，同文档复用并 reveal） |
| F07 | 沉浸阅读、居中、最大宽度、左目录栏、侧栏显隐、自适应、多标签 | `App.tsx`（grid 动态列 + focusMode）、`global.css` 1024/768 断点、`reading-canvas.spec.tsx` |
| F08 | Light/Dark/System(auto)、字体与字号行宽配置、CSS Variables、VS Code 主题适配与实时切换 | `configuration-service.ts`（`resolveTheme` 读 `activeColorTheme.kind` + `onDidChangeActiveColorTheme`）、`application.ts:49` 广播、`global.css` 三级 Token、`design-tokens.spec.ts` 13 项 |
| F10 | 命令面板、自定义打开、快捷键、工作区配置、自动刷新、主题同步、Webview 生命周期、CSP、启用/禁用 | `package.json` 4 条 keybinding（`when: readora.readerActive`）、`html-template.ts` CSP（`frame-src 'none'`、无 `unsafe-eval`）+ `html-template.spec.ts` |
| F11 | 资源优化、大文档降级、内存释放、XSS、CSP、外部资源、SVG 安全、异常隔离 | `cache.ts`、`normalizer.ts` `isSourceTooLarge`、`platform-portability.spec.ts`、`security-suite.spec.ts` |

**统计口径结论：** 110 条 P0 中，经核实现实缺失 **2 条**（F10-002、F06-008），**1 条**验收口径未闭合（性能目标），其余有实现落点且多数具备自动化用例。

### 4.4 P1 / P2 缺口清单（不阻塞发布，但需如实登记）

| 编号 | 需求 | 优先级 | 现状 |
|---|---|---|---|
| F01-010 / F01-012 / F01-017 | 行号 / 代码折叠 / 脚注 | P1 | 未实现（无 footnote 插件、无 `lineNumbers` 相关代码） |
| F02-008 / F02-009 / F02-010 | 返回顶部 / 阅读进度 / 面包屑 | P1 / P1 / P2 | 未实现（`backToTop`、`progress` 命中 0） |
| F03-001～009 | Wiki Link 全族 | P1 / P2 | 未实现：`processors.ts` 头注释显式声明 §5.1 第 5 步延后，`registry.spec.ts:95` 断言 `deferred === ["wikiLink"]` |
| F05-006 | 阅读器内上下文菜单 | P1 | 未实现 |
| F05-008 | 跨会话阅读位置记忆 | P1 | 未实现（无 `workspaceState` / `globalState` 使用）；`apps/extension/README.md:97` 已如实声明"not in this release"，无虚报 |
| F05-010 | 阅读状态恢复 | P1 | 部分（会话内 `retainContextWhenHidden` + `state.save` 已做，重启后不恢复） |
| F06-004 / F06-005 | 附件预览 / PDF | P1 / P2 | 未实现 |
| F07-005 / F07-007 | 右侧信息栏 / 全屏阅读 | P2 / P1 | 右侧栏为占位文案（`App.tsx:311-314`），全屏未实现 |
| F08-010 / F08-011 | 主题预设 / 自定义 CSS | P1 / P2 | 未实现 |
| F09-001~004 / F09-009 / F09-010 | Properties 展示、Tags、Callout、自定义容器、注释处理 | P1 / P2 | 未实现；Frontmatter 识别与基础解析已做（`frontmatter.ts` + `DocumentHeader.tsx` 原文列出） |
| F09-005 | `==高亮文本==` | P1 | 未实现；F09-006 删除线依赖 markdown-it 默认 preset 隐式支持，**无一条用例锁定**（全仓 `s_open` / `<s>` 命中 0） |
| F10-004 / F10-006 / F10-011 | 文件关联 / 状态栏集成 / 国际化 | P1 / P2 / P1 | 未实现 |
| F11-003 / F11-013 / F11-014 | 增量刷新 / 错误日志 / 性能指标采集 | P1 | 未实现或半实现：错误上报仅 `console.error`（`extension.ts:19`、`handlers.ts:59`、`host-message-handler.ts:100`），无 OutputChannel；无运行时性能采集，只有测试基准 |

本表是评估当日（`c9275b8`）的快照，按 §13 开头的约定不随里程碑改写。后续已闭合的行记在
§13.7：其中 **F01-017 脚注已于 M10（v0.10.0）交付**、**F05-006 已于 M11（v0.11.0）拿到
首个实例**，这两行的「未实现」表述就此过期。

---

## 5. IMP-002 Story / Task 完成度

EPIC 优先级以文档标注为准（EPIC-03/04/05/07/08/09/10/11/12 为 P0，EPIC-06 为 P1）。

| Story | 优先级 | 判定 | 未闭合的 Task 与证据 |
|---|---|---|---|
| STORY-01-01～03 | P0 | Done | workspace / contracts / 构建脚本齐备，`build` 与 `verify` 通过 |
| STORY-02-01～03 | P0 | Done | 生命周期、文档打开、Session 均有 spec（extension 55 用例） |
| **STORY-02-04** | P0 | **未达 DoD** | TASK-02-04-02 未实现（无 FileSystemWatcher）；验收标准「外部文件变化能够被检测」不成立 |
| STORY-03-01～03 | P0 | Done | React Shell、三栏布局、基础组件 |
| STORY-04-01～04 | P0 | Done | 管线 + Sanitizer + 代码块 + 高亮 |
| STORY-05-01～03 | P0 | Done（含保留意见） | 缩放/拖动/滚轮/双击由 Pele `enableZoom` 提供，但项目侧 0 条交互断言（见 §7） |
| STORY-06-01 数学 | P1 | Done | 与 IMP-003 §5 KaTeX 门槛闭合记录一致 |
| STORY-06-02 Frontmatter | P1 | 部分 | TASK-06-02-04「Properties 展示」未做（右侧栏占位） |
| STORY-06-03 Wiki Link | P1 | 未开始 | `processors.ts` 注释 + `registry.spec.ts` 断言 |
| STORY-07-01～03 | P0 | Done | 搜索在 M7 补齐，DoD 其余项满足 |
| STORY-08-01～03 | P0 | Done | 三个 spec 文件覆盖策略 / 解析 / 逃逸 |
| STORY-09-01 | P0 | 部分 | TASK-09-01-04「基础快捷键」做了 4 条，但与 PRD-002 §14 规定不同（见 §7 偏差 D-3） |
| STORY-09-02 | P0 | Done（限会话内） | 与 F05-008 的 P1 缺口一致，符合文档定义边界 |
| STORY-09-03 | P0 | 部分 | TASK-09-03-02 Properties、TASK-09-03-03「Backlinks 占位状态」未实现；右侧栏只有一个 Properties 占位，**没有 Backlinks 的空状态**。注意 IMP-002 §768 的原话是"不得将未实现的 Backlinks 功能伪装成已完成能力"——现状是诚实占位缺失，不是虚报，但仍属未完成 Task |
| STORY-10-01～03 | P0 | Done | 视觉回归以 `design-tokens.spec.ts` + 实测双轨支撑 |
| STORY-11-01～03 | P0 | Done | 安全 / 性能 / 生命周期三套件 |
| **STORY-12-01** | P0 | **未达 DoD** | TASK-12-01-05「配置 Playwright」未做：全仓 `playwright` 命中 0（package.json、脚本、CI 全无），验收标准「关键交互可以通过 E2E 验证」不成立 |
| STORY-12-02 | P0 | 部分 | CI 三平台矩阵已建（`ci.yml` L37），但矩阵跑的是构建+打包+verify，不是"在 VS Code 里安装并运行"；TASK-12-02-04「不同 VS Code 版本验证」只声明 `engines.vscode: ^1.95.0`，无多版本实测记录 |
| **STORY-12-03** | P0 | **未达 DoD** | TASK-12-03-02「配置扩展图标与描述」未做（`icon` 字段缺失，`apps/extension/resources/` 只有 README.md）；TASK-12-03-05「编写发布说明」未做（CHANGELOG 无 `[1.0.0]`） |

**IMP-002 §18 DoD 复核：** 第 3 条「代码通过 Lint」在 HEAD 失败 → 严格意义上 M7 没有任何 Story 可以标记 Done。这是本报告把"发布准入"判为不通过的首要依据。

---

## 6. 文档体系自身完成度（docs 目录内部评估）

### 6.1 规模与结构

15 个文件 / 12,125 行：PRD 3 篇（2,102 行）、ARC 8 篇（5,482 行）、IMP 3 篇（3,003 行）、品牌治理 1 篇（557 行）。结构完整，编号连续，上游依赖链（PRD → ARC → IMP）在每篇的属性表中一致声明，无孤立文档。

### 6.2 进度载体全部失效（本次评估的核心发现）

| 现象 | 实测 | 影响 |
|---|---|---|
| 文档状态字段 | 15 篇的属性表中「文档状态」一行**全部**写 `Draft`，且正文末尾各自重复一遍（如 ARC-001 L970、IMP-003 L631） | 与 IMP-003 §10.1–10.3 的"已完成"表格直接矛盾：同一批文档在一处自称完成、在另一处自称草稿。读者无法判断哪句有效 |
| 验收 / 自查清单 | `- [ ]` 共 **111 项**（ARC-005 10、ARC-006 20、ARC-007 22、ARC-008 11、IMP-001 16、IMP-003 32），`- [x]` **0 项** | IMP-003 §7.1–7.4 的发布准入清单一条都没勾，等于文档没有记录任何一次验收结论。本次评估的数据（§2、§3）恰好可以直接回填 |
| Story 完成状态 | IMP-002 §2.4 定义了 Todo / In Progress / Blocked / Review / Done 五态，但 12 个 Epic、35 个 Story 中**没有任何一处使用这些状态值** | 进度无法从规范体系读出，只能靠 git log 与 CHANGELOG 反推——这正是"检查完成进度"必须依赖外部推断的原因 |
| 后续文档表陈旧 | IMP-002 §21 仍写 `IMP-003 待编写`；PRD-001 L684-691 把 PRD-002/003、ARC-001~004 全列为"待编写"，并列出 **TSD-001 / TSD-002 两个从未存在的编号**（内容实际被 IMP-001 吸收） | 交叉引用链尾部保留着早期编写期的快照；TSD 编号还在文档体系里留下悬空承诺 |
| 范围与优先级冲突 | PRD-001 `F08-003 System Theme` 是 **P0**，IMP-003 §3.2 却把"系统主题自动跟随"列入"MVP 可选增强，不阻塞发布" | 两个文档对同一能力的阻塞性判定不同；实现上已按 P0 做了（`auto` + `activeColorTheme`），冲突未回写到文档 |
| V1.0 承诺悬空 | IMP-003 §3.2 说"基础 Frontmatter 解析和 Wiki Link 跳转属于 V1.0 的增强范围"；实际 V1.0.0 只兑现了 Frontmatter 解析，Wiki Link 未做，而 §8 又把"更完整的 Wiki Link"排进 V1.1.x | "V1.0"这个词在 §3.2 指发布版本、在 §8 指未交付范围，需在下一篇修订中区分 V1.0.0 与 1.0 线 |
| CHANGELOG 标题层级 | `[0.9.0]` 与 `[1.0.0]` 两段把 Added／Fixed／发布物 等子块写成 `##`（与版本标题同级），`[1.1.0]` 起改用正确的 `###` | **低**：旧段属已发布内容，为不动 tag 内文本而保留原层级；下一次文档治理轮统一降级为 `###` 即可 |

### 6.3 可追溯性与格式质量

| 项 | 实测 | 判定 |
|---|---|---|
| 编号引用密度 | 代码 + 文档内共 **588 处** `PRD/ARC/IMP/BRAND-xxx §n` 引用，覆盖 197 个章节目标 | **优**：需求→架构→实现的正向追溯在注释层已成型，这是本次能在有限时间内完成核对的根本原因 |
| 悬空引用 | **8 处**：①`BRAND-001 §2.2/§2.3/§2.4/§2.5/§3.1` 共 6 处（`constants.ts:4`、`configuration-service.ts:10`、`commands/index.ts:14`、`contracts/src/protocol.ts:7`、`verify-vsix.mjs:144/…`）—— 被引文档实际文件名是 `Readora 正式品牌命名与文档迁移规范.md`，未采用 `BRAND-001：` 前缀，按编号解析文件名的工具链找不到它；②`docs/ARC-005 §14.2.4` 2 处（`image-layer.spec.ts:153`、`image-preview.spec.tsx:200`）—— ARC-005 只有 §14.2 的扁平列表，无 14.2.4 小节 | **低（但应修）**：①是命名规范与自身编号声明不一致（文内 `文档编号 = BRAND-001`，文件名却无编号），②应改写为"§14.2 第 4 项"的统一记法 |
| 非 Markdown 标签 | IMP-003 有 **19 处** `<box>` / `<badge>` / `<grid>` / `<title>` / `<divider>` JSX 风格标签；其余 14 篇为 0 | **低**：这些标签在 VS Code / GitHub 的 Markdown 渲染器里按原样输出，影响可读性（§2.2 表格、§4.x 里程碑标题、§10.4 统计块）；且全仓无对应渲染组件，属编写期残留 |
| 图表语法 | 各篇 mermaid 代码块语法正确（本次未逐块渲染校验） | 通过 |
| 代码-文档一致性 | 见 §7 | 存在 3 处需登记的偏差 |

### 6.4 对外文档（README / CHANGELOG）与实现的一致性

抽查结论是**正向的**：`apps/extension/README.md` 与 `README.md` 对 V1.0.0 的描述与实际代码相符，包括主动声明"跨会话记忆属 F05-008（P1）不在本版"、"工作区级搜索属后续候选"。唯一措辞问题：

- `apps/extension/README.md:54` 称主题切换时"Mermaid diagrams **re-render** with it"。实际机制是按 ARC-003 §8.4 / PRD-003 §9.4，通过 `--pele-*` CSS 变量映射实现**免重解析的重绘**（`global.css:893-903` 明确写了"without re-parsing or re-laying it out"，`pele-adapter.ts` 调用 `mount()` 时不传 `themeVariables`）。"re-render"一词与架构文档表述相反，建议改为"repaint / retheme"。**低**。

---

## 7. 架构符合度抽查（ARC-001～008）

| 文档 | 抽查重点 | 判定 |
|---|---|---|
| ARC-001 | 分层与包边界（contracts / markdown-core / extension / webview 四件套 + scripts） | ✓ 与目录实况一致；§14.2"暂不引入"项未见越界实现 |
| ARC-002 | §5.1 九项处理内容、§5.3 处理器固定顺序、§7.3 任务列表、§8.3 未注册语言降级、§9 数学分两步 | ✓ `processors.ts` 保持顺序不变量并注释说明第 5/7 步延后；⚠ 偏差 D-1（见下） |
| ARC-003 | §8.2/8.4 主题变量映射、§9.2 输入上限、错误卡片、净化 | ✓ 引擎不承担主题变量注入，项目以 CSS 变量映射达成同步，符合文档；上限 50,000 字符有用例 |
| ARC-004 | §9 文件变化与实时更新、§8.3 链接打开权限、§11 主题解析 | **✗ 偏差 D-2**：§9 要求的 `createFileSystemWatcher` 与"文件变化必须进行防抖"未实现；其余（消息校验、URI 边界、Session 版本防旧覆盖）符合 |
| ARC-005 | §? 布局分区（含底部 `ReaderStatusBar`）、§14.2 渲染性能策略、目录结构建议 `ReaderStatusBar/` | **偏差 D-4**：ReaderStatusBar 未实现（全仓 `StatusBar` 命中 0）。F10-006 状态栏本身是 P2、F02-009 阅读进度是 P1，因此不构成 P0 违规，但 ARC-005 的应用骨架图与实际组件表不一致，需要在下一篇修订或明确降级为 V1.1.x |
| ARC-006 | 三级 Token、优先级、VS Code 变量 fallback、高对比 / reduced-motion | ✓ M5 落地并有 `design-tokens.spec.ts` 13 项回归 |
| ARC-007 | §8.2 隐藏保位、§8.3 防抖 800ms、§9 搜索范围与数据模型 | ✓ `App.tsx:157-179` 与 `SearchPanel.tsx` 对齐；搜索命中结果带 `documentVersion` 并在文档更新时失效，符合 §9.2/§541 的一致性要求 |
| ARC-008 | §5 净化、§6.1 授权根、§7.1 `localImageUri` 能力位、路径与符号链接逃逸 | ✓ 三重防御（渲染期惰性标记 + Host 判定 + Webview 水合复判）与文档同构，且有专项 spec |

### 需在文档中登记的实现偏差

| 编号 | 偏差 | 建议处置 |
|---|---|---|
| D-1 | `processors.ts` 头注释称"§5.1 第 5、7 步（wiki link、资源引用提取）属于后续里程碑"，但第 7 步的能力实际已由 `images.ts`（引用分类）+ Host 侧 `resource-policy/resolver` 承担。注释与实现不符 | 修注释，把第 7 步标注为"已在 P06/Host 侧完成，P04 不再单独提取"，避免下一里程碑重复建设或误判缺口 |
| D-2 | ARC-004 §9 的 FileSystemWatcher 与文件级防抖未实现（= F06-008 P0 缺口） | 登记 DEFER-05 并在 V1.0.x 补齐 |
| D-3 | PRD-002 §14 快捷键规范与 `contributes.keybindings` 不一致：规范给 `Ctrl/Cmd+Shift+M`（打开）、`Ctrl/Cmd+ +/−/0`（字号）、`Ctrl/Cmd+Shift+F`（专注）；实现是 `cmd+alt+f/o/left/right`（专注、目录、宽度）+ Webview 内 `Cmd/Ctrl+F`（搜索）与 `Escape`（关闭）。打开命令无键位，字号快捷键完全没有 | 两种收敛方式二选一：①按 PRD-002 补齐键位（注意 `Cmd+Shift+F` 与宿主全局搜索冲突，现状 `cmd+alt+f` 的规避理由是成立的）；②修订 PRD-002 §14 为"首版键位表"并把冲突规避写进规范。**不建议长期并存两套事实** |
| D-4 | ARC-005 应用骨架含 ReaderStatusBar 与 `ReaderStatusBar/` 目录，实际不存在 | 在 ARC-005 标注为 V1.1.x 范围，或随 F02-009 阅读进度一起在下一版本实现 |
| D-5 | F04-032 拖动、F04-033 滚轮缩放、F04-034 双击缩放的实际能力来自 Pele `enableZoom`（源码含 pointerdown/pointermove/wheel/dblclick 与 grab 光标），项目侧对 `pointer`/`wheel`/`dblclick` **0 条断言**；阅读器自己的工具栏只覆盖 zoom-in/out/fit/reset | 在 `pele-compat.spec.ts` 增加一组交互事件断言，把"引擎隐式提供的 P0 交互"固化为升级回归防线（IMP-001 §3.4 第 7 条要求 Pele 必须有独立兼容性测试，当前只覆盖渲染面） |

---

## 8. IMP-003 §7.5 顺延登记表复核与建议新增

| 编号 | 原定 | 本次复核 |
|---|---|---|
| DEFER-01 文档内搜索 | M7 关闭 | **已真实关闭**：搜索面板 + 引擎 + 两个 spec 合计新增 1,576 行，覆盖 ARC-007 §9.1 全部首期能力 |
| EXCP-01 KaTeX | M7 关闭 | **已真实关闭**：math.ts + parser 自定义规则 + math.spec + 20 woff2 本地打包，`verify` 逐条计数确认 |
| DEFER-02 `repository` 占位 | 仍开放 | **确认仍开放**，且每次 `pnpm verify` 都会输出提醒；范围实际比登记更大（见 DEFER-07） |
| DEFER-03 `katex` 关键字 | M7 兑现 | **已兑现** |
| NOTE-01 dev-only advisory | 每次发布复扫 | **本轮无法复扫**：`pnpm audit` 在本机因镜像源缺 endpoint 而失败（§2）。发布前必须给出可执行的复扫路径 |

建议新增（依据均来自本报告已核实的证据）：

| 建议编号 | 项 | 定性 | 建议处理 |
|---|---|---|---|
| **DEFER-04** | `pnpm lint` 在 HEAD 有 2 处 error | **发布阻塞缺陷**（违反 IMP-002 §18 DoD 3、IMP-003 §7.1） | 立即修：把两处 `delete map[key]` 改为把 `allowedTags`/`allowedAttributes` 置 `false`（DOMPurify 语义等价），或对该行内联豁免并写明理由；修完复跑 lint + 574 用例 |
| **DEFER-05** | F10-002 编辑器右键菜单（P0）、F06-008 文件变化监听（P0） | P0 需求缺失且未登记，属 §4.5 那次"计划遗漏"的同类复发 | 二选一：V1.0.x 补齐（右键菜单成本极低，只需 `contributes.menus.editor/context` 一条 + 验证）；或按需求变更流程正式降级并修订 PRD-001 |
| **DEFER-06** | STORY-12-01 的 E2E（Playwright）与 STORY-12-03 的图标 | P0 Story 未达 DoD | 图标属视觉资产（BRAND-001 §4.3 明示不阻塞工程初始化，但阻塞 Marketplace 上架）；E2E 需给出"关键交互通过 E2E 验证"的替代证据或正式移出准入条件 |
| **DEFER-07** | 发布元数据四项：`publisher` 未注册确认、`repository` 占位、无 `icon`、无 `homepage`/`bugs` | 市场信息未完成 | 与 DEFER-02 合并为一项"上架前元数据清单"，逐项给出负责人与来源（BRAND-001 §2.2/§3.1） |
| **NOTE-02** | 性能验收口径为产品目标的 2 倍 | 验证口径松动 | 在 IMP-003 §7.3 显式记录该口径，或补一条按真实目标断言的基准 |

---

## 9. 发布准入 §7.1～§7.4 回填建议（可直接抄进 IMP-003）

| 清单项 | 建议勾选 | 依据 |
|---|---|---|
| §7.1 Markdown 核心语法正确 / Mermaid 范围明确 / 本地图片 / Outline / 文档变化同步 | 前四项 ✓，最后一项 **✗** | 同步仅覆盖编辑器内文档（§4.1 F06-008） |
| §7.1 所有 MVP P0 Story 已完成 / 所有 P0 验收条件通过 | **✗** | F10-002、F06-008、STORY-12-01/12-03 |
| §7.2 CSP / 无 unsafe-eval / Sanitizer / SVG / URL Scheme / 路径边界 / Host 校验 / 无已知严重漏洞 | 前七项 ✓，第八项 **待补证据** | 七项均有用例；最后一项本机 `pnpm audit` 不可执行，CI 结果未附 |
| §7.3 首渲达标 / 中文档达标 / 图表延迟渲染 / 无明显卡顿 / 无泄漏 / 性能报告 | **部分** | 2 倍口径（§4.2），其余满足；报告在 CHANGELOG M6 段，V1.0.0 未更新 |
| §7.4 VSIX 可安装 / 三平台 / Manifest 完整 / README / License / 第三方许可 / Release Notes / Git Tag | README ✓、License ✓、第三方许可 ✓（34,803 字节随包）、其余 **✗ 或部分** | 图标 / publisher / repository 未完成；Release Notes 缺 `[1.0.0]`；无 tag |

---

## 10. 建议行动清单（按优先级）

1. **修 lint（阻塞-1）**：`sanitizer.ts:259/267` 两处 `delete` 改为显式置 `false` 或带理由的局部豁免；复跑 `pnpm lint` + `pnpm test`，确认 CI 三平台转绿。
2. **补 §4.8 未完成的两件发布动作（阻塞-2）**：CHANGELOG 增加 `[1.0.0]` 段（含 M7 关闭 DEFER-01/EXCP-01/DEFER-03、遗留 DEFER-02/04～07 的结论），创建本地 annotated tag `v1.0.0`（IMP-003 §4.8 已承诺）。
3. **收敛 F10-002 与 F06-008（阻塞-3、高）**：右键菜单可在一次提交内完成；文件系统监听按 ARC-004 §9 补 `createFileSystemWatcher` + 防抖，并补"外部改动触发刷新"的用例。
4. **把进度写回文档**：IMP-003 §7.1～7.4 按 §9 的结论回填勾选；15 篇状态字段从 `Draft` 改为 `Released`（或统一 `Final`）并同步 §10 表格；IMP-002 为 35 个 Story 实际启用 §2.4 的五态；修正 IMP-002 §21 与 PRD-001 后续文档表（含从未存在的 TSD-001/002）。
5. **消除三处文档-实现偏差**：PRD-002 §14 键位表（D-3）、ARC-005 ReaderStatusBar（D-4）、`processors.ts` 第 7 步注释（D-1）。
6. **补两类回归防线**：Pele 交互事件断言（D-5）；GFM 删除线 / 脚注等语法至少各 1 条用例（当前依赖 markdown-it 默认 preset 的隐式行为）。
7. **发布元数据一次性收口（DEFER-07）**：publisher 注册确认、repository 真实地址、`assets/icon.png` + `icon` 字段、homepage/bugs；同步把 `pnpm audit` 改为在镜像源下可执行或明确标注仅在 CI 运行。
8. **命名可追溯性**：把品牌治理文档改为 `BRAND-001：Readora 正式品牌命名与文档迁移规范.md`（编号前缀与其余 14 篇一致），或统一把 6 处 `BRAND-001 §x` 引用改为按文件名引用。

---

## 11. 评分与最终判定

| 维度 | 分数 | 依据 |
|---|---|---|
| 规范内容完备性 | **A** | 14 篇 + 治理篇覆盖需求/架构/实施三层，边界收敛明确（IMP-003 §10.5） |
| 规范可追溯性 | **B+** | 588 处编号引用成型；8 处悬空、1 处记法不规范、19 处非 Markdown 标签 |
| 规范进度治理 | **D** | 状态字段 15/15 为 Draft、111 项清单 0 回填、Story 五态从未使用、2 处后续文档表陈旧、1 处优先级冲突 |
| 功能实施（MVP P0） | **A-** | 110 条 P0 缺失 2 条 + 1 条口径未闭合；主线全部可用且有用例 |
| 质量门禁 | **B-** | typecheck/test/coverage/build/verify 全绿（574 用例、四包覆盖率达标），但 lint 红灯一票否决 |
| V1.0.0 发布准入 | **C（不通过）** | §7.1/7.4 各有多项未闭合，tag 与 release notes 缺失 |

**最终判定：Readora 已完成 V1.0.0 的功能实体，尚未完成 V1.0.0 的发布准入。** 一次 lint 修复、一段 CHANGELOG、一个 tag、两条 P0 缺口的补齐或正式降级，即可把"声明的 1.0.0"变成"可审计的 1.0.0"。规范体系的下一个薄弱环节不在内容质量，而在**进度与结论没有回写机制**——本次评估的全部数据都应该成为 IMP-003 §7 的勾选项和 §7.5 的登记行。

> 本段判定的处置进展见 §13：lint 与许可证副本已转绿、CHANGELOG `[1.0.0]` 已补、`v1.0.0` annotated tag 已创建、F10-002 右键菜单已补齐（§13.1）。准入判定本身仍维持"不通过"，因为 F06-008 与 F10-004 未闭合、扩展图标与市场元数据缺失、E2E 未配置，且提交与 tag 尚未推送到任何远端。

---

## 12. 附录：证据索引

| 证据 | 位置 |
|---|---|
| lint 失败点 | `packages/markdown-core/src/sanitizer.ts:259`、`:267`（`mathElementHook` / `mathAttributeHook`） |
| 门禁退出码 | 本轮 `pnpm lint/typecheck/test/test:coverage/build/verify/audit` 实测（§2 表） |
| 测试计数 | contracts 37 / extension 55 / markdown-core 234 / webview 248 = 574 |
| 覆盖率 | 四包 `All files` 行：100 / 94.77 / 95.63 / 89.01（lines） |
| VSIX | `readora-1.0.0.vsix` 964,836 字节、31 条目、20 个 KaTeX woff2、`THIRD_PARTY_NOTICES.md` 34,803 字节 |
| 无 tag / CHANGELOG 停滞 | `git tag`（空）；`git log --oneline -- CHANGELOG.md` → 仅 `238ec6c` |
| Manifest 缺口 | `apps/extension/package.json`：`contributes` 无 `menus`、无 `icon`、`publisher: readora-dev`、`repository.url` 含 `<owner>`、`engines.vscode: ^1.95.0` |
| 无文件系统监听 | 全仓 `createFileSystemWatcher` 命中 0；`apps/extension/src/application.ts:41-52` |
| 无 E2E | 全仓 `playwright` 命中 0（package.json / scripts / CI） |
| 数学与搜索落点 | `packages/markdown-core/src/math.ts`、`parser.ts`（自定义 `$$`/`$` 规则）、`apps/webview/src/search/search-engine.ts`、`SearchPanel.tsx` |
| 图表能力面 | `apps/webview/src/__tests__/pele-compat.spec.ts`（P0_SOURCES 七类图表）、`packages/markdown-core/src/diagram.ts:36`（50,000 上限）、`apps/webview/src/diagram/diagram-error.ts` |
| 主题同步机制 | `apps/extension/src/configuration/configuration-service.ts:25`、`application.ts:49`、`apps/webview/src/styles/global.css:893-925`（`--pele-*` 映射）、`apps/webview/src/diagram/pele-adapter.ts`（不传 `themeVariables`） |
| 引用扫描方法 | 以 `docs/*.md` 的 `## N.` / `### N.M` 标题集合为章节全集，用编号加分节号的组合正则扫描 apps、packages、scripts、docs 四类文件，得 588 处引用、197 个目标、8 处悬空 |

## 13. 处置跟踪（评估当日，基线之后）

评估交付后用户授权执行第 1、2 步修复，本节记录进展，不改动 §2–§11 的原始判定（它们描述的是 `c9275b8` 的状态）。

一处自指细节需要说明：`v1.0.0` 指向 `a2a7d69`，而本节关于 tag 的行与 `CHANGELOG.md` 的 tag 行是在该提交之后写下的，所以 tag 内的这两处文本仍是打 tag 之前的版本。补记没有 amend 到 `a2a7d69`，以免改写一个已经被命名对象引用的提交。

### 13.1 已处置

| 项 | 处置 | 复核证据 |
|---|---|---|
| DEFER-04 / 阻塞-1（lint 2 error） | `packages/markdown-core/src/sanitizer.ts` 的两个钩子改为把决定写成布尔值（`event.allowedTags[tag] = isElement(node) && isMathMarkup(node)`），不再动态 `delete` | `pnpm lint` EXIT=0（0 error / 0 warning）；`pnpm typecheck` EXIT=0；`pnpm -r test` 574 用例全绿（`math.spec.ts` 与 `security-suite.spec.ts` 是这次改动的直接回归护栏） |
| 语义等价性核实 | 读 `dompurify@3.4.17` 源码确认：元素侧按真值查表（`!ALLOWED_TAGS[tagName]`），属性侧同理（`ALLOWED_ATTR[lcName]`，dist/purify.js L2162），都不是键存在性判断；钩子表由 `_forkSharedAllowlist` 在存在钩子时克隆，调用结束即丢弃 | 因此 `false` 与"键缺失"对 DOMPurify 等价，白名单不会因为留下 `false` 键而放宽，也不会跨调用泄漏 |
| 许可证副本新鲜度（§2 复核补充） | `pnpm package` 触发 `scripts/release-assets.mjs` 重新生成 `THIRD_PARTY_NOTICES.md`，`katex@0.19.1` 前言回到脚本输出（脚本 L377-381），CI 的 `git diff --exit-code THIRD_PARTY_NOTICES.md` 恢复可通过 | 差异仅该段落一处，其余约 34 KB 内容未变 |
| 发布物一致性 | 用修复后的源码重新打包，替换修复前的 `readora-1.0.0.vsix`（该文件被 `.gitignore` 的 `*.vsix` 忽略，属本地产物，不入库） | 966,219 字节 / 31 条目；SHA-256 `a771719d992d5f9ee4ee5685d429a13c915101efafd8f7fbc5f074c599f345ec`；`pnpm verify` OK（仍输出 repository 占位提醒） |
| 阻塞-2 之一：Release Notes | `CHANGELOG.md` 新增 `[1.0.0]` 段：Added（搜索、数学）、Fixed（lint）、门禁复跑结果、发布物、发布准入缺口表、复现方式与 audit 环境说明；`[0.9.0]` 原文保留 | 段落内六项门禁数据与 SHA-256 均为本轮实测值 |
| 覆盖率复核 | 四包 lines 未因修复变化 | contracts 100% / extension 94.77% / markdown-core 95.63% / webview 89.01%，`pnpm test:coverage` EXIT=0 |
| 阻塞-2 之二：Git Tag | 上述四项改动收进提交 `a2a7d69`（`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`、`sanitizer.ts`、本篇；`*.vsix` 被忽略不入库），随后在该提交上创建 annotated tag `v1.0.0`，兑现 IMP-003 §4.8 的交付边界 | `git log` 显示 `a2a7d69 (HEAD -> main, tag: v1.0.0)`；`git cat-file -p v1.0.0` 的 `object` 指向该提交；暂存前用 `git diff --cached --name-only` 负检无 node_modules / dist / out / vsix 泄漏，符合 IMP-001 §17 的提交规范 |
| DEFER-05 之一：F10-002（P0 右键菜单） | `apps/extension/package.json` 补 `contributes.menus`：`editor/context`（`editorLangId == markdown`）与 `explorer/context`（`resourceExtname` 覆盖 `.md` 与 `.markdown`）各列 Open Reader / Open to the Side；新增 `commands/target.ts` 的 `resolveCommandTarget` 让命令接收资源管理器传来的 URI，非文档资源走显式拒绝；`openReader` 获得无 `when` 的全局键位 `ctrl+alt+r` / `cmd+alt+r`；`refresh` 在没有活动编辑器时回退到会话自身的文档 | extension 用例 55 → 78（`target.spec.ts` 13 + `manifest.spec.ts` 10），全量 597 用例；`pnpm lint`／`pnpm typecheck` 均为 0。`manifest.spec.ts` 把"菜单条目只引用已注册命令、不得无 `when`、`when` 覆盖扩展表"固化为回归护栏 |
| F10-002 的发布载体 | 这批入口改动不适合留在已打 tag 的 1.0.0 里，因此五包版本一起 1.0.0 → 1.1.0，重新打包并创建 `v1.1.0` annotated tag；`readora-1.0.0.vsix` 保留不动，维持与 `v1.0.0` 的对应关系 | `readora-1.1.0.vsix`：31 条目 / 967,124 字节 / SHA-256 `3309332dca205cd443c10f31165ebb083eede801598975863bd669c6006d164d`；`pnpm verify` OK；`pnpm test:coverage` 的 extension lines 由 94.77% 升到 95.39%。产物内容按解包核验：`extension/package.json` 的 `contributes` 已含 `menus`（`editor/context` + `explorer/context`）与 5 条 keybindings，`extension/dist/extension.js` 含 `resolveCommandTarget`，`extension/readme.md` 为 V1.1.0 状态段 |
| 首屏空白（V1.1.1，用户在真实宿主里报出） | `WebviewManager.open()` 在赋值 `webview.html` 后立刻 `postMessage` 发 `document/load`，而消息监听器要到 bundle 加载、React 挂载后的第一个 effect 才注册，这条消息因此被丢弃；`reader.ready` 两端本已实现，但 host 侧处理函数是空实现。改为把快照暂存进新增的 `webview/pending-delivery.ts`，在收到 ready 时才投递，并让 `open()` 当场校验 payload 以保持超限文档的早报 | `pnpm -r test` 605 用例（extension 78 → 86，新增 `pending-delivery.spec.ts` 8 项）；`pnpm lint`／`pnpm typecheck`／`pnpm test:coverage`／`pnpm build`／`pnpm package`／`pnpm verify` 全部 EXIT=0；extension lines 95.39% → 95.62%，`pending-delivery.ts` 100% |
| 覆盖报表的盲区（诊断过程中查得） | `apps/extension` 的 coverage 只列出**不依赖 `vscode`** 的模块：`constants.ts`、`target.ts`、`link-policy.ts`、`resource-policy.ts`、`resource-resolver.ts`、`html-template.ts`、`pending-delivery.ts`。`webview-manager.ts`、`handlers.ts`、`host-message-handler.ts`、`commands/index.ts`、`application.ts`、`document-service.ts`、`link-opener.ts`、`reader-session.ts` 这一整层不在报表内，因此"95.62% lines"与"集成层零测试"同时成立 | 逐行核对 coverage 的 `All files` 表所得；这意味着 §2 与 §11 的覆盖率结论描述的是被统计到的那部分，不代表该包被验证过的范围。该盲区已由下一行的 `vscode` 测试替身闭合 |
| 覆盖盲区的闭合与首屏缺陷的回归护栏（用户授权"补 vscode stub 集成测试"） | 新增 `apps/extension/src/__stubs__/vscode.ts`：只建模 Host 真正调用的 API，未建模的调用刻意以 `TypeError` 暴露；接入方式是零配置的 `vi.mock("vscode", async () => import("../../__stubs__/vscode.js"))`。其上写两个集成 spec：`webview/__tests__/document-delivery.spec.ts`（17 用例，直接断言"建面板时不得发送 `document/load`，必须等 `reader.ready`"）与 `messaging/__tests__/host-handlers.spec.ts`（16 用例，把 `document.open` 交给 OS、`resource.resolve` 读磁盘两条权限边界接进真实 dispatcher）。`vitest.config.ts` 加 `coverage.exclude` 把替身与 spec 挡在报表外。顺带修正产品代码一处顺序：`open()` 的载荷预校验移到创建面板之前，超限文档不再留下空白面板 | 三次变异检查证明护栏有效：回退 `stageForReady` → 4 红；`toWebviewUri` 改返回磁盘 URI → 1 红；`LinkOpenerService.open` 跳过策略短路 → 3 红；恢复后全绿。用例 extension 86 → 119，全量 605 → 638；`pnpm lint`／`pnpm typecheck` 为 0；extension lines 在诚实分母下为 95.04%（阈值 80），替身刚接入时曾降到 81.42%，那是补测试之前的真实余量而非回归。本段不重新出包：`.vscodeignore` 排除 `src/**` 与 `vitest.config.ts`，实测 `dist/extension.js` 中 `StubPanel` 命中数为 0 |

### 13.2 仍未闭合

| 项 | 原因 | 需要的决策 |
|---|---|---|
| 远端与上架 | 仓库仍未配置远端（`git remote -v` 为空），`v1.0.0` 与 `v1.1.0` 两个 tag 及其提交都只在本地；Marketplace 上架需要的图标与元数据未闭合 | 需要远端地址与发布者身份确认后 `git push && git push --tags`，并完成 DEFER-06 / DEFER-07 |
| DEFER-05 剩余：F06-008 文件系统监听（P0） | 全仓仍无 `createFileSystemWatcher`，只监听编辑器内文档的变更与保存 | 按 ARC-004 §9 补 watcher + 防抖，并补"外部改动触发刷新"的用例；或走需求变更流程正式降级 |
| F10-004 Markdown 文件关联（P1，用户实际报出的缺口） | 未贡献 `customEditors`，双击 `.md` 仍是文本编辑器；`workbench.editorAssociations` 只认 custom editor 的 viewType，配上也无效 | 需要 `CustomTextEditorProvider` 形态改造（生命周期、脏态与保存、多标签、CSP 与 `localResourceRoots` 迁移），并先补 ARC-004 / IMP-002 条目；右键菜单是当前的替代工作流 |
| DEFER-06 | Playwright E2E（TASK-12-01-05）、扩展图标（TASK-12-03-02）。**该缺陷已兑现一次实测损失**（见 §13.5）；stub 护栏接入后，host↔webview 的消息时序与两条权限边界已在 dispatcher 层被 33 条用例守住，剩下的是替身建模不到的那一段：真实 bundle 在真实 Chromium 里能否解析 HTML/nonce、字体与 KaTeX 是否真的渲染、`acquireVsCodeApi()` 往返 | 补齐 E2E，或把"关键交互通过 E2E 验证"改写为可达成的准入表述。建议措辞按验证层次拆分：协议与时序类断言归 stub 集成测试（已完成），像素与真实宿主行为类断言归 E2E（未完成） |
| DEFER-07 | publisher / repository / icon / homepage / bugs 四项市场元数据 | 注册与真实地址确认后一次性收口 |
| NOTE-02 | 性能断言口径为产品目标的 2 倍 | 补真实目标断言，或在 IMP-003 §7.3 记录该口径 |
| 文档治理回填（§6.2） | 状态字段、111 项清单、Story 五态、后续文档表、F08-003 优先级冲突 | 需要一次专门的规范修订轮，不属于本轮授权范围 |

### 13.3 评估方法上的自我修正

首轮评估把"本地可执行的根脚本"当作门禁全集，因此漏掉了 `.github/workflows/ci.yml` 中定义、但本地未单独复演的**许可证副本新鲜度**步骤（`pnpm notices` + `git diff --exit-code`）——它同样是会令 CI 变红的缺陷。后续同类审计应把 CI 的每个 step 逐一在本地复演，而不是只跑 `package.json` 里列出的脚本名；该步骤已补进 §2 的实测表。

### 13.4 入口缺口的规范链归因（处置 F10-002 时查得）

用户报出的现象是"安装了 VSIX 但 .md 没有关联"。核对后确认这不是安装问题：manifest 的 `contributes` 在基线上只有 `commands` / `keybindings` / `configuration`，阅读器由 `createWebviewPanel` 承载且只能由命令触发，因此不存在任何文件级入口。

更值得注意的是规范链上的归因。对 `docs/*.md` 全文检索 `menus`、`customEditors`、`editor/context`、`上下文菜单`，结果是：**F10-001～F10-006 这组入口需求只在 PRD-001 的需求表里出现过一次，ARC-004（VS Code 扩展集成架构）、IMP-001（技术实现规范）、IMP-002（任务分解）、IMP-003（版本实施）均无任何对应设计条目或任务条目**。这解释了缺口为什么能一路穿过 M2～M7 未被发现，也是"计划遗漏"类问题在 DEFER-01（搜索被 §4.5 任务清单遗漏）之后的第二次复发。

建议的规范修订（本轮未执行，属文档治理范围）：

1. ARC-004 增设"贡献点与入口"小节，明确 `contributes.menus` / `keybindings` 的入口矩阵与 `when` 条件口径；
2. IMP-002 为 F10 域补 Story/Task 条目，并把"入口可达性"写进验收标准；
3. PRD-001 对 F10-004 给出决策：要么升为交付项并配 CustomEditorProvider 形态说明，要么在 §2.2 非目标附近显式声明"第一期不做默认打开方式"。

### 13.5 首屏空白的根因与验证层次（处置 V1.1.1 时查得）

用户在 V1.1.0 里第一次走通入口，看到的却是 `Waiting for document…` / `Open a Markdown file to start reading.`——占位文案来自 `apps/webview/src/app/ReadingCanvas.tsx:216`，说明面板已创建而 `document/load` 从未生效。诊断按排除法推进，四步都留下了证据：

1. **契约侧排除**：`DocumentSnapshot` 只有 `documentUri` / `languageId` / `version` / `text` 四个字段，与 `DocumentLoadPayloadSchema`（`.strict()`，第五个字段是 `preferences`）逐一对得上，webview 侧又用同一个 schema 解析，所以既不会抛也不会被静默拒绝；
2. **投递侧命中**：`WebviewManager.open()` 在 `panel.webview.html = ...` 之后同步 `void postMessage(...)`，而接收端的 `message` 监听器由 `App.tsx` 挂载后的第一个 effect 注册，中间还隔着 bundle 下载与执行；`void` 同时丢掉了 `postMessage` 返回的 `Thenable<boolean>`，连"未能投递"的信号都不看；
3. **握手侧命中**：`MessageType.ReaderReady` 两端都已实现（webview 挂载即发，host 已注册处理器），但 `handlers.ts` 的处理器是 `handle: () => null`，其注释写着"`document.load` 已在 `WebviewManager.open()` 里投递完毕，这里无需再做任何事"——这句假设正是缺陷本身；
4. **平台语义佐证**：VS Code API 对 `Webview.postMessage` 的返回值原文是"A response of true does not mean that the message was actually received by the webview. For example, no message listeners may be have been hooked up inside the webview … If you want confirm that a message as actually received, you can try having your webview posting a confirmation message back to your extension."——建议的补救手段就是我们已有却闲置的 ready 回执。

两点结论值得留下。其一是**修复形态**：把投递从"创建面板时发一次"改为"暂存 + ready 时发"，状态收进不依赖 `vscode` 的 `PendingDeliveries`，因此第一次可单测的恰恰是这条此前无法验证的协议；`open()` 保留当场校验，使超限文档依旧走错误提示（该校验在 `v1.1.1` 里发生于建面板之后，前移见 §13.6）。其二是**验证层次的自我认知**：`apps/extension` 的 coverage 表只列出不依赖 `vscode` 的模块，`webview-manager.ts` 所在的整层从未被统计，所以 95%+ 的 lines 与"该层零测试"并不矛盾——本报告的覆盖率结论应据此理解其边界（§2、§11 同）。第三类成因（DEFER-01 的任务遗漏、§13.4 的规范链零条目、本节的验证层次缺位）到此集齐，后续审计建议把"CI 每个 step 逐条复演"与"覆盖率报表的分母由哪些模块构成"列为固定检查项。

顺带修正一处本轮写下的文档措辞：`apps/extension/src/webview/pending-delivery.ts` 与 `handlers.ts` 的注释已按上述真实语义重写，不再保留"投递已在 `open()` 完成"的表述。

第三点结论来自用户侧：**已装上 `readora-1.1.1.vsix` 并确认正文正常渲染，不再停在 `Waiting for document…`**（2026-11-12）。上述四步排除法因此从"推断出的根因"升为"被真实宿主证实的根因"，本报告的 §4 里 F04/F05 首屏路径可据此视为已闭合；在 DEFER-06 的 E2E 补齐之前，这仍是全仓唯一一条拥有宿主实证的功能性结论。

### 13.6 护栏的可证伪性与一处事实更正（`v1.1.1` tag 之后）

用户选定"补 vscode stub 集成测试"之后，验证层次被拆成三段并各自落进可运行的检查：**协议与时序**（`__stubs__/vscode.ts` + `document-delivery.spec.ts` 17 用例）、**权限边界与 dispatcher**（`host-handlers.spec.ts` 16 用例）、**像素与真实宿主行为**（仍属 DEFER-06 的 E2E，未闭合）。

护栏本身按可证伪的标准验收，方法是变异检查——故意把它声称防住的缺陷写回去，看是否变红：

| 变异 | 期望 | 实测 |
|---|---|---|
| `stageForReady` 回退成当场 `deliverLoad` | 时序断言变红 | 4 例红，恢复后 17/17 绿 |
| `createResourceGateway.toWebviewUri` 直接返回磁盘 URI | 泄漏一条磁盘路径即变红 | 1 例红 |
| `LinkOpenerService.open` 跳过 `!decision.ok` 短路 | 三条拒绝用例变红 | 3 例红 |

三次变异都命中它要防的那个缺陷，说明护栏不是"跟着实现重写一遍断言"。写护栏过程中也留下两条替身建模的教训，值得给后续补测试的人：`onDidReceiveMessage` 属于 `Webview` 而非 `WebviewPanel`，放错位置会让 16 条用例以 `TypeError` 失败——那是替身的 bug 而不是产品的 bug；替身对未建模 API 必须选择"暴露"而不是"返回 undefined"，否则它会替产品吞掉本该暴露的错误。

覆盖率数字因此发生了一次口径变化，需要显式记录：extension 的 lines 从"只统计 7 个不依赖 `vscode` 的模块"的 95.62%，先跌到分母诚实后的 81.42%，再随两个集成 spec 补齐回到 **95.04%**。三个数字都高于阈值 80，但它们不是同一把尺子——只有后两个描述的是这一层被验证过的程度。`application.ts`、`extension.ts`、`document-service.ts`、`configuration-service.ts` 仍未被任何用例 import，因此依然不在表内。

一处事实更正：`CHANGELOG.md` 的 `[1.1.1]` 段原先写着"投递失败仍然早报……而不是留下一个空白面板"，而那个版本的校验实际发生在面板创建之后，因此这句描述超出了产物真实行为。把预校验移到 `open()` 顶部是 tag 之后的产品改动，已记入 `[Unreleased]`；已 tag 的段落只做就地更正、不 amend `95c76c4`，理由与 §13 开头那条自指细节相同——不改写已被命名对象引用的提交。

### 13.7 里程碑后的状态变化（M10 / M11）

本报告 §4.4 那行「F05-006 阅读器内上下文菜单｜未实现」在 M11（v0.11.0）后不再成立。
按文档自己的口径只在此登记，不回改 §2～§11 的原始判定：

| 项 | 处置 | 复核证据 |
|---|---|---|
| F05-006 阅读器内上下文菜单（P1）→ **首个实例** | 顶栏新增一枚 Export 下拉：`aria-haspopup="menu"` 触发器 + `role="menu"` 面板 + 三枚 `role="menuitem"`（HTML / PDF / PNG），键盘可达（方向键环、Esc 关闭、焦点归还触发器）、click-outside 判据与 Reader Settings 弹层同源；Host 侧另贡献两条 VS Code 上下文菜单（`editor/context` 与 `explorer/context` 各三条导出命令）。**这不等于正文区右键菜单**：在文档上右键弹出的那层阅读器自有菜单仍属未实现，本轮交付的是菜单形态与键盘可达性的首个实例 | `apps/webview/src/app/ExportMenu.tsx` 与其 14 条单测；`tests/e2e/export.spec.ts` 在真实 Chromium 里验证菜单键盘全程可达；`apps/extension/src/__tests__/manifest.spec.ts` 把「菜单条目只引用已注册命令」继续作为硬护栏 |
| F01-017 脚注（P1，本表同一条「未实现」）→ **已交付** | M10 实现脚注区与双向锚点跳转；本表 §4.4 首行「无 footnote 插件」的成因描述同时过期 | README「M10 · v0.10.0」小节与 `packages/markdown-core/src/__tests__/footnote.spec.ts`（19 条） |
| F06-005 PDF（P2）→ **仍不算交付** | M11 交的是「把当前文档导出为 PDF」，不是 PDF 附件预览。两者不同，因此本行维持原判定 | 本表上一行不动；README M11 的「未纳入」里点名区分 |

顺带登记一条规范缺口：ARC-004 §8.3 的权威消息表（当时 11 行）没有任何导出通道，而
「把已渲染的正文交给 Host 写盘」在本架构下只能是一来一回。M11 据此补设
`export.request` / `export.capture` / `export.data` 三条，并已把 ARC-004 升到 1.2.0
（表补齐到 17 条并逐条写推导依据）。这与 §13.4 那条「入口需求只在 PRD 层存在」是
同一类问题：规范缺位不会阻止实现，只会让实现自己临时定口径。

### 13.8 编辑模式立项（纯文档轮，未动代码）

用户提出「能做编辑模式吗」，选定**完整所见即所得**并明确要求**先改文档再实现**。本轮交付：

| 项 | 处置 | 根据 |
|---|---|---|
| 新增 ARC-009《编辑模式架构》 | 16 章 / Draft：双态分离、源行范围写回、宿主模型承载编辑生命周期、E0–E6 阶段、ADR-009-01～10 | 前置事实四条硬约束均逐条对到实现文件（含 `MarkdownContent.tsx` 的全量 `innerHTML` 重写与 `positionOf` 的 `endLine` 归一） |
| 需求立项 | PRD-001 1.1.0：§2.2 非目标边界对照表、§4 功能域 11→12、§5.12 F12（F12-001～010）、UC-005、§8 V1.4 节、新增 §12 修订记录 | §10.3「不随意增加一级功能域」需走变更评审，本轮逐项回应 |
| 受影响的既有架构条款 | ARC-002 1.3.0（§12.3 源位置身份契约）、ARC-004 1.3.0（§8.3 `document.edit` 17→18、§8.5 第 9 条、§9.4 写回、ADR-004-005）、ARC-008 1.4.0（§9.3.1、§14.5 六道硬约束、ADR-008-10/11） | 「`CustomReadonlyEditorProvider` 选型不变」是本轮最重要的否定性结论 |
| 实施层 | IMP-001 1.2.0、IMP-002 1.1.0（新增 §22 EPIC-13）、IMP-003 1.1.0（§8 V1.4.x） | EPIC-13 追加为 §22 而非插到 §17，因为重排会让本篇 §18/§21 的历史引用指错 |
| **代码未动** | F12 **仍未实现**。实现入口是 IMP-002 §22 与 ARC-009 §12，不是本轮任何一句描述 | 所以 §4 需求完成度表不得因本轮上调，F12 也不计入任何已交付版本 |

对 §13.2「文档治理回填（§6.2）」那一行的**部分**闭合（该整行仍未闭合，不移入 §13.1）：

- 已闭合：PRD-001 §10.4 后续文档表按仓库实际回填，两个从未存在的 TSD-001 / TSD-002 已标明去向；IMP-002 §21 的「IMP-003 待编写」已更正；IMP-001 / IMP-002 状态字段转 Final。
- 仍未闭合：111 项 `- [ ]` 清单零回填（本轮新增的 IMP-002 §22 也没启用 §2.4 的 Story 五态，该治理项不得因为本轮而显得已动）、F08-003 优先级冲突、PRD-001／002／003 与 ARC-009 仍为 Draft。

另登记两条原报告 §6 清单之外的新发现（均非本轮引入）：IMP-001 §11.2 的响应字段写 `data` 而实现是 `payload`；§11.3 那张 10 行冒号命名草案表已与 `MESSAGE_REGISTRY` 全部分叉。两处均改为指向 ARC-004 §8.3 而不是拄一份新名单 —— 两处名单必然再分叉。

一条方法上的自我修正：本轮曾在 IMP-003 写明「IMP-001 §4.2 / §8.4 已同步修订」，实测推翻 —— §4.2 的 markdown-core 运行环境本就是 Webview（渲染管线不在 Host），§8.4 本就允许净化后的 `innerHTML`。两句都是错的印象，IMP-003 已更正。教训：列「受影响条款」必须逐条读原文，**未需要改动的项也要说清**。

---

**文档结束**

**版本：1.0.0**
**状态：Final**
