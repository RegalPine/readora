/**
 * 真机文件系统夹具测试（IMP-001 §14 Fixture Test，STORY-08-01 / 08-03）。
 *
 * resource-service.spec.ts 把 stat / realpath 全部换成注入端口，
 * 好处是五个错误码都能确定性触发，代价是它从没真的碰过一块磁盘字节。
 * 本文件补上另一半：端口由 node:fs 实现，读的是 tests/fixtures/ 下生成的真图。
 *
 * 于是这些结论只在真机上成立：扩展名大小写、百分号编码能否落到同一个 inode、
 * 缓存版本是否真的跟着 mtime 走、符号链接能不能骗过 boundary。
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { readFile as fsReadFile, realpath, stat as fsStat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import type * as vscode from "vscode";
import { READORA_ERROR_CODES, type ResourceKind, type ResourceResolveResult } from "@readora/contracts";
import { Uri as StubUri } from "../__stubs__/vscode";
import { createResourcePolicy, type ResourcePolicy } from "../resources/resource-policy";
import {
  computeResourceId,
  ResourceService,
  type ResourceResolveOutcome,
  type ResourceServicePorts,
  type ResourceStat
} from "../resources/resource-service";
import { contentVersion } from "../resources/webview-uri";

/** 真实根：仓库路径若含符号链接，boundary 的 realpath 结果会不同于拼接结果。 */
const ROOT = realpathSync(resolve(process.cwd(), "../../tests/fixtures"));
const ASSETS = join(ROOT, "assets");
const OUTSIDE = join(ROOT, "outside");
const ESCAPE_LINK = join(ASSETS, "escape-link.png");

/** 符号链接夹具是否真的存在（Windows 无权限时生成器会跳过）。 */
const SYMLINK = isSymlinkAt(ESCAPE_LINK);

function isSymlinkAt(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    // 非 POSIX 平台建不出链接时夹具文件本身缺席。
    return false;
  }
}

/** 文档放进 assets/ 时，outside/ 才真的落在授权根之外（boundary 的语义）。 */
const DOC_AT_FIXTURES = StubUri.file(join(ROOT, "images.md")).toString();
const DOC_INSIDE_ASSETS = StubUri.file(join(ASSETS, "doc.md")).toString();

function bytesOf(path: string): number {
  return readFileSync(path).byteLength;
}

interface Harness {
  service: ResourceService;
  resolve(
    reference: string,
    options?: { kind?: ResourceKind; documentUri?: string }
  ): Promise<ResourceResolveOutcome>;
  ok(
    reference: string,
    options?: { kind?: ResourceKind; documentUri?: string }
  ): Promise<ResourceResolveResult>;
  /** 失败时返回错误码；成功时返回 null —— 让「哪个分支被走到」成为显式断言。 */
  failureCode(
    reference: string,
    options?: { kind?: ResourceKind; documentUri?: string }
  ): Promise<string | null>;
  statCalls: string[];
}

function createHarness(
  policy: ResourcePolicy,
  workspaceFolders: () => readonly string[]
): Harness {
  const statCalls: string[] = [];
  const ports: ResourceServicePorts = {
    policy: () => policy,
    async stat(uri: vscode.Uri): Promise<ResourceStat | null> {
      statCalls.push(uri.fsPath);
      try {
        const info = await fsStat(uri.fsPath);
        return { size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile() };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
          return null;
        }
        throw error;
      }
    },
    // 真机 realpath：符号链接在这里现出原形。
    realpath: (path: string) => realpath(path),
    /** 真机字节：M11 导出内联走的同一条出口，缺失与不给读同样回 null。 */
    async readFile(uri: vscode.Uri): Promise<Uint8Array | null> {
      try {
        return await fsReadFile(uri.fsPath);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
          return null;
        }
        throw error;
      }
    },
    workspaceFolders
  };
  const service = new ResourceService(ports);
  const run = async (
    reference: string,
    options: { kind?: ResourceKind; documentUri?: string } = {}
  ): Promise<ResourceResolveOutcome> =>
    service.resolve({
      documentUri: options.documentUri ?? DOC_AT_FIXTURES,
      reference,
      kind: options.kind ?? "image",
      asWebviewUri: (uri) =>
        `https://webview.invalid${uri.path}${uri.query.length > 0 ? `?${uri.query}` : ""}`
    });

  return {
    service,
    statCalls,
    resolve: run,
    async failureCode(reference, options) {
      const outcome = await run(reference, options);
      return outcome.ok ? null : outcome.code;
    },
    async ok(reference, options) {
      const outcome = await run(reference, options);
      if (!outcome.ok) {
        throw new Error(`${reference} failed with ${outcome.code}: ${outcome.message}`);
      }
      return outcome.result;
    }
  };
}

