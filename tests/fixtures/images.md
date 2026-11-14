# M3 图片夹具（STORY-08-01 / 08-02 / 08-03）

本文件是图片链路的**人读 + 机读**双重夹具：

- 浏览器 harness 直接打开它，肉眼核对四态（`pending` / `ready` / `missing` / `blocked`）；
- `apps/webview` 的夹具测试把它跑进真实 `renderMarkdown`，再交给 `image-layer` 断言状态机；
- `apps/extension` 的真机 fs 测试用同一批 `assets/` 文件断言解析、边界与策略。

状态列写在每节引言里，改动夹具时请同步改动断言。
`assets/` 与 `outside/` 下的图片由 `node scripts/gen-fixture-assets.mjs` 生成，可重复执行。

## 1. 白名单 MIME（预期：全部 ready）

策略允许的五个类型各一张，覆盖「扩展名 → MIME → 浏览器解码」整条链。

![PNG 位图](assets/logo.png)
![JPEG 位图](assets/photo.jpg)
![GIF 位图](assets/diagram.gif)
![WebP 位图](assets/icon.webp)
![SVG 矢量](assets/flow.svg)

本地 SVG 一律走 `<img>`，永不内联：`<img>` 语境里 SVG 内的脚本不执行，
这是不依赖 Sanitizer 也成立的纵深防御（`flow.svg` 内置了一个脚本探针）。

## 2. 空格、Unicode 与百分号编码（预期：全部 ready）

前两种写法指向同一个文件。渲染层会把尖括号目标里的空格与中文**归一成同一个百分号形式**
（CommonMark 的 `normalizeLink` 行为），于是 Host 只会看到一种写法：

![中文与空格文件名（尖括号目标）](<assets/中文 标志.png>)
![中文与空格文件名（百分号编码）](assets/%E4%B8%AD%E6%96%87%20%E6%A0%87%E5%BF%97.png)
![大写文件名与扩展名](assets/CAPITAL.PNG)

第三种写法验证 MIME 判定忽略扩展名大小写；连文件名一起大写，
是为了让断言在大小写敏感的文件系统上同样成立（而不是「碰巧」命中 logo.png）。

## 3. 标题、尺寸与跳出文档目录（预期：ready）

![带标题的图](assets/logo.png "标题：中文与空格")
![同级之上但仍在工作区内](../fixtures/assets/logo.png)

`../…` 只要落回授权根之内就必须能解析（ARC-008 §5.1）：
只允许文档目录之内的引用会把这种写法错误地报成越权。

## 4. 缺失与不可读（预期：missing + 原因）

![不存在的图片](assets/missing.png)
![指向目录](assets/)
![空引用]()

前两种给出「本地图片不存在或不可读」，而不是留一个 0×0 的空框（AUD-001 F06-006）；
最后一种连请求都不该发出去，就地报「图片引用为空」。

## 5. 越出授权根（预期：denied → missing + 越界原因）

四条写法指向的是同一类越界，必须全部被拒，且不能因为编码形式不同而漏掉任何一条。

![明文穿越](../../etc/passwd.png)
![百分号斜杠穿越](..%2f..%2fetc%2fpasswd.png)
![大小写混写的编码穿越](..%2F..%2Fetc%2Fpasswd.png)
![百分号反斜杠穿越](..%5c..%5cetc%5cpasswd.png)

第三条验证编码大小写不影响判定，第四条是唯一能让反斜杠分隔符进到 Host 的写法：
CommonMark 会把目的地里的字面 `\` 百分号化，所以「反斜杠别名」在解码后与 `../`
走同一条归一路径，不存在第二条通道。

![双重编码（预期不是越权）](..%252e%252e%252fetc%252fpasswd.png)

最后一行是双重编码：只解码一次，结果是字面文件名 `..%2e%2e%2f…`，
留在文档目录内且不存在，因此预期是 **missing（不存在）** 而不是 denied ——
把它写进夹具，是为了让「只解码一次」这个决定留下可见的行为差异。

![符号链接逃逸](assets/escape-link.png)

符号链接那张是 `assets/` 内的链接，真身指向 `outside/secret.png`：
路径字面上完全合法，只有对 `realpath` 结果二次校验才能拦住它。
非 POSIX 平台生成不了符号链接时该夹具缺席，对应断言自动跳过。

## 6. 类型不允许（预期：unsupported → missing + 类型原因）

![Markdown 不是图片](sample.md)

`sample.md` 存在且在授权根内，但它不是图片：能力边界与授权边界必须给出不同的原因。

## 7. 外部与内联数据（预期：blocked，不发请求）

![CDN 上的图](https://example.com/assets/logo.png)
![协议相对地址](//cdn.example.com/logo.png)
![data URI 图片](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)

远端与 `data:` 图片在 M3 默认不加载，Webview 侧就地标记 `blocked`，
连 `resource.resolve` 都不发起 —— 策略拦截不该产生网络副作用。

## 8. 结构内的图片（预期：与所在结构同渲染，不破坏排版）

表格、引用块、列表与链接包裹的图片都要走同一套激活逻辑，
不能因为不在正文顶层就被漏掉。

| 缩略图 | 说明 |
| :----- | :--- |
| ![表格里的图](assets/logo.png) | 表格单元格内的本地图 |
| ![表格里的缺失图](assets/none.png) | 单元格内的缺失图 |

> 引用块里的图：
>
> ![引用块](assets/flow.svg)

- 列表项里的图：![列表项](assets/icon.webp)

1. 有序列表里的缺失图：![有序](assets/absent.gif)

[![被链接包裹](assets/photo.jpg)](https://example.com/gallery)

被链接包裹时图片仍要正常激活；点击优先给 Lightbox，
需要打开外链时由链接自己的 `data-readora-external` 命中委托（见 interactions 测试）。

## 9. 大小上限（说明）

`readora.resources.maxImageSizeMb`（默认 10，范围 1~50）超限时报 `resource.tooLarge`。
本夹具不放一个 10 MB 的真图进仓库：该分支由
`apps/extension/src/__tests__/resource-service.spec.ts` 用注入的 stat 端口确定性地覆盖。

## 10. 跨文档最小跳转（预期：交 Host 解析后打开目标文档）

- [跳到同目录的 sample.md](./sample.md)：目标存在且在授权根内，Host 解析成功。
- [跳到不存在的笔记](./other-note.md)：解析失败，点击回退成行内提示而不是静默无效。

相对 `.md` 链接在 M2 只有降级提示；M3 起点击发 `document.navigate`，
由 Host 按 `kind=document` 解析（只认 `.md/.markdown`），Webview 不拼路径。
