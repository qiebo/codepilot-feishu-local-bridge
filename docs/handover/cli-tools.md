# CLI Tools — 系统 CLI 工具管理与聊天感知

## 核心思路

AI 工作流中 CLI 工具（ffmpeg、jq、ripgrep 等）是重要基础设施，但用户往往不知道装什么、怎么装。本功能在侧边栏新增 "CLI Tools" 页面，提供精选工具推荐、一键安装、AI 补全描述，并在聊天时自动将已安装工具注入 system prompt，让 Claude 知道用户系统上有哪些工具可用。

## 目录结构

```
src/lib/
├── cli-tools-catalog.ts      # 静态精选 catalog（6 个核心 + EXTRA_WELL_KNOWN_BINS）
├── cli-tools-detect.ts        # 系统检测逻辑（which/where + --version）
├── cli-tools-context.ts       # 聊天上下文构建（system prompt 注入块）

src/app/api/cli-tools/
├── catalog/route.ts           # GET — 返回完整 catalog 列表
├── installed/route.ts         # GET — 检测并返回已安装工具的 runtime info
└── [id]/
    ├── status/route.ts        # GET — 单个工具状态 + 版本
    ├── install/route.ts       # POST — SSE 流式安装日志
    ├── detail/route.ts        # GET — 详情弹窗数据
    └── describe/route.ts      # POST — AI 生成双语工具描述

src/components/cli-tools/
├── CliToolsManager.tsx        # 主管理容器（已安装区 + 推荐区）
├── CliToolCard.tsx            # 工具卡片（installed / recommended 两种 variant）
├── CliToolDetailDialog.tsx    # 详情弹窗（简介 / 场景 / 引导 / 示例提示词）
├── CliToolInstallDialog.tsx   # SSE 安装进度弹窗
├── CliToolBatchDescribeDialog.tsx  # 批量 AI 描述生成
└── CliToolExtraDetailDialog.tsx   # 额外检测工具的详情弹窗

src/app/cli-tools/page.tsx     # 页面入口
```

## 数据流

### 工具检测

```
页面加载 → CliToolsManager 并行请求:
  GET /api/cli-tools/catalog    → CLI_TOOLS_CATALOG（静态数据）
  GET /api/cli-tools/installed  → detectAllCliTools()
    → 遍历 catalog binNames + EXTRA_WELL_KNOWN_BINS
    → which/where 查找 → --version 提取版本
    → 模块级缓存（TTL 2 分钟）
→ 合并 catalog + runtime info → 分区渲染
```

### 工具安装

```
用户点击"安装" → 选择安装方式（brew/npm/pipx）
  → POST /api/cli-tools/[id]/install { method }
  → 服务端 spawn 子进程执行 catalog 中声明的 command
  → SSE 流式返回 stdout/stderr
  → CliToolInstallDialog 实时显示日志
  → 完成后重新检测工具状态
```

安全约束：只执行 catalog 中声明的 command，不接受用户自定义命令。

### AI 描述生成

```
用户点击"自动完善介绍" → POST /api/cli-tools/[id]/describe { providerId }
  → 校验 tool.supportsAutoDescribe === true
  → generateTextViaSdk() 生成中英双语介绍（60s 超时）
  → 返回 { zh, en } 文本
  → 前端存入 localStorage（key: cli-tool-desc-{id}）
  → 刷新后从 localStorage 恢复
```

### 聊天上下文注入

```
用户发送消息 → POST /api/chat
  → buildCliToolsContext()
    → detectAllCliTools()（命中缓存则直接返回）
    → 格式化已安装工具为 <available_cli_tools> XML 块
    → 追加到 system prompt 末尾
  → Claude 获知用户系统上可用的 CLI 工具
```

### 聊天侧 CLI 选择器

```
聊天输入框工具栏 → 点击 Terminal 图标 → popoverMode = 'cli'
  → 异步 fetch /api/cli-tools/installed + /api/cli-tools/catalog
  → 搜索框过滤 → 选择工具
  → 若输入框为空：预填 "我想用 {tool} 工具完成：" (zh) / "I want to use {tool} to: " (en)
  → 若输入框有内容：附加 CliBadge { id, name }
  → 发送时 CliBadge → systemPromptAppend 注入到 system prompt（不显示在对话中）
```

## 类型定义

关键类型在 `src/types/index.ts`：

| 类型 | 用途 |
|------|------|
| `CliToolStatus` | `'not_installed' \| 'installed' \| 'needs_auth' \| 'ready'` |
| `CliToolCategory` | `'media' \| 'data' \| 'search' \| 'download' \| 'document' \| 'productivity'` |
| `InstallMethod` | `'brew' \| 'npm' \| 'pipx' \| 'cargo'` |
| `CliToolDefinition` | 完整的工具定义（名称、binNames、摘要、分类、安装方式、详情、示例提示词） |
| `CliToolRuntimeInfo` | 运行时检测结果（状态、版本、路径、AI 描述） |
| `CliToolInstallMethod` | 包含 `method`、`command`、`platforms` |

## 设计决策

### 为什么用静态 catalog 而不是动态发现？

安全性——只允许执行预审过的安装命令。可预测性——工具列表、描述、示例提示词都是策划过的内容，质量可控。

### 为什么检测用 which 而不是直接运行？

Electron 桌面环境中 PATH 往往不完整。通过 `getExpandedPath()`（`src/lib/platform.ts`）展开 `/usr/local/bin`、`~/.cargo/bin` 等常见路径后传给 `which`，兼容桌面和终端两种启动方式。

### 为什么 AI 描述存 localStorage 而不是 DB？

描述是锦上添花，不是核心数据。避免 schema 迁移负担，丢失可重新生成。

### 聊天侧 CLI 选择器的 popover 模式

采用 `PopoverMode = 'file' | 'skill' | 'cli' | null` 枚举，CLI 是 button-triggered（点击工具栏图标触发），与 skill 的 text-triggered（输入 `/` 触发）不同。button-triggered 弹窗的焦点策略是将焦点交给弹窗内的搜索框，而 text-triggered 弹窗焦点保留在 textarea。

### EXTRA_WELL_KNOWN_BINS

除 catalog 中的 6 个精选工具外，`cli-tools-catalog.ts` 还导出 `EXTRA_WELL_KNOWN_BINS` 数组——常见但不需要详情页的工具（如 python、node、go、docker 等），用于聊天上下文注入，让 Claude 知道系统上还有哪些工具。

## 修改文件清单

| 文件 | 改动 |
|------|------|
| `src/types/index.ts` | 新增 CLI tool 相关类型定义 |
| `src/components/layout/NavRail.tsx` | navItems 增加 CLI Tools 导航项 |
| `src/i18n/en.ts` | 新增 `nav.cliTools` + `cli_tools.*` 英文 key |
| `src/i18n/zh.ts` | 新增 `nav.cliTools` + `cli_tools.*` 中文 key |
| `src/app/api/chat/route.ts` | system prompt 末尾追加 CLI tools context |
| `src/components/chat/MessageInput.tsx` | CLI 选择器弹窗 + CliBadge + systemPromptAppend |
