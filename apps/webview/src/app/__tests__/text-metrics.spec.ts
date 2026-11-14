/**
 * 阅读时长与字数口径测试（PRD-003 §5.6，STORY-06 的顶栏 pill / 状态条 / 大纲标签共用）。
 *
 * 关键回归点是 §5.6 点名的那个错误：`split(/\s+/)` 把一整段汉字算成一个词，
 * 一篇 3000 字的中文笔记会报成 "1 min read"。所以「中文按字、拉丁按词」这一条
 * 必须逐字符钉住，而不是只测一个中英混排的样例。
 */
import { describe, expect, test } from "vitest";
import {
  READING_UNITS_PER_MINUTE,
  countTextUnits,
  formatReadingTime,
  formatSectionUnits,
  formatUnitCount,
  measureText,
  readingMinutesOf
} from "../text-metrics";

describe("countTextUnits：CJK 感知", () => {
  test("连续汉字逐字计数，不是一串算一个", () => {
    expect(countTextUnits("阅读时长")).toBe(4);
    expect(countTextUnits("这是一篇三千字的中文笔记")).toBe(12);
  });

  test("连续拉丁字母数字按词计数", () => {
    expect(countTextUnits("hello world")).toBe(2);
    expect(countTextUnits("Reading preferences live on three CSS variables")).toBe(7);
    // `v0` 是同一串字母数字，`.` 才切开：v0 / 6 / 0 三段。
    expect(countTextUnits("v0.6.0")).toBe(3);
  });

  test("中英混排：表意字符逐字，拉丁词整串", () => {
    // 「中文」2 字 + reading 1 词 + 「时长」2 字 + time 1 词
    expect(countTextUnits("中文 reading 时长 time")).toBe(6);
  });

  test("假名、CJK 扩展 A 区、兼容表意区都算表意字符", () => {
    expect(countTextUnits("ひらがな")).toBe(4);
    expect(countTextUnits("カタカナ")).toBe(4);
    expect(countTextUnits("㐀䶿")).toBe(2); // U+3400 / U+4DBF：扩展 A 区两端
    expect(countTextUnits("豈")).toBe(1); // U+F900 兼容表意区
  });

  test("标点、空白与 Markdown 语法字符不计", () => {
    expect(countTextUnits("!!! --- ... *** ###")).toBe(0);
    expect(countTextUnits("")).toBe(0);
    // `#`、`-`、`**` 都是语法字符；进账的只有 Title / item / bold / code 四个词。
    expect(countTextUnits("# Title\n\n- item **bold** `code`")).toBe(4);
    expect(countTextUnits("| a | b |\n| --- | --- |")).toBe(2);
  });

  test("URL 里的字母数字按段计入（源文计数不还原语法）", () => {
    // 口径写在头注：数据源是 Markdown 源文。`:` `//` `.` 都不是字母数字，
    // 于是一个 URL 数出 5 段——它是「单元数」而不是严格词数，量级不受影响。
    expect(countTextUnits("see https://example.com/docs")).toBe(5);
  });
});

describe("readingMinutesOf：max(1, ceil(units/300))，空文档 0", () => {
  test("速率是 300 单元/分钟", () => {
    expect(READING_UNITS_PER_MINUTE).toBe(300);
  });

  test("空文档返回 0，不声称要读一分钟（§5.6 末句）", () => {
    expect(readingMinutesOf(0)).toBe(0);
    expect(readingMinutesOf(-1)).toBe(0);
    expect(readingMinutesOf(Number.NaN)).toBe(0);
  });

  test("有内容就至少一分钟，往上取整", () => {
    expect(readingMinutesOf(1)).toBe(1);
    expect(readingMinutesOf(READING_UNITS_PER_MINUTE)).toBe(1);
    expect(readingMinutesOf(READING_UNITS_PER_MINUTE + 1)).toBe(2);
    expect(readingMinutesOf(901)).toBe(4);
  });

  test("3000 字中文报 10 分钟而不是 1 分钟（§5.6 要修的那个 bug）", () => {
    const text = "中".repeat(3_000);
    expect(measureText(text)).toEqual({ units: 3_000, minutes: 10, empty: false });
  });
});

describe("measureText：空文档判定", () => {
  test("空与纯符号文档都算空，pill 据此不出现", () => {
    expect(measureText("")).toEqual({ units: 0, minutes: 0, empty: true });
    expect(measureText("\n\n   ---\n  ")).toEqual({ units: 0, minutes: 0, empty: true });
    expect(measureText("hello").empty).toBe(false);
  });
});

describe("文案 formatter（顶栏 / 状态条 / 大纲共用一处措辞）", () => {
  test("pill 文案", () => {
    expect(formatReadingTime(measureText(`${"word ".repeat(599)}word`))).toBe("2 min read");
    expect(formatReadingTime(measureText("hello"))).toBe("1 min read");
  });

  test("状态条字数带千分位", () => {
    expect(formatUnitCount(840)).toBe("840 words");
    expect(formatUnitCount(12_345)).toBe("12,345 words");
    expect(formatUnitCount(0)).toBe("0 words");
  });

  test("大纲行内标签只有字数一路（源行号 formatter 已移除）", () => {
    expect(formatSectionUnits(840)).toBe("840w");
    expect(formatSectionUnits(0)).toBe("0w");
  });
});
