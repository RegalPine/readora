import { describe, expect, test } from "vitest";
import { decideLinkOpen } from "../security/link-policy";

describe("decideLinkOpen", () => {
  test("放行 http/https", () => {
    expect(decideLinkOpen("https://example.com/doc")).toEqual({
      allowed: true,
      uri: "https://example.com/doc"
    });
    expect(decideLinkOpen("http://example.com").allowed).toBe(true);
  });

  test("拒绝 file://（本地文件不得经 OS 打开）", () => {
    const decision = decideLinkOpen("file:///etc/passwd");
    expect(decision.allowed).toBe(false);
  });

  test("拒绝 vscode:// 与 javascript:", () => {
    expect(decideLinkOpen("vscode://file/tmp/a.md").allowed).toBe(false);
    expect(decideLinkOpen("javascript:alert(1)").allowed).toBe(false);
  });

  test("拒绝相对路径与非法 URL", () => {
    expect(decideLinkOpen("./relative.md").allowed).toBe(false);
    expect(decideLinkOpen("").allowed).toBe(false);
    expect(decideLinkOpen("not a url").allowed).toBe(false);
  });

  test("拒绝 data: 与自定义 scheme", () => {
    expect(decideLinkOpen("data:text/html,hello").allowed).toBe(false);
    expect(decideLinkOpen("custom-scheme://target").allowed).toBe(false);
  });
});