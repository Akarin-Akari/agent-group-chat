# Group Chat MCP Server v2.0 — 功能测试计划

> **目标**：验证 "MD 文档即群聊" 新架构的完整功能，并继续完成"哈梅内伊事件"群聊讨论。
>
> **前置条件**：`npm run build` 已通过零错误。SQLite 数据库 `data/group-chat.db` 存在（含历史数据）。
>
> **日期**：2026-03-03

---

## 一、架构变更摘要（供下一个 Agent 快速理解）

### 1.1 核心变化

| 维度 | 旧架构 (v1) | 新架构 (v2) |
|------|-----------|-----------|
| 数据源 | SQLite 数据库（唯一真相） | MD 文件（ground truth）+ SQLite（可选索引） |
| 存储结构 | `messages` / `rooms` / `participants` 三张表 | `data/rooms/{id}/chat.md` + `meta.json` + `data/participants.json` |
| 消息写入 | INSERT INTO messages | `fs.appendFileSync` 追加到 chat.md |
| 消息读取 | SELECT FROM messages | 解析 chat.md 中的 `<!-- msg:... -->` HTML 注释标记 |
| Relay 模式 | 仅 inline（内嵌全文到 prompt） | **双模式**：file_ref（首选，~200 token）+ inline（备选，~4000 token） |
| 迁移 | 无 | 自动检测 SQLite → 首次启动自动迁移到 MD 文件 |

### 1.2 关键文件

| 文件 | 角色 |
|------|------|
| `src/storage/file-store.ts` | **核心**：MD 文件读写引擎 |
| `src/storage/migrate.ts` | SQLite → MD 迁移脚本 |
| `src/manager.ts` | 管理器（已重写，底层调用 FileStore） |
| `src/server.ts` | MCP Server 入口（v2.0，使用 FileStore） |
| `src/index.ts` | 启动入口（含自动迁移逻辑） |
| `src/tools/relay-message.ts` | file_ref 模式 relay |
| `src/tools/relay-message-inline.ts` | inline 模式 relay（fallback） |
| `src/tools/relay-common.ts` | relay 共享逻辑（验证 + 执行 + 存储） |

### 1.3 chat.md 格式

```markdown
# Room Name

> Room description

<!-- msg:claude #1 2026-03-02T20:00:15.000Z -->

这是第一条消息内容。

<!-- msg:codex #2 2026-03-02T20:05:30.000Z -->

这是 Codex 的回复。

<!-- msg:gemini #3 2026-03-02T20:10:45.000Z pinned -->

这条消息被置顶了。
```

**解析正则**：`<!-- msg:(\w+) #(\d+) ([\dT:.-]+Z?)(?: (.+))? -->`

---

## 二、测试步骤（按顺序执行）

### Phase 0: 启动 MCP Server 验证自动迁移

**步骤**：
1. 确保 `data/rooms/` 目录**不存在**（当前状态已满足）
2. 确保 `data/group-chat.db` 存在（当前状态已满足）
3. 启动 MCP Server（通过 Claude Code 的 `/mcp` 面板重新连接 `group-chat` 服务器）
4. 观察 stderr 日志是否输出自动迁移信息

**预期结果**：
- 输出 `[group-chat] Detected SQLite database without MD files. Running auto-migration...`
- 输出 `[group-chat] Migration complete: X rooms, Y participants, Z messages`
- `data/rooms/` 目录被创建
- 每个 room 下包含 `meta.json` 和 `chat.md`
- `data/participants.json` 被创建

**验证命令**（迁移后执行）：
```bash
# 检查目录结构
ls -la data/rooms/
# 检查每个 room 的文件
ls -la data/rooms/*/
# 检查 participants
cat data/participants.json
# 检查 chat.md 格式是否正确
head -30 data/rooms/*/chat.md
```

### Phase 1: 基础 CRUD 功能测试

#### 1.1 创建新房间

**MCP 工具调用**：
```json
{
  "tool": "create_room",
  "input": {
    "name": "Architecture Test Room",
    "description": "Testing new MD-based architecture"
  }
}
```

**验证**：
- 返回新 room_id
- `data/rooms/{new_id}/meta.json` 存在且内容正确
- `data/rooms/{new_id}/chat.md` 存在且包含 header（`# Architecture Test Room`）

#### 1.2 注册参与者

**MCP 工具调用**（如果 claude/codex/gemini 已存在则跳过）：
```json
{
  "tool": "register_participant",
  "input": {
    "name": "claude",
    "model": "claude-opus-4-6",
    "role": "orchestrator"
  }
}
```

**验证**：
- `data/participants.json` 中包含该参与者

#### 1.3 加入房间

```json
{
  "tool": "join_room",
  "input": {
    "room_id": "<新房间 ID>",
    "participant_name": "claude"
  }
}
```

**验证**：
- `meta.json` 的 `participants` 数组包含 "claude"

#### 1.4 发送消息

