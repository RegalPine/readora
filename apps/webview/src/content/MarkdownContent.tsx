/**
 * Markdown 正文容器（ARC-005 §9 / IMP-001 §8.4 / ARC-003 §6 / ARC-008 §9）。
 *
 * 渲染管线跑在 Webview 内（IMP-001 §4.2）：这里调 renderMarkdown，
 * 只把 Sanitizer 之后的 HTML 写入容器（IMP-001 §8.4 允许的唯一 innerHTML 形态），
 * 写入后一次性绑定事件委托（不生成内联脚本），并让图片层、图表层与代码编辑器层接管产物。
 *
 * 五条不变量：
 * - 旧 version 的结果不覆盖新内容（ARC-005 §9.5）；
 * - 全量渲染 + 内容 hash 跳过重复渲染（ARC-002 §13.1）：同文本的重复 update
 *   连解析都不重跑，产物只由 text / 主题 / 文档标识决定，version 不是渲染输入；
 * - 渲染结果通过 onRendered 上报，供上层展示 metadata 与诊断；
 * - 附加层与 DOM 同生命周期：正文重写即销毁旧实例，卸载即清理观察器与监听，
 *   不留悬挂的在途请求（ARC-003 §6.3）；
 * - 附加层只创建自己的节点，不重写正文（innerHTML 写入点仍只有这一处）。
 */
import { useEffect, useMemo, useRef } from "react";
import type { DiagramEngine } from "@readora/diagram-core";
import {
  computeContentHash,
  renderMarkdown,
  type MarkdownRenderResult,
  type ResolvedRenderTheme
} from "@readora/markdown-core";
import { createDiagramLayer, type DiagramLayer } from "./diagram-layer";
import { createImageLayer, type ImageLayer } from "./image-layer";
import { attachContentInteractions, type ContentInteractionHandlers } from "./interactions";
import {
  createCodeEditorLayer,
  type CodeEditorLayer
} from "./code-editor/code-editor-layer";

export interface MarkdownContentProps {
  documentId: string;
  documentUri: string;
  version: number;
  text: string;
  /**
   * 当前明暗：只喂给附加层的主题同步，不参与解析（ARC-006 §11.1）。
   */
  theme: ResolvedRenderTheme;
  handlers: ContentInteractionHandlers;
  /** 引擎注入点：单测替成 mock；留空则由挂载层自建真实引擎。 */
  diagramEngine?: DiagramEngine;
  /** 字号偏好：度量变化才需要引擎重算布局（主题变化不走这里）。 */
  fontSize?: number;
  onRendered?: (result: MarkdownRenderResult) => void;
}

/**
 * 上一次解析的输入指纹与产物，用于「内容 hash 跳过重复渲染」。
 *
 * 主题**不在**指纹里（ARC-006 §11.1）：换明暗只改 `<html>` 上的属性，
 * 把主题算进渲染输入会让每次切换都重跑一遍管线、重写 innerHTML，
 * 于是已挂载的图表实例连同在途请求一起被丢弃重造——正是 §11.1 禁止的那条。
 */
interface RenderCache {
  hash: string;
  text: string;
  documentId: string;
  result: MarkdownRenderResult;
}

interface ContentLayers {
  image: ImageLayer;
  diagram: DiagramLayer;
  code: CodeEditorLayer;
}

function sameSource(
  cache: RenderCache,
  hash: string,
  text: string,
  documentId: string
): boolean {
  // hash 命中只是快路径，必须再全等复核文本，避免指纹碰撞端出陈旧内容。
  return cache.hash === hash && cache.text === text && cache.documentId === documentId;
}

