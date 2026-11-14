/**
 * Pele 注册表（IMP-002 TASK-05-02-02、ARC-003 §5.1）。
 *
 * 本产品不用 Pele 的全量入口，也不用它的 lazy 入口：
 * - 全量入口把 33 类图表打进 Webview 包，违背 F11-001 包体约束；
 * - lazy 入口依赖动态 import，而 Webview 的 CSP 是 `script-src 'nonce-...'`
 *   且 `connect-src 'none'`，动态片段在真实面板里不可靠。
 * 因此这里显式登记 IMP-001 §9.4 的兼容性清单（含全部 P0 类型），
 * 其余类型按 ARC-003 §5.4 显示源码 + 未启用提示，不影响其它图表。
 */
import { register, registered } from "pele/core";
import type { DiagramType } from "pele/core";

import erDiagram from "pele/diagrams/er";
import flowchartDiagram from "pele/diagrams/flowchart";
import ganttDiagram from "pele/diagrams/gantt";
import gitGraphDiagram from "pele/diagrams/gitGraph";
import classDiagram from "pele/diagrams/class";
import mindmapDiagram from "pele/diagrams/mindmap";
import pieDiagram from "pele/diagrams/pie";
import quadrantChartDiagram from "pele/diagrams/quadrantChart";
import requirementDiagram from "pele/diagrams/requirement";
import sankeyDiagram from "pele/diagrams/sankey";
import sequenceDiagram from "pele/diagrams/sequence";
import stateDiagram from "pele/diagrams/state";
import timelineDiagram from "pele/diagrams/timeline";
import xychartDiagram from "pele/diagrams/xychart";

/** 锁定版本（IMP-001 §3.3「Pele = 锁定验证版本」）；与 node_modules 的一致性由测试守护。 */
export const PELE_LOCKED_VERSION = "1.13.0";

/** 已启用类型清单，与 IMP-001 §9.4 的兼容性测试清单一一对应。 */
export const REGISTERED_DIAGRAM_TYPES: readonly string[] = [
  "flowchart",
  "sequence",
  "class",
  "state",
  "er",
  "gantt",
  "pie",
  "gitGraph",
  "mindmap",
  "timeline",
  "requirement",
  "quadrantChart",
  "sankey",
  "xychart"
];

const DIAGRAMS = [
  flowchartDiagram,
  sequenceDiagram,
  classDiagram,
  stateDiagram,
  erDiagram,
  ganttDiagram,
  pieDiagram,
  gitGraphDiagram,
  mindmapDiagram,
  timelineDiagram,
  requirementDiagram,
  quadrantChartDiagram,
  sankeyDiagram,
  xychartDiagram
];

let installed = false;

/** 幂等注册：多次调用不会重复登记引擎模块。 */
export function registerPeleDiagrams(): void {
  if (installed) {
    return;
  }
  register(...DIAGRAMS);
  installed = true;
}

export function isDiagramTypeRegistered(type: string): boolean {
  return registered(type as DiagramType);
}
