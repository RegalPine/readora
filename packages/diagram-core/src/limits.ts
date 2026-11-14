/**
 * 图表输入 / 输出安全限额（ARC-003 §9.2、F04-058）。
 *
 * 「不能把第三方引擎的安全能力视为 Webview 的全部安全措施」：
 * 这里既约束交给 Pele 的源码规模，也把 scheme 白名单显式传给引擎，
 * 使引擎产物从一开始就不带危险外部引用，产品侧 SVG Sanitizer 再做第二层。
 */

/** Mermaid 源码输入上限：50 000 字符（ARC-003 §9.2 实现基线）。 */
export const MAX_DIAGRAM_SOURCE_CHARACTERS = 50_000;

/** SVG 输出上限（字符数）：超限视为资源耗尽风险，走错误态不插入。 */
export const MAX_SVG_OUTPUT_CHARACTERS = 2_000_000;

/** 边数上限，挡住「连线爆炸」型图表把主线程钉死。 */
export const MAX_DIAGRAM_EDGES = 2_000;

/** 图表内链接只放行 http/https（ARC-008 §8.3），其余 scheme 由引擎直接拒绝。 */
export const ALLOWED_LINK_SCHEMES: readonly string[] = ["http", "https"];

/** 图表内不放开任何外部图片 scheme（隐私与网络访问边界，ARC-008 §8.1）。 */
export const ALLOWED_IMAGE_SCHEMES: readonly string[] = [];

/** 交给引擎的 rel 值，与正文外链口径一致。 */
export const DIAGRAM_LINK_REL = "noopener noreferrer nofollow";

/** SVG 内部 id 前缀默认值。 */
export const DIAGRAM_ID_PREFIX = "readora-diagram-";

/** 超过输入上限时的用户可见说明（不含堆栈）。 */
export const OVER_LIMIT_MESSAGE =
  "Diagram source exceeds the 50000 character limit.";
