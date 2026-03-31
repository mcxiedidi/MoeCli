# MoeCli

> 一个以粉色风格为主、支持多 Provider 的本地编码 CLI。

[English README](./README.md)

MoeCli 是一个运行在终端里的多 Provider 编码助手，保留了现代 coding agent 工作流里最有价值的能力：流式对话、本地工具、浏览器集成、搜索、任务规划、子 Agent，以及长会话自动压缩。

如果你想要一个类似 Codex / Claude Code 风格的本地 CLI，但又不想被单一厂商绑定，MoeCli 就是为这种场景设计的。

## 亮点

- 粉色主题终端界面，支持流式输出和工具活动展示
- 原生支持多 Provider，不绑定单一模型厂商
- 支持聊天模式与任务模式，并可快捷切换
- 内置本地文件、Shell、浏览器、搜索、子 Agent 工具
- 长会话自动压缩上下文，避免聊久了直接报错
- 支持本地 Provider Profile 与密钥存储
- 支持从 Provider 拉取模型列表，拉不到时可手动输入

## 支持的 Provider

| Provider | 状态 | 说明 |
| --- | --- | --- |
| OpenAI Responses | 已支持 | 原生 Responses API |
| OpenAI Compatible | 已支持 | 优先 Responses，失败回退 Chat |
| Anthropic | 已支持 | Messages API |
| Amazon Bedrock | 已支持 | Converse / ConverseStream 风格接入 |
| Google Gemini | 已支持 | Gemini API 接入 |

## 安装

### 全局安装

```bash
npm i -g @moetanorg/moecli
```

### 启动

```bash
moecli
```

### 运行要求

- Node.js 22+

## 快速开始

### 1. 启动 MoeCli

```bash
moecli
```

### 2. 添加 Provider 配置

在 CLI 里输入：

```text
/providers
```

你可以配置：

- Profile 名称
- Provider 类型
- Base URL / Region / Extra Headers
- API Key
- 默认模型

如果模型列表拉取失败，MoeCli 会允许你手动输入模型 ID。

### 3. 开始聊天

```text
帮我解释一下这个仓库结构
```

### 4. 切换到任务模式

```text
/mode task
```

或者直接使用：

```text
Shift+Tab
```

## 交互模式

### Chat & Edit

适合：

- 普通对话
- 代码问答
- 直接改代码
- 快速排错

### Task

适合：

- 先规划再执行的任务
- 较大的实现工作
- 需要审批的任务流
- 多步骤编码任务

Task 模式的设计目标是：

1. 先探索
2. 必要时向用户提问
3. 提交任务计划
4. 等待批准
5. 批准后执行

## 内置工具

MoeCli 使用本地工具层，而不是依赖厂商特有的云端能力。

### 核心工具

- `read_file`
- `list_files`
- `write_file`
- `shell`
- `web_search`

### 浏览器工具

- `browser_status`
- `browser_open`
- `browser_snapshot`
- `browser_screenshot`

### 任务流工具

- `request_user_input`
- `task_submit_plan`

### 子 Agent 工具

- `agent_spawn`
- `agent_send`
- `agent_wait`
- `agent_abort`

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看帮助 |
| `/providers` | 新增、编辑、切换或删除 Provider Profile |
| `/model` | 切换当前模型 |
| `/mode` | 在 `chat-edit` 与 `task` 之间切换 |
| `/status` | 查看当前会话、Provider、模型和压缩状态 |
| `/config` | 配置浏览器、搜索与默认 Agent 模式 |
| `/browser` | 查看本地浏览器集成状态 |
| `/clear` | 开启一个全新的会话 |
| `/exit` | 退出 MoeCli |

## 搜索集成

MoeCli 支持可配置的实时搜索接口。

你可以在这里配置：

```text
/config
```

典型配置包括：

- Endpoint URL
- 鉴权 Header 名
- 鉴权 Header 前缀
- API Key
- 默认 site / filetype / sort / time range

## 上下文自动压缩

长对话会自动处理，不需要用户手动介入。

MoeCli 会同时保留：

- 本地完整运行历史
- 发给模型的压缩后活跃上下文
- 用于长任务持续记忆的 session memory 文件

当上下文过大时，MoeCli 会自动压缩旧内容并继续，而不是直接失败。

## 本地存储

默认情况下，MoeCli 会把数据写到：

```text
~/.moecli
```

其中包含：

- settings
- secrets
- cache
- session memory
- agent 状态

你也可以用下面的环境变量改目录：

```bash
MOECLI_HOME=/custom/path
```

## 开发

### 安装依赖

```bash
npm install
```

### 开发模式启动

```bash
npm run dev
```

### 构建

```bash
npm run build
```

### 测试

```bash
npm test
```

## 包信息

发布包名：

```text
@moetanorg/moecli
```

命令行入口：

```text
moecli
```

## 目标

MoeCli 希望成为一个真正适合本地开发工作流的编码 CLI：

- 多 Provider
- 工具丰富
- 任务导向
- 终端原生
- 适合长时间工程对话

如果你喜欢终端型 coding agent，但希望对 Provider 和本地工作流拥有更高控制权，MoeCli 就是为你准备的。
