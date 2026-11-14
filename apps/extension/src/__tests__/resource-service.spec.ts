/**
 * 资源策略、缓存与解析服务测试（ARC-008 §6 / §7，STORY-08-01 / 08-03）。
 *
 * 端口全部注入：stat / realpath / workspaceFolders / webview URI 转换器，
 * 因此五个资源错误码的触发条件都能被确定性断言，而不是靠真实文件系统。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import type * as vscode from "vscode";
import { READORA_ERROR_CODES, type ResourceKind } from "@readora/contracts";
import { Uri as StubUri } from "../__stubs__/vscode";
import {
  canonicalFileUri,
  contentVersion,
  versionedFileUri,
  asWebviewResourceUri,
  type WebviewUriTarget
} from "../resources/webview-uri";
import {
  BYTES_PER_MB,
  classifyExternalReference,
  createResourcePolicy,
  decideExternalReference,
  decideMimeType,
  DEFAULT_MAX_IMAGE_MB,
  mimeTypeForPath,
  type ResourcePolicy
} from "../resources/resource-policy";
import {
  resourceCacheKey,
  ResourceCache,
  RESOURCE_CACHE_CAPACITY
} from "../resources/cache";
import {
  computeResourceId,
  ResourceService,
  type InlineReadOutcome,
  type ResourceResolveOutcome,
  type ResourceServicePorts,
  type ResourceStat
} from "../resources/resource-service";

const DOC = "file:///docs/src/read.md";
const LOGO = "/docs/src/assets/logo.png";

/** 直接用 stub 的 Uri 类：与 mock 后的 "vscode" 是同一个实现。 */
function stubUri(value: string): vscode.Uri {
  return StubUri.parse(value) as unknown as vscode.Uri;
}

/** 拒绝原因取值；放行本身就是测试失败。 */
function denialOf(
  policy: ResourcePolicy,
  fsPath: string,
  kind: ResourceKind
): "unsupported" | "denied" {
  const decision = decideMimeType(policy, fsPath, kind);
  if (decision.allowed) {
    throw new Error(`expected ${fsPath} to be rejected for kind=${kind}`);
  }
  return decision.denial;
}

interface FakeFile {
  size: number;
  mtimeMs: number;
  isFile?: boolean;
  /** 导出内联读到的字节；缺省按 size 个零字节算（测试只关心长度与 base64 能否对齐）。 */
  bytes?: Uint8Array;
}

interface Harness {
  ports: ResourceServicePorts;
  service: ResourceService;
  policy: ResourcePolicy;
  statPaths: string[];
  realpathPaths: string[];
  readPaths: string[];
  resolve(reference: string, kind?: ResourceKind): Promise<ResourceResolveOutcome>;
  readInline(reference: string, kind?: ResourceKind): Promise<InlineReadOutcome>;
}

function toWebview(uri: vscode.Uri): string {
  return `https://webview.invalid${uri.path}${uri.query.length > 0 ? `?${uri.query}` : ""}`;
}

function createHarness(
  files: Record<string, FakeFile>,
  options: {
    policy?: Parameters<typeof createResourcePolicy>[0];
    links?: Record<string, string>;
    folders?: string[];
  } = {}
): Harness {
  const policy = createResourcePolicy(options.policy ?? {});
  const statPaths: string[] = [];
  const realpathPaths: string[] = [];
  const readPaths: string[] = [];
  const ports: ResourceServicePorts = {
    policy: () => policy,
    async stat(uri) {
      statPaths.push(uri.path);
      const file = files[uri.path];
      if (!file) {
        return null;
      }
      const stat: ResourceStat = {
        size: file.size,
        mtimeMs: file.mtimeMs,
        isFile: file.isFile ?? true
      };
      return stat;
    },
    async readFile(uri) {
      readPaths.push(uri.path);
      const file = files[uri.path];
      if (!file) {
        return null;
      }
      return file.bytes ?? new Uint8Array(file.size);
    },
    async realpath(path) {
      realpathPaths.push(path);
      const link = options.links?.[path];
      if (link !== undefined) {
        return link;
      }
      if (path.includes("broken")) {
        throw new Error("ENOENT");
      }
      return path;
    },
    workspaceFolders: () => options.folders ?? ["/docs"]
  };
  const service = new ResourceService(ports);
  return {
    ports,
    service,
    policy,
    statPaths,
    realpathPaths,
    readPaths,
    resolve: (reference, kind = "image") =>
      service.resolve({ documentUri: DOC, reference, kind, asWebviewUri: toWebview }),
    readInline: (reference, kind = "image") =>
      service.readInline({ documentUri: DOC, reference, kind })
  };
}

