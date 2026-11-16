# Pele 图表夹具（STORY-05-01 / 05-02，IMP-001 §9.4）

本文件是 Pele 全部 33 类图表源码的**唯一来源**：`packages/diagram-core` 的兼容测试逐节解析它，
浏览器 harness 直接把它当文档加载。夹具与单测各写一套源码的话，
「测过的类型」和「看得见的类型」迟早会分叉。

约定（解析规则见 `src/__tests__/fixture-source.ts`）：

- 二级标题即用例 id；不带点的是**已注册类型**，必须出图；
- `invalid.<name>` 必须落到错误态；全部内置类型都必须通过渲染和 SVG 安全检查；
- 每节只取第一个围栏块，语言必须是 `mermaid`；
- 每类源码都刻意混入中文、长文本、特殊字符（`< > & 「」 ()`）与大节点，避免只测最顺利路径。

超长样本（> 50 000 字符）由 `node scripts/gen-fixture-assets.mjs` 生成到
`tests/fixtures/diagrams-over-limit.md`：那是一段机器拼出来的规则文本，
塞进本文件只会让人读不动，所以单独成文。

## flowchart

```mermaid
flowchart TD
  A[这是一段用来压测布局的中文长文本，包含（括号）、逗号、引号「」与尖括号 <> 以及 & 符号] --> B{是否继续?}
  B -->|是| C[结束节点]
  B -->|否| A
  C --> D["这是一段用来压测布局的中文长文本，包含（括号）、逗号、引号「」与尖括号 <> 以及 & 符号 尾部"]
  subgraph 分组一 [含空格的分组]
    E[E1] --> F[F2]
  end
```

## sequence

```mermaid
sequenceDiagram
  participant U as 用户界面
  participant S as 服务端 API
  U->>S: 提交请求（这是一段用来压测布局的中文长文本，包含（括号）、逗号、引号「」与尖括号 <> 以及 & 符号）
  S-->>U: 返回结果
  activate S
  S->>S: 内部处理 & 校验
  deactivate S
  Note over U,S: 备注：中文 + <尖括号>
```

## class

```mermaid
classDiagram
  class 用户服务 {
    +String 姓名
    +登录(密码 String) Boolean
    +注销() void
  }
  class 管理员服务 {
    +审核() Boolean
  }
  用户服务 <|-- 管理员服务 : 继承关系
  用户服务 "1" --> "*" 订单 : 持有
```

## state

```mermaid
stateDiagram-v2
  [*] --> 待审核
  待审核 --> 已通过 : 审核通过 & 盖章
  待审核 --> 已驳回 : 驳回
  已通过 --> [*]
  note right of 待审核 : 这是一段用来压测布局的中文长文本，包含（括号）、逗号、引号「」与尖括号 <> 以及 & 符号
  state 复合状态 {
    [*] --> 子状态
    子状态 --> [*]
  }
```

## er

```mermaid
erDiagram
  用户 ||--o{ 订单 : 下单
  订单 ||--|{ 订单项 : 包含
  用户 {
    string 姓名
    string 邮箱 "这是一段用来压测布局的中"
  }
  订单 {
    int 编号
    string 备注 "可含中文"
  }
```

## gantt

```mermaid
gantt
  title 项目排期（这是一段用来压测布局的中文长文本，包含（括号）、逗号、引号「」与尖括号 <> 以及 & 符号）
  dateFormat YYYY-MM-DD
  axisFormat %m-%d
  section 阶段一 设计
    需求评审 :done, a1, 2024-01-01, 3d
    视觉稿 :active, a2, after a1, 4d
  section 阶段二 交付
    联调测试 :crit, a3, after a2, 5d
    里程碑 :milestone, a4, after a3, 0d
```

## pie

```mermaid
pie showData
  title 各语言占比（这是一段用来压测布局的中文长文本，包含（括号）、逗号、引号「」与尖括号 <> 以及 & 符号）
  "简体中文" : 42
  "English (US)" : 30
  "日本語 & 特殊 % 字符" : 28
```

## gitGraph

```mermaid
gitGraph
  commit
  branch feature-A
  checkout feature-A
  commit
  commit id: "这是一段用来压测布局"
  checkout main
  commit
  merge feature-A tag: "发布v1"
  commit type: HIGHLIGHT id: "关键点"
```

Pele 的 gitGraph 分支名走独立词法，中文分支名会被拒——这是引擎限制，
写在夹具里是为了让「退化到 ASCII 分支名」这个决定留下痕迹（README 已登记）。

