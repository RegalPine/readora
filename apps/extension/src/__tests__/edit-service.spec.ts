/**
 * 编辑写回的决策阶梯（ARC-009 §5.2 / STORY-13-02）。
 *
 * 端口全部注入，所以这里能确定性钉住两件事：
 * 1. **每道失败说哪个错误码** —— 三枚 edit 码 + 三枚既有码各自的位置；
 * 2. **拒收不得留下任何部分效果** —— 每条拒收路径都断言
 *    `applyLineReplacement` 零调用、模型文本与版本零变化
 *    （ARC-008 §16.1 第 16–18 条的「拒收且宿主模型零变化」）。
 *
 * 接线（真 `createReaderApplication` + 回声）在 `document-edit-wiring.spec.ts`，
 * 本文件只测判断本身。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { READORA_ERROR_CODES, type DocumentEditPayload } from "@readora/contracts";
import { ReaderError } from "../errors";
import {
  EditService,
  type EditModel,
  type EditServicePorts,
  type EditSessionInfo,
  type LineReplacement
} from "../edit/edit-service";

const DOCUMENT_URI = "file:///docs/read.md";
/** 10 行文档：行号 0..9，所以 `endLine: 9` 是最后一个合法终点。 */
const LINE_COUNT = 10;

interface Harness {
  ports: EditServicePorts;
  service: EditService;
  apply: ReturnType<typeof vi.fn>;
  modelOf: ReturnType<typeof vi.fn>;
  applyCalls(): LineReplacement[];
  setSession(session: EditSessionInfo | null): void;
  setModel(model: EditModel | null): void;
  setScheme(scheme: string): void;
  setApplied(model: EditModel | null): void;
  model(): EditModel | null;
}

function createHarness(): Harness {
  let session: EditSessionInfo | null = { documentUri: DOCUMENT_URI, hasPanel: true };
  let model: EditModel | null = { lineCount: LINE_COUNT, snapshotVersion: 3 };
  let scheme = "file";
  let applied: EditModel | null = { lineCount: LINE_COUNT, snapshotVersion: 4 };
  const appliedCalls: LineReplacement[] = [];
  const modelCalls: string[] = [];

  const ports: EditServicePorts = {
    sessionOf: () => session,
    schemeOf: () => scheme,
    modelOf: async (documentUri) => {
      modelCalls.push(documentUri);
      return model;
    },
    applyLineReplacement: async (input) => {
      // 模型「变化」由这里唯一制造：任何拒收路径走到这里都算失败。
      appliedCalls.push(input);
      if (applied) {
        model = applied;
      }
      return applied;
    }
  };
  const apply = vi.fn(ports.applyLineReplacement);
  const modelOf = vi.fn(ports.modelOf);
  ports.applyLineReplacement = async (input) => apply(input) as Promise<EditModel | null>;
  ports.modelOf = async (documentUri) => modelOf(documentUri) as Promise<EditModel | null>;

  return {
    ports,
    service: new EditService(ports),
    apply,
    modelOf,
    applyCalls: () => appliedCalls,
    setSession: (value) => {
      session = value;
    },
    setModel: (value) => {
      model = value;
    },
    setScheme: (value) => {
      scheme = value;
    },
    setApplied: (value) => {
      applied = value;
    },
    model: () => model
  };
}

function payload(overrides: Partial<DocumentEditPayload> = {}): DocumentEditPayload {
  return {
    documentUri: DOCUMENT_URI,
    range: { startLine: 2, endLine: 4 },
    newText: "## Rewritten block",
    baseVersion: 3,
    ...overrides
  };
}

/** 拒收路径的共同断言：抛出的错误码 + 模型端口一次没被误用。 */
async function expectRejection(
  harness: Harness,
  input: DocumentEditPayload,
  code: string
): Promise<void> {
  const before = harness.model();
  const error = await harness.service
    .editDocument(input, "s1")
    .catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ReaderError);
  expect((error as ReaderError).code).toBe(code);
  expect(harness.apply).toHaveBeenCalledTimes(0);
  // 「零变化」不能只靠没调端口：模型读数本身也要没动过。
  expect(harness.model()).toEqual(before);
}

