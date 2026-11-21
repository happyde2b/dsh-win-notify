# Windows 通知（dsh-win-notify）

## 使命

为 DeepSeek Harness 实现 **Windows 系统通知**：任务完成、任务出错、需要用户选择/回答、
需要审批时，在屏幕右下角弹出 Windows 系统 Toast（进通知中心），点击通知**聚焦桌面端窗口**。

## 用户要求（按提出顺序，全部已实现）

1. harness 完成任务或需要用户选择时通过 Windows 通知提醒
2. **必须是右下角系统通知**（不是 msg.exe 弹窗，是通知中心那种 Toast）
3. **子代理完成/出错不通知，其余照旧**（顶层完成、出错、提问、审批都通知）
4. **审批未处理每 5 分钟重复提醒**（多条合并一条；批准/拒绝/取消/会话销毁即停止）
5. **点击通知打开桌面端界面，不是浏览器**
6. 前台/后台都弹（不检测焦点）

## 当前通知规则

| 场景 | 事件 | 行为 |
| --- | --- | --- |
| 任务完成（仅顶层） | `turn/end` completed | 弹"DSH 任务完成" |
| 任务出错（仅顶层） | `turn/end` error | 弹"DSH 任务出错" |
| 需要回答 | `tool/call` `ask_user_question` | 弹"DSH 需要你的回答" |
| 需要审批（含子代理） | `approval/asked` | 弹"DSH 需要你的审批"+ 每 5 分钟提醒 |
| 审批已处理 | `approval/decided` | 停止提醒 |
| 子代理完成/出错 | 子代理 `turn/end` | **不通知**（root 过滤） |

## 文件位置

- 源码：`D:\zhangsir_code\my-dsh-pluging\dshWindows通知\`（本工作区，包根即此目录）
  - `lib/index.js` —— 插件主逻辑（cordis 插件，订阅 `ctx.on('session/event')`，零依赖）
  - `lib/toast.ps1` —— 弹 Toast（WinRT）+ 惰性注册 `dsh-desktop://` 协议（**纯 ASCII**）
  - `lib/open-desktop.ps1` —— 协议处理器：聚焦/启动桌面端窗口（**纯 ASCII**）
  - `cordis.patch.yml` —— 插入插件行（id `win-notify`）
  - `install.js` —— 安装（复制到 profile）或 `--pack` 打包 tgz
- 安装目标：`D:\DeepSeekHarness\dsh-home\profiles\desktop\node_modules\dsh-win-notify`
- 配置层：`D:\DeepSeekHarness\dsh-home\profiles\desktop\cordis.patch.yml`（按 id `win-notify`）
- 生效链路：改本工作区源码后跑 `node install.js` 覆盖安装副本（或 `--pack` 后在插件页装 tgz），
  再重启桌面端（`index.js` 变化才需要重启；两个 .ps1 是实时读取）。本仓库为源码主线，
  profile 里的副本是从这里同步过去的。

## 安装（界面「插件」按钮，推荐）

1. 打包：`node "D:\zhangsir_code\my-dsh-pluging\dshWindows通知\install.js" --pack`
   → 生成 `D:\DeepSeekHarness\downloads\dsh-win-notify-<版本>.tgz`
   （npm tarball 规范：内容必须在顶层 `package/` 下，脚本已处理；2026-09-19 已生成 0.2.0）
2. DSH 侧栏点「**插件**」→「**添加插件**」→ 输入框填**绝对路径**
   `D:\DeepSeekHarness\downloads\dsh-win-notify-0.2.0.tgz`（也可 `file:…`；也接受源码目录，
   但中文目录不保险）→ 点「**安装**」→ 成功后点「**立即启用**」
3. **重启桌面端**生效（`lib/index.js` 被服务进程缓存；`lib/*.ps1` 是实时读取）

- 输入框接受：包名（可带版本）、Git 地址、压缩包（tgz）、本地绝对路径；相对路径被拒。
  **必须是有 `cordis.patch.yml` 的组合包**，否则 inspect 阶段直接被拒。
- 备选（命令行，不需要 pnpm）：`node "D:\zhangsir_code\my-dsh-pluging\dshWindows通知\install.js"`
- 装好后插件页出现 `win-notify` 行，开关即该行；参数改
  `<DSH_HOME>\profiles\desktop\cordis.patch.yml` 里按 id `win-notify` 的 `config:`。
- 安装日志：`<DSH_HOME>\profiles\desktop\.plugin-manager\logs\`。

## 2026-09-19 迁移适配（官方桌面端）

本机已换成官方桌面端（`@deepseek-ai/dsh-desktop` 0.1.6-alpha.2，`D:\DeepSeekHarness\DeepSeek Harness\`），
数据家 `D:\DeepSeekHarness\dsh-home\`。旧 `workspace\plugins\dsh-win-notify` 与 profile 均随重装删除，
插件已按下列差异重建：

| 差异 | 旧环境 | 新环境 |
| --- | --- | --- |
| 数据家 / profile | `workspace\profiles\web` | `dsh-home\profiles\desktop`（还有 `web`） |
| 点击通知的目标 | msedge 的 " - DSH" --app 窗口 | **官方桌面端 Electron 进程** `DeepSeek Harness.exe`（窗口标题含 "DeepSeek Harness"） |
| 通知归属 AUMID | `DeepSeekHarness.Desktop.v3`（旧快捷方式） | `com.deepseek.harness`（官方 appId；失败自动回退） |
| 回退 clickUrl | web UI 3080 | 桌面端当前**未监听 3080**（web 服务未起），仅作兜底 |
| 插件安装 | `dsh.cmd plugin`（pnpm） | 官方插件管理器（内置 pnpm 11.7.0 + node 24）或 `install.js` 复制 |

**兼容性已实测确认（读 app.asar 内官方实现）**：
- `turn/end` `turn/start` `tool/call` `tool/result` `user/message` `session/title` 都在
  `dsh-session/lib/types/known-event-types.js` 的 `KNOWN_SESSION_EVENT_TYPES` 里
- `approval/asked` = `{ id, toolName, callId?, reason? }`；`approval/decided` = `{ id, outcome }`
  （与旧版逐字相同，待审批跟踪用 `会话id:审批id` 作 key）
- `ask_user_question` 工具名未变
- 插件规范未变：`cordis.patch.yml` 的 `- insert: [- id, name]`、`type: module` +
  `main: lib/index.js`、`dsh.bundle.patch` 声明（参照用户装的 dshmarket 1.48.0）
- 未变的部分：WinRT Toast、AUMID 候选链、`dsh-desktop://` 协议机制（注册表 HKCU 未被重装清理，
  但 command 指向的旧路径已失效 → 插件惰性注册会按新路径自动改写）

