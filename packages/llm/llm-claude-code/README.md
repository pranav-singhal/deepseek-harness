---
description: "Claude models through the user's locally installed Claude Code program."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-code

English | [中文](README.zh.md)

## Summary

This package adds the **Claude (via Claude Code)** model route. It starts the user's unmodified `claude` program through Anthropic's Claude Agent SDK and lets that program make the model call under the user's existing Claude Code login. DeepSeek Harness supplies its own tools where the SDK accepts them. The plugin never collects, stores, refreshes, or forwards Claude credentials, and it never reads Claude Code's credential files.

## Table of Contents

- [Use](#use)
- [Understand](#understand)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use

The base bundle loads the plugin as `llm-claude-code`. No API key is required. Install Claude Code, run `claude`, and type `/login`. Open **Settings → Models**. The row stays visible while Claude Code is missing or signed out and explains those steps. After a signed-in probe reports models, pick one. Set `DSH_CLAUDE_PATH` to the executable when `claude` is not on `PATH`. Set `enabled: false` under the plugin to keep the route off.

## Understand

A probe starts `claude` with an idle prompt and reads the account source and model list from the SDK's initialization result. The route is registered only when that result shows a login source other than `none` and at least one model. The probe repeats every 30 seconds while the route is not ready, and again after a volatile settings change. A request that arrives before the route is ready probes once more, then fails with `AUTH`.

Each chat session keeps one `claude` process. The first request sends the harness transcript as one user prompt and appends the harness note plus the request's system text. While a tool call is pending, the process stays open. The next request on the same session and purpose resumes it when the model, system text, effort, and tool definitions are unchanged and every pending tool call has a result. Any other change closes the process and sends the transcript again. A signed-out or authentication failure drops the route and asks the user to run `claude` and type `/login`.

The child environment is the current process environment with Anthropic token variables removed, so a harness API key is not forwarded. Isolation variables turn off Claude Code instruction files, automatic memory, automatic compaction, the away summary, tool search, and the advisor tool. Built-in Claude Code tools are disabled. Harness tools are exposed as an in-process MCP server named `dsh`.

## Further Exploration

- [Run from source](../../../README.md#run-from-source) — local checkout, including the macOS Claude Code steps.
- [Providers](../../../docs/user/guide/providers.md#use-claude-through-claude-code) — the Settings → Models row.
- [Config catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-claude-code) — the `enabled` field.
- [LLM streaming](../../../docs/subsystems/llm-streaming.md) — the adapter vocabulary this route emits.

## Model Experience

### Appended instructions

#### What the model sees

Every Claude Code request appends the fixed note below, then the harness system text for that request. The note is the same on every call.

##### Appended note

```markdown
You are answering inside DeepSeek Harness. Use only the dsh tools. Do not use Claude Code built-in tools. Do not ask for an API key.
```

#### Token effect

The note and the harness system text are sent on every new Claude Code process. A resumed tool turn does not send them again.

#### KV Cache effect

The appended text stays at the front of a live process, so later tool turns can reuse it. A new process sends it again.

### Transcript and tools

#### What the model sees

The user prompt is the harness transcript rendered as labeled text. An image or file is the sentence `[Image omitted. This route sends text only.]` or `[File <name> omitted. This route sends text only.]`. Harness tools arrive as MCP tools named `mcp__dsh__*`. Claude Code built-in tools are not offered.

#### Token effect

The first request of a process sends the whole transcript. A resumed tool turn sends only the tool result back to the waiting process.

#### KV Cache effect

A resumed tool turn keeps the process, so the earlier transcript can stay cached. A changed model, system text, effort, or tool set starts a new process and sends the transcript as new text.

## Known Limitations and Deferred Work

- This route does not offer an in-app Claude sign-in or a Claude API key field.
- It does not send the harness attribution header, a custom base URL, temperature, top-p, stop sequences, or a seed, because the unmodified `claude` program owns the HTTP request.
- Images and files are omission text, not bytes.
- Claude Code instruction files, hooks, skills, memory, automatic compaction, plan mode, built-in tools, and its usage display stay off.
- A machine without a local `claude` program cannot use the route.
- The separate Claude Code subagent package still uses the SDK's bundled runtime, not this route.
- A login finished after startup appears on the next probe.

### Dev Note

The adapter cannot attach `attributionHeaders()`. Adding `ANTHROPIC_CUSTOM_HEADERS` or `CLAUDE_AGENT_SDK_CLIENT_APP` marks the process as a third-party client, which can make a subscription login reject the request.
