/**
 * @readora/test-utils：共享测试夹具。
 * 只放跨包复用的构造器；包内专用 stub 留在各自包中。
 */
import type { DocumentSnapshot, ReaderPreferences } from "@readora/contracts";

export const DEFAULT_PREFERENCES: ReaderPreferences = {
  theme: "auto",
  fontSize: 16,
  lineHeight: 1.75,
  contentWidth: 820,
  showOutline: true,
  typography: "newsreader",
  themePreset: "default"
};

export function createDocumentSnapshot(
  overrides: Partial<DocumentSnapshot> = {}
): DocumentSnapshot {
  return {
    documentUri: "file:///fixture/sample.md",
    languageId: "markdown",
    version: 1,
    text: "# Sample\n\nHello Readora.",
    ...overrides
  };
}