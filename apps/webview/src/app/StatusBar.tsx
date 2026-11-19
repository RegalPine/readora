/**
 * 状态条（PRD-003 §10.5 外壳四段之一，字段口径见 §4.6）。
 *
 * §4.6 是本仓的「区块渲染诚实性规则」：任何字段只在有真实数据源时渲染。
 * 因此这里只有三项，逐条都能自证：
 *
 *  字数            `text-metrics.ts` 对 `DocumentSnapshot.text` 的单元数
 *  缩放 z%         会话内缩放状态
 *  主题 light/dark 解析后的明暗（`theme.update` 的 `ResolvedTheme`）
 *
 * 文档版本已按产品反馈移除：内部快照版本（如 v0）容易被误认为插件版本。
 * 版本仍用于消息时序、搜索与导出一致性，只是不再作为阅读字段展示。
 *
 * 原先的第一项 `N sections`（顶层分节数）已按产品反馈删掉：节数是目录那
 * 一栏直接能数出来的东西，在底部再报一次只是把同一个信息说两遍，而且得先跟读者
 * 解释「只算顶层、子节不计」才不跟目录对不上。
 *
 * 原先的第六项 `Bridge: Connected`（判据为收到过 `document.load`）已删：状态条随
 * 外壳一起等第一份快照（`App.tsx` 的 loading 分支不渲染外壳），所以它出现即已连接，
 * 一个恒为 Connected 的字段等于没有字段，而且 "Bridge" 是 `HostBridge` 的内部术语，
 * 读者不知道那是什么。「收到过快照」这件事由状态条本身的存在来证明，不用重复报一遍。
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

/** 三项的稳定名字：测试与 e2e 按它定位，改名等于改契约。 */
export type StatusField = "words" | "zoom" | "theme";

export interface StatusBarProps {
  /** `TextMetrics.units`：中文按字、拉丁按词。0 也照样显示，这是真实值。 */
  wordCount: number;
  /** 同一份计量：时长 pill 只在 `empty` 时缺席，字数那项照实显示。 */
  metrics: TextMetrics;
  /** 模式标签的数据源：真的在专注模式里才写 Focus（§11.2）。 */
  focusMode: boolean;
  zoom: number;
  theme: ResolvedTheme;
}

export function StatusBar({
  wordCount,
  metrics,
  focusMode,
  zoom,
  theme
}: StatusBarProps) {
  return (
    <div className={STATUS_CLASS} role="contentinfo" aria-label="Document status">
      {/* 文案走 text-metrics 的 formatter：状态条字数与 pill 时长、大纲行内标签是同一份计量，
          措辞也该只有一处定义。 */}
      <Item field="words">{formatUnitCount(wordCount)}</Item>
      <Item field="zoom">{`zoom ${formatZoom(zoom)}`}</Item>
      <Item field="theme">{`theme ${theme}`}</Item>
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
