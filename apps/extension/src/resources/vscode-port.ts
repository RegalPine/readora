/**
 * ResourceServicePorts 的 VS Code 实现（ARC-004 §3.1 装配边界）。
 *
 * 单测不覆盖本文件：它只把 vscode.workspace.fs / workspaceFolders /
 * node:fs.realpath 转译成端口签名，逻辑一律留在可测的模块里。
 * stat 走 workspace.fs 而非 node:fs，才能同时支持未来的非 file scheme。
 */
import * as vscode from "vscode";
import { realpath } from "node:fs/promises";
import type { ResourcePolicy } from "./resource-policy";
import type { ResourceServicePorts, ResourceStat } from "./resource-service";

export function createResourcePorts(getPolicy: () => ResourcePolicy): ResourceServicePorts {
  return {
    policy: getPolicy,
    async stat(uri) {
      let info: vscode.FileStat;
      try {
        info = await vscode.workspace.fs.stat(uri);
      } catch (error) {
        // FileNotFound 是「资源缺失」而不是「读不了」，交给调用方判空。
        const code = (error as { code?: string }).code;
        if (code === "FileNotFound" || code === "EntryNotFound") {
          return null;
        }
        throw error;
      }
      const stat: ResourceStat = {
        size: info.size,
        mtimeMs: info.mtime,
        isFile: info.type === vscode.FileType.File
      };
      return stat;
    },
    realpath: (path) => realpath(path),
    /**
     * 字节读取同样走 workspace.fs（与 stat 共用一个提供方），`FileNotFound`
     * 跟 stat 一样返回 null：「没这个文件」与「读不了」在导出侧的处分不同。
     */
    async readFile(uri) {
      try {
        return await vscode.workspace.fs.readFile(uri);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "FileNotFound" || code === "EntryNotFound") {
          return null;
        }
        throw error;
      }
    },
    workspaceFolders() {
      return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.path);
    }
  };
}
