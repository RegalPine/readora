/**
 * 图表能力判定（ARC-003 §4.3 / §5.1 / §5.4）。
 *
 * 「不要通过简单正则表达式作为唯一兼容性判断依据」：本模块不自己猜类型，
 * 判定全部委托给注入的引擎能力探针（真实实现取 Pele 的 detectType / registered），
 * 产品只在其前面加一道输入规模闸门。
 */
import { DIAGRAM_ERROR_CODES } from "./errors";
import { MAX_DIAGRAM_SOURCE_CHARACTERS, OVER_LIMIT_MESSAGE } from "./limits";
import type { DiagramError } from "./types";

export type DiagramCapabilityStatus =
  | "ready"
  | "over-limit"
  | "unknown-syntax"
  | "type-not-registered";

export interface DiagramCapabilityProbe {
  /** 引擎能否识别源码对应的图表类型（不做语法解析）。 */
  detectType(source: string): string | null;
  /** 该类型是否在当前注册集内。 */
  isRegistered(type: string): boolean;
}

export interface DiagramCapability {
  status: DiagramCapabilityStatus;
  diagramType: string | null;
  sourceLength: number;
}

export function resolveCapability(
  source: string,
  probe: DiagramCapabilityProbe
): DiagramCapability {
  const sourceLength = source.length;
  // 先闸门后解析：超限源码根本不该送进引擎（F04-058 资源耗尽防护）。
  if (sourceLength > MAX_DIAGRAM_SOURCE_CHARACTERS) {
    return { status: "over-limit", diagramType: null, sourceLength };
  }
  const diagramType = probe.detectType(source.trim());
  if (diagramType === null) {
    return { status: "unknown-syntax", diagramType: null, sourceLength };
  }
  if (!probe.isRegistered(diagramType)) {
    return { status: "type-not-registered", diagramType, sourceLength };
  }
  return { status: "ready", diagramType, sourceLength };
}

/** 非 ready 时给出可直接展示的错误；ready 返回 null（ARC-003 §5.4 显示源码 + 提示）。 */
export function capabilityError(capability: DiagramCapability): DiagramError | null {
  switch (capability.status) {
    case "ready":
      return null;
    case "over-limit":
      return { kind: "over-limit", code: DIAGRAM_ERROR_CODES.OVER_LIMIT, message: OVER_LIMIT_MESSAGE };
    case "unknown-syntax":
      return {
        kind: "unsupported",
        code: DIAGRAM_ERROR_CODES.UNSUPPORTED,
        message: "Not recognized as a supported diagram type."
      };
    case "type-not-registered":
      return {
        kind: "unsupported",
        code: DIAGRAM_ERROR_CODES.NOT_REGISTERED,
        message: `Diagram type "${capability.diagramType ?? "unknown"}" is not enabled in this reader.`
      };
  }
}
