/**
 * 生产端口装配测试（ARC-004 §3.1，STORY-08-01）。
 *
 * vscode-port.ts 自己声明「单测不覆盖本文件」，但那是在它只有 stub 可测的年代：
 * 现在 resources 目录整体进 80% 门禁，而它是 resources 的一部分，
 * 更重要的是 —— 它是唯一走 `vscode.workspace.fs` 的端口实现，
 * 装配错了（比如把目录当文件、把 FileNotFound 当读取失败）整条链路都会变形。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import * as vscode from "vscode";
import { READORA_ERROR_CODES } from "@readora/contracts";
import {
  FileType,
  Uri as StubUri,
  fileStates,
  resetVscodeStub,
  statCalls,
  workspace
} from "../__stubs__/vscode";
import { createResourcePorts } from "../resources/vscode-port";
import { createResourcePolicy } from "../resources/resource-policy";
import { ResourceService } from "../resources/resource-service";

beforeEach(() => {
  resetVscodeStub();
});

/** stub 的 Uri 与 @types/vscode 的 Uri 结构差一个 toJSON，按其它 spec 的惯例 cast。 */
const LOGO = StubUri.file("/docs/src/assets/logo.png") as unknown as vscode.Uri;

describe("stat 端口", () => {
  it("普通文件转成 ResourceStat，mtime 用 workspace.fs 的字段名", async () => {
    fileStates.set(LOGO.fsPath, { type: FileType.File, size: 2048, mtime: 1_700_000_000_000 });
    const ports = createResourcePorts(createResourcePolicy);
    const stat = await ports.stat(LOGO);
    expect(stat).toEqual({ size: 2048, mtimeMs: 1_700_000_000_000, isFile: true });
    expect(statCalls).toEqual([LOGO.fsPath]);
  });

  it("目录原样上报 isFile:false，由服务判定 notFound", async () => {
    fileStates.set(LOGO.fsPath, { type: FileType.Directory, size: 0, mtime: 1 });
    const ports = createResourcePorts(createResourcePolicy);
    expect(await ports.stat(LOGO)).toEqual({ size: 0, mtimeMs: 1, isFile: false });
  });

  it("FileNotFound 是「缺失」而不是「读不了」：返回 null", async () => {
    const ports = createResourcePorts(createResourcePolicy);
    expect(await ports.stat(LOGO)).toBeNull();
  });

  it("两种命名不一样的 NotFound 码都算缺失", async () => {
    const spy = vi.spyOn(vscode.workspace.fs, "stat").mockRejectedValue(
      Object.assign(new Error("gone"), { code: "EntryNotFound" })
    );
    const ports = createResourcePorts(createResourcePolicy);
    expect(await ports.stat(LOGO)).toBeNull();
    spy.mockRestore();
  });

  it("权限类失败必须冒泡，不能被吞成缺失", async () => {
    const spy = vi
      .spyOn(vscode.workspace.fs, "stat")
      .mockRejectedValue(Object.assign(new Error("EACCES"), { code: "NoPermission" }));
    const ports = createResourcePorts(createResourcePolicy);
    await expect(ports.stat(LOGO)).rejects.toThrow("EACCES");
    spy.mockRestore();
  });
});

describe("workspaceFolders 与 realpath 端口", () => {
  it("没有 workspace folder 时返回空数组，而不是 undefined", () => {
    const ports = createResourcePorts(createResourcePolicy);
    expect(ports.workspaceFolders()).toEqual([]);
    workspace.workspaceFolders = [
      { uri: StubUri.file("/docs"), name: "docs", index: 0 },
      { uri: StubUri.file("/other"), name: "other", index: 1 }
    ];
    expect(ports.workspaceFolders()).toEqual(["/docs", "/other"]);
  });

  it("realpath 直接落到 node:fs：符号链接的真身在它这里现形", async () => {
    const ports = createResourcePorts(createResourcePolicy);
    const { join, resolve } = await import("node:path");
    const { realpath } = await import("node:fs/promises");
    const fixtures = resolve(process.cwd(), "../../tests/fixtures");
    const expected = await realpath(join(fixtures, "assets", "logo.png"));
    expect(await ports.realpath(expected)).toBe(expected);
  });
});

describe("端口 + 服务的生产装配形状", () => {
  it("stat 说有但磁盘上没有：realpath 二次校验把它挡在门外", async () => {
    // stub 的 fs 与真机 realpath 在这里故意「不一致」：
    // 这正好证明授权结论取自真实文件系统，而不是取自任何一方可伪造的 stat 表。
    fileStates.set(LOGO.fsPath, { type: FileType.File, size: 2048, mtime: 100 });
    const ports = createResourcePorts(() => createResourcePolicy());
    const service = new ResourceService(ports);
    workspace.workspaceFolders = [{ uri: StubUri.file("/docs"), name: "docs", index: 0 }];
    const outcome = await service.resolve({
      documentUri: StubUri.file("/docs/src/read.md").toString(),
      reference: "assets/logo.png",
      kind: "image",
      asWebviewUri: (uri) => `https://webview.invalid${uri.path}`
    });
    expect(!outcome.ok && outcome.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    expect(!outcome.ok && outcome.message).toContain("canonicalized");
    expect(service.cacheSize).toBe(0);
  });
});
