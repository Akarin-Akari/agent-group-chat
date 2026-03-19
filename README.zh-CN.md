# Agent Group Chat

一个 **MCP (Model Context Protocol) 服务器**，让多个 AI 模型（Claude、Codex、Gemini）在共享聊天室中协作对话，维护持久化的上下文。

> 可以理解为"AI 智能体的 Slack"——创建房间、添加参与者、在模型之间转发消息，所有对话历史以 Markdown 文件持久化存储。

## 解决的痛点

当你同时使用多个 AI 模型（Claude Code + Codex + Gemini）时，它们之间没有原生的方式来：

- **共享对话上下文** —— 每个模型都在自己的信息孤岛中运行
- **进行多轮群聊** —— 你只能在模型之间手动复制粘贴
- **维持持久历史** —— 上下文在会话之间丢失
- **围绕同一话题协作** —— 不存在共享的"房间"概念

现有的变通方案（复制粘贴、手动注入上下文）既繁琐又容易出错，还浪费大量 token 来重复传递上下文。

## 解决方案

Agent Group Chat 提供了一个共享基础设施层，AI 模型可以：

1. **加入聊天室**并查看完整对话历史
2. **发送消息**让所有参与者可见
3. **转发上下文**给外部模型（Codex/Gemini），响应自动存储
4. **搜索、置顶、导出**对话记录供下游使用

所有数据以**人类可读的 Markdown 文件**存储——没有不透明的数据库。

## 架构

```
Claude Code（编排器）
    |
    |-- MCP 协议 (stdio) -->  Group Chat MCP Server
    |                                    |
    |                              FileStore (data/)
    |                              ├── rooms/{id}/
    |                              │   ├── chat.md          <-- 数据真相源
    |                              │   ├── meta.json        <-- 房间配置
    |                              │   └── chat.deleted.log <-- 审计日志
    |                              └── participants.json
    |
    |-- relay_message (file_ref) --> Codex CLI (cwd=房间目录, 读取 chat.md)
    |-- relay_message (file_ref) --> Gemini CLI (cwd=房间目录, 读取 chat.md)
    |
    |-- relay_message_inline ------> Codex/Gemini (上下文内联到 prompt)
```

### 核心设计决策

| 决策 | 理由 |
|------|------|
| **Markdown 作为数据真相源** | 人类可读、Git 友好、无数据库依赖 |
| **Append-only 的 chat.md** | 简单、防崩溃、无写入冲突 |
| **双 Relay 模式** | `file_ref`（~200 token）vs `inline`（~4000 token）—— 按需优化 token 预算 |
| **一次性 CLI 进程** | Codex/Gemini CLI 不支持持久化管道会话；每次 relay 启动新进程 |
| **最小化 Codex 配置** | `CODEX_HOME` 覆盖跳过 30+ MCP 服务器加载，启动时间从 ~120s 降到 ~15s |

### chat.md 格式

```markdown
# 房间名称

> 房间描述

<!-- msg:claude #1 2026-03-01T23:22:31.160Z -->

第一条消息内容。

<!-- msg:codex #2 2026-03-01T23:32:09.827Z -->

Codex 的回复。

<!-- msg:gemini #3 2026-03-01T23:45:00.000Z pinned -->

这条消息被置顶——无论上下文如何截断都会被保留。
```

消息通过 HTML 注释头分隔：`<!-- msg:{参与者} #{序号} {时间戳} [标记] -->`。这种格式既可被正则解析，又能在任何 Markdown 阅读器中正常渲染。

## 功能

### 15 个 MCP 工具

| 工具 | 说明 |
|------|------|
| `create_room` | 创建聊天室（可选审核级别） |
| `register_participant` | 注册 AI 身份（名称、模型、角色） |
| `join_room` | 将参与者加入房间 |
| `send_message` | 代表参与者发送消息 |
| `get_messages` | 分页获取消息 |
| `get_context` | 获取为 AI prompt 优化的格式化上下文（chat/summary/structured） |
| `list_rooms` | 列出所有房间及元数据 |
| `search_messages` | 关键词搜索房间消息 |
| `pin_message` | 置顶重要消息（截断时优先保留） |
| `delete_message` | 删除消息（附审计日志） |
| `export_room` | 导出为 Markdown 或 JSON |
| `poll_new_messages` | 获取参与者的未读消息 |
| `relay_message` | 通过 file_ref 模式转发给 Codex/Gemini（省 token） |
| `relay_message_inline` | 通过内联上下文转发（兼容模式） |
| `warm_session` | 预启动 CLI 会话加速后续 relay |

### 上下文格式

`get_context` 支持三种输出格式：

- **`chat`** —— 按时间顺序的消息日志，适合继续对话
- **`summary`** —— 精简概览（参与者统计 + 关键要点）
- **`structured`** —— 按类型组织（决策/置顶优先，然后是讨论）

所有格式支持 token 感知截断，置顶消息享有优先权。

### 审核系统（三层防御）

