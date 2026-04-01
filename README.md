# MoeCli

> A pink-themed, provider-agnostic coding CLI for local development workflows.

[中文文档](./README.zh-CN.md)

MoeCli is a multi-provider coding assistant that runs in your terminal and keeps the useful parts of a modern coding agent workflow: streaming chat, local tools, browser integration, search, task planning, sub-agents, and automatic context compaction.

It is designed for people who want a Codex / Claude Code style local CLI, but with their own provider choice.

## Highlights

- Pink-themed terminal experience with streaming output and tool activity rendering
- Native support for multiple providers instead of being locked to one vendor
- Chat mode and task mode with keyboard switching
- Local file, shell, browser, search, and sub-agent tools
- Automatic context compaction for long-running conversations
- Provider profiles with local secret storage
- Model sync from provider endpoints, with manual fallback when model listing is unavailable

## Supported Providers

| Provider | Status | Notes |
| --- | --- | --- |
| OpenAI Responses | Supported | Native Responses API flow |
| OpenAI Compatible | Supported | Responses-first, Chat fallback |
| Anthropic | Supported | Messages API |
| Amazon Bedrock | Supported | Converse / ConverseStream style integration |
| Google Gemini | Supported | Gemini API integration |

## Install

### Global install

```bash
npm i -g @moetanorg/moecli
```

### Run directly

```bash
moecli
```

### Requirements

- Node.js 22+

## Quick Start

### 1. Launch MoeCli

```bash
moecli
```

### 2. Add your first provider profile

Inside the CLI:

```text
/providers
```

You can add:

- profile name
- provider type
- base URL / region / extra headers
- API key
- default model

If model listing fails, MoeCli will let you type the model id manually.

### 3. Start chatting

```text
Explain this repo structure
```

### 4. Switch to task mode when you want a plan-first workflow

```text
/mode task
```

Or use:

```text
Shift+Tab
```

## Interaction Modes

### Chat & Edit

Use this mode for:

- normal conversation
- code questions
- refactors and direct edits
- quick debugging

### Task

Use this mode for:

- plan-first execution
- larger implementation work
- task review and approval flow
- multi-step coding jobs

Task mode is designed to:

1. explore first
2. ask follow-up questions when needed
3. submit a task plan
4. wait for approval
5. execute after approval

## Built-in Tools

MoeCli includes a local tool layer instead of relying on cloud-only features.

### Core tools

- `read_file`
- `list_files`
- `write_file`
- `shell`
- `web_search`

### Browser tools

- `browser_status`
- `browser_open`
- `browser_snapshot`
- `browser_screenshot`

### Task workflow tools

- `request_user_input`
- `task_submit_plan`

### Sub-agent tools

- `agent_spawn`
- `agent_send`
- `agent_wait`
- `agent_abort`

## Common Commands

| Command | Description |
| --- | --- |
| `/help` | Show command help |
| `/providers` | Add, edit, activate, or delete provider profiles |
| `/model` | Change the active model |
| `/mode` | Switch between `chat-edit` and `task` |
| `/status` | Show current session, provider, model, and compaction state |
| `/config` | Configure browser, search, and default agent mode |
| `/browser` | Inspect local browser integration |
| `/clear` | Start a fresh conversation |
| `/exit` | Quit MoeCli |

## Search Integration

MoeCli supports a configurable search endpoint for real-time web search.

You can configure search inside:

```text
/config
```

Typical settings include:

- endpoint URL
- auth header name
- auth header prefix
- API key
- default site / filetype / sort / time range

## Context Compaction

Long conversations are handled automatically.

MoeCli keeps:

- full local runtime history
- active compacted context for the model
- session memory file for long-running work

When the prompt gets too large, MoeCli will compact older context and continue instead of simply failing.

## Local Storage

By default, MoeCli stores its local data in:

```text
~/.moecli
```

This includes:

- settings
- secrets
- cache
- session memory
- agent state

You can override the home directory with:

```bash
MOECLI_HOME=/custom/path
```

## Development

### Install dependencies

```bash
npm install
```

### Start in development mode

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

## Package

Published package:

```text
@moetanorg/moecli
```

CLI command:

```text
moecli
```

## Vision

MoeCli aims to be a practical local coding CLI that is:

- provider-agnostic
- tool-rich
- task-oriented
- terminal-native
- friendly to long-running engineering work

If you like terminal coding agents but want more control over providers and local workflows, MoeCli is built for that.

## Thanks

[Linux.Do](https://linux.do)
[MoeTan](https://moetan.org)
