# dsh-win-notify

DSH Windows 通知插件：**任务完成、任务出错、需要用户选择/回答、需要审批**时，弹出 Windows 右下角系统 Toast 通知（进通知中心）；审批未处理每 5 分钟提醒一次；点击通知聚焦 / 启动 DSH 桌面端窗口。

> 适配官方桌面端 `@deepseek-ai/dsh-desktop` 0.1.6-alpha.2（2026-09-19 验证：事件 API 与插件规范均未变）。

## 通知规则

| 场景 | 触发事件 | 行为 |
| --- | --- | --- |
| 任务完成（仅顶层会话） | `turn/end` completed | 弹 "DSH 任务完成" + 会话标题/最近任务 |
| 任务出错（仅顶层会话） | `turn/end` error | 弹 "DSH 任务出错" + 错误信息 |
| 需要选择/回答 | `tool/call` `ask_user_question` | 弹 "DSH 需要你的回答" + 问题内容 |
| 需要审批（任何会话，含子代理） | `approval/asked` | 弹 "DSH 需要你的审批"，未处理每 5 分钟提醒 |
| 审批已处理 | `approval/decided` | 停止提醒 |
| 子代理完成/出错 | 子代理会话 `turn/end` | **不通知** |

- 多条待审批合并为一条提醒通知（"DSH 待审批提醒（第 N 次）"）
- 前台/后台都弹（不检测窗口焦点）
- 点击通知 → `dsh-desktop://open` → 聚焦桌面端窗口（未运行则启动）

## 安装

**前置**：Node.js 20+；设置环境变量 `DSH_HOME` 指向 DSH 数据家（如 `D:\DeepSeekHarness\dsh-home`），
或安装时用 `--dsh-home <路径>` 显式传入。

**方式 A：手动复制（默认，不需要 pnpm）**

```powershell
git clone https://github.com/happyde2b/dsh-win-notify.git
cd dsh-win-notify
node install.js                  # → <DSH_HOME>\profiles\desktop\node_modules\dsh-win-notify
node install.js --profile web    # 指定 profile
# 同步更新 profile 的 package.json（dependencies + dsh.profile.bundles）
```

**方式 B：官方插件管理器（打包成 tgz 后安装）**

```powershell
node install.js --pack                    # 产物：<DSH_HOME>\downloads\dsh-win-notify-<version>.tgz
node install.js --pack --out D:\tmp       # 自定义输出目录
# 在 DSH 桌面端「设置 → 插件 → 添加插件」里填该 tgz 的绝对路径，安装后启用
```

两种方式都需要**重启 DSH 桌面端**生效（`lib/index.js` 被服务进程缓存）。
`lib/toast.ps1`、`lib/open-desktop.ps1` 每次弹通知实时读取，改脚本无需重启。

## 配置

在 `<DSH_HOME>\profiles\desktop\cordis.patch.yml` 里按 id `win-notify` 覆盖：

```yaml
- id: win-notify
  config:
    enabled: true              # 总开关
    onTurnComplete: true       # 任务完成通知
    onTurnError: true          # 任务出错通知
    onUserQuestion: true       # 需要回答通知
    onApproval: true           # 需要审批通知
    approvalReminderMs: 300000 # 审批重复提醒间隔（毫秒），0=关闭
    onlyRootAgents: true       # 仅顶层会话（排除子代理）
    minIntervalMs: 10000       # 同类通知最小间隔（毫秒）
    clickUrl: 'http://127.0.0.1:3080'     # 协议不可用时的回退地址
    desktopAumid: 'com.deepseek.harness'  # 通知归属的 AUMID；''=回退到 DSH.Notify
    debugLog: '%TEMP%\\dsh-win-notify.log' # 排查日志；''=关闭
```

`debugLog` 默认写到 `%TEMP%\dsh-win-notify.log`（超过 512 KB 自动滚动成 `.1`）。里面记录
插件加载、turn/end 等事件的顶层判定（`root=true/false depth=… origin=…`）、实际发出的
通知与节流跳过、以及 `toast.ps1` 的退出码——排查"为什么没弹"先看这个文件。

## 实现要点

- 订阅持久化 `session/event` 流（与界面同一数据源），不侵入任何核心包；零第三方依赖。
- 顶层判定读 `session.header`：`origin === 'subagent'` 或 `delegationDepth >= 1` 视为子代理
  （0.2.2-rc.3 起 `agents` 服务已不再提供 `roots()`，旧写法会让所有完成通知被静默过滤）。
- `lib/toast.ps1`：WinRT `ToastNotificationManager` 弹通知，AUMID 候选链
  `[desktopAumid, DSH.Notify, 系统 PowerShell AUMID, '']`；惰性注册 `dsh-desktop://` 协议
  （HKCU，含必需的 `URL Protocol` 标记）；首次运行会创建 `DSH Notifications.lnk` 注册桩
  （目标 explorer.exe，切勿改回 powershell.exe——会被 Defender 当木马删除）。
- `lib/open-desktop.ps1`：协议处理器。聚焦 `DeepSeek Harness` 进程窗口（AppActivate）→
  未运行则启动 `DeepSeek Harness.exe` → 兜底启动快捷方式。
- 两个 .ps1 **必须保持纯 ASCII**：PowerShell 5.1 按系统 ANSI(GBK) 读 .ps1，UTF-8 中文注释
  会吞掉换行导致解析失败。
