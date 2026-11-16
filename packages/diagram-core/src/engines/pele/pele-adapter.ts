/**
 * Pele Adapter（IMP-002 TASK-05-02-01/04、ARC-003 §4.2 / §6.2、IMP-001 §9.3）。
 *
 * 本文件是 diagram-core 内唯一 import "pele/core" 的实现：Pele 的真实签名
 * （RenderOptions / Mounted / PeleError）到此为止，对外只暴露 DiagramEngine 契约。
 * 这样做的收益不只是「换引擎成本低」，更重要的是其余模块可以脱离 Pele 独立单测。
 *
 * 两条来自阶段 0 冒烟的实测结论已经固化进实现：
 * 1. render() 在 jsdom 下完全可用（兼容测试留在 vitest）；
 * 2. mount() 在容器宽度为 0 时会推迟出图（真实浏览器有宽度才同步产出），
 *    且 Pele 的 destroy() 不清空容器 DOM —— 所以容器清理由本 Adapter 负责。
 */
import {
  detectType as peleDetectType,
  mount as peleMount,
  render as peleRender,
  supports as peleSupports,
  type MountOptions,
  type Mounted,
  type RenderOptions,
  type ZoomOptions
} from "pele/core";

import { capabilityError, resolveCapability } from "../../capability";
import { diagramCacheKey, createDiagramCache, type DiagramCache } from "../../cache";
import { DiagramRenderError, DiagramSecurityError, toDiagramError } from "../../errors";
import {
  ALLOWED_IMAGE_SCHEMES,
  ALLOWED_LINK_SCHEMES,
  DIAGRAM_ID_PREFIX,
  DIAGRAM_LINK_REL,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_SOURCE_CHARACTERS,
  MAX_SVG_OUTPUT_CHARACTERS
} from "../../limits";
import { sanitizeSvgToNode } from "../../svg-sanitizer";
import type {
  DiagramEngine,
  DiagramError,
  DiagramInspection,
  DiagramMountOptions,
  DiagramRenderOptions,
  DiagramRenderResult,
  DiagramState,
  DiagramZoomControls,
  MountedDiagram
} from "../../types";
import {
  isDiagramTypeRegistered,
  PELE_LOCKED_VERSION,
  registerPeleDiagrams
} from "./registry";

/** 交给引擎的安全闸门：scheme 白名单为空即「图表里不该出现任何外部引用」。 */
const ENGINE_GUARDS: Pick<
  RenderOptions,
  "limit" | "outputLimit" | "maxEdges" | "linkSchemes" | "imageSchemes" | "linkRel"
> = {
  limit: MAX_DIAGRAM_SOURCE_CHARACTERS,
  outputLimit: MAX_SVG_OUTPUT_CHARACTERS,
  maxEdges: MAX_DIAGRAM_EDGES,
  linkSchemes: [...ALLOWED_LINK_SCHEMES],
  imageSchemes: [...ALLOWED_IMAGE_SCHEMES],
  linkRel: DIAGRAM_LINK_REL
};

export interface PeleAdapterOptions {
  /** 默认可读字号与字族；Webview 不传，交给引擎按容器计算。 */
  readonly fontSize?: number;
  readonly fontFamily?: string;
  /** render() 结果缓存容量（ARC-003 §11.3）；传 0 关闭缓存。 */
  readonly cacheCapacity?: number;
}

/**
 * 产品契约的 `boolean | "auto"` → Pele 的 zoom 选项。
 *
 * `controls: false` 是唯一的目的：Pele 那组浮在画布右上角的缩放按钮会给 svg 写下
 * `max-width` + `margin-right` 给自己让位（实测吃掉 42px 栏宽，宽图从此钉死在左边），
 * 而 zoom-in / out / fit / reset 本就归图表工具栏（ARC-003 §7.3 偏差 D-5）。
 * 拖动 / 滚轮 / 双击这些隐式交互照旧由 Pele 接管，`false` 仍表示完全不启用。
 */
function toPeleZoom(zoom: boolean | "auto"): ZoomOptions | false {
  return zoom === false ? false : { always: zoom === true, controls: false };
}

/** 可选字段逐项判定：exactOptionalPropertyTypes 下不能把 undefined 显式写进选项。 */
function toRenderOptions(
  options: DiagramRenderOptions | undefined,
  defaults: PeleAdapterOptions
): RenderOptions {
  let next: RenderOptions = {
    ...ENGINE_GUARDS,
    responsive: true,
    idPrefix: DIAGRAM_ID_PREFIX
  };
  const overrides: (keyof DiagramRenderOptions)[] = [
    "maxWidth",
    "fontSize",
    "fontFamily",
    "idPrefix",
    "measurer"
  ];
  if (defaults.fontFamily !== undefined) {
    next = { ...next, fontFamily: defaults.fontFamily };
  }
  if (defaults.fontSize !== undefined) {
    next = { ...next, fontSize: defaults.fontSize };
  }
  for (const key of overrides) {
    // measurer 两侧结构一致（width(text, size, style)），产品契约不复制 Pele 的类型。
    const value = options?.[key];
    if (value !== undefined) {
      next = { ...next, [key]: value };
    }
  }
  return next;
}

