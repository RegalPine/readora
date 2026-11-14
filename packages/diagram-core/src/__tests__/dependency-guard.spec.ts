/**
 * 依赖边界与门面暴露面守卫（IMP-001 §3.4 第 1/3/7 条、§9.3、ARC-003 §4.1）。
 *
 * 本 spec 自身用 node:fs 做静态守护；被测运行时代码必须保持零 node / 零 vscode 依赖。
 * 「Pele 只能经 Adapter 使用」有两条独立防线：eslint no-restricted-imports + 本文件，
 * 任一条被绕过都会在 pnpm -r test 阶段红。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import * as facade from "../index";
import { PELE_LOCKED_VERSION, REGISTERED_DIAGRAM_TYPES } from "../engines/pele/registry";

const SOURCE_ROOT = resolve(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") {
        continue;
      }
      files.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function relative(path: string): string {
  return path.slice(SOURCE_ROOT.length + 1).replace(/\\/g, "/");
}

function isAdapterModule(path: string): boolean {
  return relative(path).startsWith("engines/pele/");
}

const IMPORTS_PELE = /(?:from|import)\s+["']pele(?:\/[^"']*)?["']/;

describe("Pele 依赖边界", () => {
  it("只有 src/engines/pele/** 允许 import pele", () => {
    const offenders = sourceFiles(SOURCE_ROOT)
      .filter((file) => !isAdapterModule(file))
      .filter((file) => IMPORTS_PELE.test(readFileSync(file, "utf8")))
      .map(relative);
    expect(offenders).toEqual([]);
  });

  it("门面不引入 pele，也不转露引擎原始符号", () => {
    const index = readFileSync(resolve(SOURCE_ROOT, "index.ts"), "utf8");
    expect(IMPORTS_PELE.test(index)).toBe(false);
    // Adapter 只能经 ./engine 出场一次，门面不得直接转露工厂。
    expect(index.includes('from "./engines/pele/pele-adapter"')).toBe(false);
    expect(index.includes('from "./engine"')).toBe(true);
  });

  it("运行时代码零 node / 零 vscode 依赖", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const content = readFileSync(file, "utf8");
      if (/from\s+["']vscode["']|require\(\s*["']vscode["']/.test(content)) {
        offenders.push(`${relative(file)}: vscode`);
      }
      if (/from\s+["']node:|require\(\s*["']node:/.test(content)) {
        offenders.push(`${relative(file)}: node:`);
      }
      if (/\b(?:process|__dirname|__filename|Buffer)\s*[.[]/.test(content)) {
        offenders.push(`${relative(file)}: node global`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("依赖清单与锁定版本", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8")
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  it("运行时依赖只有 dompurify 与 pele", () => {
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["dompurify", "pele"]);
  });

  it("pele 精确锁版，不允许区间（IMP-001 §3.4 第 1 条）", () => {
    const spec = manifest.dependencies?.["pele"] ?? "";
    expect(spec).toBe(PELE_LOCKED_VERSION);
    expect(spec).not.toMatch(/[\^~*x]/);
  });

  it("常量与真实安装版本一致，升级必须同步改代码", () => {
    const installed = JSON.parse(
      readFileSync(resolve(process.cwd(), "node_modules/pele/package.json"), "utf8")
    ) as { version: string; license?: string };
    expect(installed.version).toBe(PELE_LOCKED_VERSION);
    expect(installed.license).toBe("MIT");
  });

  it("Pele 声明的运行时依赖为空（包体增量全部来自我们注册的 diagram 模块）", () => {
    const peleManifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "node_modules/pele/package.json"), "utf8")
    ) as { dependencies?: Record<string, string>; engines?: { node?: string } };
    expect(Object.keys(peleManifest.dependencies ?? {})).toHaveLength(0);
    expect(peleManifest.engines?.node).toContain("20");
  });
});

describe("门面暴露面", () => {
  const exportedNames = Object.keys(facade).sort();

  it("不露 mount / render / register / detectType 等引擎原始入口", () => {
    for (const forbidden of [
      "mount",
      "render",
      "register",
      "registered",
      "detectType",
      "supports",
      "parse",
      "enableZoom",
      "PeleError",
      "createPeleAdapter"
    ]) {
      expect(exportedNames).not.toContain(forbidden);
    }
  });

  it("业务侧需要的能力全部可得", () => {
    for (const required of [
      "DIAGRAM_ENGINE_ID",
      "DIAGRAM_ERROR_CODES",
      "MAX_DIAGRAM_SOURCE_CHARACTERS",
      "PELE_TOKEN_MAP",
      "REGISTERED_DIAGRAM_TYPES",
      "createDiagramEngine",
      "resolveCapability",
      "sanitizeSvgToNode",
      "toDiagramDiagnostic"
    ]) {
      expect(exportedNames).toContain(required);
    }
  });

  it("占位导出不得复活（M3 之前门面是空的）", () => {
    expect(exportedNames).not.toContain("DIAGRAM_CORE_MILESTONE");
  });

  it("注册集是 14 类且顺序稳定", () => {
    expect(REGISTERED_DIAGRAM_TYPES).toHaveLength(14);
    expect(REGISTERED_DIAGRAM_TYPES.slice(0, 5)).toEqual([
      "flowchart",
      "sequence",
      "class",
      "state",
      "er"
    ]);
  });
});
