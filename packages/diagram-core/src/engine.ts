/**
 * 图表引擎工厂（ARC-003 §4.1、ADR-003-002）。
 *
 * Webview 拿到的是 DiagramEngine，不是 Pele Adapter：
 * 「Pele 只能经 Adapter 使用」的下一层保障是「Adapter 只能经工厂使用」，
 * 将来替换或增加降级引擎时只改这一处映射，调用方签名不变。
 */
import { createPeleAdapter, type PeleAdapterOptions } from "./engines/pele/pele-adapter";
import type { DiagramEngine } from "./types";

/** 当前唯一实现；保留字面量常量供测试与文档引用。 */
export const DIAGRAM_ENGINE_ID = "pele" as const;

export type DiagramEngineKind = typeof DIAGRAM_ENGINE_ID;

export function createDiagramEngine(options: PeleAdapterOptions = {}): DiagramEngine {
  return createPeleAdapter(options);
}