/**
 * Sanitize 桥接：Pele 要求返回 Node，产品的安全处理失败时返回 null。
 * 此处把 null 变成 DiagramSecurityError 抛出，让上层进入错误态而不是插入未验证 SVG。
 */
function wrapSanitize(
  sanitize: ((svg: string) => Node | null) | undefined
): (svg: string) => Node {
  const handle = sanitize ?? sanitizeSvgToNode;
  return (svg: string): Node => {
    const node = handle(svg);
    if (!node) {
      throw new DiagramSecurityError(
        "Diagram output failed safety processing and was not inserted."
      );
    }
    return node;
  };
}

class PeleZoomControls implements DiagramZoomControls {
  constructor(private readonly read: () => Mounted | undefined) {}

  get available(): boolean {
    return this.read()?.zoom !== undefined;
  }

  get scale(): number {
    return this.read()?.zoom?.scale ?? 1;
  }

  zoomBy(factor: number): void {
    this.read()?.zoom?.zoomBy(factor);
  }

  fit(): void {
    const zoom = this.read()?.zoom;
    if (zoom) {
      zoom.zoomTo(zoom.fit);
    }
  }

  /**
   * 「1:1」= 一个图纸单位对一个 CSS 像素，不调引擎的 reset()。
   *
   * 引擎的未缩放态由 CSS 决定，而我们的 svg 带 `max-width: 100%`（components.css
   * 那条居中规则），于是**比栏宽的图在未缩放态下已经就是 Fit**：实测 1159×64 的图
   * 落在 754px 栏里，Fit 与 1:1 点出来的 viewBox 同为 `0 0 1159 64`、元素盒同为
   * 754×41.6 —— 两个按钮做同一件事，正是用户问「1:1 与 fit 有什么区别」的出处。
   * `zoomTo(1)` 让宽图回到真 100%（超出栏宽的部分由引擎的拖动查看，Fit 一键回来）；
   * 比栏窄的图 fit 本来就是 1，引擎按区间下限夹回未缩放态 —— 那时两者确实同义。
   */
  reset(): void {
    this.read()?.zoom?.zoomTo(1);
  }
}

class PeleMountedDiagram implements MountedDiagram {
  private inner: Mounted | undefined;
  private currentSource: string;
  private currentOptions: DiagramMountOptions | undefined;
  private currentState: DiagramState = "created";
  private currentError: DiagramError | undefined;
  private destroyed = false;

  readonly zoom: DiagramZoomControls;

  constructor(
    private readonly container: HTMLElement,
    source: string,
    options: DiagramMountOptions | undefined,
    private readonly renderOptions: (options: DiagramRenderOptions | undefined) => RenderOptions,
    /** 能力闸门：非 ready 的源码一律不交给引擎（ARC-003 §5.4 局部降级）。 */
    private readonly guard: (source: string) => DiagramError | null
  ) {
    this.currentSource = source;
    this.currentOptions = options;
    this.zoom = new PeleZoomControls(() => this.inner);
  }

  get state(): DiagramState {
    return this.currentState;
  }

  get error(): DiagramError | undefined {
    return this.currentError;
  }

  /** Pele 把引擎内部异常收在 mounted.error 上，同时回调 onError；两处都要归档。 */
  private absorb(raw: unknown): DiagramError {
    const error = toDiagramError(raw);
    this.currentError = error;
    this.currentState = "failed";
    this.currentOptions?.onError?.(error);
    return error;
  }

  private succeed(): void {
    this.currentError = undefined;
    // 容器宽度为 0（离屏 / jsdom）时 Pele 推迟出图，等 refresh() 再判定。
    this.currentState = this.inner?.result === undefined ? "mounting" : "rendered";
  }

  private mountOptions(): MountOptions {
    const options = this.currentOptions;
    // DiagramMountOptions 继承 DiagramRenderOptions，多余字段由 toRenderOptions 逐项筛掉。
    return {
      ...this.renderOptions(options),
      // zoom: "auto" 让 Pele 在溢出时才接管拖动 / 滚轮 / 双击（ARC-003 §7.3 D-5）。
      zoom: toPeleZoom(options?.zoom ?? "auto"),
      sanitize: wrapSanitize(options?.sanitize),
      onError: (raw: unknown): void => {
        this.absorb(raw);
      }
    };
  }

