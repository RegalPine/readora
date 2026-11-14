/**
 * 错误模型与诊断（IMP-002 TASK-05-02-05、ARC-003 §10.1 / §10.2 / §10.3）。
 *
 * 引擎异常以「鸭子类型的 code / line / column」模拟，
 * 这样错误分层可以脱离 Pele 独立验证（IMP-001 §9.3）。
 */
import { describe, expect, it } from "vitest";

import {
  DIAGRAM_ERROR_CODES,
  DiagramLimitError,
  DiagramNotRegisteredError,
  DiagramRenderError,
  DiagramSecurityError,
  toDiagramDiagnostic,
  toDiagramError
} from "../errors";
import type { DiagramError } from "../types";

function engineError(code: string, extra: Record<string, unknown> = {}): unknown {
  return Object.assign(new Error(`${code} 崩了`), { code, ...extra });
}

describe("toDiagramError：引擎 code → 产品分类", () => {
  it("syntax 与 semantic 都归为源码问题", () => {
    for (const code of ["syntax", "semantic"]) {
      const error = engineError(code, { line: 3, column: 7 });
      const result = toDiagramError(error);
      expect(result.kind).toBe("syntax");
      expect(result.source).toEqual({ line: 3, column: 7 });
    }
  });

  it("unsupported-diagram → unsupported", () => {
    expect(toDiagramError(engineError("unsupported-diagram")).kind).toBe("unsupported");
  });

  it("limit → over-limit", () => {
    expect(toDiagramError(engineError("limit")).kind).toBe("over-limit");
  });

  it("未知异常归 runtime，不谎报成因", () => {
    expect(toDiagramError(engineError("weird")).kind).toBe("runtime");
    expect(toDiagramError(new Error("boom")).kind).toBe("runtime");
    expect(toDiagramError("字符串异常").kind).toBe("runtime");
    expect(toDiagramError(null).message).toBe("Diagram rendering failed.");
  });

  it("行列缺失时不编造位置", () => {
    expect(toDiagramError(engineError("syntax")).source).toBeUndefined();
    expect(toDiagramError(engineError("syntax", { line: 2 })).source).toEqual({ line: 2 });
  });

  it("非有限数字的位置被忽略", () => {
    const result = toDiagramError(engineError("syntax", { line: Number.NaN }));
    expect(result.source).toBeUndefined();
  });
});

describe("toDiagramError：产品自有异常", () => {
  it("安全 / 超限 / 未注册各自带码", () => {
    expect(toDiagramError(new DiagramSecurityError("unsafe"))).toEqual({
      kind: "security",
      message: "unsafe"
    });
    expect(toDiagramError(new DiagramLimitError("too big"))).toEqual({
      kind: "over-limit",
      message: "too big"
    });
    const unregistered = toDiagramError(new DiagramNotRegisteredError("journey"));
    expect(unregistered.kind).toBe("unsupported");
    expect(unregistered.code).toBe(DIAGRAM_ERROR_CODES.NOT_REGISTERED);
  });

  it("Adapter 载体二次转换保持成因", () => {
    const detail: DiagramError = { kind: "syntax", message: "行 3 有语法问题" };
    expect(toDiagramError(new DiagramRenderError(detail))).toBe(detail);
  });
});

describe("toDiagramDiagnostic", () => {
  it("未注册按 warning，其余按 error", () => {
    expect(
      toDiagramDiagnostic({
        kind: "unsupported",
        code: DIAGRAM_ERROR_CODES.NOT_REGISTERED,
        message: "x"
      }).severity
    ).toBe("warning");
    expect(toDiagramDiagnostic({ kind: "syntax", message: "x" }).severity).toBe("error");
    expect(toDiagramDiagnostic({ kind: "security", message: "x" }).severity).toBe("error");
  });

  it("kind 默认映射到对应错误码", () => {
    const cases: Array<[DiagramError["kind"], string]> = [
      ["syntax", DIAGRAM_ERROR_CODES.SYNTAX],
      ["unsupported", DIAGRAM_ERROR_CODES.UNSUPPORTED],
      ["over-limit", DIAGRAM_ERROR_CODES.OVER_LIMIT],
      ["security", DIAGRAM_ERROR_CODES.SECURITY],
      ["layout", DIAGRAM_ERROR_CODES.RUNTIME],
      ["resource", DIAGRAM_ERROR_CODES.RUNTIME],
      ["runtime", DIAGRAM_ERROR_CODES.RUNTIME]
    ];
    for (const [kind, code] of cases) {
      expect(toDiagramDiagnostic({ kind, message: "x" }).code).toBe(code);
    }
  });

  it("code 覆盖优先于 kind 默认值", () => {
    const diagnostic = toDiagramDiagnostic({
      kind: "runtime",
      code: "readora.diagram.custom",
      message: "x"
    });
    expect(diagnostic.code).toBe("readora.diagram.custom");
  });

  it("长消息截断到 240 字符", () => {
    const diagnostic = toDiagramDiagnostic({ kind: "runtime", message: "y".repeat(500) });
    expect(diagnostic.message).toHaveLength(240);
  });

  it("位置信息原样透传", () => {
    expect(toDiagramDiagnostic({ kind: "syntax", message: "x", source: { line: 4 } }).source).toEqual(
      { line: 4 }
    );
  });
});
