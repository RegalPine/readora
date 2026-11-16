/**
 * Pele 注册表（IMP-002 TASK-05-02-02、ARC-003 §5.1）。
 *
 * 本产品不用 Pele 的全量入口，也不用它的 lazy 入口：
 * - 全量入口会引入 Pele 聚合层与额外入口代码；
 * - lazy 入口依赖动态 import，而 Webview 的 CSP 是 `script-src 'nonce-...'`
 *   且 `connect-src 'none'`，动态片段在真实面板里不可靠。
 * 因此这里显式登记每个独立图表入口，避免引入 Pele 聚合入口。
 */
import { register, registered } from "pele/core";
import type { DiagramType } from "pele/core";

import erDiagram from "pele/diagrams/er";
import agentflowDiagram from "pele/diagrams/agentflow";
import architectureDiagram from "pele/diagrams/architecture";
import blockDiagram from "pele/diagrams/block";
import c4Diagram from "pele/diagrams/c4";
import cynefinDiagram from "pele/diagrams/cynefin";
import eventmodelingDiagram from "pele/diagrams/eventmodeling";
import flowchartDiagram from "pele/diagrams/flowchart";
import ganttDiagram from "pele/diagrams/gantt";
import infoDiagram from "pele/diagrams/info";
import gitGraphDiagram from "pele/diagrams/gitGraph";
import ishikawaDiagram from "pele/diagrams/ishikawa";
import journeyDiagram from "pele/diagrams/journey";
import kanbanDiagram from "pele/diagrams/kanban";
import classDiagram from "pele/diagrams/class";
import mindmapDiagram from "pele/diagrams/mindmap";
import packetDiagram from "pele/diagrams/packet";
import pieDiagram from "pele/diagrams/pie";
import quadrantChartDiagram from "pele/diagrams/quadrantChart";
import radarDiagram from "pele/diagrams/radar";
import railroadDiagram from "pele/diagrams/railroad";
import requirementDiagram from "pele/diagrams/requirement";
import sankeyDiagram from "pele/diagrams/sankey";
import sequenceDiagram from "pele/diagrams/sequence";
import stateDiagram from "pele/diagrams/state";
import swimlaneDiagram from "pele/diagrams/swimlane";
import timelineDiagram from "pele/diagrams/timeline";
import treemapDiagram from "pele/diagrams/treemap";
import treeViewDiagram from "pele/diagrams/treeView";
import usecaseDiagram from "pele/diagrams/usecase";
import vennDiagram from "pele/diagrams/venn";
import wardleyDiagram from "pele/diagrams/wardley";
import xychartDiagram from "pele/diagrams/xychart";

/** 锁定版本（IMP-001 §3.3「Pele = 锁定验证版本」）；与 node_modules 的一致性由测试守护。 */
export const PELE_LOCKED_VERSION = "1.13.0";

/** 当前 Pele 版本的内置图表类型清单；兼容夹具与此清单逐项对应。 */
export const REGISTERED_DIAGRAM_TYPES: readonly string[] = [
  "agentflow",
  "architecture",
  "block",
  "c4",
  "cynefin",
  "eventmodeling",
  "flowchart",
  "sequence",
  "class",
  "state",
  "er",
  "gantt",
  "info",
  "ishikawa",
  "journey",
  "kanban",
  "pie",
  "gitGraph",
  "mindmap",
  "packet",
  "radar",
  "railroad",
  "timeline",
  "requirement",
  "quadrantChart",
  "sankey",
  "swimlane",
  "treemap",
  "treeView",
  "usecase",
  "venn",
  "wardley",
  "xychart"
];

const DIAGRAMS = [
  agentflowDiagram,
  architectureDiagram,
  blockDiagram,
  c4Diagram,
  cynefinDiagram,
  eventmodelingDiagram,
  flowchartDiagram,
  sequenceDiagram,
  classDiagram,
  stateDiagram,
  erDiagram,
  ganttDiagram,
  infoDiagram,
  ishikawaDiagram,
  journeyDiagram,
  kanbanDiagram,
  packetDiagram,
  pieDiagram,
  radarDiagram,
  railroadDiagram,
  gitGraphDiagram,
  mindmapDiagram,
  timelineDiagram,
  requirementDiagram,
  quadrantChartDiagram,
  sankeyDiagram,
  swimlaneDiagram,
  treemapDiagram,
  treeViewDiagram,
  usecaseDiagram,
  vennDiagram,
  wardleyDiagram,
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
