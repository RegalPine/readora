/**
 * Chromium 探测顺序（M11 · 计划锁定的四条优先级）。
 *
 * 这里断言的是「顺序就是承诺」：用户配了路径就得先用它，`CHROME_PATH` 是
 * CI 与绿色版的通用约定，OS 候选与 PATH 扫描只在前面都落空时才起作用。
 * 顺序漂了不会报错，只会「用户配的那个 Chrome 永远没被用上」—— 所以逐条钉。
 */
import { describe, expect, test } from "vitest";
import {
  chromiumCandidates,
  findChromium,
  type Environment
} from "../export/chrome-locator";

const CHROME = "/opt/chrome/chrome";

function probe(options: {
  exists?: string[];
  env?: Environment;
  platform?: string;
  configured?: string;
}): { exe: string | null; configuredMissing: boolean; asked: string[] } {
  const exists = new Set(options.exists ?? []);
  const asked: string[] = [];
  const lookup = findChromium(options.configured ?? "", {
    env: options.env ?? {},
    platform: options.platform,
    existsSync: (path: string): boolean => {
      asked.push(path);
      return exists.has(path);
    }
  });
  return { ...lookup, asked };
}

describe("chromiumCandidates", () => {
  test("配置路径永远第一位，CHROME_PATH 第二", () => {
    const list = chromiumCandidates("/a/chrome", { CHROME_PATH: "/b/chrome" }, "linux");
    expect(list[0]).toBe("/a/chrome");
    expect(list[1]).toBe("/b/chrome");
  });

  test("空配置与空环境变量都不占位", () => {
    const list = chromiumCandidates("   ", { CHROME_PATH: "" }, "linux");
    expect(list[0]).toBe("/snap/bin/chromium");
  });

  test("macOS 给三枚 bundle：Chrome / Chromium / Edge（不掺 Linux 与 Windows 候选）", () => {
    const list = chromiumCandidates("", {}, "darwin");
    expect(list).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    ]);
  });

  test("Linux 只给 snap 与发行版两个固定落点，其余交给 PATH", () => {
    expect(chromiumCandidates("", {}, "linux").slice(0, 2)).toEqual([
      "/snap/bin/chromium",
      "/usr/bin/chromium-browser"
    ]);
  });

  test("Windows 用 Program Files 两枚 + LOCALAPPDATA，环境变量缺失时退回默认盘位", () => {
    const list = chromiumCandidates(
      "",
      { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      "win32"
    );
    expect(list.slice(0, 3)).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"
    ]);
    // 环境变量在真实机器上可能带尾反斜杆：拼出来不能出现双分隔符。
    const trailing = chromiumCandidates(
      "",
      { PROGRAMFILES: "D:\\PF\\" },
      "win32"
    );
    expect(trailing).toContain("D:\\PF\\Google\\Chrome\\Application\\chrome.exe");
  });

  test("PATH 扫描按系统换分隔符与命令名", () => {
    const posix = chromiumCandidates("", { PATH: "/usr/bin:/opt/bin" }, "linux");
    expect(posix).toContain("/usr/bin/google-chrome-stable");
    expect(posix).toContain("/opt/bin/chromium");
    const windows = chromiumCandidates("", { PATH: "C:\\bin" }, "win32");
    expect(windows).toContain("C:\\bin\\chrome.exe");
    expect(windows).toContain("C:\\bin\\msedge.exe");
    expect(windows.some((entry) => entry.includes("/chrome"))).toBe(false);
  });

  test("空 PATH 段与结尾分隔符不产生畸形候选", () => {
    const list = chromiumCandidates("", { PATH: ":/usr/bin:" }, "linux");
    expect(list.some((entry) => entry.startsWith(":"))).toBe(false);
    expect(list).toContain("/usr/bin/chrome");
  });

  test("Windows 上 PATH 用分号分隔，POSIX 上用冒号", () => {
    expect(chromiumCandidates("", { PATH: "/a:/b" }, "linux")).toContain("/a/chrome");
    expect(chromiumCandidates("", { PATH: "C:\\a;C:\\b" }, "win32")).toContain("C:\\b\\msedge.exe");
  });

  test("POSIX 上 PATH 变量名三种大小写都认（WSL 与 git-bash 各写各的）", () => {
    expect(chromiumCandidates("", { Path: "/x" }, "linux")).toContain("/x/chrome");
    expect(chromiumCandidates("", { path: "/y" }, "linux")).toContain("/y/chrome");
  });
});

describe("findChromium", () => {
  test("取第一个存在的候选，后面的不再问", () => {
    const result = probe({
      configured: CHROME,
      env: { CHROME_PATH: "/other/chrome" },
      platform: "linux",
      exists: [CHROME, "/other/chrome"]
    });
    expect(result.exe).toBe(CHROME);
    expect(result.asked).toEqual([CHROME]);
  });

  test("配置路径不存在时继续试其余候选：一处配错不该让导出不可用", () => {
    const result = probe({
      configured: "/nope/chrome",
      env: { CHROME_PATH: "/env/chrome" },
      platform: "linux",
      exists: ["/env/chrome"]
    });
    expect(result.exe).toBe("/env/chrome");
    expect(result.configuredMissing).toBe(false);
  });

  test("全落空返回 null；给过配置路径就标 configuredMissing", () => {
    const result = probe({ configured: "/nope/chrome", platform: "linux", exists: [] });
    expect(result.exe).toBe(null);
    expect(result.configuredMissing).toBe(true);
  });

  test("没配路径时全落空不怪用户（configuredMissing=false）", () => {
    const result = probe({ platform: "linux", exists: [] });
    expect(result.exe).toBe(null);
    expect(result.configuredMissing).toBe(false);
  });

  test("platform 缺省取 process.platform，不因未注入而抛错", () => {
    const lookup = findChromium("", { env: {}, existsSync: () => false });
    expect(lookup.exe).toBe(null);
  });
});
