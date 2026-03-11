# Feishu Local Runtime

本地 Feishu 桥接运行时约定，供后续开发者或 agent 在新机器上复现当前部署。

## Runtime Layout

- Source tree: `/home/peanut/Applications/CodePilot-src`
- Runtime files: `/home/peanut/Applications/CodePilot-runtime`
- Data directory: `~/.codepilot`
- HTTP endpoint: `http://127.0.0.1:3416`
- Systemd user service: `codepilot.service`

## Current Bridge Defaults

- Channel: Feishu
- Default work dir: `/home/peanut/workspace`
- Default provider: `env`
- Default model: `doubao-seed-2.0-code`
- Permissions: `dangerously_skip_permissions=true`

## Service Commands

```bash
systemctl --user status codepilot.service --no-pager
systemctl --user restart codepilot.service
journalctl --user -u codepilot.service -n 100 --no-pager
curl -sS http://127.0.0.1:3416/api/bridge
```

## Bridge Chat Commands

```text
/status
/new
/model
/model code
/model pro
/model kimi
```

- `/model` shows the current bridge model and supported aliases.
- `/model code|pro|kimi` updates the current bridge session model and
  `bridge_default_model`, so later `/new` sessions inherit the same model.

## Runtime Behavior

- Feishu bridge uses DB-backed conversation history instead of Claude native SDK resume.
- Bridge history is marked as reference-only; Claude is instructed to answer only the current user message.
- Bridge appends a local-agent operating prompt so Claude treats the session as local-machine access by default.
- Feishu does not stream partial answer text. Instead it sends sparse progress updates for important stages on longer tasks.
- For execution-style tasks, Feishu now appends an explicit final closing line
  to the bottom of the final result message instead of sending a separate
  reminder:
  - `当前任务已执行完毕。如需继续，请直接发送下一条指令。`
  - if attachments are returned, they are sent first and the final text/card
    result is sent last so the closing line appears at the bottom of the final
    visible result
- Progress updates are delayed and rate-limited by default:
  - first status after about 8 seconds of runtime
  - later status messages no more than about every 18 seconds for phase changes
  - long-running tool reminders roughly every 45 seconds
- The bridge now explicitly treats Feishu as the primary remote-assistant surface:
  - Claude is instructed to inspect existing tools, MCP servers, plugins, and project integrations before rebuilding functionality from scratch
  - domain-specific tasks should prefer existing project tooling first
- The bridge now also hardens tool execution behavior:
  - Claude is instructed to use native tool calls instead of printing pseudo `<function_calls>` or `<invoke>` markup
  - if the model still returns pseudo tool-call markup without any real tool event, the bridge retries the turn once with a stricter tool-use prompt
  - if a real tool completed but Claude did not provide a plain-language conclusion, the bridge falls back to the last useful tool result so Feishu still receives an outcome
- Runtime MCP loading is now more explicit:
  - user-scoped MCP config is merged from `~/.claude.json` and `~/.claude/settings.json`
  - project-scoped MCP config is merged from `.cursor/mcp.json` and `.vscode/mcp.json` along the active working-directory path
  - HTTP MCP servers still need their backing service to be running, otherwise Claude can see the tool config but cannot call the tool successfully
- Login, QR scan, SMS verification, CAPTCHA, and similar human-in-the-loop tasks now use a handoff policy:
  - Claude is instructed to send a QR image, login screenshot, or explicit next-step prompt before waiting for manual action
  - Feishu sends an early reminder for these tasks if they have not returned quickly
  - such tasks auto-pause after about 5 minutes instead of hanging silently forever
  - visible-browser/manual-login handoffs use a shorter timeout of about 2 minutes and explicitly discourage long-running Playwright wait loops
- Common natural-language stop requests such as `停止这个任务`, `先停止`, or `cancel this task` are treated like `/stop` when a task is currently running.
- Feishu attachment return path supports image and file markers:
  - `<<FEISHU_IMAGE:/absolute/path/to/file.png>>`
  - `<<FEISHU_FILE:/absolute/path/to/file.pdf>>`
- Tool-result artifacts are also supported:
  - non-text MCP tool results such as Base64 QR-code images are materialized to local files automatically
  - those files are then sent back to Feishu through the normal attachment delivery path

## Workspace CLAUDE.md Template

Place this file at `/home/peanut/workspace/CLAUDE.md` for bridge sessions:

```md
# Local Agent Rules

You are the coding agent running locally on Peanut's computer through Claude Code CLI and the Feishu bridge.

## Identity

- Treat this as a local agent session, not a cloud-only chat session.
- You can inspect this machine, read and write files, run shell commands, install or configure software, and operate local services within the granted runtime permissions.
- If asked about the active model, provider, permissions, or environment, inspect the runtime or configuration instead of guessing.

## Default Behavior

- When the user asks for local system information, inspect it directly.
- When the user asks to install, configure, fix, or run something, do it directly instead of only giving manual steps.
- Only switch to tutorial or advisory mode if the user explicitly asks for guidance or if direct execution is actually blocked.
- Never claim that you cannot access the local machine unless a tool call already failed and you report that concrete failure.

## Tool Use

- Prefer using tools proactively: Bash, Read, Edit, Write, Glob, and other available tools.
- Check the current state before making changes.
- For risky or destructive actions, confirm intent briefly before proceeding.
- If a task can be completed on this machine, attempt it rather than deferring the work back to the user.

## Response Style

- Match the user's language.
- Lead with the result, then key facts or blockers.
- Keep answers concise by default.
- Do not repeat earlier questions or answers unless they are needed for the current request.
```
