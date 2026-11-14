import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import { isMarkdownPath, resolveCommandTarget } from "../commands/target";
import { Uri, resetVscodeStub, window } from "../__stubs__/vscode";

beforeEach(() => {
  resetVscodeStub();
});

describe("isMarkdownPath", () => {
  test("覆盖 .md / .markdown 且大小写不敏感", () => {
    expect(isMarkdownPath("/tmp/a.md")).toBe(true);
    expect(isMarkdownPath("/tmp/a.markdown")).toBe(true);
    expect(isMarkdownPath("/tmp/A.MD")).toBe(true);
    expect(isMarkdownPath("/tmp/a.txt")).toBe(false);
    expect(isMarkdownPath("/tmp/md")).toBe(false);
  });
});

describe("resolveCommandTarget", () => {
  test("explorer 传入 Markdown Uri 优先", () => {
    const target = resolveCommandTarget(Uri.file("/tmp/a.md"));
    expect(target?.source).toBe("explorer");
    expect(target?.uri.fsPath).toBe("/tmp/a.md");
  });

  test("explorer 传入非 Markdown / 非 file scheme 拒绝", () => {
    expect(resolveCommandTarget(Uri.file("/tmp/a.txt"))).toBeNull();
    expect(resolveCommandTarget(Uri.parse("https://example.com/a.md"))).toBeNull();
  });

  test("无参数时回退活动的 Markdown 编辑器", () => {
    window.activeTextEditor = {
      document: { uri: Uri.file("/tmp/b.md"), languageId: "markdown" }
    };
    const target = resolveCommandTarget(undefined);
    expect(target?.source).toBe("editor");
    expect(target?.uri.fsPath).toBe("/tmp/b.md");
  });

  test("活动编辑器非 Markdown 时拒绝", () => {
    window.activeTextEditor = {
      document: { uri: Uri.file("/tmp/b.ts"), languageId: "typescript" }
    };
    expect(resolveCommandTarget(undefined)).toBeNull();
  });

  test("无参数且无活动编辑器时拒绝", () => {
    expect(resolveCommandTarget(undefined)).toBeNull();
  });
});