describe("resource-policy", () => {
  test("默认策略：位图与 SVG 放行、外部与 data: 关闭、上限 10 MB", () => {
    const policy = createResourcePolicy();
    expect(policy.allowWorkspaceResources).toBe(true);
    expect(policy.allowExternalImages).toBe(false);
    expect(policy.allowDataImages).toBe(false);
    expect(policy.allowSvg).toBe(true);
    expect(policy.maxResourceSize).toBe(DEFAULT_MAX_IMAGE_MB * BYTES_PER_MB);
    expect(policy.allowedMimeTypes).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "text/markdown"
    ]);
  });

  test("maxImageSizeMb 越界与非法值都回退到安全区间", () => {
    expect(createResourcePolicy({ maxImageSizeMb: 0 }).maxResourceSize).toBe(1 * BYTES_PER_MB);
    expect(createResourcePolicy({ maxImageSizeMb: 999 }).maxResourceSize).toBe(
      50 * BYTES_PER_MB
    );
    expect(createResourcePolicy({ maxImageSizeMb: Number.NaN }).maxResourceSize).toBe(
      DEFAULT_MAX_IMAGE_MB * BYTES_PER_MB
    );
  });

  test("策略版本随配置变化，SVG 关闭时白名单同步收缩", () => {
    const withSvg = createResourcePolicy();
    const withoutSvg = createResourcePolicy({ allowSvg: false });
    expect(withoutSvg.allowedMimeTypes).not.toContain("image/svg+xml");
    expect(withoutSvg.version).not.toBe(withSvg.version);
    expect(createResourcePolicy({ maxImageSizeMb: 20 }).version).not.toBe(withSvg.version);
  });

  test("mimeTypeForPath 认扩展名、忽略大小写、拒绝只有目录点号的路径", () => {
    expect(mimeTypeForPath("/a/b.PNG")).toBe("image/png");
    expect(mimeTypeForPath("b.jpeg")).toBe("image/jpeg");
    expect(mimeTypeForPath("x.markdown")).toBe("text/markdown");
    expect(mimeTypeForPath("no-extension")).toBeNull();
    expect(mimeTypeForPath("/v1.2/config")).toBeNull();
    expect(mimeTypeForPath("evil.exe")).toBeNull();
  });

  test("decideMimeType 区分能力边界与授权边界", () => {
    const policy = createResourcePolicy();
    expect(decideMimeType(policy, LOGO, "image")).toEqual({ allowed: true, mimeType: "image/png" });
    expect(denialOf(policy, "/docs/src/read.md", "image")).toBe("unsupported");
    expect(denialOf(policy, LOGO, "document")).toBe("unsupported");
    expect(decideMimeType(policy, "/docs/a.md", "document")).toEqual({
      allowed: true,
      mimeType: "text/markdown"
    });
    expect(denialOf(createResourcePolicy({ allowSvg: false }), "/docs/a.svg", "image")).toBe(
      "denied"
    );
  });

  test("外部引用分类：data 与 http(s)、协议相对", () => {
    expect(classifyExternalReference("data:image/png;base64,AA")).toBe("data");
    expect(classifyExternalReference("https://cdn/a.png")).toBe("external");
    expect(classifyExternalReference("//cdn/a.png")).toBe("external");
    expect(classifyExternalReference("./a.png")).toBeNull();
  });

  test("外部引用默认拒绝，策略放开后仍声明 M3 不支持", () => {
    expect(decideExternalReference(createResourcePolicy(), "https://cdn/a.png").allowed).toBe(
      false
    );
    expect(decideExternalReference(createResourcePolicy(), "data:image/png;base64,AA").allowed).toBe(
      false
    );
    expect(
      decideExternalReference(
        createResourcePolicy({ allowExternalImages: true }),
        "https://cdn/a.png"
      ).allowed
    ).toBe(true);
  });
});

