# Feishu V2 Migration Notes

## 目标

以 upstream `CodePilot v0.38.2` 为底座，迁移本地飞书桥接定制，同时尽量接近上游新的 Feishu streaming 架构。

## 已完成

### 1. 迁移到 upstream v2 源码结构

工作树：

- ` /home/peanut/Applications/CodePilot-v2-src`

保留了 upstream 的：

- `ChannelPlugin` 架构
- Feishu plugin
- bridge-manager 中的 card streaming 流程
- `/feishu doctor` 等上游命令

### 2. 迁移的本地定制

已迁移到 `v2` 工作树的能力：

- `/model code|pro|kimi`
- `bridge_default_model` 持久化
- Feishu 启动问候
- 自然语言停止任务
- 去除旧的稀疏文本过程提示，过程信息仅走流式卡片
- 工具过程默认折叠，飞书卡片内支持“展开工具过程 / 收起工具过程”
- 工具记录升级为结构化过程：输入摘要、关键进度、结果摘要、耗时
- 登录/扫码人工介入 watchdog
- Feishu artifact marker 解析
- 工具结果附件落盘与回传
- 本地代理、工具优先、人工接管类 system prompt
- 结果收口文案

### 3. 关键链路补丁

涉及文件：

- `src/lib/bridge/bridge-manager.ts`
- `src/lib/bridge/conversation-engine.ts`
- `src/lib/claude-client.ts`
- `src/lib/bridge/artifact-markers.ts`
- `src/lib/tool-result-artifacts.ts`
- `src/lib/mcp-config.ts`
- `src/lib/channels/feishu/card-controller.ts`
- `src/lib/channels/feishu/outbound.ts`

## 关键技术结论

### 结论一：上游声明的 `CardKit v2` 在当前官方依赖下并不能直接跑

实际验证结果：

- 上游 `package.json` 依赖：`@larksuiteoapi/node-sdk@^1.59.0`
- 本机安装后运行时对象：
  - `client.cardkit.v1` 存在
  - `client.cardkit.v2` 不存在

因此，不能直接依赖 upstream 那套：

- `cardkit.v2.card.create`
- `cardkit.v2.card.streamContent`
- `cardkit.v2.card.setStreamingMode`
- `cardkit.v2.card.update`

### 结论二：当前可行的单卡片流式实现是“共享卡片 + `im.message.patch`”

当前 SDK 运行时可用：

- `client.im.message.patch`
- `client.im.message.updateByCard`

因此当前实现采用双路径：

1. 如果未来运行时出现 `cardkit.v2`：
   - 走上游原生 `CardKit v2` streaming
2. 当前环境：
   - 发送一条开启 `config.update_multi=true` 的共享 `interactive` 卡片
   - 后续用 `im.message.patch` 原地更新同一条消息
   - 不依赖额外的 `cardkit:card:write` 权限

### 结论三：`CardKit v1` 现在已经可用，并作为当前线上首选路径

2026-03-19 实测结果：

- `cardkit:card:write` 已开通
- `cardkit.v1.card.create` 成功
- `cardkit.v1.card.update` 成功
- 关联飞书消息 `message_id` 的 `update_time` 发生变化，确认是原地更新

当前代码顺序已经改成：

1. 优先尝试 `CardKit v2`
2. 当前环境优先走 `CardKit v1`
3. 若 `CardKit v1` 异常，再降级到“共享卡片 + message.patch”

这仍然是“单卡片流式更新”，只是底层不是 CardKit v2。

## 当前并行运行实例

- 服务：`codepilot-v2.service`
- 端口：`3417`
- 数据目录：`/home/peanut/.codepilot-v2`

当前已完成切换：

- 旧服务 `codepilot.service` 已停用
- `codepilot-v2.service` 已接管飞书桥接
- `remote_bridge_enabled=true`

## 下一步切换建议

已验证项：

1. 飞书桥接由 `codepilot-v2.service` 接管
2. 长任务过程中只出现一条 `interactive` 卡片
3. 同一 `message_id` 的 `update_time` 连续增长，确认是原地更新
4. 未再回退成多条稀疏过程消息
