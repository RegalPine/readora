/**
 * @readora/diagram-core 公共门面（IMP-001 §9.3、ARC-003 §4.1）。
 *
 * 门面只暴露产品契约：引擎工厂、能力判定、SVG 安全处理、主题映射与安全限额。
 * Pele 的 mount / render / register 与任何 pele 原始符号一律不在此出现，
 * 于是「业务代码不感知第三方引擎」由导出面 + eslint no-restricted-imports 双重保证。
 */

// 常量与错误码先行：webview 侧只按常量做输入闸门，不必接触引擎。
export {
  ALLOWED_IMAGE_SCHEMES,
  ALLOWED_LINK_SCHEMES,
  DIAGRAM_ID_PREFIX,
  DIAGRAM_LINK_REL,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_SOURCE_CHARACTERS,
  MAX_SVG_OUTPUT_CHARACTERS,
  OVER_LIMIT_MESSAGE
} from "./limits";
export {
  DIAGRAM_ERROR_CODES,
  DiagramLimitError,
  DiagramNotRegisteredError,
  DiagramRenderError,
  DiagramSecurityError,
  toDiagramDiagnostic,
  toDiagramError
} from "./errors";
export type { DiagramErrorCode } from "./errors";
export { capabilityError, resolveCapability } from "./capability";
export type {
  DiagramCapability,
  DiagramCapabilityProbe,
  DiagramCapabilityStatus
} from "./capability";
export { sanitizeSvgDetailed, sanitizeSvgToNode } from "./svg-sanitizer";
export type { SvgSanitizeReason, SvgSanitizationOutcome } from "./svg-sanitizer";
export { PELE_SERIES_VARIABLES, PELE_TOKEN_MAP } from "./theme";
export type { PeleTokenMapping } from "./theme";
export { REGISTERED_DIAGRAM_TYPES, isDiagramTypeRegistered } from "./engines/pele/registry";
// Adapter 本身不进门面：调用方只能经 createDiagramEngine 拿到引擎（ADR-003-002）。
export { DIAGRAM_ENGINE_ID, createDiagramEngine } from "./engine";
export type { DiagramEngineKind } from "./engine";

export type {
  DiagramDiagnostic,
  DiagramEngine,
  DiagramError,
  DiagramErrorKind,
  DiagramInspection,
  DiagramMountOptions,
  DiagramRenderOptions,
  DiagramRenderResult,
  DiagramState,
  DiagramTextMeasurer,
  DiagramZoomControls,
  MountedDiagram
} from "./types";