describe("webview-uri 与缓存", () => {
  test("版本号由 mtime 与 size 组成，取整后可读", () => {
    expect(contentVersion({ mtimeMs: 1.9, size: 3 })).toBe("1-3");
    expect(contentVersion({ mtimeMs: 1_700_000_000_000, size: 1024 })).toBe(
      `${(1_700_000_000_000).toString(36)}-${(1024).toString(36)}`
    );
  });

  test("query 参与寻址：内容变化后 URI 字符串必然不同", () => {
    const file = stubUri("file:///docs/src/assets/logo.png#frag");
    const first = versionedFileUri(file, { mtimeMs: 100, size: 2048 });
    const second = versionedFileUri(file, { mtimeMs: 101, size: 2048 });
    const version = contentVersion({ mtimeMs: 100, size: 2048 });
    expect(first.query).toBe(version);
    expect(first.fragment).toBe("");
    expect(first.toString()).toContain(`?${version}`);
    expect(second.toString()).not.toBe(first.toString());

    const panelLike: WebviewUriTarget = {
      asWebviewUri: (uri) =>
        stubUri(
          `https://stub.vscode-cdn.net${uri.path}${
            uri.query.length > 0 ? `?${uri.query}` : ""
          }`
        )
    };
    expect(asWebviewResourceUri(panelLike, first, { mtimeMs: 100, size: 2048 })).toBe(
      `https://stub.vscode-cdn.net/docs/src/assets/logo.png?${version}`
    );
    expect(canonicalFileUri(first).query).toBe("");
    expect(canonicalFileUri(first).path).toBe("/docs/src/assets/logo.png");
  });

  test("缓存键含 URI / mtime / size / 策略版本，任一变化即新条目", () => {
    const base = { uri: "file:///a.png", mtimeMs: 1, size: 2, policyVersion: "p1" };
    const key = resourceCacheKey(base);
    expect(resourceCacheKey(base)).toBe(key);
    expect(resourceCacheKey({ ...base, mtimeMs: 2 })).not.toBe(key);
    expect(resourceCacheKey({ ...base, size: 3 })).not.toBe(key);
    expect(resourceCacheKey({ ...base, policyVersion: "p2" })).not.toBe(key);
    expect(resourceCacheKey({ ...base, uri: "file:///b.png" })).not.toBe(key);
  });

  test("LRU 到容量即淘汰最久未用，命中会刷新新近度", () => {
    const cache = new ResourceCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.invalidate("a")).toBe(true);
    expect(cache.invalidate("a")).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.keys()).toEqual([]);
    expect(RESOURCE_CACHE_CAPACITY).toBe(256);
    expect(() => new ResourceCache<number>(0)).toThrow();
  });

  test("默认容量 256 条以内不丢，超出后按序淘汰", () => {
    const cache = new ResourceCache<number>();
    for (let index = 0; index < RESOURCE_CACHE_CAPACITY; index += 1) {
      cache.set(`k${index.toString()}`, index);
    }
    expect(cache.size).toBe(RESOURCE_CACHE_CAPACITY);
    cache.set("extra", 1);
    expect(cache.size).toBe(RESOURCE_CACHE_CAPACITY);
    expect(cache.get("k0")).toBeUndefined();
  });
});

