/**
 * 14 类图表兼容性测试（IMP-001 §9.4、F04-001~005 P0 清单）。
 *
 * 阶段 0 结论：Pele 在 jsdom + 注入 measurer 下可完整出图，因此兼容测试留在 vitest，
 * 浏览器 harness 只补「交互 / 主题 / 真实排版」那部分取证。
 *
 * 源码一律取自 tests/fixtures/diagrams.md —— 测的和给人看的是同一份文本，
 * 夹具里每类都刻意混入中文、长文本、特殊字符与大节点。
 */
import { describe, expect, it } from "vitest";

import {
  DIAGRAM_ERROR_CODES,
  REGISTERED_DIAGRAM_TYPES,
  sanitizeSvgToNode,
  toDiagramDiagnostic,
  toDiagramError,
  type DiagramDiagnostic,
  type DiagramTextMeasurer
} from "../index";
import { createDiagramEngine } from "../index";
import {
  overLimitSource,
  registeredSections,
  sectionSource,
  sectionsWithPrefix
} from "./fixture-source";

const measurer: DiagramTextMeasurer = {
  width: (text, size) => text.length * size * 0.6
};

const CASES = registeredSections();

describe("Pele 14 类兼容渲染（jsdom + 注入 measurer）", () => {
  const engine = createDiagramEngine();

  it("夹具与注册集一一对应，缺类多类都算失败", () => {
    expect(CASES.map((item) => item.id)).toEqual([...REGISTERED_DIAGRAM_TYPES]);
    expect(REGISTERED_DIAGRAM_TYPES).toHaveLength(14);
  });

  it("夹具确实承载了疑难字符，而不是被简化成最顺利路径", () => {
    const joined = CASES.map((item) => item.source).join("\n");
    for (const marker of ["中文", "（括号）", "<>", "&"]) {
      expect(joined, marker).toContain(marker);
    }
    // 长文本：至少有一行超过 60 字符在压布局
    const longest = Math.max(
      ...CASES.flatMap((item) => item.source.split("\n").map((line) => line.length))
    );
    expect(longest).toBeGreaterThan(60);
  });

  for (const item of CASES) {
    it(`${item.id}：识别、渲染并可通过安全检查`, async () => {
      const inspection = engine.inspect(item.source);
      expect(inspection.detectedType).toBe(item.id);
      expect(inspection.registered).toBe(true);

      const result = await engine.render(item.source, { measurer });
      expect(result.type).toBe(item.id);
      expect(result.svg).toContain("<svg");
      expect(result.width).toBeGreaterThan(0);

      const node = sanitizeSvgToNode(result.svg);
      expect(node).not.toBeNull();
      const markup = node instanceof Element ? node.outerHTML : "";
      expect(markup).not.toMatch(/<script|onload=|javascript:/i);
    });
  }
});

describe("非正常源码：识别得出来，也降级得下去", () => {
  const engine = createDiagramEngine();

  /** 引擎异常一律是 DiagramRenderError；这里把它取成可断言的诊断。 */
  async function diagnosisOf(source: string): Promise<DiagramDiagnostic> {
    try {
      await engine.render(source, { measurer });
    } catch (raw) {
      return toDiagramDiagnostic(toDiagramError(raw));
    }
    throw new Error("expected the fixture to fail rendering");
  }

  it("语法错误报 syntax，并带上可定位的行号", async () => {
    const source = sectionSource("invalid.syntax");
    expect(engine.inspect(source)).toEqual({ detectedType: "flowchart", registered: true });
    const diagnostic = await diagnosisOf(source);
    expect(diagnostic.code).toBe(DIAGRAM_ERROR_CODES.SYNTAX);
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.source?.line).toBeGreaterThan(0);
  });

  it("识别不出类型 → unsupported，不进引擎解析", async () => {
    const source = sectionSource("invalid.unknown-syntax");
    expect(engine.inspect(source).detectedType).toBeNull();
    expect(await diagnosisOf(source)).toMatchObject({
      code: DIAGRAM_ERROR_CODES.UNSUPPORTED,
      message: expect.any(String)
    });
  });

  it("未启用类型显示为「未注册」而不是崩溃", async () => {
    const sections = sectionsWithPrefix("unregistered.");
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      const inspection = engine.inspect(section.source);
      expect(inspection.detectedType, section.id).not.toBeNull();
      expect(inspection.registered, section.id).toBe(false);
      const diagnostic = await diagnosisOf(section.source);
      expect(diagnostic.code, section.id).toBe(DIAGRAM_ERROR_CODES.NOT_REGISTERED);
      expect(diagnostic.message, section.id).toContain(String(inspection.detectedType));
    }
  });

  it("超 50 000 字符在进引擎之前就被拦下（F04-058）", async () => {
    const source = overLimitSource();
    expect(source.length).toBeGreaterThan(50_000);
    // 类型照样识别得出来，只是规模闸门先落地：不解析就不可能耗尽布局时间。
    expect(engine.inspect(source).detectedType).not.toBeNull();
    expect(await diagnosisOf(source)).toMatchObject({
      code: DIAGRAM_ERROR_CODES.OVER_LIMIT
    });
  });
});
