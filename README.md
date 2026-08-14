# dsh-edit-resend

DeepSeek Harness (DSH) 插件：在消息已发送之后**原位编辑并重新发送**——包括**停止正在进行的回复、编辑、重新发送**——同时提供分支式的编辑 / 重生成 / 重试任意回合 / 版本时间线（撤销与重做）。

与上游 `dsh-message-edit` 的关键区别：本插件的**版本元数据存在会话日志之外**（`DSH_HOME/storages/dsh-edit-resend/versions.json`），从不往会话日志写自定义事件类型，因此不会触发宿主重启后的 `SessionFormatUnsupportedError`，会话始终可恢复。

## 功能

- **停止并编辑重发**：回复进行中，标题栏出现「■ 停止」；停止后，最后一条消息仍可编辑，点「编辑」→ 修改 →「重新发送」，即从该消息之前分支、以新文本重跑。**不会产生重复消息**，原版本保留在版本树中。
- **编辑已落定消息**：编辑用户文本、助手思考（reasoning）与助手回复（response）。
- **重生成**：从最后一条已落定回复所属回合之前分支，用原输入重新生成。
- **重试任意回合**：在 Timeline 中选任意历史回合重跑。
- **级联策略**：`truncate`（默认，截断后续）/ `preserve`（保留后续用户输入依次重跑）。
- **版本切换**：标题栏 `←` 撤销 / `→` 重做；Timeline 标签页展示完整分支树、编辑前后内容、操作时间。

## 安装

```bash
dsh plugin --profile web add dsh-edit-resend
# 或本地开发（符号链接）：
dsh plugin --profile web add -w link:/path/to/dsh-edit-resend
```

安装后重启 dsh（`dsh web`）即生效。

## 构建

```bash
npm install
npm run build
```

生成 `index.mjs`（Host 插件）与 `client.js`（Browser 插件）。

## 架构

- **Host 半**（`src/host.ts`，注入 `sessions`/`agents`/`sessionQuery`/`workspaceRegistry`/`webServer`）：通过 `ctx.agents.create({ seed, meta })` 事务缝从目标回合之前分支；`parentSession` 落在会话头建立谱系，版本效果元数据落在插件私有 JSON 存储。
- **Client 半**（`src/client/*`，注入 `slots`/`conversation`/`connection`/`sessions`）：注册 `conversation.view`（Timeline 标签页）与 `conversation.session.header.actions`（停止 / 撤销 / 重做 / 重生成），并用 MutationObserver 把「编辑 / 重试」按钮注入到消息操作行。
- **HTTP 接口**：`GET /edit-resend?sessionId=`（时间线投影）、`POST /edit-resend`（`edit`/`reroll`/`retry`）。

## 范围边界

- 不原地改写会话事件；历史 append-only。
- 不联动恢复工作区文件 / 外部命令副作用。
- 不修改 DSH 引擎或官方 UI 包。