const WHITELIST: Array<[string, string]> = [
  ["assets/logo.png", "image/png"],
  ["assets/photo.jpg", "image/jpeg"],
  ["assets/diagram.gif", "image/gif"],
  ["assets/icon.webp", "image/webp"],
  ["assets/flow.svg", "image/svg+xml"]
];

function rootHarness(policy = createResourcePolicy()): Harness {
  return createHarness(policy, () => [ROOT]);
}

describe("真机解析：MIME 与字节", () => {
  it("五种白名单类型各自解析成功，byteSize 就是磁盘上的真实字节数", async () => {
    const harness = rootHarness();
    for (const [reference, mimeType] of WHITELIST) {
      const result = await harness.ok(reference);
      expect(result.mimeType, reference).toBe(mimeType);
      expect(result.byteSize, reference).toBe(bytesOf(join(ROOT, reference)));
      expect(result.kind).toBe("image");
      expect(result.resourceId).toMatch(/^res-[0-9a-f]{16}$/);
      expect(result.webviewUri).not.toContain("file:");
    }
  });

  it("文件名与扩展名都大写时仍认出 PNG", async () => {
    const harness = rootHarness();
    const result = await harness.ok("assets/CAPITAL.PNG");
    expect(result.mimeType).toBe("image/png");
    expect(result.byteSize).toBe(bytesOf(join(ASSETS, "CAPITAL.PNG")));
  });

  it("百分号编码的中文文件名落到同一个 inode：resourceId 与真名一致", async () => {
    const harness = rootHarness();
    const encoded = await harness.ok("assets/%E4%B8%AD%E6%96%87%20%E6%A0%87%E5%BF%97.png");
    const canonical = await realpath(join(ASSETS, "中文 标志.png"));
    expect(encoded.resourceId).toBe(computeResourceId(canonical));
    expect(encoded.byteSize).toBe(bytesOf(join(ASSETS, "中文 标志.png")));
  });

  it("版本号取自真实 mtime 与 size，且写进 webview URI 的 query", async () => {
    const harness = rootHarness();
    const info = await fsStat(join(ASSETS, "logo.png"));
    const version = contentVersion({ mtimeMs: info.mtimeMs, size: info.size });
    const result = await harness.ok("assets/logo.png");
    expect(result.version).toBe(version);
    expect(result.webviewUri).toBe(`https://webview.invalid${ASSETS}/logo.png?${version}`);
  });

  it("跳出文档目录但仍在 workspace 内的写法可以解析（ARC-008 §5.1）", async () => {
    const harness = rootHarness();
    const result = await harness.ok("../fixtures/assets/logo.png");
    expect(result.mimeType).toBe("image/png");
  });

  it("同一文件重复解析命中缓存，但每次仍重新 stat 与校验边界", async () => {
    const harness = rootHarness();
    const first = await harness.ok("assets/logo.png");
    expect(harness.service.cacheSize).toBe(1);
    const second = await harness.ok("assets/logo.png");
    expect(second).toEqual(first);
    expect(harness.statCalls).toHaveLength(2);
    harness.service.clearCache();
    expect(harness.service.cacheSize).toBe(0);
  });
});