```json
{
  "tool": "send_message",
  "input": {
    "room_id": "<新房间 ID>",
    "participant_name": "claude",
    "content": "这是一条测试消息，验证 MD 文件写入功能。"
  }
}
```

**验证**：
- `chat.md` 末尾追加了新消息块
- 格式为 `<!-- msg:claude #1 <timestamp> -->\n\n消息内容\n`
- `meta.json` 的 `sequenceCounter` 递增

#### 1.5 读取消息

```json
{
  "tool": "get_messages",
  "input": {
    "room_id": "<新房间 ID>"
  }
}
```

**验证**：
- 返回的消息列表与 chat.md 内容一致
- 包含 participant、sequence、timestamp、content 字段

#### 1.6 获取上下文

```json
{
  "tool": "get_context",
  "input": {
    "room_id": "<新房间 ID>",
    "format": "chat"
  }
}
```

**验证**：
- 返回格式化的聊天上下文
- 内容与 chat.md 一致

#### 1.7 列出所有房间

```json
{
  "tool": "list_rooms",
  "input": {}
}
```

**验证**：
- 包含迁移过来的旧房间
- 包含新创建的测试房间

#### 1.8 搜索消息

```json
{
  "tool": "search_messages",
  "input": {
    "room_id": "<房间 ID>",
    "query": "测试"
  }
}
```

**验证**：
- 能找到包含"测试"的消息
- 返回结果包含消息元数据

#### 1.9 导出房间

```json
{
  "tool": "export_room",
  "input": {
    "room_id": "<新房间 ID>",
    "format": "markdown"
  }
}
```

**验证**：
- markdown 格式直接返回 chat.md 内容
- json 格式返回解析后的结构化数据

#### 1.10 Pin 消息

```json
{
  "tool": "pin_message",
  "input": {
    "room_id": "<新房间 ID>",
    "message_id": "1"
  }
}
```

**注意**：v2 中 `message_id` 实际是序列号字符串（如 "1"、"2"），不是 UUID。

**验证**：
- chat.md 中对应消息的 HTML 注释行出现 `pinned` 标记
- 如 `<!-- msg:claude #1 2026-03-03T... pinned -->`

### Phase 2: Relay 功能测试

#### 2.1 file_ref 模式（首选）

```json
{
  "tool": "relay_message",
  "input": {
    "room_id": "<测试房间 ID>",
    "target": "codex",
    "prompt": "请阅读聊天记录并发表你对当前讨论的看法。"
  }
}
```

**验证**：
- Codex CLI 以房间目录为 cwd 启动
- prompt 极简（~200 tokens），只让 Codex 读 chat.md
- Codex 的响应自动存储到 chat.md
- `meta.json` 的 `sequenceCounter` 递增

#### 2.2 inline 模式（备选）

```json
{
  "tool": "relay_message_inline",
  "input": {
    "room_id": "<测试房间 ID>",
    "target": "gemini",
    "prompt": "请基于上下文提供你的分析。"
  }
}
```

**验证**：
- prompt 中内嵌了 chat.md 的最近消息（~4000 token 预算内）
- Gemini 的响应自动存储到 chat.md
- `meta.json` 的 `sequenceCounter` 递增

### Phase 3: 迁移数据完整性验证

**前提**：Phase 0 的自动迁移已完成。

#### 3.1 验证 "哈梅内伊事件" 房间

**步骤**：
1. 使用 `list_rooms` 找到迁移过来的 Iran News / 哈梅内伊 相关房间
2. 检查 `meta.json` 中的元数据是否完整
3. 检查 `chat.md` 中的消息数量是否与 SQLite 原始数据一致（预期 13 条消息）
4. 检查消息格式是否正确（HTML 注释分隔符、参与者名称、序列号、时间戳）

**验证命令**：
```bash
# 统计每个 chat.md 中的消息数
grep -c "<!-- msg:" data/rooms/*/chat.md

# 查看具体内容
cat data/rooms/*/chat.md
```

#### 3.2 验证参与者数据

```bash
cat data/participants.json | python -m json.tool
```

**预期**：包含 claude、codex、gemini 三个参与者的完整信息。

---

## 三、"哈梅内伊事件" 群聊讨论续接

### 3.1 背景

之前在 SQLite 架构下，已经创建了一个关于"哈梅内伊事件"（伊朗最高领袖死亡）的多 AI 群聊讨论房间。该房间包含约 13 条消息记录。

### 3.2 续接任务

在完成上述所有功能测试之后，使用新架构继续该讨论：

1. **找到迁移后的房间**
   ```json
   { "tool": "list_rooms", "input": {} }
   ```
   找到含 "Iran" 或 "哈梅内伊" 的房间 ID。

2. **查看当前上下文**
   ```json
   {
     "tool": "get_context",
     "input": { "room_id": "<iran_room_id>", "format": "chat" }
   }
   ```