## mindmap

```mermaid
mindmap
  root((中文根节点))
    分支一
      子项 A
      子项 B
    分支二 含空格
    这是一段用来压测布局的中文长文本，包含（括号）、
    ::icon(fa fa-book)
```

## timeline

```mermaid
timeline
  title 历史沿革（这是一段用来压测布局的中文长文本，包含（）
  2020 : 成立 : 首个版本
  2021 : 发布 A, B
  2022 : 扩展海外市场
  2023-2024 : 重构与规模化
```

## requirement

```mermaid
requirementDiagram
  requirement Req001 {
    id: REQ001
    text: "这是一段用来压测布局的中文长文本，包含（括号）、逗号、引号「」与尖括号 <> 以及 & 符号"
    risk: high
    verifymethod: test
  }
  functionalRequirement Perf001 {
    id: PERF001
    text: "性能目标：首屏 1 秒内"
    risk: medium
    verifymethod: analysis
  }
  element FrontModule {
    type: "WebUI"
  }
  FrontModule - satisfies -> Req001
  FrontModule - verifies -> Perf001
```

requirement 的名称与 id 只接受 ASCII 标识符，中文说明必须写成引号串（引擎词法限制）。

## quadrantChart

```mermaid
quadrantChart
  title 优先级矩阵（中文坐标）
  x-axis 低成本 --> 高成本
  y-axis 低影响 --> 高影响
  quadrant-1 立即执行
  quadrant-2 重点评估
  quadrant-3 暂缓
  quadrant-4 备选
  任务A: [0.3, 0.6]
  任务B: [0.75, 0.85]
  这是一段用来压测: [0.2, 0.1]
```

## sankey

```mermaid
sankey-beta
  流量来源,落地页,1000
  落地页,注册流程,600
  落地页,跳出,400
  注册流程,付费转化,250
  注册流程,留存观察,350
```

## xychart

```mermaid
xychart-beta
  title "月度销量（这是一段用来压测布局的中文长文本，包含（括号）"
  x-axis ["一月", "二月", "三月", "四月"]
  y-axis "销量 / 件" 0 --> 100
  bar [30, 60, 45, 80]
  line [30, 60, 45, 80]
```

## agentflow
```mermaid
agentflow-beta TB
  User[Reader] --> Agent[Assistant]
```

## architecture
```mermaid
architecture-beta
  service api(server)[API]
  service db(database)[DB]
  db:R --> L:api
```

## block
```mermaid
block-beta
  columns 2
  A["Reader"]
  B["Renderer"]
```

## c4
```mermaid
C4Context
  Person(user, "Reader")
  System(app, "Readora")
  Rel(user, app, "reads")
```

## cynefin
```mermaid
cynefin-beta
```

## eventmodeling
```mermaid
eventmodeling
```

## ishikawa
```mermaid
ishikawa-beta
  延迟交付
    流程
      审核耗时
    人员
      资源不足
```

## info
```mermaid
info
```

## journey
```mermaid
journey
  title Reader journey
  section Reading
    Open document: 5: Reader
```

## kanban
```mermaid
kanban
  Todo
    task1[Read]
  Done
    task2[Finish]
```

## packet
```mermaid
packet-beta
  0-7: "magic"
  8-15: "length"
```

## radar
```mermaid
radar-beta
  axis Ease,Speed,Quality
  curve Current{3,4,5}
```

## railroad
```mermaid
railroad-ebnf-beta
  entry = "start" "end" ;
```

## swimlane
```mermaid
swimlane-beta
```

## treemap
```mermaid
treemap-beta
  "Root"
    "Docs": 2
```

## treeView
```mermaid
treeView-beta
  Readora/
    docs/
      guide.md
```

## usecase
```mermaid
usecase-beta
  actor Reader("Reader")
  Read("Read document")
  Reader --> Read
```

## venn
```mermaid
venn-beta
```

## wardley
```mermaid
wardley-beta
```

## invalid.syntax

```mermaid
graph TD
  A[开始 --> B[结束]
```

节点标签的中括号没闭合：Pele 报 syntax，挂载层出错误卡，同一篇里其它图表照常渲染（局部降级）。

## invalid.unknown-syntax

```mermaid
这不是图表源码，也没有任何可识别的类型关键字。
```

识别不出类型 → `unknown-syntax`，同样走错误卡，不炸整篇。
