/**
 * 状态条（PRD-003 §10.5 外壳四段之一，字段口径见 §4.6）。
 *
 * §4.6 是本仓的「区块渲染诚实性规则」：任何字段只在有真实数据源时渲染。
 * 因此这里只有六项，逐条都能自证：
 *
 *  N 节            outline 条目数（markdown-core 产）
 *  字数            `text-metrics.ts` 对 `DocumentSnapshot.text` 的单元数
 *  文档版本 v{n}   当前快照的 `version`（与消息严格同源，不是本地计数器）
 *  缩放 z%         会话内缩放状态
 *  主题 light/dark 解析后的明暗（`theme.update` 的 `ResolvedTheme`）
 *  Bridge: 连接态  判据是**收到过 `document.load`**，不是「组件挂载了」
 *
 * 原型 `code.html` 状态条里的 `Ln 142, Col 18` 与 `UTF-8` 被 §4.6 点名剔除：
 * Webview 没有光标位置与文件编码信息。面包屑的可点击目录段同理（无
 * reveal-in-explorer 能力），它在顶栏里是纯文本。这里不补任何「看起来像」的字段。
 *
 * 右端那一组 pill（阅读时长 + 模式标签）从顶栏迁到这里（产品反馈：放底部右侧），
 * 口径原样保留：空文档不出时长 pill（§5.6），模式标签跟着真的专注态走，
 * 不永远写着 Reading。它们仍带 `data-readora-pill` 这套定位锁定，迁位不迁语义；
 * 但外观在状态条里被 `.readora-status-pills .readora-pill` 撤成纯文本（产品反馈：
 * 不要背景和边框），class 名留着只是为了让 e2e 与视觉基线的选择器不用改。
 *
 * 地标用 `role="contentinfo"`：一个文档视图里状态条是页面级元信息，读屏器
 * 可以一步跳过去；不用 `status`，它暗示的是会变的临时通知。
 */
import type { ReactNode } from "react";
import type { ResolvedTheme } from "@readora/contracts";
import type { TextMetrics } from "./text-metrics";
import { formatReadingTime, formatUnitCount } from "./text-metrics";
import { formatZoom } from "./zoom";

/**
 * 内容根节点。外层 `.readora-statusbar` 是外壳的第四段（`ReaderShell` 负责），
 * 尺寸归外壳、字段归本组件：两件事各自的测试互不牵连。
 */
export const STATUS_CLASS = "readora-status";
export const STATUS_ITEM_CLASS = "readora-status-item";
export const STATUS_PILLS_CLASS = "readora-status-pills";
export const PILL_CLASS = "readora-pill";

/** 六项的稳定名字：测试与 e2e 按它定位，改名等于改契约。 */
export type StatusField = "sections" | "words" | "version" | "zoom" | "theme" | "bridge";

export interface StatusBarProps {
  sectionCount: number;
  /** `TextMetrics.units`：中文按字、拉丁按词。0 也照样显示，这是真实值。 */
  wordCount: number;
  /** 同一份计量：时长 pill 只在 `empty` 时缺席，字数那项照实显示。 */
  metrics: TextMetrics;
  /** 模式标签的数据源：真的在专注模式里才写 Focus（§11.2）。 */
  focusMode: boolean;
  documentVersion: number;
  zoom: number;
  theme: ResolvedTheme;
  /** 收到过 `document.load` 即为已连接（§4.6 的判据）。 */
  bridgeConnected: boolean;
}

export function StatusBar({
  sectionCount,
  wordCount,
  metrics,
  focusMode,
  documentVersion,
  zoom,
  theme,
  bridgeConnected
}: StatusBarProps) {
  return (
    <div className={STATUS_CLASS} role="contentinfo" aria-label="Document status">
      <Item field="sections">{`${sectionCount} sections`}</Item>
      {/* 文案走 text-metrics 的 formatter：状态条字数与 pill 时长、大纲行内标签是同一份计量，
          措辞也该只有一处定义。 */}
      <Item field="words">{formatUnitCount(wordCount)}</Item>
      <Item field="version">{`v${documentVersion}`}</Item>
      <Item field="zoom">{`zoom ${formatZoom(zoom)}`}</Item>
      <Item field="theme">{`theme ${theme}`}</Item>
      <Item field="bridge">
        <span
          className="readora-status-indicator"
          data-readora-bridge-state={bridgeConnected ? "connected" : "disconnected"}
          aria-hidden="true"
        />
        {`Bridge: ${bridgeConnected ? "Connected" : "Disconnected"}`}
      </Item>
      <div className={STATUS_PILLS_CLASS}>
        {metrics.empty ? null : (
          <span className={PILL_CLASS} data-readora-pill="reading-time">
            {formatReadingTime(metrics)}
          </span>
        )}
        <span
          className={PILL_CLASS}
          data-readora-pill="mode"
          data-readora-mode={focusMode ? "focus" : "reading"}
        >
          {focusMode ? "Focus" : "Reading"}
        </span>
      </div>
    </div>
  );
}

function Item({ field, children }: { field: StatusField; children: ReactNode }) {
  return (
    <span className={STATUS_ITEM_CLASS} data-readora-status={field}>
      {children}
    </span>
  );
}
