/**
 * diagram-core 内部契约（ARC-003 §4.2 / IMP-001 §9.2）。
 *
 * 这一组类型是产品内部抽象，业务侧（webview）只见 DiagramEngine / MountedDiagram，
 * 不感知 Pele 的真实签名（ADR-003-002：Pele 只能经 Adapter 使用）。
 */

/** 图表实例生命周期状态（ARC-003 §6.2 / §6.3）。 */
export type DiagramState =
  | "created"
  | "mounting"
  | "rendered"
  | "updating"
  | "failed"
  | "destroyed";

/** 文本度量注入点：测试环境无浏览器排版，度量必须由外部提供（Pele RenderOptions 对齐）。 */
export interface DiagramTextMeasurer {
  width(text: string, size: number, style: number): number;
}

export interface DiagramRenderOptions {
  /** 文本度量器；Webview 侧留空由引擎默认实现，测试侧注入假实现。 */
  measurer?: DiagramTextMeasurer;
  maxWidth?: number;
  fontSize?: number;
  fontFamily?: string;
  /** SVG 内部 id 前缀；同页多图必须各不相同，否则 id 互相打架。 */
  idPrefix?: string;
}

export interface DiagramRenderResult {
  svg: string;
  width: number;
  height: number;
  /** 引擎识别出的图表类型（如 flowchart）。 */
  type: string;
}

export interface DiagramMountOptions extends DiagramRenderOptions {
  zoom?: boolean | "auto";
  /** SVG 插入前处理；返回 null 表示安全处理失败，必须走错误态而非未验证插入。 */
  sanitize?: (svg: string) => Node | null;
  onError?: (error: DiagramError) => void;
}

/**
 * 图表缩放控制（ARC-003 §7.3、F04-031/032）。
 *
 * 工具栏按钮不自己算 transform：缩放能力归引擎，产品侧只转发指令，
 * 引擎未接管（未溢出 / 已销毁）时全部退化为空操作，不抛错。
 */
export interface DiagramZoomControls {
  readonly available: boolean;
  readonly scale: number;
  /** 相对当前倍率缩放，> 1 放大、< 1 缩小。 */
  zoomBy(factor: number): void;
  /** 适应窗口：回到「整图可见」的基准倍率。 */
  fit(): void;
  /** 复位为 1:1（一个图纸单位 = 一个 CSS 像素）：比容器宽的图会溢出，靠拖动看局部。 */
  reset(): void;
}

export interface MountedDiagram {
  readonly state: DiagramState;
  /** 最近一次失败的结构化成因；成功为 undefined（exactOptionalPropertyTypes 下显式建模）。 */
  readonly error: DiagramError | undefined;
  readonly zoom: DiagramZoomControls;
  update(source: string, options?: DiagramMountOptions): void;
  refresh(): void;
  destroy(): void;
}

export interface DiagramInspection {
  /** 引擎能否识别该源码对应的图表类型。 */
  readonly detectedType: string | null;
  /** 该类型是否已在本产品注册集内（未注册 = 不启用，走降级而非崩溃）。 */
  readonly registered: boolean;
}

export interface DiagramEngine {
  readonly id: string;
  /** 引擎版本，参与缓存键（ARC-003 §11.3）。 */
  readonly version: string;
  supports(source: string): boolean;
  inspect(source: string): DiagramInspection;
  render(source: string, options?: DiagramRenderOptions): Promise<DiagramRenderResult>;
  mount(container: HTMLElement, source: string, options?: DiagramMountOptions): MountedDiagram;
}

/** 错误分类（ARC-003 §10.1）。 */
export type DiagramErrorKind =
  | "syntax"
  | "unsupported"
  | "over-limit"
  | "security"
  | "layout"
  | "resource"
  | "runtime";

export interface DiagramError {
  kind: DiagramErrorKind;
  /** 面向用户的简短说明，不含异常堆栈（ARC-003 §10.2）。 */
  message: string;
  /** 诊断码覆盖点：同一 kind 下需要区分成因时使用（如「类型未启用」）。 */
  code?: string;
  source?: { line?: number; column?: number };
}

/** 图表诊断（ARC-003 §10.3）。 */
export interface DiagramDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  source?: { line?: number; column?: number };
}