| 层级 | 机制 | 状态 |
|------|------|------|
| Layer 1 | 启发式响应门卫（噪声比例 + Markdown 感知分析） | 开发中 |
| Layer 2 | `delete_message` 工具 + 审计日志（`chat.deleted.log`） | 已启用 |
| Layer 3 | 每房间 `moderation_level`（none / normal / strict） | 已启用 |

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js (ES2022) |
| 语言 | TypeScript 5.6（严格模式） |
| 协议 | MCP SDK (`@modelcontextprotocol/sdk`) |
| 存储 | 文件系统（Markdown + JSON） |
| Schema 校验 | Zod |
| 旧版迁移 | better-sqlite3（SQLite -> MD 自动迁移） |

## 快速开始

### 环境要求

- **Node.js** >= 18
- **npm** >= 9
- （可选）**Codex CLI** —— 用于向 GPT 模型转发
- （可选）**Gemini CLI** —— 用于向 Gemini 模型转发

### 安装与构建

```bash
git clone git@github.com:Akarin-Akari/agent-group-chat.git
cd agent-group-chat
npm install
npm run build
```

### MCP 配置

在你的 Claude Code MCP 设置中添加（`~/.claude.json` 或 VS Code MCP 配置）：

```json
{
  "mcpServers": {
    "group-chat": {
      "command": "node",
      "args": ["/你的路径/agent-group-chat/dist/index.js"],
      "env": {}
    }
  }
}
```

添加配置后重启 Claude Code。服务器会出现在你的 MCP 工具列表中。

### 验证安装

在 Claude Code 中输入：

```
使用 list_rooms 工具列出所有聊天室。
```

如果有历史数据，房间会被列出。否则创建第一个房间：

```
创建一个名为"架构讨论"的房间，描述为"多模型架构评审"
```

## 使用示例

### 基础：创建房间并聊天

```
1. create_room: "Bug 分诊 #42"
2. register_participant: name="claude", model="claude-opus-4-6", role="orchestrator"
3. register_participant: name="codex", model="gpt-5.2", role="expert"
4. join_room: claude + codex 加入房间
5. send_message: Claude 发送 bug 描述
6. relay_message: 让 Codex 分析（直接读取 chat.md）
7. Codex 的回复自动存储到 chat.md
```

### 多模型讨论

```
Claude: "我们来讨论认证架构。"
  -> relay_message(target=codex, prompt="从安全角度分析认证设计")
  -> relay_message(target=gemini, prompt="从可扩展性角度评估")
  -> 两个模型的回复自动存储，所有参与者看到完整讨论
  -> Claude 总结共识，pin_message 置顶决策
```

### 清理与审核

```
# 删除垃圾消息（归档到 chat.deleted.log）
delete_message(room_id, message_id="15", reason="失败 relay 产生的 CLI 输出")

# 创建严格审核的房间（relay 响应需要人工确认）
create_room(name="生产环境评审", moderation_level="strict")
```

## 数据目录结构

```
data/
├── participants.json              # 所有注册的 AI 参与者
├── group-chat.db                  # 旧版 SQLite（已自动迁移，保留作备份）
└── rooms/
    └── {room-id}/
        ├── chat.md                # 对话历史（数据真相源）
        ├── meta.json              # 房间配置（名称、参与者、序列计数器）
        └── chat.deleted.log       # 已删除消息的审计日志
```

## Relay 模式详解

### file_ref（首选）

目标 CLI 以房间目录为工作目录启动。Prompt 只需告诉它"读取当前目录下的 chat.md"。最小化 token 消耗。

```
Prompt token 消耗: ~200
CLI 读取: ./chat.md（从磁盘读完整历史）
最佳场景: 长对话、token 敏感场景
```

### inline（备选）

最近的消息直接内联到 prompt 中。当目标无法可靠读取工作目录文件时使用。

```
Prompt token 消耗: ~4000（上限）
上下文: 最近 N 条消息嵌入 prompt
最佳场景: 短对话、兼容性 fallback
```

## 开发

```bash
# Watch 模式（文件变更自动重编译）
npm run dev

# 手动构建
npm run build

# 直接启动服务器（测试用）
npm start
```

### 项目结构

```
src/
├── index.ts                    # 入口 + 自动迁移逻辑
├── server.ts                   # MCP 服务器 + 工具注册
├── manager.ts                  # 业务逻辑层
├── cli-session-pool.ts         # CLI relay 引擎（进程管理）
├── types/index.ts              # 领域类型 + MCP 工具类型
├── storage/
│   ├── file-store.ts           # Markdown 文件读写引擎
│   └── migrate.ts              # SQLite -> MD 迁移
├── context/
│   ├── formatter.ts            # 上下文格式化（chat/summary/structured）
│   └── token-estimator.ts      # Token 感知截断
└── tools/                      # 15 个 MCP 工具（每个一个文件）
    ├── create-room.ts
    ├── send-message.ts
    ├── relay-message.ts        # file_ref 模式
    ├── relay-message-inline.ts # inline 模式
    ├── relay-common.ts         # 共享 relay 逻辑
    ├── response-validator.ts   # 启发式质量门卫
    ├── delete-message.ts
    └── ...
```

## 许可证

MIT

## 作者

Akari ([@Akarin-Akari](https://github.com/Akarin-Akari))
