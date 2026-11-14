/**
 * Wiki Link 的 Host 侧解析测试（IMP-001 §12.2 / ARC-008 §7，STORY-06-03）。
 *
 * Webview 只交出 `[[Note]]` 里的 `Note`，**拼路径与存在性检查全在 Host**。
 * 这里锁三件事：
 * 1. 候选生成的判据（补 `.md` / `.markdown` 的边界，以及为什么不碰带点的引用）；
 * 2. 命中顺序与「非 notFound/unsupported 类判定不再问文件系统」的护栏；
 * 3. 全部落空时报 readora.wikilink.missing —— 与 readora.resource.notFound
 *    必须是两个码，否则日志分不清「作者写错了链接」和「图片丢了」。
 *
 * 端口全部注入（stat / realpath / workspaceFolders），断言不依赖真实磁盘。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import { READORA_ERROR_CODES } from "@readora/contracts";
import {
  createResourcePolicy,
  type ResourcePolicyInput
} from "../resources/resource-policy";
import {
  markdownCandidates,
  ResourceService,
  type DocumentTargetOutcome,
  type ResourceServicePorts,
  type ResourceStat
} from "../resources/resource-service";

const DOC = "file:///docs/src/read.md";

function baseName(value: string): string {
  return value.split("/").pop() ?? value;
}

/**
 * Outcome 里的 `uri` 是 vscode.Uri，stub 与真实 vscode.Uri 都能提供 path。
 * 断言只读 path，不去比较对象身份 —— Host 给 Webview 的答案永远是错误码，
 * 路径本身从不回传（这条由 document-delivery 的用例锁，不在这里重复）。
 */
function pathOf(outcome: DocumentTargetOutcome): string {
  if (!outcome.ok) {
    throw new Error(`expected ok, got ${outcome.code}: ${outcome.message}`);
  }
  return outcome.uri.path;
}

interface Harness {
  service: ResourceService;
  statPaths: string[];
  resolveDocument(reference: string): Promise<DocumentTargetOutcome>;
}

function createHarness(
  files: Record<string, FakeFileSpec>,
  options: { policy?: ResourcePolicyInput } = {}
): Harness {
  const statPaths: string[] = [];
  const ports: ResourceServicePorts = {
    policy: () => createResourcePolicy(options.policy),
    async stat(uri) {
      statPaths.push(uri.path);
      const file = files[uri.path];
      if (!file) {
        return null;
      }
      const stat: ResourceStat = { size: file.size, mtimeMs: file.mtimeMs, isFile: true };
      return stat;
    },
    async realpath(path) {
      return path;
    },
    // 本文件只测跳转解析，从不读字节：谁在这里调了 readFile 就该当场报错，
    // 而不是拿到一份没人核对过的零字节。
    async readFile(): Promise<Uint8Array | null> {
      throw new Error("readFile is not expected in wikilink resolution");
    },
    workspaceFolders: () => ["/docs"]
  };
  const service = new ResourceService(ports);
  return {
    service,
    statPaths,
    resolveDocument: (reference) => service.resolveDocument({ documentUri: DOC, reference })
  };
}

interface FakeFileSpec {
  size: number;
  mtimeMs: number;
}

const MD: FakeFileSpec = { size: 42, mtimeMs: 3 };