describe("ResourceService 解析链", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness({
      [LOGO]: { size: 2048, mtimeMs: 100 },
      "/docs/src/read.md": { size: 300, mtimeMs: 50 },
      "/docs/assets/wide.png": { size: 10, mtimeMs: 10 },
      "/docs/src/a.svg": { size: 10, mtimeMs: 10 },
      "/docs/src/tool.exe": { size: 10, mtimeMs: 10 },
      "/docs/src/huge.png": { size: 20 * BYTES_PER_MB, mtimeMs: 10 },
      "/docs/src/notes.txt": { size: 10, mtimeMs: 10 },
      "/docs/src/dir.png": { size: 10, mtimeMs: 10, isFile: false },
      "/docs/src/broken-link.png": { size: 10, mtimeMs: 10 },
      "/etc/passwd.png": { size: 10, mtimeMs: 10 }
    });
  });

  test("成功解析：webview URI 带版本号，本地绝对路径不外泄", async () => {
    const version = contentVersion({ mtimeMs: 100, size: 2048 });
    const outcome = await harness.resolve("assets/logo.png");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result).toEqual({
      resourceId: computeResourceId(LOGO),
      webviewUri: `https://webview.invalid${LOGO}?${version}`,
      mimeType: "image/png",
      kind: "image",
      byteSize: 2048,
      version
    });
    expect(outcome.result.webviewUri).not.toContain("file:");
    expect(outcome.result.resourceId).toMatch(/^res-[0-9a-f]{16}$/);
  });

  test("resourceId 只暴露摘要：同路径稳定、异路径不同", () => {
    expect(computeResourceId(LOGO)).toBe(computeResourceId(LOGO));
    expect(computeResourceId("/docs/src/other.png")).not.toBe(computeResourceId(LOGO));
  });

  test("每次 resolve 先 stat：内容变更不可能命中陈旧缓存", async () => {
    const first = await harness.resolve("assets/logo.png");
    expect(harness.statPaths).toEqual([LOGO]);
    const second = await harness.resolve("assets/logo.png");
    expect(harness.statPaths).toEqual([LOGO, LOGO]);
    if (!first.ok || !second.ok) {
      throw new Error("expected both resolutions to succeed");
    }
    expect(second.result.version).toBe(first.result.version);
    // 缓存只省掉重复求摘要与 MIME 推导，绝不跳过 boundary：
    // 键不含文档作用域，跳过校验等于把 A 文档的授权结果复用给 B 文档。
    expect(harness.realpathPaths).toEqual([LOGO, LOGO]);
    expect(harness.service.cacheSize).toBe(1);

    const files: Record<string, FakeFile> = { [LOGO]: { size: 4096, mtimeMs: 100 } };
    const changed = createHarness(files);
    const third = await changed.resolve("assets/logo.png");
    if (!third.ok) {
      throw new Error("expected resolution to succeed");
    }
    expect(third.result.byteSize).toBe(4096);
    expect(third.result.version).toBe(contentVersion({ mtimeMs: 100, size: 4096 }));
  });

  test("clearCache 后重新走完整校验", async () => {
    await harness.resolve("assets/logo.png");
    harness.service.clearCache();
    expect(harness.service.cacheSize).toBe(0);
    await harness.resolve("assets/logo.png");
    expect(harness.realpathPaths).toEqual([LOGO, LOGO]);
  });

  test("文件不存在 → resource.notFound", async () => {
    const outcome = await harness.resolve("assets/missing.png");
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(!outcome.ok && outcome.message).toContain("missing.png");
  });

  test("目录不是文件 → resource.notFound", async () => {
    const outcome = await harness.resolve("dir.png");
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  test("超过大小上限 → resource.tooLarge，且不外发 URI", async () => {
    const outcome = await harness.resolve("huge.png");
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_TOO_LARGE);
    expect(!outcome.ok && outcome.message).toContain(String(20 * BYTES_PER_MB));
    // 大小闸门在授权校验之后、生成 URI 之前：拒绝时不产生任何可访问地址。
    expect(harness.statPaths).toEqual(["/docs/src/huge.png"]);
    expect(harness.service.cacheSize).toBe(0);
  });

  test("stat 抛错 → resource.unreadable", async () => {
    const ports: ResourceServicePorts = {
      policy: () => createResourcePolicy(),
      stat: async () => {
        throw new Error("EACCES");
      },
      readFile: async () => new Uint8Array(1),
      realpath: async (path) => path,
      workspaceFolders: () => ["/docs"]
    };
    const outcome = await new ResourceService(ports).resolve({
      documentUri: DOC,
      reference: "assets/logo.png",
      kind: "image",
      asWebviewUri: toWebview
    });
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_UNREADABLE);
    expect(!outcome.ok && outcome.message).toContain("EACCES");
  });

  test("编码穿越出根 → resource.denied", async () => {
    for (const reference of [
      "../../etc/passwd.png",
      "..%2f..%2fetc%2fpasswd.png",
      "..\\..\\etc\\passwd.png"
    ]) {
      const outcome = await harness.resolve(reference);
      expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    }
  });

  test("符号链接逃逸与无法 canonicalize 都拒绝", async () => {
    const escaping = createHarness(
      { "/docs/src/escape.png": { size: 10, mtimeMs: 1 } },
      { links: { "/docs/src/escape.png": "/home/other/private/secret.png" } }
    );
    const outcome = await escaping.resolve("escape.png");
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    expect(escaping.realpathPaths).toEqual(["/docs/src/escape.png"]);

    const broken = await harness.resolve("broken-link.png");
    expect(!broken.ok && broken.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
  });

  test("工作区资源总开关关闭时全部拒绝", async () => {
    const closed = createHarness(
      { [LOGO]: { size: 10, mtimeMs: 1 } },
      { policy: { allowWorkspaceResources: false } }
    );
    const outcome = await closed.resolve("assets/logo.png");
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain("allowWorkspaceResources");
    }
  });

  test("未识别扩展名 → resource.unsupported；被关掉的 SVG → resource.denied", async () => {
    const unknown = await harness.resolve("tool.exe");
    expect(!unknown.ok && unknown.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
    const text = await harness.resolve("notes.txt");
    expect(!text.ok && text.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);

    const noSvg = createHarness({ "/docs/src/a.svg": { size: 10, mtimeMs: 1 } }, {
      policy: { allowSvg: false }
    });
    const denied = await noSvg.resolve("a.svg");
    expect(!denied.ok && denied.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
  });

  test("外部与 data: 引用先过策略：默认拒绝，放开后声明不支持", async () => {
    const blocked = await harness.resolve("https://cdn.example.com/a.png");
    expect(!blocked.ok && blocked.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);

    const opened = createHarness(
      { [LOGO]: { size: 10, mtimeMs: 1 } },
      { policy: { allowExternalImages: true, allowDataImages: true } }
    );
    const unsupported = await opened.resolve("https://cdn.example.com/a.png");
    expect(!unsupported.ok && unsupported.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
    const data = await opened.resolve("data:image/png;base64,AAAA");
    expect(!data.ok && data.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
  });

  test("绝对 file: 引用与空引用都拒绝，不猜测路径", async () => {
    const absolute = await harness.resolve("file:///etc/passwd.png");
    expect(!absolute.ok && absolute.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    const empty = await harness.resolve("   ");
    expect(!empty.ok && empty.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
    const anchor = await harness.resolve("#section");
    expect(!anchor.ok && anchor.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
  });

  test("kind=document 只接受 Markdown", async () => {
    const md = await harness.service.resolveDocument({
      documentUri: DOC,
      reference: "read.md"
    });
    expect(md.ok).toBe(true);
    if (md.ok) {
      expect(md.uri.path).toBe("/docs/src/read.md");
    }
    const png = await harness.service.resolveDocument({
      documentUri: DOC,
      reference: "assets/logo.png"
    });
    expect(!png.ok && png.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
  });

  test("上级目录的 Markdown 在工作区根内可解析", async () => {
    const outcome = await harness.service.resolveDocument({
      documentUri: DOC,
      reference: "../guide.md"
    });
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_NOT_FOUND);
    const withFile = createHarness({ "/docs/guide.md": { size: 5, mtimeMs: 1 } });
    const ok = await withFile.service.resolveDocument({
      documentUri: DOC,
      reference: "../guide.md"
    });
    expect(ok.ok).toBe(true);
  });

  test("非 file 文档没有解析基准", async () => {
    const outcome = await harness.service.resolve({
      documentUri: "untitled:Untitled-1",
      reference: "a.png",
      kind: "image",
      asWebviewUri: toWebview
    });
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
  });
});

describe("readInline：M11 导出内联的唯一字节出口", () => {
  // 这条通道存在的全部理由就是「与屏上同源」：任何一扇门被绕过，导出件就能带上
  // 屏幕上看不到的东西。因此下面逐条拿与 resolve 同一批用例去问 readInline。
  const PNG_HEAD = Uint8Array.from([137, 80, 78, 71]);
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness({
      [LOGO]: { size: PNG_HEAD.length, mtimeMs: 100, bytes: PNG_HEAD },
      "/docs/src/a.svg": { size: 10, mtimeMs: 10 },
      "/docs/src/tool.exe": { size: 10, mtimeMs: 10 },
      "/docs/src/huge.png": { size: 20 * BYTES_PER_MB, mtimeMs: 10 },
      "/docs/src/missing.png": { size: 0, mtimeMs: 1 },
      "/docs/src/broken-link.png": { size: 10, mtimeMs: 10 },
      "/etc/passwd.png": { size: 10, mtimeMs: 10 }
    });
  });

  test("放行时只给 MIME 与 base64：结果里一个路径字符都不出现", async () => {
    const outcome = await harness.readInline("assets/logo.png");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.mimeType).toBe("image/png");
    expect(outcome.base64).toBe("iVBORw==");
    expect([...Buffer.from(outcome.base64, "base64")]).toEqual([...PNG_HEAD]);
    // ARC-008 §7.3：交付物里不能出现本地地址，连回传都不行。
    expect(JSON.stringify(outcome)).not.toMatch(/\/docs|file:/);
  });

  test("与屏上同源：resolve 与 readInline 在同一批引用上给出同一个结论", async () => {
    const references = [
      "assets/logo.png",
      "a.svg",
      "tool.exe",
      "huge.png",
      "https://cdn.example.com/a.png",
      "../../etc/passwd.png",
      "file:///etc/passwd.png",
      "missing.png"
    ];
    for (const reference of references) {
      const shown = await harness.resolve(reference);
      const inline = await harness.readInline(reference);
      expect(inline.ok).toBe(shown.ok);
      if (!shown.ok && !inline.ok) {
        expect(inline.code).toBe(shown.code);
      }
    }
  });

  test("拒绝的时候一个字节都不读：readPaths 全程为空", async () => {
    await harness.readInline("https://cdn.example.com/a.png");
    await harness.readInline("../../etc/passwd.png");
    await harness.readInline("tool.exe");
    await harness.readInline("huge.png");
    expect(harness.readPaths).toEqual([]);
  });

  test("符号链接逃逸与断裂链接都拒绝，不给第二次机会", async () => {
    const escaping = createHarness(
      { [LOGO]: { size: PNG_HEAD.length, mtimeMs: 100, bytes: PNG_HEAD } },
      { links: { [LOGO]: "/home/other/private/secret.png" } }
    );
    const outcome = await escaping.readInline("assets/logo.png");
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    expect(escaping.readPaths).toEqual([]);
    const broken = await harness.readInline("broken-link.png");
    expect(!broken.ok && broken.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
  });

  test("工作区资源总开关关闭时 readInline 也得不到字节", async () => {
    const closed = createHarness(
      { [LOGO]: { size: PNG_HEAD.length, mtimeMs: 100, bytes: PNG_HEAD } },
      { policy: { allowWorkspaceResources: false } }
    );
    const outcome = await closed.readInline("assets/logo.png");
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    expect(closed.readPaths).toEqual([]);
  });

  test("maxImageSizeMb 收紧后同一张图变太大：闸门与屏上共用同一个配置", async () => {
    const files = { [LOGO]: { size: 2 * BYTES_PER_MB, mtimeMs: 1 } };
    const tight = createHarness(files, { policy: { maxImageSizeMb: 1 } });
    const tooBig = await tight.readInline("assets/logo.png");
    expect(!tooBig.ok && tooBig.code).toBe(READORA_ERROR_CODES.RESOURCE_TOO_LARGE);
    expect(!tooBig.ok && tooBig.message).toContain(String(1 * BYTES_PER_MB));

    const loose = createHarness(files);
    const fine = await loose.readInline("assets/logo.png");
    expect(fine.ok).toBe(true);
  });

  test("notFound 的 message 只给短名，不给绝对路径", async () => {
    const outcome = await harness.service.readInline({
      documentUri: DOC,
      reference: "assets/nope.png",
      kind: "image"
    });
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(!outcome.ok && outcome.message).toContain("nope.png");
    expect(!outcome.ok && outcome.message).not.toContain("/docs");
  });

  test("stat 过了但字节读不到（竞态删除）→ unreadable 或 notFound，不抛错", async () => {
    const ports: ResourceServicePorts = {
      policy: () => createResourcePolicy(),
      stat: async () => ({ size: PNG_HEAD.length, mtimeMs: 1, isFile: true }),
      readFile: async () => null,
      realpath: async (path) => path,
      workspaceFolders: () => ["/docs"]
    };
    const outcome = await new ResourceService(ports).readInline({
      documentUri: DOC,
      reference: "assets/logo.png",
      kind: "image"
    });
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  test("读字节抛错 → unreadable，原因原样带出（不翻成成功也不丢）", async () => {
    const ports: ResourceServicePorts = {
      policy: () => createResourcePolicy(),
      stat: async () => ({ size: PNG_HEAD.length, mtimeMs: 1, isFile: true }),
      readFile: async () => {
        throw new Error("EACCES");
      },
      realpath: async (path) => path,
      workspaceFolders: () => ["/docs"]
    };
    const outcome = await new ResourceService(ports).readInline({
      documentUri: DOC,
      reference: "assets/logo.png",
      kind: "image"
    });
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_UNREADABLE);
    expect(!outcome.ok && outcome.message).toContain("EACCES");
  });

  test("kind=document 也走同一条 plan：非 Markdown 一律 unsupported", async () => {
    const asImage = await harness.readInline("assets/logo.png", "image");
    expect(asImage.ok).toBe(true);
    const asDocument = await harness.readInline("assets/logo.png", "document");
    expect(!asDocument.ok && asDocument.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
    const md = await harness.readInline("read.md", "document");
    expect(!md.ok && md.code).toBe(READORA_ERROR_CODES.RESOURCE_NOT_FOUND);
  });
});
