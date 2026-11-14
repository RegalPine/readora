# Readora Extension — 开发说明（apps/extension）

> 本文件是面向贡献者的模块级开发文档，**不是**扩展 Details 页内容。
> 安装 vsix 后 VS Code「扩展 → Details」渲染的是同目录的 `README.md`（面向用户）。

VS Code 扩展宿主端。入口 `src/extension.ts` 只做生命周期转发，实际模块装配在
`src/application.ts`（`createReaderApplication` 统一管理所有 Disposable）。
业务模块划分见 `src/`：configuration / document / session / webview /
messaging / security / commands / export / resources，另有顶层
`constants.ts` / `diagnostics.ts` / `errors.ts`。

## 命令

- 构建：仓库根 `pnpm build:host`（esbuild → `dist/extension.js`）
- 打包：`pnpm package:vsix`（vsce，`--no-dependencies`，contracts 已 bundle）
- 测试：`pnpm test`（vscode stub + 依赖注入，不依赖真实 VS Code）

## 注意

- publisher `readora-dev` 为占位，发布前必须替换为注册 publisher。
- `repository` / `bugs` / `homepage` 已指向 `https://github.com/RegalPine/readora`，
  且 `repository.directory` = `apps/extension`：vsce 拿它作为基准改写 Details 页的
  链接，缺失时本目录 `README.md` 里的相对链接会让 `package:vsix` 直接报错中止；
  因此新增链接仍优先写绝对 URL 或反引号纯文本路径。
- Webview 产物由 `apps/webview` 构建写入 `dist/webview/`，
  HTML 模板按固定路径 `assets/main.js` / `assets/main.css` 引用。
- 文档读取一律 `workspace.fs`，禁止 `node:fs`（ARC-008）。
- vsce 默认取本目录 `README.md` 作为扩展 Details 页；`.vscodeignore` 未排除
  `README.md`，故其内容会随 vsix 打包并对最终用户可见，请勿写入内部信息。