3. **Claude 发起新一轮讨论**
   ```json
   {
     "tool": "send_message",
     "input": {
       "room_id": "<iran_room_id>",
       "participant_name": "claude",
       "content": "基于之前的讨论，让我们进一步分析哈梅内伊去世后伊朗权力交接的三个可能场景：\n\n1. **平稳过渡**：专家会议迅速选出新最高领袖\n2. **权力真空**：内部派系斗争导致过渡期混乱\n3. **军事介入**：革命卫队借机扩大影响力\n\n@codex @gemini 你们怎么看这三个场景的可能性？"
     }
   }
   ```

4. **Relay 给 Codex（使用 file_ref 模式，首选）**
   ```json
   {
     "tool": "relay_message",
     "input": {
       "room_id": "<iran_room_id>",
       "target": "codex",
       "prompt": "请阅读 chat.md 中的完整聊天记录，分析哈梅内伊去世后伊朗权力交接的三个可能场景，并给出你的判断。"
     }
   }
   ```

5. **Relay 给 Gemini（使用 file_ref 模式）**
   ```json
   {
     "tool": "relay_message",
     "input": {
       "room_id": "<iran_room_id>",
       "target": "gemini",
       "prompt": "请阅读 chat.md 中的完整聊天记录，分析哈梅内伊去世后伊朗权力交接的三个可能场景，并给出你从地缘政治角度的分析。"
     }
   }
   ```

6. **验证讨论结果**
   - 检查 chat.md 是否正确追加了 Codex 和 Gemini 的回复
   - 检查消息格式（HTML 注释 + 纯 markdown 内容）
   - 检查 sequenceCounter 是否正确递增
   - 使用 `export_room` 导出完整讨论记录

---

## 四、回归测试清单

完成以上测试后，逐项确认：

- [ ] **自动迁移**：SQLite → MD 文件迁移正确执行
- [ ] **创建房间**：目录结构 + meta.json + chat.md 正确生成
- [ ] **注册参与者**：participants.json 正确写入
- [ ] **加入房间**：meta.json participants 数组正确更新
- [ ] **发送消息**：chat.md append-only 写入，格式正确
- [ ] **读取消息**：解析 chat.md 返回正确的消息数组
- [ ] **获取上下文**：格式化输出与 chat.md 一致
- [ ] **搜索消息**：grep-style 搜索 chat.md 内容
- [ ] **列出房间**：扫描 data/rooms/ 目录，返回所有房间
- [ ] **导出房间**：markdown 格式直接返回 chat.md 内容
- [ ] **Pin 消息**：chat.md 中对应行正确添加 pinned 标记
- [ ] **Poll 新消息**：基于 sequenceCounter 返回新消息
- [ ] **Relay file_ref**：Codex/Gemini 以房间目录为 cwd，读 chat.md 并响应
- [ ] **Relay inline**：内嵌上下文到 prompt，控制在 ~4000 token 预算内
- [ ] **响应自动存储**：relay 响应自动 append 到 chat.md
- [ ] **迁移数据完整性**：消息数量、参与者、元数据与 SQLite 原始数据一致
- [ ] **哈梅内伊讨论续接**：新架构下成功完成多 AI 群聊讨论

---

## 五、已知限制与注意事项

1. **relay 超时**：Codex 在 `--sandbox read-only` 模式下需要 30-120 秒加载 MCP 服务器。设置合理的超时时间。

2. **file_ref 模式依赖**：Codex 需要能读取 cwd 下的文件。如果 `--sandbox read-only` 不允许读取 cwd 文件，需要 fallback 到 `relay_message_inline`。

3. **pin_message 参数变化**：v2 中 `message_id` 参数改为序列号字符串（如 "1" 而非 UUID）。

4. **SQLite 保留**：迁移后 `group-chat.db` 不会被删除，仅作备份。新架构不再依赖它。

5. **并发安全**：MCP Server 通过 stdio transport 运行，天然单线程，无并发写入风险。

---

## 六、故障排查

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 迁移未触发 | `data/rooms/` 已存在但为空 | 删除 `data/rooms/` 目录后重启 |
| 迁移报错 | SQLite 数据库损坏或版本不兼容 | 检查 `group-chat.db` 完整性 |
| relay 超时 | Codex/Gemini CLI 未安装或 API key 未配置 | 检查 `codex --version` / `gemini --version` |
| chat.md 解析失败 | 消息内容包含与分隔符冲突的 HTML 注释 | 检查正则匹配是否精确 |
| pin 操作失败 | 序列号不存在或格式错误 | 确认传入的是数字字符串 "1" 而非 UUID |
| 手动 Read chat.md 乱码 | 文件编码问题 | 确保所有写入使用 UTF-8 |

---

*本文档由浮浮酱 (Claude Opus 4.6) 生成于 2026-03-03，用于指导下一个 agent 进行 Group Chat MCP Server v2.0 的功能测试。*