describe("真机解析：授权根与符号链接", () => {
  /** 文档与 workspace folder 都在 assets/：outside/ 于是真的在根之外。 */
  function scoped(policy = createResourcePolicy()): Harness {
    return createHarness(policy, () => [ASSETS]);
  }

  it("根内图片放行", async () => {
    const harness = scoped();
    const result = await harness.ok("logo.png", { documentUri: DOC_INSIDE_ASSETS });
    expect(result.mimeType).toBe("image/png");
  });

  it("字面 ../ 越出授权根 → denied", async () => {
    const harness = scoped();
    expect(
      await harness.failureCode("../outside/secret.png", { documentUri: DOC_INSIDE_ASSETS })
    ).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
  });

  // 非 POSIX 平台建不出符号链接时跳过而不是假装通过：这条断言的前提是链接真的存在。
  it("符号链接的字面路径完全合法，realpath 二次校验才拦住它", { skip: !SYMLINK }, async () => {
    // 先证夹具本身成立：链接真身确实在根外。
    expect(await realpath(ESCAPE_LINK)).toBe(await realpath(join(OUTSIDE, "secret.png")));
    const harness = scoped();
    expect(await harness.failureCode("escape-link.png", { documentUri: DOC_INSIDE_ASSETS })).toBe(
      READORA_ERROR_CODES.RESOURCE_DENIED
    );
  });

  it("跨文档跳转越出授权根同样是 denied（kind=document）", async () => {
    const harness = scoped();
    expect(
      await harness.failureCode("../images.md", {
        documentUri: DOC_INSIDE_ASSETS,
        kind: "document"
      })
    ).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
  });

  it("绝对 file: 引用不经资源解析通道", async () => {
    const harness = scoped();
    const absolute = StubUri.file(join(ASSETS, "logo.png")).toString();
    expect(await harness.failureCode(absolute, { documentUri: DOC_INSIDE_ASSETS })).toBe(
      READORA_ERROR_CODES.RESOURCE_DENIED
    );
  });
});

describe("真机解析：缺失、类型与策略", () => {
  it("不存在的文件与目录都是 notFound", async () => {
    const harness = rootHarness();
    for (const reference of ["assets/missing.png", "assets/"]) {
      expect(await harness.failureCode(reference), reference).toBe(
        READORA_ERROR_CODES.RESOURCE_NOT_FOUND
      );
    }
  });

  it("在授权根内的非图片文件报 unsupported，而不是 notFound", async () => {
    const harness = rootHarness();
    expect(await harness.failureCode("sample.md")).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);
    // 存在性已经确认过：报「类型不支持」的前提是它真的在磁盘上。
    expect(harness.statCalls.some((path) => path.endsWith("sample.md"))).toBe(true);
  });

  it("远端与 data: 引用不碰文件系统", async () => {
    const harness = rootHarness();
    for (const reference of [
      "https://example.com/assets/logo.png",
      "//cdn.example.com/logo.png",
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    ]) {
      expect(await harness.failureCode(reference), reference).toBe(
        READORA_ERROR_CODES.RESOURCE_DENIED
      );
    }
    expect(harness.statCalls).toEqual([]);
  });

  it("策略关掉 SVG 后本地 SVG 变成授权拒绝", async () => {
    const harness = rootHarness(createResourcePolicy({ allowSvg: false }));
    expect(await harness.failureCode("assets/flow.svg")).toBe(
      READORA_ERROR_CODES.RESOURCE_DENIED
    );
  });

  it("放开外部图片开关后仍诚实声明 M3 不抓取", async () => {
    const harness = rootHarness(createResourcePolicy({ allowExternalImages: true }));
    expect(await harness.failureCode("https://example.com/assets/logo.png")).toBe(
      READORA_ERROR_CODES.RESOURCE_UNSUPPORTED
    );
  });

  it("关掉工作区资源开关后本地图片一律 denied，且不落磁盘", async () => {
    const harness = rootHarness(createResourcePolicy({ allowWorkspaceResources: false }));
    expect(await harness.failureCode("assets/logo.png")).toBe(
      READORA_ERROR_CODES.RESOURCE_DENIED
    );
    expect(harness.statCalls).toEqual([]);
  });

  it("同一份 Markdown 在 kind=image 下被拒、在 kind=document 下放行", async () => {
    const harness = rootHarness();
    expect(await harness.failureCode("images.md")).toBe(
      READORA_ERROR_CODES.RESOURCE_UNSUPPORTED
    );
    const asDocument = await harness.resolve("images.md", { kind: "document" });
    expect(asDocument.ok).toBe(true);
  });
});
