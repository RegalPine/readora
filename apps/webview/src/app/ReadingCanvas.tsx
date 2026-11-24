/**
 * 阅读画布（ARC-005 §9；M3 接入资源解析、图表与 Lightbox）。
 *
 * 结构：DocumentHeader（Frontmatter 属性卡片，无属性时不渲染）→
 * MarkdownContent（正文 + 附加层）→
 * 诊断提示条（只呈现 error 级，页内可折叠，不弹 Host 通知）→ Lightbox 覆盖层。
 * M5 起阅读偏好改由 `<html>` 上的三个变量生效（PRD-003 §11.4），本层不再写内联样式；
 * 主题元数据经 ThemeContext 下发（ARC-006 §10），取色全在 CSS 变量里。
 *
 * 本层是「能力装配点」：bridge 的请求能力在这里变成正文可用的四个 handler，
 * 资源解析结果的复判与去重由 ResourceRequestCache 承担，Webview 不自拼路径。
 */
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import type {
  DocumentEditResult,
  DocumentLoadPayload,
  MessageType,
  ResourceKind,
  ResolvedTheme
} from "@readora/contracts";
import type { MarkdownRenderResult, OutlineItem } from "@readora/markdown-core";
import { Lightbox } from "../content/lightbox";
import { DocumentHeader } from "./DocumentHeader";
import { useTheme } from "./theme-context";
import { MarkdownContent } from "../content/MarkdownContent";
import type { ImageActivationRequest } from "../content/interactions";
import { ResourceRequestCache, type ResourceEntry } from "../content/resource-cache";
import type { EditLayer, EditPort } from "../content/edit/edit-layer";

/** 画布需要通知与请求两种能力，收窄接口以便与 HostBridge 解耦（ARC-005 §6）。 */
export interface CanvasBridge {
  notify(type: MessageType, payload: unknown): void;
  request<T>(type: MessageType, payload: unknown): Promise<T>;
}

interface ReadingCanvasProps {
  payload: DocumentLoadPayload;
  /**
   * 主题注入点：单测直接给明暗，生产留空由 ThemeContext 提供（ARC-006 §10.2）。
   * 明暗只决定代码配色与图表系列色，正文取色一律走 CSS 变量。
   */
  theme?: ResolvedTheme;
  bridge: CanvasBridge;
  /** 专注模式：只影响布局类名，正文渲染路径不参与（PRD-002 §11.2）。 */
  focusMode?: boolean;
  /** 编辑模式与它的挂起信号（ARC-009 §7.2 / §7.3）：本层只做装配。 */
  editMode?: boolean;
  editSuspended?: boolean;
  /** 「继续编辑」要关搜索：上面两个信号的反方向，本层仍只装配。 */
  editResume?: () => void;
  /** 接管层的向上出口：App 在导出取帧前用它挂起编辑（ARC-008 §16.1）。 */
  editLayerRef?: RefObject<EditLayer | null>;
  /** 渲染产物里的大纲数据上抛给 App，供 Reader Shell 构树（ARC-007 §4.1）。 */
  onOutline?: (items: readonly OutlineItem[]) => void;
  /** 正文写入完成的通知（ARC-007 §8.2 第 2 步：先渲染后定位）。 */
  onRendered?: (version: number) => void;
}

