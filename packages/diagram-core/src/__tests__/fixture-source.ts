/**
 * 图表夹具解析器（仅供测试读取 tests/fixtures/diagrams.md）。
 *
 * 夹具是文档形态的：浏览器 harness 要把它当普通 .md 加载并肉眼检查，
 * 所以解析器必须服从文档结构（二级标题 + mermaid 围栏），
 * 而不是反过来让夹具迁就某种 JSON 清单。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DIAGRAM_FIXTURE_PATH = resolve(process.cwd(), "../../tests/fixtures/diagrams.md");
export const OVER_LIMIT_FIXTURE_PATH = resolve(
  process.cwd(),
  "../../tests/fixtures/diagrams-over-limit.md"
);

export interface DiagramFixtureSection {
  /** 二级标题原文，如 `flowchart` / `invalid.syntax` / `unregistered.journey`。 */
  readonly id: string;
  /** 围栏内源码，保留原始换行与缩进（去掉围栏本身）。 */
  readonly source: string;
}

const HEADING = /^##\s+(.+?)\s*$/;
const FENCE = /^\s*```mermaid\s*$/;
const FENCE_END = /^\s*```\s*$/;

export function parseDiagramFixture(markdown: string): DiagramFixtureSection[] {
  const lines = markdown.split("\n");
  const sections: DiagramFixtureSection[] = [];
  let heading: string | null = null;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const title = HEADING.exec(line);
    if (title) {
      heading = title[1] ?? null;
      index += 1;
      continue;
    }
    if (heading !== null && FENCE.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_END.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      sections.push({ id: heading, source: body.join("\n") });
      heading = null;
    }
    index += 1;
  }
  return sections;
}

export function readDiagramFixture(path = DIAGRAM_FIXTURE_PATH): DiagramFixtureSection[] {
  return parseDiagramFixture(readFileSync(path, "utf8"));
}

/** 不带点的标题即已注册类型，顺序就是 IMP-001 §9.4 的清单顺序。 */
export function registeredSections(): DiagramFixtureSection[] {
  return readDiagramFixture().filter((section) => !section.id.includes("."));
}

export function sectionsWithPrefix(prefix: string): DiagramFixtureSection[] {
  return readDiagramFixture().filter((section) => section.id.startsWith(prefix));
}

/** 单个用例的源码；找不到就抛，避免夹具被误删后测试静默少跑。 */
export function sectionSource(id: string): string {
  const found = readDiagramFixture().find((section) => section.id === id);
  if (!found) {
    throw new Error(`diagram fixture section "${id}" is missing`);
  }
  return found.source;
}

/** 超限夹具：围栏内那段就是 > 50 000 字符的源码。 */
export function overLimitSource(path = OVER_LIMIT_FIXTURE_PATH): string {
  const parsed = parseDiagramFixture(readFileSync(path, "utf8"));
  const found = parsed.find((section) => section.id === "over-limit");
  if (!found) {
    throw new Error("run `node scripts/gen-fixture-assets.mjs` to produce diagrams-over-limit.md");
  }
  return found.source;
}
