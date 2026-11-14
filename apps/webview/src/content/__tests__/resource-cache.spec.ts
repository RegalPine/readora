/**
 * 资源请求层测试（IMP-001 §14 Unit Test，ARC-008 §8 / §16.1 第 10 条）。
 *
 * 关键点只有一个：Host 消息不可信。载荷必须过 ResourceResolveResultSchema，
 * 不合契约就降级为 missing；错误串里的错误码要还原出来，才能给出行内原因。
 */
import { describe, expect, it, vi } from "vitest";
import { READORA_ERROR_CODES } from "@readora/contracts";
import { ResourceRequestCache, parseResourceFailure } from "../resource-cache";
import { okResult } from "./test-support";

const DOCUMENT_URI = "file:///vault/notes/doc.md";

function requester(payload: unknown) {
  const request = vi.fn(async (_type: string, _payload: unknown): Promise<unknown> => payload);
  return { request, cache: new ResourceRequestCache({ request }, DOCUMENT_URI) };
}

describe("请求合并与复用", () => {
  it("同一引用的并发请求合并成一次", async () => {
    const { request, cache } = requester(okResult("assets/a.png"));
    const [first, second] = await Promise.all([
      cache.resolve("assets/a.png"),
      cache.resolve("assets/a.png")
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("kind 参与键：图片与文档不会互相顶替", async () => {
    const { request, cache } = requester(okResult("assets/a.png"));
    await cache.resolve("notes/other.md", "document");
    await cache.resolve("notes/other.md", "image");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toEqual({
      documentUri: DOCUMENT_URI,
      reference: "notes/other.md",
      kind: "document"
    });
  });

  it("结果复用直到 clear；clear 后重新问 Host（改图能刷新的前提）", async () => {
    const { request, cache } = requester(okResult("assets/a.png"));
    await cache.resolve("assets/a.png");
    await cache.resolve("assets/a.png");
    expect(request).toHaveBeenCalledTimes(1);
    expect(cache.pendingCount).toBe(1);

    cache.clear();
    expect(cache.pendingCount).toBe(0);
    await cache.resolve("assets/a.png");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("invalidate 只影响单个引用", async () => {
    const { request, cache } = requester(okResult("assets/a.png"));
    await cache.resolve("assets/a.png");
    await cache.resolve("assets/b.png");
    cache.invalidate("assets/a.png");
    await cache.resolve("assets/a.png");
    await cache.resolve("assets/b.png");
    expect(request).toHaveBeenCalledTimes(3);
  });
});

describe("响应复判（防伪造 Host 消息）", () => {
  it("多余字段被 strict 校验拒掉，降级为 unreadable 而不是写进 DOM", async () => {
    const forged = { ...okResult("assets/a.png"), localPath: "/etc/passwd" };
    const { cache } = requester(forged);
    const entry = await cache.resolve("assets/a.png");
    expect(entry.ok).toBe(false);
    if (!entry.ok) {
      expect(entry.code).toBe(READORA_ERROR_CODES.RESOURCE_UNREADABLE);
      expect(entry.message).toContain("did not match the resource contract");
    }
  });

  it("缺 version / 类型不符同样被拒", async () => {
    const base = okResult("assets/a.png");
    const { cache } = requester({ ...base, version: "" });
    expect((await cache.resolve("assets/a.png")).ok).toBe(false);

    const wrongType = requester({ ...base, byteSize: "1024" as unknown as number });
    expect((await wrongType.cache.resolve("assets/a.png")).ok).toBe(false);
  });

  it("合契约的载荷原样透出", async () => {
    const result = okResult("assets/a.png");
    const { cache } = requester(result);
    const resolved = await cache.resolve("assets/a.png");
    expect(resolved).toEqual({ ok: true, result });
  });
});

describe("失败还原", () => {
  it("剥掉 Readora 前缀后取回错误码", () => {
    expect(
      parseResourceFailure(new Error("Readora: readora.resource.denied: outside authorized roots"))
    ).toEqual({
      code: READORA_ERROR_CODES.RESOURCE_DENIED,
      message: "readora.resource.denied: outside authorized roots"
    });
  });

  it("没有错误码前缀时归 unreadable，绝不静默成功", () => {
    expect(parseResourceFailure(new Error("Readora: request timed out."))).toEqual({
      code: READORA_ERROR_CODES.RESOURCE_UNREADABLE,
      message: "request timed out."
    });
    expect(parseResourceFailure("boom").code).toBe(READORA_ERROR_CODES.RESOURCE_UNREADABLE);
    expect(parseResourceFailure(undefined).code).toBe(READORA_ERROR_CODES.RESOURCE_UNREADABLE);
  });

  it("reject 的失败在 resolve 通道里同样还原成 ok:false", async () => {
    const request = vi.fn(async () => {
      throw new Error("Readora: readora.resource.notFound: no such file");
    });
    const cache = new ResourceRequestCache({ request }, DOCUMENT_URI);
    const entry = await cache.resolve("assets/gone.png");
    expect(entry).toEqual({
      ok: false,
      code: READORA_ERROR_CODES.RESOURCE_NOT_FOUND,
      message: "readora.resource.notFound: no such file"
    });
    // 失败结果同样被记住：同一引用不重复敲门
    await cache.resolve("assets/gone.png");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