/** 从文档 URI 取展示用文件名；不做本地路径拼接（IMP-001 §12.2）。 */
export function fileNameOf(documentUri: string): string {
  const tail = documentUri.split(/[\\/]/).pop() ?? documentUri;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

export function ReadingCanvas({
  payload,
  theme: themeOverride,
  bridge,
  focusMode = false,
  editMode = false,
  editSuspended = false,
  editResume,
  editLayerRef,
  onOutline,
  onRendered
}: ReadingCanvasProps) {
  // 主题元数据从 Context 取：颜色由 `<html>` 上的属性驱动，本层不为配色重渲染。
  const context = useTheme();
  const theme = themeOverride ?? context.theme;
  const [rendered, setRendered] = useState<MarkdownRenderResult | null>(null);
  const [notesOpen, setNotesOpen] = useState(true);
  const [lightbox, setLightbox] = useState<ImageActivationRequest | null>(null);
  const { preferences } = payload;
  // 上抛回调走 ref：MarkdownContent 的 effect 只认它自己的依赖，不该被父层重渲染牵连。
  const onOutlineRef = useRef(onOutline);
  const onRenderedRef = useRef(onRendered);
  onOutlineRef.current = onOutline;
  onRenderedRef.current = onRendered;

  /**
   * 请求缓存与正文文本同生命周期：正文一变就换新实例，
   * 于是改过的图会重新问 Host 拿到新的版本号 URI，而不是复用旧地址（ARC-008 §7.3）。
   */
  const resources = useMemo(
    () => new ResourceRequestCache(bridge, payload.documentUri),
    [bridge, payload.documentUri, payload.text]
  );

  /**
   * 写回端口（ARC-009 §6.1）。
   *
   * `payloadRef` 是这里唯一允许的记性，且**只存不读**：`documentUri()` /
   * `version()` 在提交那一刻现读当下那一帧的 payload，绝不把取出来的值缓存进
   * 端口对象 —— 陈旧的那两份正是冲突的唯一来源，端口自己先把它扣住就等于
   * 把乐观锁的锤交给了会过期的一侧。
   */
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const editPort = useMemo<EditPort>(
    () => ({
      submit: (request) =>
        bridge.request<DocumentEditResult>("document.edit", {
          documentUri: request.documentUri,
          range: request.range,
          newText: request.newText,
          baseVersion: request.baseVersion
        }),
      documentUri: () => payloadRef.current.documentUri,
      version: () => payloadRef.current.version
    }),
    [bridge]
  );

  const handlers = useMemo(
    () => ({
      openExternal: (uri: string) => {
        bridge.notify("document.open", { uri });
      },
      // 跨文档跳转：目标交 Host 解析（相对引用按会话文档定位），失败给出行内原因。
      navigate: async (reference: string): Promise<boolean> => {
        try {
          await bridge.request("document.navigate", { uri: reference });
          return true;
        } catch {
          return false;
        }
      },
      openImage: (request: ImageActivationRequest) => {
        if (request.src.length > 0) {
          setLightbox(request);
        }
      },
      resolveResource: (reference: string, kind?: ResourceKind): Promise<ResourceEntry> =>
        resources.resolve(reference, kind)
    }),
    [bridge, resources]
  );

  /**
   * 正文写入完成的唯一上抛点：大纲数据与「可以定位了」的通知同源，
   * 于是 Reader Shell 构的树与 DOM 里的锚点永远来自同一次渲染（ARC-007 §5.1）。
   */
  const handleRendered = useCallback((result: MarkdownRenderResult) => {
    setRendered(result);
    onOutlineRef.current?.(result.outline);
    onRenderedRef.current?.(result.version);
  }, []);

  const closeLightbox = useCallback(() => {
    setLightbox(null);
  }, []);

  const errors = (rendered?.diagnostics ?? []).filter((item) => item.severity === "error");

  return (
    <>
      {/*
       * 偏好不再写内联样式（PRD-003 §11.4 单一变量驱动）：字号、行高、宽度都由
       * App 落在 `<html>` 上的三个变量决定，正文与按 em 给的标题一起跟着走。
       */}
      <main className={`readora-canvas${focusMode ? " readora-canvas--focus" : ""}`}>
        <DocumentHeader
          // M6 / STORY-06-02：卡片的数据是 markdown-core 交出的字面量名单，
          // 本层不解析 Frontmatter 文本，也不在这里做第二次裁剪。
          properties={rendered?.metadata.properties ?? []}
        />

        {errors.length > 0 ? (
          <section
            className="readora-diagnostic-bar"
            aria-label="Rendering problems"
            aria-live="polite"
          >
            <button
              type="button"
              className="readora-diagnostic-toggle"
              aria-expanded={notesOpen}
              onClick={() => {
                setNotesOpen((open) => !open);
              }}
            >
              {`${errors.length} rendering problem${errors.length === 1 ? "" : "s"}`}
            </button>
            {notesOpen ? (
              <ul className="readora-diagnostic-list">
                {errors.map((item) => (
                  <li key={`${item.code}-${item.nodeId ?? "document"}`}>{item.message}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        <MarkdownContent
          documentId={payload.documentUri}
          documentUri={payload.documentUri}
          version={payload.version}
          text={payload.text}
          theme={theme}
          handlers={handlers}
          fontSize={preferences.fontSize}
          editMode={editMode}
          editSuspended={editSuspended}
          editResume={editResume}
          editPort={editPort}
          editLayerRef={editLayerRef}
          onRendered={handleRendered}
        />
      </main>

      {lightbox ? <Lightbox request={lightbox} onClose={closeLightbox} /> : null}
    </>
  );
}
