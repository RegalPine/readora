/**
 * Markdown 正文容器（ARC-005 §9 / IMP-001 §8.4 / ARC-003 §6 / ARC-008 §9）。
 *
 * 渲染管线跑在 Webview 内（IMP-001 §4.2）：这里调 renderMarkdown，
 * 只把 Sanitizer 之后的 HTML 写入容器（IMP-001 §8.4 允许的唯一 innerHTML 形态），
 * 写入后一次性绑定事件委托（不生成内联脚本），并让图片层、图表层、编辑接管层与代码编辑器层接管产物。
 *
 * 五条不变量：
 * - 旧 version 的结果不覆盖新内容（ARC-005 §9.5）；
 * - 全量渲染 + 内容 hash 跳过重复渲染（ARC-002 §13.1）：同文本的重复 update
 *   连解析都不重跑，产物只由 text / 主题 / 文档标识决定，version 不是渲染输入；
 * - 渲染结果通过 onRendered 上报，供上层展示 metadata 与诊断；
 * - 附加层与 DOM 同生命周期：正文重写即销毁旧实例，卸载即清理观察器与监听，
 *   不留悬挂的在途请求（ARC-003 §6.3）；
 * - 附加层只创建自己的节点，不重写正文（innerHTML 写入点仍只有这一处）。
 *
 * 编辑接管层（ARC-009 §8，E2）是上面最后两条的**登记例外**：它的实例跨正文重写
 * 存活，只在卸载时 destroy。理由是无条件重写的 innerHTML 会端掉用户正在输入的
 * 那个节点，而那份输入在源文件里还不存在。于是重写顺序固定成
 * 「edit.detachForRewrite() → 写 innerHTML → edit.scan()」，由本层保证三步在同一次
 * effect 里连着跑完，不给中间任何插队的机会。
 */
import { useEffect, useMemo, useRef, type RefObject } from "react";
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
import { createEditLayer, type EditLayer, type EditPort } from "./edit/edit-layer";
import { isFileSchemeUri } from "./edit/source-text";

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
  /**
   * 编辑模式开关（ARC-009 §7.2）。
   *
   * 它走 prop 而不是 `reader.viewState` 通道：那条通道方向是 host→view，
   * 且没有任何 Host 会写「编辑模式」这个字段（§8.3 里没有 view→view 的视图状态位）。
   */
  editMode?: boolean | undefined;
  /** 搜索面板打开即挂起编辑（§7.3）。 */
  editSuspended?: boolean | undefined;
  /**
   * 接管层请求「把搜索关掉以便继续编辑」（§7.3「继续编辑 = 关搜索并重挂」）。
   * 挂起信号的所有权在上层，本层不代它改状态，只负责转达。
   */
  editResume?: (() => void) | undefined;
  /** 写回端口：留空即本层完全不接管正文（单测与不可写文档同一形态）。 */
  editPort?: EditPort | undefined;
  /** 把接管层交回上层，供导出前显式挂起（ARC-008 §16.1）。 */
  editLayerRef?: RefObject<EditLayer | null> | undefined;
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
  /**
   * 跨正文重写存活的那一个（见文件头注的例外说明）。
   *
   * 写成 `| undefined` 而不是 `?:`：本项目开了 `exactOptionalPropertyTypes`，
   * 「没有这个键」与「这个键是 undefined」（没给 editPort）不是一回事，
   * 而重建时两种都要能写进同一个对象。
   */
  edit: EditLayer | undefined;
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
  editMode = false,
  editSuspended = false,
  editResume,
  editPort,
  editLayerRef,
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
  /**
   * 写回端口与当前全文都走 ref：它们**不能**进 render effect 的依赖表，
   * 否则上层的 `payload` 一变就把整层重建（ARC-009 §8）。
   */
  const editPortRef = useRef(editPort);
  const editResumeRef = useRef(editResume);
  const textRef = useRef(text);
  editPortRef.current = editPort;
  editResumeRef.current = editResume;
  textRef.current = text;
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
    // 接管层先于重写摘走活动单元所在的那一个节点（ARC-009 §5.4 的保全仲裁）。
    const edit = layersRef.current?.edit;
    edit?.detachForRewrite();
    // 唯一允许的 innerHTML 写入点：值来自 renderMarkdown 的 DOMPurify 产物（IMP-001 §8.4），
    // 管线失败时也只输出转义纯文本，绝不写入未验证 HTML。
    container.innerHTML = result.html;
    // 旧产物已离开 DOM：其观察目标、在途请求与引擎实例全部作废。
    // edit **不在**此列：它持有刚从上面捣下来的那个节点，插回去要在 scan 里做。
    layersRef.current?.image.destroy();
    layersRef.current?.diagram.destroy();
    layersRef.current?.code.destroy();
    if (!sameDocument) {
      // 换文档：上一次没提交出去的输入与新文档毫无关系，丢（§5.4）。
      edit?.resetForDocument();
    }
    const image = createImageLayer({
      // 解析一律交 Host：Webview 不拼路径、不猜本地位置（ARC-008 §8.1）。
      resolve: (reference, kind) => handlersRef.current.resolveResource(reference, kind)
    });
    const diagram = createDiagramLayer(engineRef.current ? { engine: engineRef.current } : {});
    // 代码编辑器层没有注入口：CodeMirror 是纯本地库，不像 mermaid 那样需要外部解析器，
    // 也没有「换引擎」的需求，所以单测靠 createEditor 参数注替身（见 code-editor-layer）。
    const code = createCodeEditorLayer();
    // 接管层只在有端口时存在，并且**只建一次**（ARC-009 §8：它在 code 层之前接管）。
    const nextEdit =
      edit ??
      (editPortRef.current
        ? createEditLayer({
            port: editPortRef.current,
            source: () => textRef.current,
            onResume: () => editResumeRef.current?.()
          })
        : undefined);
    layersRef.current = { image, diagram, code, edit: nextEdit };
    if (nextEdit && editLayerRef) {
      editLayerRef.current = nextEdit;
    }
    image.scan(container);
    diagram.scan(container);
    nextEdit?.scan(container);
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

  /**
   * 编辑模式开关只转给接管层，不重建任何层（ARC-009 §7.2）。
   *
   * 它不能进 render effect 的依赖表：那会让「点一下开关」变成整篇重排 DOM，
   * 阅读位置与已挂载的图表实例一起没了 —— 那不是开关，那是刷新。
   */
  useEffect(() => {
    const edit = layersRef.current?.edit;
    if (!edit) {
      return;
    }
    // 只读判据：`file:` 之外的文档不给编辑入口（§7.2，UX 判据，权威在 Host）。
    edit.setAvailable(isFileSchemeUri(documentUri));
    edit.setEditMode(editMode);
  }, [editMode, documentUri]);

  // 搜索面板打开即挂起编辑（§7.3）：高亮插入会拆改文本节点，与在输入的元素重合。
  useEffect(() => {
    layersRef.current?.edit?.setSuspended(editSuspended);
  }, [editSuspended]);

  useEffect(
    () => () => {
      layersRef.current?.image.destroy();
      layersRef.current?.diagram.destroy();
      layersRef.current?.code.destroy();
      // 只有卸载才销毁接管层：DOM 已重建，持有节点与卡片跟着作废。
      layersRef.current?.edit?.destroy();
      if (editLayerRef) {
        editLayerRef.current = null;
      }
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