describe("EditService 的决策阶梯", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  test("端口集合只有四件事：没有 save / postMessage / pushUpdate", () => {
    // 「不隐式写盘」「不新增刷新机制」由端口的**形状**保证：写回代码拿不到
    // 这两个入口，注释里写多少遍都不如让它编译不过。
    expect(Object.keys(harness.ports).sort()).toEqual([
      "applyLineReplacement",
      "modelOf",
      "schemeOf",
      "sessionOf"
    ]);
  });

  test("版本对得上、范围合法：写回成功，返回的是写回之后的版本", () => {
    // 返回的不是入参 baseVersion，也不端口自己猜的数，而是宿主模型写回后的读数。
    return expect(harness.service.editDocument(payload(), "s1")).resolves.toEqual({
      version: 4
    });
  });

  test("成功路径把四个字段原样交给端口：不夹取、不改写、不补换行", async () => {
    await harness.service.editDocument(payload({ newText: "- a\n- b" }), "s1");
    expect(harness.apply).toHaveBeenCalledTimes(1);
    expect(harness.applyCalls()).toEqual([
      {
        documentUri: DOCUMENT_URI,
        startLine: 2,
        endLine: 4,
        newText: "- a\n- b"
      }
    ]);
  });

  test("删空一个区块是合法编辑：newText 为空串照样写回", async () => {
    const result = await harness.service.editDocument(payload({ newText: "" }), "s1");
    expect(result.version).toBe(4);
    expect(harness.apply).toHaveBeenCalledTimes(1);
  });

  test("单行区块（startLine === endLine）合法", async () => {
    await harness.service.editDocument(payload({ range: { startLine: 5, endLine: 5 } }), "s1");
    expect(harness.apply).toHaveBeenCalledTimes(1);
  });

  test("① 会话不在 → RESOURCE_DENIED，且不读模型", async () => {
    harness.setSession(null);
    await expectRejection(harness, payload(), READORA_ERROR_CODES.RESOURCE_DENIED);
    expect(harness.modelOf).toHaveBeenCalledTimes(0);
  });

  test("① 面板已释放 → RESOURCE_DENIED：与「没有会话」同码，用户动作本来就一样", async () => {
    harness.setSession({ documentUri: DOCUMENT_URI, hasPanel: false });
    await expectRejection(harness, payload(), READORA_ERROR_CODES.RESOURCE_DENIED);
  });

  test("② documentUri 与会话文档不符 → TARGET_INVALID（伪造目标换不到写权限）", async () => {
    await expectRejection(
      harness,
      payload({ documentUri: "file:///docs/other.md" }),
      READORA_ERROR_CODES.TARGET_INVALID
    );
    // 授权判定必须早于任何文件系统动作：越权的那一条不能先把模型打开一遍。
    expect(harness.modelOf).toHaveBeenCalledTimes(0);
  });

  test("② 只有大小写不同的 URI 也算别的文档：不做归一化就不存在第二套判据", async () => {
    await expectRejection(
      harness,
      payload({ documentUri: DOCUMENT_URI.toUpperCase() }),
      READORA_ERROR_CODES.TARGET_INVALID
    );
  });

  test("③ 非 file scheme → TARGET_INVALID：虚拟文档上没有源行范围这回事", async () => {
    harness.setScheme("untitled");
    await expectRejection(harness, payload(), READORA_ERROR_CODES.TARGET_INVALID);
    expect(harness.modelOf).toHaveBeenCalledTimes(0);
  });

  test("④ 模型打不开 → DOCUMENT_UNREADABLE", async () => {
    harness.setModel(null);
    await expectRejection(harness, payload(), READORA_ERROR_CODES.DOCUMENT_UNREADABLE);
  });

  test("⑤ baseVersion 落后一版 → EDIT_STALE（快照空间的版本，不是宿主模型 version）", async () => {
    // 复现「外部已改」：模型版本已经领先 baseVersion。护栏比的是投递给 View 的
    // 那个数字，所以这里领先多少都同一码。
    harness.setModel({ lineCount: LINE_COUNT, snapshotVersion: 7 });
    await expectRejection(harness, payload({ baseVersion: 3 }), READORA_ERROR_CODES.EDIT_STALE);
  });

  test("⑤ baseVersion 领先（View 不该见到的未来版本）同样 → EDIT_STALE", async () => {
    await expectRejection(harness, payload({ baseVersion: 4 }), READORA_ERROR_CODES.EDIT_STALE);
  });

  test("⑤ 首次编辑：baseVersion 为 0（文档没在文本编辑器里打开）必须放行", async () => {
    // 这条钉的是分歧本身：`snapshotVersionOf` 对没打开的文档报 0，View 拿到的
    // 也是 0。按宿主模型 version（openTextDocument 之后是 1）判就会误杀这一笔。
    harness.setModel({ lineCount: LINE_COUNT, snapshotVersion: 0 });
    harness.setApplied({ lineCount: LINE_COUNT, snapshotVersion: 1 });
    await expect(
      harness.service.editDocument(payload({ baseVersion: 0 }), "s1")
    ).resolves.toEqual({ version: 1 });
    expect(harness.apply).toHaveBeenCalledTimes(1);
  });

  test("⑥ 倒挂范围 → EDIT_RANGE_INVALID：Schema 放行到这里，所以必须在这挡下", async () => {
    // 契约的 Schema 只管形状（整数、非负），`endLine >= startLine` 是语义判断。
    // 少了这一条，倒挂范围会变成一个「合法」的替换请求打到宿主上。
    await expectRejection(
      harness,
      payload({ range: { startLine: 6, endLine: 2 } }),
      READORA_ERROR_CODES.EDIT_RANGE_INVALID
    );
  });

  test("⑥ endLine 越界一行即拒，不钳位也不截断", async () => {
    await expectRejection(
      harness,
      payload({ range: { startLine: 8, endLine: LINE_COUNT } }),
      READORA_ERROR_CODES.EDIT_RANGE_INVALID
    );
  });

  test("⑥ 边界：endLine 落在最后一行（lineCount - 1）合法", async () => {
    await harness.service.editDocument(
      payload({ range: { startLine: 8, endLine: LINE_COUNT - 1 } }),
      "s1"
    );
    expect(harness.apply).toHaveBeenCalledTimes(1);
  });

  test("陈旧必须先于范围合法性判定：版本已不可信时报 stale 而不是 rangeInvalid", async () => {
    // 版本对不上时行数本身就不可信，报 rangeInvalid 会把用户引向「重开编辑器」，
    // 而他要做的其实是「重新同步」。
    harness.setModel({ lineCount: 3, snapshotVersion: 9 });
    await expectRejection(
      harness,
      payload({ baseVersion: 3, range: { startLine: 0, endLine: 20 } }),
      READORA_ERROR_CODES.EDIT_STALE
    );
  });

  test("⑦ 宿主拒绝应用 → EDIT_APPLY_FAILED：这是唯一允许触碰模型端口的一步之后", async () => {
    harness.setApplied(null);
    const before = harness.model();
    const error = await harness.service
      .editDocument(payload(), "s1")
      .catch((cause: unknown) => cause);
    expect((error as ReaderError).code).toBe(READORA_ERROR_CODES.EDIT_APPLY_FAILED);
    expect(harness.apply).toHaveBeenCalledTimes(1);
    expect(harness.model()).toEqual(before);
  });

  test("错误消息带上可定位的事实：版本号与行数进日志，路径不进", async () => {
    harness.setModel({ lineCount: LINE_COUNT, snapshotVersion: 8 });
    const stale = await harness.service
      .editDocument(payload(), "s1")
      .catch((cause: unknown) => cause);
    expect((stale as Error).message).toContain("3");
    const invalid = await harness.service
      .editDocument(payload({ baseVersion: 8, range: { startLine: 0, endLine: 40 } }), "s1")
      .catch((cause: unknown) => cause);
    expect((invalid as Error).message).toContain(`${LINE_COUNT}-line`);
  });
});
