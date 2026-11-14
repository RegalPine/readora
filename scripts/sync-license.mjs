/**
 * 把根 `LICENSE` 同步到 `apps/extension/LICENSE`（IMP-003 §7.4「许可证随包分发」）。
 *
 * 为什么不是直接把许可证写在 `apps/extension/`：`vsce` 只认**打包目录**里的
 * `LICENSE`，仓库根本没有「上一层」这个概念；但许可证的法律归属对象是整个仓库，
 * 把它放进子包就等于允许两处各写一份，迟早漂移。所以权威始终是根那一份，
 * 子包里的那一份由本脚本生成，`pnpm verify` 断言它真的进了 VSIX。
 *
 * 这一份**不要进 `.gitignore`**。实测两件事：打包目录里没有它时，VSIX 里就没有任何
 * 许可证（vsce 只看打包目录，不看仓库根）；有它且未被忽略时，它作为
 * `extension/LICENSE.txt` 进包。至于「被 gitignore 会不会照样进包」没有测过，
 * 也不必去赌 —— `pnpm verify` 的许可证断言是唯一能发现这件事的地方。
 *
 * 同步是**字节复制**且幂等：内容相同就不写（不更新时间戳），不同才覆盖并报告。
 * 不做「找不到根 LICENSE 就生成一份 MIT」这类兜底 —— 许可证选型是人定的
 * （README M6 登记为本批决策），脚本没有资格代替人签字。
 */
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "LICENSE");
const TARGET = join(ROOT, "apps/extension/LICENSE");

if (!existsSync(SOURCE)) {
  process.stderr.write(
    "[sync-license] FAIL 仓库根没有 LICENSE：许可证选型属发布决策，脚本不代为创建\n"
  );
  process.exitCode = 1;
} else {
  const source = readFileSync(SOURCE);
  const upToDate =
    existsSync(TARGET) &&
    statSync(TARGET).size === source.byteLength &&
    readFileSync(TARGET).equals(source);
  if (upToDate) {
    process.stdout.write(
      `[sync-license] OK   apps/extension/LICENSE 与根 LICENSE 一致（${source.byteLength} B）\n`
    );
  } else {
    copyFileSync(SOURCE, TARGET);
    process.stdout.write(
      `[sync-license] COPY 根 LICENSE → apps/extension/LICENSE（${source.byteLength} B，供 vsce 打包）\n`
    );
  }
}
