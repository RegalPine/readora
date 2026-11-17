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
  toSystemPath,
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

/**
 * 跨平台回归锁（初始版本在 macOS 上开发，这一组是欠下的那张账）。
 *
 * 全部用**字符串**造 Windows 形状的路径，不读 `process.platform`、也不碰磁盘，
 * 因此在 macOS / Linux 的 CI 上同样成立。夹具测试只能在 Windows 机器上
 * 跑到盘符分支，那一条盖不住「有人在 POSIX 机器上把转换删掉」这种回退。
 */
describe("boundary 跨平台：Windows 盘符", () => {
  test("toSystemPath 只在盘符形态下剥前导斜杠", () => {
    // POSIX：`/x` 本来就是真路径，动一下就变成相对当前目录的另一条路径。
    expect(toSystemPath("/docs/src/a.png", false)).toBe("/docs/src/a.png");
    expect(toSystemPath("/C:/docs/a.png", false)).toBe("/C:/docs/a.png");
    // Windows：URI 语法多出来的前导斜杠不是路径的一部分。
    expect(toSystemPath("/C:/docs/a.png", true)).toBe("C:/docs/a.png");
    expect(toSystemPath("/c:/docs/a.png", true)).toBe("c:/docs/a.png");
    // 不是盘符开头的串（POSIX 风格、UNC、相对形态）一律原样交出。
    expect(toSystemPath("/docs/a.png", true)).toBe("/docs/a.png");
    expect(toSystemPath("//server/share/a.png", true)).toBe("//server/share/a.png");
    expect(toSystemPath("/", true)).toBe("/");
  });

  test("realpath 收到的是操作系统路径，不是 URI 路径", async () => {
    // 这条是 Windows 上「本地图片全灭」的直接回归锁：`/C:/…` 递给 node:fs
    // 会被当成当前盘根下的 `C:` 目录，ENOENT → boundary 按未验证路径拒绝。
    const asked: string[] = [];
    const outcome = await verifyBoundary(
      "/C:/docs/src/a.png",
      "file:///C%3A/docs/src/read.md",
      ["/C:/docs"],
      {
        realpath: async (path) => {
          asked.push(path);
          return path;
        }
      }
    );
    expect(asked).toEqual(["C:/docs/src/a.png"]);
    expect(outcome.ok).toBe(true);
  });

  test("盘符大小写不一致不算越界，也不放进别的卷", async () => {
    // 宿主给的文档 URI 常是小写盘符，文件系统给的 realpath 回执常是大写：
    // 两道校验吃的是同一个串，只不过来自两侧。
    const seen: string[] = [];
    const outcome = await verifyBoundary(
      "/F:/GitHub/docs/assets/logo.png",
      "file:///f%3A/GitHub/docs/read.md",
      ["/f:/GitHub"],
      {
        realpath: async (path) => {
          seen.push(path);
          return "F:\\GitHub\\docs\\assets\\logo.png";
        }
      }
    );
    expect(seen).toEqual(["F:/GitHub/docs/assets/logo.png"]);
    expect(outcome.ok && outcome.canonicalPath).toBe("F:/GitHub/docs/assets/logo.png");

    // 放宽只到「同一个卷」这一层：换了盘符、或换了目录，仍然照旧拒绝。
    const otherDrive = await verifyBoundary(
      "/F:/GitHub/docs/a.png",
      "file:///d%3A/GitHub/docs/read.md",
      ["/d:/GitHub"],
      { realpath: async (path) => path }
    );
    expect(!otherDrive.ok && otherDrive.reason).toBe("outside-roots");

    const otherDir = await verifyBoundary(
      "/F:/GitHub/other/a.png",
      "file:///f%3A/GitHub/docs/read.md",
      ["/f:/GitHub/docs"],
      { realpath: async (path) => path }
    );
    expect(!otherDir.ok && otherDir.reason).toBe("outside-roots");
  });

  test("符号链接跳到根外：带盘符也拦得住", async () => {
    const outcome = await verifyBoundary(
      "/F:/GitHub/docs/escape.png",
      "file:///f%3A/GitHub/docs/read.md",
      ["/f:/GitHub"],
      { realpath: async () => "D:\\elsewhere\\secret.png" }
    );
    expect(!outcome.ok && outcome.reason).toBe("symlink-escape");
  });

  test("除盘符外仍按大小写敏感比较", () => {
    expect(isInside("/F:/docs/a.png", "/f:/docs")).toBe(true);
    expect(isInside("/docs/Secret/a.png", "/docs/secret")).toBe(false);
    expect(pathSegments("/C:/docs/src/a.png")).toEqual(["c:", "docs", "src", "a.png"]);
    expect(pathSegments("/docs/C:/a.png")).toEqual(["docs", "C:", "a.png"]);
  });

  test("盘符文档的目录不会被算成根目录", () => {
    // `posix.dirname('/C:\\x\\a.md')` 会把整个带反斜杠的串当一个文件名、返回目录 `/`，
    // 于是每条引用都到根目录去找 —— 真机夹具在 Windows 上报 notFound 就是这条路。
    const driveDoc = "file:///f%3A/GitHub/docs/read.md";
    expect(documentDirectory(driveDoc)?.path).toBe("/f:/GitHub/docs");
    expect(resolved("assets/logo.png", driveDoc)).toBe(
      "file:///f%3A/GitHub/docs/assets/logo.png"
    );
    expect(resolved("../other/a.png", driveDoc)).toBe("file:///f%3A/GitHub/other/a.png");
  });

  test("uri.file 与 parse 在盘符上往返一致", () => {
    // parse 不依赖运行平台，这条在任何机器上都能锁住「盘符不被当成文件名的一部分」。
    const parsed = Uri.parse("file:///f%3A/GitHub/docs/read.md");
    expect(parsed.path).toBe("/f:/GitHub/docs/read.md");
    expect(parsed.toString()).toBe("file:///f%3A/GitHub/docs/read.md");
    expect(Uri.parse(parsed.toString()).path).toBe(parsed.path);
  });
});