## 踩过的坑（全部实测）

1. **WinRT toast 必须用有效 AUMID**：`CreateToastNotifier('')` 在 Win11 报
   "参数错误 applicationId"；无参重载报 "Element not found"（0x80070490）。可用：
   系统内置 `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`。
2. **PowerShell 5.1 按 ANSI(GBK) 读 .ps1**：UTF-8 无 BOM 的中文注释会把多字节尾字节与
   换行 0x0A 组成双字节字符、**吞掉换行** → `param(...)` 被注释吃掉、`)` 悬空报
   "Unexpected token ')'"。所有被 powershell.exe 执行的脚本**注释必须纯 ASCII**。
3. **PowerShell 无法调用 vtable-only COM 接口**：`[IShellLinkW]$link` cast `__ComObject` 报
   ConvertToFinalInvalidCastException（pwsh7/PS5.1 均失败）；`Marshal.GetTypedObjectForIUnknown`
   返回仍是 `__ComObject`（无 IDispatch 不能晚绑定）。→ 这类接口必须放进 C#（`Add-Type`）调用。
4. **非打包应用 foreground 激活点击会静默失败**（最重要）：AUMID 没有注册表 activator 时，
   点击 toast 完全无反应。→ 改用**自定义 URL 协议** `dsh-desktop://` + `activationType="protocol"`。
5. **自定义协议必须带 `URL Protocol` 标记**：只注册 `shell\open\command` 时点击会弹
   "获取打开此'dsh-desktop'链接的应用…没有可打开此链接的应用"。必须补
   `HKCU\Software\Classes\dsh-desktop` 下的空值 `URL Protocol`（+ `(Default)="URL:dsh-desktop Protocol"`）。
6. **注册表键创建顺序**：`Set-ItemProperty` 不自动建键 → 先 `New-Item -Path <完整command键> -Force`。
7. **Defender 误报**：快捷方式指向 `powershell.exe -WindowStyle Hidden` 匹配恶意模式
   （HEUR:Trojan/LNK.Agent.b）会被删 → 注册桩目标用 `explorer.exe` 无参数，**勿改回**。
8. **工具沙箱限制**：Start Menu、`D:\.pnpm-store`、HKCU 写入均被拦 → pnpm 安装不可用、
   协议注册需提权；这些限制只在 Agent 工具沙箱存在，真实运行（桌面端进程）没有。
9. **通知触发验证方法**：spawn 异步 + 临时目录会被子进程退出时删除，直接计数不可靠 →
   80ms 轮询 `%TEMP%\dsh-win-notify-*` 的**出现时刻**，对比事件 emit 时刻验证节流/提醒间隔。
10. **pnpm store 位置**：旧 profile 的 node_modules 链接自 `D:\.pnpm-store\v11`，与 pnpm 默认
    store 不一致（ERR_PNPM_UNEXPECTED_STORE）→ 手动复制安装更省事。
11. **0.2.2-rc.3 起 `agents` 服务没有 `roots()` 了**（2026-11-14 实测）：旧 `isRootSession`
    靠 `ctx.get('agents').roots()` 判断顶层，方法不存在 → 恒 false → 完成/出错/提问通知
    全部被静默过滤（审批分支不过滤，所以"审批还能弹、完成不弹"）。改为读
    `session.header`：`header.origin === 'subagent'` 或 `header.delegationDepth >= 1` 即非顶层。
    排查手段：插件配置 `debugLog: '<绝对路径>'`，会记录 plugin loaded / 事件、root 判定、
    notify / 节流跳过 / toast.ps1 退出码。

## 生效性

- `toast.ps1` / `open-desktop.ps1`：每次调用实时读取，**改完立即生效**。
- `index.js`：被服务进程缓存，**需重启桌面端**（由用户操作，Agent 不自行杀/起进程）。
- 只读验证手段：`node --check lib/index.js`、PS `Parser::ParseFile` 语法检查、
  `reg.exe query HKCU\Software\Classes\dsh-desktop /s`、`Get-Process "DeepSeek Harness"`、
  `.\dsh.cmd --profile desktop --dump-config`（新环境无 dsh.cmd，可用桌面端内的插件清单 UI）。

## Git 约定

- 仓库：`D:\zhangsir_code\my-dsh-pluging\dshWindows通知`（源码主线），远端 `happyde2b/dsh-win-notify`。
- **提交信息一律用中文**，格式「类型：简述」，类型用：初始导入 / 修复 / 功能 / 文档 / 发布准备 / 构建。
- 例：`修复顶层判定：改用 session.header 判断根会话，恢复完成/出错/提问通知（0.2.1）`
- 改完源码先 `node --check lib/index.js` 再提交；发版时同步 `package.json` 版本并打 tag。