export function MarkdownContent({
  documentId,
  documentUri,
  version,
  text,
  theme,
  handlers,
  diagramEngine,
  fontSize,
  onRendered
}: MarkdownContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const writtenVersionRef = useRef(-1);
  const writtenDocumentIdRef = useRef<string | undefined>(undefined);
  const writtenHtmlRef = useRef<string | null>(null);
  const handlersRef = useRef(handlers);
  const engineRef = useRef(diagramEngine);
  const cacheRef = useRef<RenderCache | null>(null);
  const layersRef = useRef<ContentLayers | null>(null);
  engineRef.current = diagramEngine;

  const contentHash = computeContentHash(text);

  const result = useMemo(() => {
    const cached = cacheRef.current;
    if (cached && sameSource(cached, contentHash, text, documentId)) {
      // 内容未变（如仅主题/版本更新）：复用上一次解析产物，不重跑管线。
      return cached.result.version === version ? cached.result : { ...cached.result, version };
    }
    const rendered = renderMarkdown({ documentId, documentUri, version, text, theme });
    cacheRef.current = { hash: contentHash, text, documentId, result: rendered };
    return rendered;
    // theme 不进依赖表：它只作为渲染输入的一次性取值，切换由下面的附加层同步。
  }, [documentId, documentUri, version, text, contentHash]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    // 版本号只在同一篇文档内可比：换文档即另起一条计数线，
    // 否则跨文档跳到一份版本号更小的文件会被当成「迟到的旧快照」丢掉。
    const sameDocument = writtenDocumentIdRef.current === documentId;
    if (sameDocument && version < writtenVersionRef.current) {
      return;
    }
    writtenDocumentIdRef.current = documentId;
    writtenVersionRef.current = version;
    // 同内容重复 update（version 变了但产物一致）不重排 DOM；换文档时即使产物一致
    // 也要重写：图片层与图表层的实例、在途请求都还绑在旧文档上。
    if (sameDocument && writtenHtmlRef.current === result.html) {
      return;
    }
    writtenHtmlRef.current = result.html;
    // 唯一允许的 innerHTML 写入点：值来自 renderMarkdown 的 DOMPurify 产物（IMP-001 §8.4），
    // 管线失败时也只输出转义纯文本，绝不写入未验证 HTML。
    container.innerHTML = result.html;
    // 旧产物已离开 DOM：其观察目标、在途请求与引擎实例全部作废。
    layersRef.current?.image.destroy();
    layersRef.current?.diagram.destroy();
    layersRef.current?.code.destroy();
    const image = createImageLayer({
      // 解析一律交 Host：Webview 不拼路径、不猜本地位置（ARC-008 §8.1）。
      resolve: (reference, kind) => handlersRef.current.resolveResource(reference, kind)
    });
    const diagram = createDiagramLayer(engineRef.current ? { engine: engineRef.current } : {});
    // 代码编辑器层没有注入口：CodeMirror 是纯本地库，不像 mermaid 那样需要外部解析器，
    // 也没有「换引擎」的需求，所以单测靠 createEditor 参数注替身（见 code-editor-layer）。
    const code = createCodeEditorLayer();
    layersRef.current = { image, diagram, code };
    image.scan(container);
    diagram.scan(container);
    code.scan(container);
    onRendered?.(result);
  }, [documentId, result, version, onRendered]);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    return attachContentInteractions(container, {
      openExternal: (uri) => handlersRef.current.openExternal(uri),
      navigate: (reference) => handlersRef.current.navigate(reference),
      openImage: (request) => handlersRef.current.openImage(request),
      resolveResource: (reference, kind) => handlersRef.current.resolveResource(reference, kind)
    });
  }, []);

  // 主题同步只切 class：颜色由 CSS 变量求值，不重新解析、不重排（ARC-003 §8.2）。
  // 这条 effect 是主题变化唯一到达渲染管线的路径（ARC-006 §11.1）。
  useEffect(() => {
    layersRef.current?.diagram.syncTheme(theme);
  }, [theme]);

  // 字号变化影响文本度量，必须让引擎重算布局；主题变化不到这里（上面那条负责）。
  // 代码编辑器同一条：CodeMirror 缓存行高，CSS 变量换了字号得请它重测一次。
  useEffect(() => {
    if (fontSize === undefined) {
      return;
    }
    layersRef.current?.diagram.refreshAll();
    layersRef.current?.code.refreshAll();
  }, [fontSize]);

  useEffect(
    () => () => {
      layersRef.current?.image.destroy();
      layersRef.current?.diagram.destroy();
      layersRef.current?.code.destroy();
      layersRef.current = null;
      // 卸载后 DOM 已重建：允许下一次挂载重新写入并重新接管。
      writtenHtmlRef.current = null;
      writtenVersionRef.current = -1;
      writtenDocumentIdRef.current = undefined;
    },
    []
  );

  // 版本标记挂在正文容器上：搜索高亮、导航数据都要能判断自己是否已经过期
  // （ARC-007 §9.4 第 3 条、§12「文档版本不一致 → 丢弃过期数据」）。
  return (
    <div
      className="readora-document"
      data-readora-document-version={version}
      ref={containerRef}
    />
  );
}
