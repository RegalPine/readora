/**
 * 阅读时长与字数口径（PRD-003 §5.6）。
 *
 * 状态条右端的 `N min read` pill、状态条的字数、大纲行内的 `840w` 共用这一个计数函数：
 * 三个地方各数一遍迟早会数出三个答案，而它们并排显示在同一屏里。
 *
 * 之所以要专门的函数，是 §5.6 点名的那个可感知错误：`text.split(/\s+/).length`
 * 对中文按空白切分，一整段汉字算 1 个词，一篇 3000 字的中文笔记会被报成
 * "1 min read"。规则三条：
 * 1. 每个 CJK 表意字符（含日文假名、CJK 扩展 A 区）计 1 个单元 —— 中文一个字就是一个词；
 * 2. 连续的非 CJK 字母数字序列按词计，一个序列 1 个单元；
 * 3. 标点、空白、Markdown 语法字符不计。
 *
 * 数据源是 `DocumentSnapshot.text`（Markdown 源文，不是渲染后的 DOM 文本）：
 * 口径要能在渲染之前算出来（首帧的 pill 不该等 DOM），也让 §3 的分节字数可以
 * 直接按源行区间切同一份文本。代价是语法字符会混进来，规则 3 正是为它写的 ——
 * `#`、`*`、`` ` ``、`|`、`>` 都不是字母数字，天然落不进任何单元。
 *
 * 已知未覆盖：谚文（한글）与阿拉伯字母走规则 2 的「一串算一个」，对纯韩文档会
 * 明显低估；§5.6 的口径只承诺中日韩表意字符，这里不擅自扩面（README 登记）。
 */

/** 300 单元/分钟：中英混排的保守舒适读数（PRD-003 §5.6）。 */
export const READING_UNITS_PER_MINUTE = 300;

/**
 * 一个单元 = 一个表意字符，或一串连续的字母/数字。
 *
 * 两个分支的先后顺序有意义：`\p{L}` 也包含汉字，若字母分支在前，一整段中文会被
 * 当成一个词，正好退化成 §5.6 要修掉的那个 bug。表意分支先吃掉单个字符，
 * 剩下的拉丁与数字才轮到第二支。
 */
const UNIT_PATTERN =
  /[\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]|[\p{L}\p{N}]+/gu;

export function countTextUnits(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  // 全局 flag 的 `match` 返回全部命中且不留下 lastIndex 状态，正是计数要的语义。
  return text.match(UNIT_PATTERN)?.length ?? 0;
}

/**
 * `minutes = max(1, ceil(units / 300))`，但空文档是 0 ——
 * 一篇没有内容的文档不该声称「读完要 1 分钟」（§5.6 末句：空文档返回 0 字、不显示 pill）。
 */
export function readingMinutesOf(units: number): number {
  if (!(units > 0)) {
    return 0;
  }
  return Math.max(1, Math.ceil(units / READING_UNITS_PER_MINUTE));
}

export interface TextMetrics {
  /** 单元数：中文按字、拉丁按词。 */
  readonly units: number;
  /** 预估阅读分钟数；空文档为 0。 */
  readonly minutes: number;
  /** 空文档判定：pill 与状态条的字数都据此决定要不要显示。 */
  readonly empty: boolean;
}

export function measureText(text: string): TextMetrics {
  const units = countTextUnits(text);
  return { units, minutes: readingMinutesOf(units), empty: units === 0 };
}

/** 阅读时长 pill 文案（§10.5，现贴在状态条右端）。 */
export function formatReadingTime(metrics: TextMetrics): string {
  return `${metrics.minutes} min read`;
}

/** 状态条的字数文案（大纲底部统计已下掉，节数只剩状态条这一处）。 */
export function formatUnitCount(units: number): string {
  return `${units.toLocaleString("en-US")} words`;
}

/** 大纲行内的分节字数标签 `840w`（PRD-003 §10.7）。 */
export function formatSectionUnits(units: number): string {
  return `${units}w`;
}
