/**
 * P01 Source Normalizer 单测（ARC-002 §2.2）。
 */
import { describe, expect, it } from "vitest";
import { normalizeSource } from "../normalize";

describe("normalizeSource", () => {
  it("剥离 BOM", () => {
    expect(normalizeSource("\uFEFF# 标题")).toBe("# 标题");
  });

  it("BOM 只去开头，正文中的同名字符不受影响", () => {
    expect(normalizeSource("a\uFEFFb")).toBe("a\uFEFFb");
  });

  it("CRLF 与孤立 CR 归一为 LF", () => {
    expect(normalizeSource("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("清理 NUL 与控制字符，保留制表符与换行", () => {
    expect(normalizeSource("a\u0000b\u0007c\td\ne\u001F")).toBe("abc\td\ne");
  });

  it("保留行尾空白：CommonMark 硬换行语义不得被裁剪（§7.2）", () => {
    const source = "第一行  \n第二行\n";
    expect(normalizeSource(source)).toBe(source);
    expect(normalizeSource(source)).toContain("第一行  \n");
  });

  it("空输入与纯空白输入不抛错", () => {
    expect(normalizeSource("")).toBe("");
    expect(normalizeSource("  \r\n  ")).toBe("  \n  ");
  });

  it("保留 Unicode 组合字符与 Emoji（不做 NFC/NFD 归一）", () => {
    const source = " café 😀\n";
    expect(normalizeSource(source)).toBe(source);
  });
});
