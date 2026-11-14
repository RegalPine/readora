/**
 * 声明「本环境不允许 eval」，让 zod 跳过它的探测（ARC-004 §10 安全基线）。
 *
 * 起因是安全用例里的一条实测红灯：Webview 一启动就记下一次
 * `securitypolicyviolation`，`blockedURI: "eval"`。来源不是文档内容，而是 zod
 * 在构造 object 解析器时探测「这里能不能把字符串编译成代码」—— 它把探测包在
 * `try` 里，所以功能上完全无害，但**浏览器照样举报一次**
 * （zod 自己在源码注释里承认这点）。
 *
 * 上游给的口径就是 `z.config({ jitless: true })`（见 zod README「CSP environments」），
 * 这里照做。代价是 Webview 侧丢掉 zod 的 JIT 快路径：本进程每帧最多解析几条固定
 * 形状的消息信封，量级上可忽略；Host 在 Node 里没有 CSP，不引这个模块，快路径保留。
 *
 * 顺序是这条的唯一要害：必须在**任何契约 Schema 被构造之前**执行，所以它做成
 * side-effect 模块、由入口排在 `@readora/contracts` 之前引入，而不是导出一个函数
 * 让调用方在自己的模块体里调 —— 那时所有 import 早就求值完了。
 */
import { z } from "zod";

z.config({ jitless: true });
