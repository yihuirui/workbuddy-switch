# Darwin 运行时修复

最初的崩溃复现与补丁验证在 2026-10-20 的 darwin/amd64 环境完成。0.1.2 预览包面向 macOS ARM64，并在发布流程中对随包运行时执行空账号库烟雾测试；这不覆盖真实账号或模型推理。

原发布 CLIProxyAPI 8.0.35、7.2.145 加载 WorkBuddy 0.9.8 均复现 Go runtime 崩溃。仅更新插件编译器仍会崩溃。实验表明：通过新的原生 pthread 进入另一套 Go runtime，可避开本机直接跨 runtime 调用的崩溃。此结果支持线程上下文冲突的诊断，但不是对所有 macOS 架构的证明。

补丁 `patches/cliproxyapi-darwin-native-threads.patch` 基于 CLIProxyAPI 提交 `3f0cef010e4ad20279500e6b0f18060b6f3f37cc`，仅改变 Darwin 的 C ABI 调用。初始化、调用、释放、关闭以及反向 host callback 均在独立原生线程中执行，调用线程同步 join，确保请求和响应指针在调用期间存活。其他平台保留原路径。

`scripts/build-patched-engine.py` 固定提交及 Go 1.26.10，在临时目录克隆、校验和应用补丁，生成独立的 `runtime/cli-proxy-api-wb`。不替换下载的原版引擎，也不覆盖已存在的修补版。第三方 MIT 许可沿用 THIRD_PARTY_NOTICES.md。

本机通过：

- 修补引擎 + 原发布 WorkBuddy 0.9.8：成功注册且有效启用。
- 缺失或错误 API key 返回 401；正确 key 可读 `/v1/models`。
- 8 路并发、80 次插件账号读取成功，空账号库覆盖 host 回调和缓冲区释放。
- CLIProxyAPI `go test ./internal/pluginhost` 通过，含动态库重新加载及初始化失败后的重试测试。
- CLIProxyAPI `go test ./...` 全量通过；项目内修补引擎正常退出（exit=0）。

全量构建/测试并行时曾两次超过 30 秒就绪窗口，负载结束后复测通过。暂推测为资源竞争，不能据此声称所有启动条件都已稳定。二进制及补丁校验值记录在 runtime-build.json。

限制：每次 ABI 调用创建线程，实际流式负载下性能尚未测量。线程创建失败时调用返回错误；void 释放/关闭路径没有错误回传，极端资源耗尽下可能泄漏；join 异常时终止代理进程，避免调用栈被释放后线程仍访问。空账号库下的 ARM64 运行时检查不证明真实账号调用、流式负载或长期运行稳定性。

任何真实账号凭据必须通过应用登录或用户主动导入，不能写入补丁、测试、日志或项目文档。
