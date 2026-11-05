# 集成依据与验证边界

Workbuddy-Switch2 0.1.2 is a macOS ARM64 preview. Its release workflow tests the bundled runtime with an empty account store; it does not verify real account sign-in or inference.

2026-10-20，按公开源码核对。

| 组件 | 来源与固定版本 | 作用 |
| --- | --- | --- |
| 桌面基础 | https://github.com/changexbc/workbuddy-switch ，22b318c1f44b335c2222e444abcc2d0f74e160f7 | OAuth、多账号、客户端切换、积分、自动签到 |
| 代理引擎 | https://github.com/router-for-me/CLIProxyAPI ，v8.0.35 | OpenAI 等协议端点、凭据调度 |
| WorkBuddy provider | https://github.com/zidanefaqih/codebuddy-intl-cpa ，v0.9.8；源码 756df12dc8ea97fa467619f4fed9afb6a42cba63 | WorkBuddy / CodeBuddy 登录态到模型服务 |

## 已核实

- workbuddy-switch 的自动签到在 crates/wb-switch-core/src/modules/checkin.rs，尽管 README 未列出。
- Switch 导出记录使用 access_token / refresh_token；插件使用 auth.accessToken / auth.refreshToken。
- Switch expiresAt 为毫秒，插件的 OAuth 输出为 Unix 秒。桥接显式转换。
- 国内与国际域名分别校验。同 UID 不同地区采用不同文件标识。
- 加密桌面凭据不能直接作为 API Token，要求重新 OAuth 登录。
- API 同步是显式、单向、仅新增；引擎独立刷新自己的凭据，重复同步不覆盖。
- 桌面库删除与 API 池移除不是同一操作；API 页提供停用/启用，须先停止服务。

## 不做的假定

- 订阅不是积分兑换，也不是增加额度。实际推理走账号有权使用的上游模型，额度仍由上游扣减。
- 模型目录可见不等于推理成功。每个地区、套餐需用真实账号验收。
- 不将第三方插件所宣称的每日奖励数额写成产品保证。
- 不自动上报模拟活动以领取奖励。插件 daily_bonus / lifecycle_auto / checkin_auto / token_keepalive 均关闭，签到由桌面既有配置负责，避免重复调度与自动删号。

## 本机运行发现

CLIProxyAPI v8.0.35 和 v7.2.145 分别加载 v0.9.8 darwin/amd64 插件时，均出现 Go runtime.cgocallback / unknown caller pc 崩溃。无插件的 v8.0.35 可启动，鉴权与模型列表接口通过。此结果证明引擎基线可用，但不证明 WorkBuddy 转 API 已成功。

后续使用固定源码提交 `3f0cef010e4ad20279500e6b0f18060b6f3f37cc` 加入 Darwin 原生线程隔离补丁，WorkBuddy 插件已成功加载，并通过 80 次并发空账号查询。当前默认优先选修补引擎。复现方法、验证及限制见 [DARWIN_RUNTIME.md](DARWIN_RUNTIME.md)。真实账号推理仍未验收。

测试脚本 scripts/smoke-proxy-runtime.py 使用临时空账号库与随机密钥，无真实账号、无付费推理。设置 WB_SKIP_PLUGIN=1 可验证引擎基线；WB_ENGINE_BINARY 可选择兼容性测试引擎。

## 桌面交付范围

首版聚焦账号、积分、签到和 API；可选 Agent Companion 悬浮窗默认不编译。原来源保留在 vendor/，恢复该功能需要单独准备对应资源。上游应用自动更新被禁用，避免覆盖 fork。