  /** 先闸门后解析：超限 / 未注册 / 无法识别都不该占用引擎。 */
  private gate(source: string): boolean {
    const failure = this.guard(source);
    if (!failure) {
      return true;
    }
    this.currentError = failure;
    this.currentState = "failed";
    this.container.replaceChildren();
    this.currentOptions?.onError?.(failure);
    return false;
  }

  mountNow(): void {
    if (this.destroyed) {
      return;
    }
    if (!this.gate(this.currentSource)) {
      return;
    }
    registerPeleDiagrams();
    try {
      this.inner = peleMount(this.container, this.currentSource, this.mountOptions());
      const pending = this.inner.error;
      if (pending !== undefined && pending !== null) {
        this.absorb(pending);
        return;
      }
      this.succeed();
    } catch (raw) {
      this.absorb(raw);
      // 失败即清空：容器里可能留着 Pele 自己的错误条，交由挂载层展示统一错误卡。
      this.container.replaceChildren();
    }
  }

  update(source: string, options?: DiagramMountOptions): void {
    if (this.destroyed) {
      return;
    }
    this.currentSource = source;
    this.currentOptions = options ?? this.currentOptions;
    if (!this.gate(source)) {
      return;
    }
    if (!this.inner) {
      this.mountNow();
      return;
    }
    this.currentState = "updating";
    try {
      this.inner.update(source, this.mountOptions());
      const pending = this.inner.error;
      if (pending !== undefined && pending !== null) {
        this.absorb(pending);
        return;
      }
      this.succeed();
    } catch (raw) {
      this.absorb(raw);
      this.container.replaceChildren();
    }
  }

  refresh(): void {
    if (this.destroyed || !this.inner) {
      this.mountNow();
      return;
    }
    try {
      this.inner.refresh();
      const pending = this.inner.error;
      if (pending !== undefined && pending !== null) {
        this.absorb(pending);
        return;
      }
      this.succeed();
    } catch (raw) {
      this.absorb(raw);
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    try {
      this.inner?.destroy();
    } finally {
      this.inner = undefined;
      // 实测：Pele 的 destroy() 只释放监听不动 DOM，容器清空必须在这里兜住。
      this.container.replaceChildren();
      this.currentState = "destroyed";
    }
  }
}

export function createPeleAdapter(adapterOptions: PeleAdapterOptions = {}): DiagramEngine {
  const cache: DiagramCache<DiagramRenderResult> = createDiagramCache(
    adapterOptions.cacheCapacity ?? 64
  );
  const renderOptions = (options: DiagramRenderOptions | undefined): RenderOptions =>
    toRenderOptions(options, adapterOptions);

  const probe = {
    detectType(source: string): string | null {
      registerPeleDiagrams();
      return peleDetectType(source);
    },
    isRegistered(type: string): boolean {
      return isDiagramTypeRegistered(type);
    }
  };

  /** 能力判定入口：render 与 mount 共用同一条闸门，避免两处口径漂移。 */
  const failureFor = (source: string): DiagramError | null =>
    capabilityError(resolveCapability(source, probe));

  return {
    id: "pele",
    version: PELE_LOCKED_VERSION,

    supports(source: string): boolean {
      // Pele 的 supports 只对「已注册类型」为真，因此注册必须先发生。
      registerPeleDiagrams();
      return peleSupports(source);
    },

    inspect(source: string): DiagramInspection {
      const detectedType = probe.detectType(source);
      return {
        detectedType,
        registered: detectedType === null ? false : probe.isRegistered(detectedType)
      };
    },

    async render(source: string, options?: DiagramRenderOptions): Promise<DiagramRenderResult> {
      const failure = failureFor(source);
      if (failure) {
        throw new DiagramRenderError(failure);
      }
      const key = diagramCacheKey({ source, engineVersion: PELE_LOCKED_VERSION, options });
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }
      try {
        registerPeleDiagrams();
        const result = peleRender(source, renderOptions(options));
        const next: DiagramRenderResult = {
          svg: result.svg,
          width: result.width,
          height: result.height,
          type: String(result.type)
        };
        cache.set(key, next);
        return next;
      } catch (raw) {
        throw new DiagramRenderError(toDiagramError(raw));
      }
    },

    mount(container: HTMLElement, source: string, options?: DiagramMountOptions): MountedDiagram {
      const instance = new PeleMountedDiagram(container, source, options, renderOptions, failureFor);
      instance.mountNow();
      return instance;
    }
  };
}
