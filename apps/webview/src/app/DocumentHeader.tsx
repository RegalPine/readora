/**
 * 文档头部与 Frontmatter 属性卡片（ARC-005 §9；PRD-003 §4.6 / STORY-06-02，M6 升级）。
 *
 * M5 之前这里只有「标题 + 文件名」两行，Frontmatter 的信息散落在正文里看不见。
 * PRD-003 §4.6 要求文档头部呈现这篇的元信息，承载它的就是这张属性卡：
 * **键值表格，按类型排版**（文本 / 数字 / 布尔 / 日期 / 列表）。
 *
 * 三条不动的边界：
 * 1. **不执行任何脚本或表达式**（STORY-06-02 验收）。卡片显示的是
 *    `markdown-core` 交出的字面量名单，`{{7*7}}`、`=1+1`、`new Date(...)` 都只是文本；
 *    分类只匹配模式，不做求值（见 frontmatter.ts 的 classifyFrontmatterValue）。
 *    日期用 `<time dateTime>` 也只是给已成立的 ISO 字面量打个标记，不格式化、不换算时区。
 * 2. **非法 Frontmatter 不影响正文**（§14.3）。名单为空就整张卡不出现，
 *    没有「渲染失败占位块」—— 卡片是可选信息，缺席本身就是正确的呈现。
 * 3. 表格不是导航：`<th scope="row">` 让读屏器把键名念成行标题，而卡片本身
 *    是一个可命名的 landmark（`aria-label`），不与正文大纲争抢目录地位。
 *
 * 上限 64 个键的裁剪与超限诊断都在 `extractFrontmatter` 里发生，本层不再截一次：
 * 两处各裁一遍就会有两个「最多显示多少」的口径。
 */
import type { FrontmatterProperty } from "@readora/markdown-core";

export interface DocumentHeaderProps {
  /** 已按「Frontmatter title 优先，否则文件名」定稿的标题文本。 */
  title: string;
  fileName: string;
  properties: readonly FrontmatterProperty[];
}

/**
 * 判断这个长得像日期的字面量是不是**真存在的日子**。
 *
 * `2024-02-30` 匹配 ISO 模式却不存在，给它挂 `<time dateTime>` 等于宣称一个
 * 无效的结构化值（读屏器与后续工具都会信它）。
 *
 * 这里不能用 `Date.parse`：V8 对 ISO 解析失败后会退回 legacy 解析，
 * `Date.parse("2024-02-30")` 照样返回一个时间戳（3 月 1 日），于是「假日期」
 * 被洗白成真日期。改成「按 UTC 组装再读回三个分量」：越界的写法会被进位到
 * 下一个月子/下一个年，回读必然对不上原值。
 *
 * 这仍然不是求值 —— 输出的还是源码里那几个字符，只是不再声称它是日期。
 * 分类阶段（frontmatter.ts）只认 ISO 形态，所以到这里的一律是 `YYYY-MM-DD` 开头。
 */
function isRealDate(literal: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(literal);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const assembled = new Date(Date.UTC(year, month - 1, day));
  return (
    assembled.getUTCFullYear() === year &&
    assembled.getUTCMonth() === month - 1 &&
    assembled.getUTCDate() === day
  );
}

function PropertyValue({ property }: { property: FrontmatterProperty }) {
  if (property.kind === "list") {
    const items = property.items ?? [];
    if (items.length === 0) {
      // 空序列：键存在但没有条目，就说「没有条目」。留白会被读成渲染坏了。
      return (
        <span className="readora-property-empty" data-readora-property-state="empty">
          No entries
        </span>
      );
    }
    return (
      <ul className="readora-property-list">
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    );
  }
  if (property.kind === "date" && isRealDate(property.text)) {
    return <time dateTime={property.text}>{property.text}</time>;
  }
  if (property.kind === "number") {
    return <span className="readora-property-number">{property.text}</span>;
  }
  return <>{property.text}</>;
}

export function DocumentHeader({ title, fileName, properties }: DocumentHeaderProps) {
  return (
    <header className="readora-document-header">
      <h1 className="readora-document-title">{title}</h1>
      <p className="readora-document-source">{fileName}</p>

      {properties.length > 0 ? (
        <section className="readora-properties" aria-label="Document properties">
          <h2 className="readora-properties-heading">Properties</h2>
          <table className="readora-properties-table">
            <caption className="readora-properties-caption">
              {`${properties.length} frontmatter ${properties.length === 1 ? "property" : "properties"}`}
            </caption>
            <tbody>
              {properties.map((property, index) => (
                <tr
                  key={`${property.key}-${index}`}
                  className="readora-property-row"
                  data-readora-property-type={property.kind}
                >
                  <th scope="row" className="readora-property-key">
                    {property.key}
                  </th>
                  <td className="readora-property-value">
                    <PropertyValue property={property} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </header>
  );
}
