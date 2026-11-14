/**
 * 相对引用解析与授权根边界测试（ARC-008 §5，STORY-08-01）。
 *
 * 关键不变量：解析层只负责「把引用变成绝对路径」，
 * 是否有权读由 boundary 决定。因此编码穿越不会在解析层被漏放，
 * 也不会在解析层被误杀 —— 两层职责分开后断言才站得住。
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import { Uri } from "../__stubs__/vscode";
import {
  authorizedRoots,
  containingWorkspaceFolder,
  isInside,
  isInsideAny,
  normalizeDirectory,
  pathSegments,
  verifyBoundary
} from "../resources/boundary";
import {
  decodeReference,
  documentDirectory,
  isAbsoluteReference,
  resolveReference
} from "../resources/path-resolver";

const DOC = "file:///docs/src/read.md";

function resolved(reference: string, documentUri = DOC): string {
  const outcome = resolveReference({ documentUri }, reference);
  if (!outcome.ok) {
    throw new Error(`unexpected rejection: ${outcome.reason} ${outcome.message}`);
  }
  return outcome.uri.toString();
}

function rejection(reference: string, documentUri = DOC): string {
  const outcome = resolveReference({ documentUri }, reference);
  if (outcome.ok) {
    throw new Error(`unexpected acceptance: ${outcome.uri.toString()}`);
  }
  return outcome.reason;
}

describe("path-resolver 基本解析", () => {
  test("同目录相对引用以文档所在目录为基准", () => {
    expect(resolved("logo.png")).toBe("file:///docs/src/logo.png");
    expect(resolved("./logo.png")).toBe("file:///docs/src/logo.png");
  });

  test("子目录与上级目录引用都能解析", () => {
    expect(resolved("assets/img/logo.png")).toBe("file:///docs/src/assets/img/logo.png");
    expect(resolved("../assets/logo.png")).toBe("file:///docs/assets/logo.png");
  });

  test("空格与 Unicode 名称保持单个 URI 表示", () => {
    expect(resolved("我的 图 片.png", "file:///docs/%E4%B8%AD%E6%96%87/a%20b.md")).toBe(
      "file:///docs/%E4%B8%AD%E6%96%87/%E6%88%91%E7%9A%84%20%E5%9B%BE%20%E7%89%87.png"
    );
  });

  test("URL 编码引用解码后再定位", () => {
    expect(resolved("a%20b.png")).toBe("file:///docs/src/a%20b.png");
    expect(resolved("%E5%9B%BE.png")).toBe("file:///docs/src/%E5%9B%BE.png");
  });

  test("query 与 fragment 不参与文件系统定位", () => {
    expect(resolved("logo.png?v=2#top")).toBe("file:///docs/src/logo.png");
    expect(resolved("logo.png#frag")).toBe("file:///docs/src/logo.png");
  });

  test("反斜杠按分隔符归一，交由 boundary 判定越界", () => {
    expect(resolved("assets\\logo.png")).toBe("file:///docs/src/assets/logo.png");
    expect(resolved("..\\..\\etc\\passwd")).toBe("file:///etc/passwd");
  });

  test("点号段与重复分隔符被 normalize 折叠", () => {
    expect(resolved("././assets//logo.png")).toBe("file:///docs/src/assets/logo.png");
  });

  test("decodeReference 只解码一次，非法编码返回 null", () => {
    expect(decodeReference("a%20b")).toBe("a b");
    expect(decodeReference("%252e%252f")).toBe("%2e%2f");
    expect(decodeReference("%ZZ")).toBeNull();
    expect(decodeReference("plain")).toBe("plain");
  });

  test("isAbsoluteReference 认 scheme 与协议相对", () => {
    expect(isAbsoluteReference("file:///a/b.png")).toBe(true);
    expect(isAbsoluteReference("https://cdn/a.png")).toBe(true);
    expect(isAbsoluteReference("//cdn/a.png")).toBe(true);
    expect(isAbsoluteReference("./a.png")).toBe(false);
    expect(isAbsoluteReference("a.png")).toBe(false);
  });
});

describe("path-resolver 拒绝清单", () => {
  test("空引用与仅锚点引用不是资源", () => {
    expect(rejection("   ")).toBe("empty");
    expect(rejection("#section-2")).toBe("fragment-only");
  });

  test("绝对引用交给链接策略，不走资源解析", () => {
    expect(rejection("https://cdn.example.com/a.png")).toBe("absolute");
    expect(rejection("file:///etc/passwd")).toBe("absolute");
    expect(rejection("data:image/png;base64,AAAA")).toBe("absolute");
    expect(rejection("//cdn.example.com/a.png")).toBe("absolute");
  });

  test("非法百分号编码直接拒（不得猜测原意）", () => {
    expect(rejection("a%2.png")).toBe("undecodable");
  });

  test("非 file 文档与无目录文档没有解析基准", () => {
    expect(rejection("a.png", "untitled:Untitled-1")).toBe("outside-document");
    expect(rejection("a.png", "vscode-userdata:/c/x.md")).toBe("outside-document");
  });

  test("documentDirectory 只承认带目录的 file URI", () => {
    expect(documentDirectory(DOC)?.path).toBe("/docs/src");
    expect(documentDirectory("file:///read.md")?.path).toBe("/");
    expect(documentDirectory("untitled:x.md")).toBeNull();
  });
});

describe("boundary 授权根", () => {
  test("isInside 按路径段比较，不用字符串前缀", () => {
    expect(isInside("/docs/src/a.png", "/docs/src")).toBe(true);
    expect(isInside("/docs/src", "/docs/src")).toBe(true);
    expect(isInside("/docs/src-secret/a.png", "/docs/src")).toBe(false);
    expect(isInside("/docs/a.png", "/docs/src")).toBe(false);
    expect(isInside("/etc/passwd", "/docs/src")).toBe(false);
  });

  test("normalizeDirectory 去尾斜杠并折叠冗余段", () => {
    expect(normalizeDirectory("/docs/src/")).toBe("/docs/src");
    expect(normalizeDirectory("/docs//./src")).toBe("/docs/src");
    expect(normalizeDirectory("/")).toBe("/");
    expect(pathSegments("/docs/src/a.png")).toEqual(["docs", "src", "a.png"]);
  });

  test("isInsideAny 命中任一根即通过", () => {
    expect(isInsideAny("/assets/logo.png", ["/docs/src", "/docs"])).toBe(false);
    expect(isInsideAny("/docs/assets/logo.png", ["/docs/src", "/docs"])).toBe(true);
  });

  test("工作区 folder 取包含文档的最深一个", () => {
    expect(
      containingWorkspaceFolder("/docs/src/read.md", ["/", "/docs", "/docs/src", "/other"])
    ).toBe("/docs/src");
    expect(containingWorkspaceFolder("/docs/src/read.md", ["/docs"])).toBe("/docs");
    expect(containingWorkspaceFolder("/elsewhere/read.md", ["/docs"])).toBeNull();
  });

  test("授权根 = 文档目录 + 所属工作区 folder", () => {
    expect(authorizedRoots(DOC, ["/docs"])).toEqual(["/docs/src", "/docs"]);
    expect(authorizedRoots(DOC, [])).toEqual(["/docs/src"]);
    expect(authorizedRoots(DOC, ["/docs/src"])).toEqual(["/docs/src"]);
    expect(authorizedRoots("untitled:x.md", ["/docs"])).toEqual([]);
  });

  test("../ 形式在根内放行、根外拒绝", async () => {
    const inside = await verifyBoundary("/docs/assets/logo.png", DOC, ["/docs"], {
      realpath: async (path) => path
    });
    expect(inside).toEqual({ ok: true, canonicalPath: "/docs/assets/logo.png" });

    const outside = await verifyBoundary("/etc/passwd", DOC, ["/docs"], {
      realpath: async (path) => path
    });
    expect(!outside.ok && outside.reason).toBe("outside-roots");
  });

  test("无工作区 folder 时只允许文档目录之内", async () => {
    const outcome = await verifyBoundary("/docs/assets/logo.png", DOC, [], {
      realpath: async (path) => path
    });
    expect(!outcome.ok && outcome.reason).toBe("outside-roots");
  });

  test("符号链接指向根外必须拒绝（realpath 二次校验）", async () => {
    const outcome = await verifyBoundary("/docs/src/escape-link.png", DOC, ["/docs"], {
      realpath: async () => "/home/other/private/secret.png"
    });
    expect(!outcome.ok && outcome.reason).toBe("symlink-escape");
  });

  test("realpath 失败按拒绝处理，不放行未验证路径", async () => {
    const outcome = await verifyBoundary("/docs/src/a.png", DOC, ["/docs"], {
      realpath: async () => {
        throw new Error("ENOENT");
      }
    });
    expect(!outcome.ok && outcome.reason).toBe("symlink-escape");
  });

  test("根目录作为唯一根时任何绝对路径都在根内", async () => {
    const outcome = await verifyBoundary("/etc/passwd", "file:///read.md", ["/"], {
      realpath: async (path) => path
    });
    expect(outcome.ok).toBe(true);
  });

  test("Uri 层不参与判定：boundary 只吃 path 字符串", () => {
    const parsed = Uri.parse("file:///docs/src/read.md");
    expect(parsed.path).toBe("/docs/src/read.md");
    expect(parsed.with({ path: "/docs/assets/logo.png" }).toString()).toBe(
      "file:///docs/assets/logo.png"
    );
  });
});
