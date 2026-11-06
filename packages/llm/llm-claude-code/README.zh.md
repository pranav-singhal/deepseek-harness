---
description: "通过用户本机安装的 Claude Code 程序运行 Claude 模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-code

[English](README.md) | 中文

## 概要

本包增加 **Claude（通过 Claude Code）** 模型路由。它通过 Anthropic 的 Claude Agent SDK 启动用户未经修改的 `claude` 程序，并由该程序在用户已有的 Claude Code 登录下发起模型调用。DeepSeek Harness 在 SDK 接受的范围内提供自己的工具。插件不收集、不保存、不刷新、不转发 Claude 凭据，也不读取 Claude Code 的凭据文件。

## 目录

- [使用](#use)
- [理解](#understand)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use"></a>
## 使用

基础包以 `llm-claude-code` 加载本插件。不需要 API key。安装 Claude Code，运行 `claude`，并输入 `/login`。打开 **Settings → Models**。在 Claude Code 缺失或未登录时，这一行仍然可见，并说明上述步骤。登录探测报告出模型后，选择其中一个。当 `claude` 不在 `PATH` 上时，把 `DSH_CLAUDE_PATH` 设为该可执行文件。在插件下设置 `enabled: false` 可关闭该路由。

<a id="understand"></a>
## 理解

探测以空闲提示启动 `claude`，并从 SDK 的初始化结果读取账户来源和模型列表。只有当该结果显示登录来源不是 `none` 且至少有一个模型时，路由才会注册。路由尚未就绪时，探测每 30 秒重复一次，易变设置变更后也会再探测一次。路由尚未就绪时到达的请求会再探测一次，然后以 `AUTH` 失败。

每个会话保留一个 `claude` 进程。首次请求把 harness 记录渲染为一条用户提示，并追加固定说明和该请求的系统文本。工具调用尚未返回时，进程保持打开。同一会话和同一用途的下一次请求，在模型、系统文本、力度和工具定义都未改变、且每个待处理工具调用都已有结果时，会继续该进程。其他变化会关闭进程并重新发送记录。登出或认证失败会撤下路由，并提示用户运行 `claude` 后输入 `/login`。

子进程环境是当前进程环境去掉 Anthropic 令牌变量后的结果，因此不会转发 harness 的 API key。隔离变量会关闭 Claude Code 的指令文件、自动记忆、自动压缩、离开摘要、工具搜索和顾问工具。Claude Code 的内置工具被禁用。Harness 工具通过名为 `dsh` 的进程内 MCP 服务器提供。

<a id="further-exploration"></a>
## 进一步探索

- [从源码运行](../../../README.zh.md#run-from-source) — 本地检出，包括 macOS 上的 Claude Code 步骤。
- [提供商](../../../docs/user/guide/providers.zh.md#use-claude-through-claude-code) — Settings → Models 中的这一行。
- [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-claude-code) — `enabled` 字段。
- [LLM 流式传输](../../../docs/subsystems/llm-streaming.zh.md) — 本路由发出的适配器词汇。

<a id="model-experience"></a>
## 模型体验

### 追加的说明

#### 模型看到什么

每次 Claude Code 请求都会先追加下面这条固定说明，再追加该请求的 harness 系统文本。这条说明在每次调用中都相同。

##### 追加的说明

```markdown
You are answering inside DeepSeek Harness. Use only the dsh tools. Do not use Claude Code built-in tools. Do not ask for an API key.
```

#### 对 token 的影响

说明和 harness 系统文本会在每个新的 Claude Code 进程中发送。继续中的工具回合不会再次发送它们。

#### 对 KV Cache 的影响

追加文本位于活动进程的前面，因此后续工具回合可以复用它。新进程会再次发送它。

### 记录与工具

#### 模型看到什么

用户提示是带标签的 harness 记录文本。图片或文件会变成句子 `[Image omitted. This route sends text only.]` 或 `[File <name> omitted. This route sends text only.]`。Harness 工具以名为 `mcp__dsh__*` 的 MCP 工具到达。不会提供 Claude Code 的内置工具。

#### 对 token 的影响

一个进程的首次请求发送整段记录。继续中的工具回合只把工具结果送回等待中的进程。

#### 对 KV Cache 的影响

继续中的工具回合保持同一进程，因此较早的记录可以留在缓存中。模型、系统文本、力度或工具集发生变化时会启动新进程，并把记录作为新文本发送。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 本路由不提供应用内的 Claude 登录，也没有 Claude API key 字段。
- 它不发送 harness 归属头、自定义 API 地址、temperature、top-p、停止序列或 seed，因为未经修改的 `claude` 程序拥有 HTTP 请求。
- 图片和文件是省略文本，不是字节。
- Claude Code 的指令文件、钩子、技能、记忆、自动压缩、计划模式、内置工具和用量显示保持关闭。
- 没有本机 `claude` 程序的机器不能使用该路由。
- 独立的 Claude Code 子代理包仍使用 SDK 自带的运行时，而不是本路由。
- 启动之后完成的登录会在下一次探测时出现。

### 开发者注记

适配器无法附上 `attributionHeaders()`。添加 `ANTHROPIC_CUSTOM_HEADERS` 或 `CLAUDE_AGENT_SDK_CLIENT_APP` 会把进程标成第三方客户端，订阅登录可能因此拒绝请求。