describe("markdownCandidates：什么引用值得补扩展名", () => {
  test("不带点的名补两个候选，顺序 .md 在前", () => {
    expect(markdownCandidates("Note")).toEqual(["Note.md", "Note.markdown"]);
    expect(markdownCandidates("notes/Archive")).toEqual([
      "notes/Archive.md",
      "notes/Archive.markdown"
    ]);
  });

  test("带扩展名的引用一个候选都不补：那是作者点名的文件", () => {
    for (const reference of ["a.md", "assets/logo.png", "archive.tar.gz", "Note.v2"]) {
      expect(markdownCandidates(reference), reference).toEqual([]);
    }
  });

  test("带查询串或锚点的引用不补候选：那不是笔记名", async () => {
    expect(markdownCandidates("Note?x=1")).toEqual([]);
    expect(markdownCandidates("Note#intro")).toEqual([]);
    expect(markdownCandidates("Note.md#intro")).toEqual([]);
    // 少了这一条护栏，`[说明](Note#intro)` 这类普通相对链接会被补成
    // `Note#intro.md` —— resolveReference 剥掉锚点后绕回同一个路径，
    // 白探两次文件系统，还把错误码从 resource.notFound 换成 wikilink.missing。
    const harness = createHarness({ "/docs/src/Note": { size: 5, mtimeMs: 1 } });
    const outcome = await harness.resolveDocument("Note#intro");
    expect(outcome.ok ? "ok" : outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
    expect(harness.statPaths).toEqual(["/docs/src/Note"]);
  });

  test("空引用与只有点的名不补（避免造出 `.md` 这种寻父写法）", () => {
    expect(markdownCandidates("")).toEqual([]);
    expect(markdownCandidates("   ")).toEqual([]);
    expect(markdownCandidates(".")).toEqual([]);
    expect(markdownCandidates("..")).toEqual([]);
  });
});

describe("resolveDocument 的候选解析", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness({});
  });

  test("[[Note]] 命中同目录的 Note.md", async () => {
    harness = createHarness({ "/docs/src/Note.md": MD });
    expect(pathOf(await harness.resolveDocument("Note"))).toBe("/docs/src/Note.md");
  });

  test("只有 Note.markdown 时命中第二个候选", async () => {
    harness = createHarness({ "/docs/src/Note.markdown": MD });
    expect(pathOf(await harness.resolveDocument("Note"))).toBe("/docs/src/Note.markdown");
  });

  test("两个候选都在时 .md 优先，且不额外探测 .markdown", async () => {
    harness = createHarness({
      "/docs/src/Note.md": MD,
      "/docs/src/Note.markdown": MD
    });
    expect(pathOf(await harness.resolveDocument("Note"))).toBe("/docs/src/Note.md");
    expect(harness.statPaths).toEqual(["/docs/src/Note", "/docs/src/Note.md"]);
  });

  test("跨目录 wiki 引用以当前文档目录为基准", async () => {
    harness = createHarness({ "/docs/notes/Archive.md": MD });
    expect(pathOf(await harness.resolveDocument("../notes/Archive"))).toBe(
      "/docs/notes/Archive.md"
    );
  });

  test("全部落空报 readora.wikilink.missing，并把试过的名字写进消息", async () => {
    const outcome = await harness.resolveDocument("Note");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe(READORA_ERROR_CODES.WIKILINK_MISSING);
    expect(outcome.message).toContain("[[Note]]");
    expect(baseName(outcome.message)).toContain("Note.markdown");
    // 三个都问过了：原文 + 两个候选。
    expect(harness.statPaths).toEqual([
      "/docs/src/Note",
      "/docs/src/Note.md",
      "/docs/src/Note.markdown"
    ]);
  });

  test("同名无扩展文件存在时仍是 Note.md 赢", async () => {
    // 这一条锁住上一轮我自己写错的注释口径：`Note`（无扩展名）过不了
    // document 的 MIME 判定，属于「不是可读 Markdown」，必须继续补候选。
    harness = createHarness({
      "/docs/src/Note": { size: 10, mtimeMs: 1 },
      "/docs/src/Note.md": MD
    });
    expect(pathOf(await harness.resolveDocument("Note"))).toBe("/docs/src/Note.md");
  });

  test("带扩展名的引用不被改写：notFound 与 unsupported 各自保留", async () => {
    const missing = await harness.resolveDocument("nope.md");
    expect(missing.ok ? "ok" : missing.code).toBe(READORA_ERROR_CODES.RESOURCE_NOT_FOUND);

    harness = createHarness({ "/docs/src/assets/logo.png": { size: 8, mtimeMs: 1 } });
    const image = await harness.resolveDocument("assets/logo.png");
    expect(image.ok ? "ok" : image.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
    // 带点的引用一次都不许多问：候选表为空，不存在 logo.png.md 的探测。
    expect(harness.statPaths).toEqual(["/docs/src/assets/logo.png"]);
  });

  test("越出授权根的 wiki 引用报 denied，且不逐个候选重复探测", async () => {
    harness = createHarness({ "/etc/secret.md": MD });
    const outcome = await harness.resolveDocument("../../etc/secret");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    // 原文那一试是「不存在」，`.md` 那一试才撞上 boundary 的拒绝；
    // 拿到 denied 之后必须立刻收手 —— `.markdown` 在同一目录下不会有别的结论。
    expect(harness.statPaths).toEqual(["/etc/secret", "/etc/secret.md"]);
  });

  test("工作区资源被关闭时 denied 直接返回，不去试两个候选", async () => {
    harness = createHarness(
      { "/docs/src/Note.md": MD },
      { policy: { allowWorkspaceResources: false } }
    );
    const outcome = await harness.resolveDocument("Note");
    expect(outcome.ok ? "ok" : outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    expect(harness.statPaths).toEqual([]);
  });
});
