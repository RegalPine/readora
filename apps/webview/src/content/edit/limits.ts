/**
 * 编辑接管层的本地阈值（ARC-009 §9.5）。
 *
 * 这个数**不是**协议约束：`DocumentEditPayload.newText` 的上限仍由 contracts 的
 * `DOCUMENT_TEXT_MAX_LENGTH`（整篇文档）决定，Host 侧按 ARC-009 §5.1 复判，Webview
 * 这一层拦不住也不该拦整篇的大小。它拦的是另一件事 —— 「人同时在一块
 * contenteditable 里改多大一段文本还算可用」，与 `MATH_SOURCE_MAX_LENGTH = 8_000`
 * 是同一个问题域（一块就地编辑的区域，装得下正常内容、装不下整篇文档）。
 *
 * 不复用 `MAX_DIAGRAM_SOURCE_CHARACTERS` / `CSV_SOURCE_MAX_LENGTH`：那两个是
 * 「送进解析引擎的输入闸门」，防的是引擎被喂爆；这里防的是交互与重排。
 */

/** 单个区块的源文本上限：超出即拒绝激活，只在原地处给一行说明。 */
export const EDIT_BLOCK_MAX_SOURCE_LENGTH = 8_000;

/** 冲突卡片上给用户的说明文案（三枚错误码文案必须不同，ARC-009 §5.3）。 */
export const EDIT_CONFLICT_MESSAGES = {
  stale: "The file changed while you were editing. Your text is kept below.",
  rangeInvalid: "This block no longer exists at the recorded source lines.",
  applyFailed: "The host refused the change. The file may be read-only or locked.",
  search: "Editing was suspended while search is open."
} as const;

/** 超过阈值时的行内提示（复用 `.readora-inline-note` 的展示通道）。 */
export const EDIT_BLOCK_TOO_LARGE_NOTE =
  "This block is too large to edit in place.";

/**
 * 顶栏开关禁用时的悬停解释（ARC-009 §7.2）。
 *
 * 禁用而不是隐藏：隐藏会让功能看起来坏了，禁用 + 一句原因才能说清
 * 「这一篇没有可写回的磁盘文件」。
 */
export const EDIT_UNAVAILABLE_TITLE = "Editing is available only for local files";

/**
 * 行内格式化的四条提示（ARC-009 §6.3，E3）。
 *
 * 全部走 `interactions.ts` 的 `showInlineNote` 通道与 `.readora-inline-note` 类名
 * —— 与超阈值提示同一个形态，不新增第二套展示层。四条都在说同一类事：
 * 「你点的那个按钮做了，但没完全按你期望的方式做」，所以措辞里都带上了原因
 * 而不是只说失败。
 */

/** 跨行选区被逐行包裹（语义从「一个 emphasis 覆盖两行」变成两个，源永远平衡）。 */
export const EDIT_MULTILINE_WRAP_NOTE =
  "Applied to each line separately so the source stays valid.";

/** 选区落在已有的行内代码里：插进去的标记不会被解析，什么也没做。 */
export const EDIT_INSIDE_CODE_NOTE =
  "This selection is inside inline code, where markers would show literally.";

/** 脚注只插引用：定义行必须是顶层区块，一次写回只有一个行范围（决策 6）。 */
export const EDIT_FOOTNOTE_NOTE =
  "Footnote reference inserted. Add its definition on its own line.";

/** 降级：选区有一端对不出文本下标，只插了一对字面标记（§6.3）。 */
export const EDIT_SELECTION_UNMAPPED_NOTE =
  "Part of the selection could not be matched, so empty markers were inserted.";

/** heading 改级别解析不出 ATX 前缀（setext、`#` 后无空格）：六枚按钮置灰。 */
export const EDIT_LEVEL_UNAVAILABLE_NOTE =
  "This heading has no ATX prefix to rewrite, so its level cannot be changed.";
