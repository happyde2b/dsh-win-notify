// dsh-win-notify —— 任务完成 / 出错 / 需要用户选择或审批时，发送 Windows 通知。
//
// 事件来源（全部来自持久化 session 事件流，订阅 ctx.on('session/event')）：
//   - turn/end reason.kind === 'completed'  → "DSH 任务完成"（仅顶层会话）
//   - turn/end reason.kind === 'error'      → "DSH 任务出错"（仅顶层会话）
//   - tool/call name === 'ask_user_question' → "DSH 需要你的回答"
//   - approval/asked                        → "DSH 需要你的审批"（任何会话，含子代理）
//   - approval/decided                      → 清除对应待审批项，停止提醒
//
// 子代理（subagent）会话的完成/出错/提问一律不通知，避免子任务刷屏；但子代理
// 触发的审批仍必须通知用户处理。审批未处理时按 approvalReminderMs 间隔重复
// 提醒（默认每 5 分钟一次，多条待审批合并为一条），直到 approval/decided 或
// 会话销毁。通知通过调用随包附带的 toast.ps1 弹出 Windows Toast（右下角系统
// 通知）；WinRT 不可用时回退到 msg.exe 弹窗与系统提示音。
//
// 兼容性（2026-09-19 实测，官方桌面端 @deepseek-ai/dsh-desktop 0.1.6-alpha.2）：
// turn/end、turn/start、tool/call、tool/result、user/message、session/title 均在
// KNOWN_SESSION_EVENT_TYPES 中；approval/asked = { id, toolName, callId?, reason? }，
// approval/decided = { id, outcome }；ask_user_question 工具名不变。
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-win-notify'

const TOOL_ASK_USER = 'ask_user_question'

/** 调试日志里值得记录的事件类型（其余事件太频繁）。 */
const DEBUG_TYPES = new Set(['turn/end', 'tool/call', 'approval/asked', 'approval/decided'])

const DEFAULTS = {
  /** 总开关。 */
  enabled: true,
  /** 一轮任务正常完成时通知。 */
  onTurnComplete: true,
  /** 任务出错时通知。 */
  onTurnError: true,
  /** 需要用户选择/回答（ask_user_question 工具）时通知。 */
  onUserQuestion: true,
  /** 需要审批（approval/asked）时通知。 */
  onApproval: true,
  /** 审批未处理时的重复提醒间隔（毫秒）；0 或负数 = 不重复提醒。 */
  approvalReminderMs: 300000,
  /** 仅顶层会话（排除子代理会话，避免子任务刷屏）。 */
  onlyRootAgents: true,
  /** 同一类别通知的最小间隔（毫秒），避免连续事件刷屏。 */
  minIntervalMs: 10000,
  /** 点击通知的回退地址（协议不可用时）；桌面端无 web 服务时可设为空串。 */
  clickUrl: 'http://127.0.0.1:3080',
  /** 弹通知优先使用的 AUMID（官方桌面端 appId，让通知归属本应用）；空字符串 = 不使用。 */
  desktopAumid: 'com.deepseek.harness',
  /** 调试日志文件（绝对路径）；默认写到 %TEMP%\dsh-win-notify.log，置空字符串可关闭。 */
  debugLog: join(tmpdir(), 'dsh-win-notify.log'),
}

/** XML 转义，并剔除 XML 1.0 不允许的控制字符。 */
function escapeXml(value) {
  return String(value)
    .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch])
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/** 取消息内容块中的纯文本（用于在通知里说明是哪个任务）。 */
function plainText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 构建 Toast XML；launch/activationType 只是初值，toast.ps1 会按协议可用性覆盖。 */
function buildToastXml(title, message, clickUrl) {
  const launch = clickUrl ? ` activationType="protocol" launch="${escapeXml(clickUrl)}"` : ''
  return `<?xml version="1.0" encoding="utf-8"?>
<toast${launch}>
  <visual>
    <binding template="ToastGeneric">
      <text>${escapeXml(title)}</text>
      <text>${escapeXml(message)}</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default" />
</toast>`
}

export function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...(config ?? {}) }
  if (opts.enabled === false) return
  const logger = ctx.logger ?? console
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'toast.ps1')

  // 排查用日志：opts.debugLog 指向一个文件时逐行追加（默认 %TEMP%\dsh-win-notify.log）。
  // 超过 512 KB 就滚动一次，只保留上一份，避免长期运行把磁盘写满。
  const debugLogPath = typeof opts.debugLog === 'string' ? opts.debugLog : ''
  const debug = (message) => {
    if (!debugLogPath) return
    try {
      if (existsSync(debugLogPath) && statSync(debugLogPath).size > 512 * 1024) {
        rmSync(`${debugLogPath}.1`, { force: true })
        renameSync(debugLogPath, `${debugLogPath}.1`)
      }
      appendFileSync(debugLogPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
    } catch { /* 忽略 */ }
  }
  debug('plugin loaded')

  // 同一类别在 minIntervalMs 内只发一次。
  const lastShown = new Map()
  const throttled = (category) => {
    const now = Date.now()
    const last = lastShown.get(category) ?? 0
    if (now - last < opts.minIntervalMs) return true
    lastShown.set(category, now)
    return false
  }

  // 判断会话是否属于顶层（root）代理。子代理会话一律视为非 root。
  // 2026-11 起（DSH core 0.2.2）agents 服务不再提供 roots()，改为读会话头：
  // 子代理会话带 header.origin === 'subagent' 或 header.delegationDepth >= 1。
  // 头信息不可用时才回退到旧的 agents.roots()。
  const isRootSession = (session) => {
    if (!opts.onlyRootAgents) return true
    try {
      const header = session?.header
      if (header) {
        if (header.origin === 'subagent') return false
        const depth = header.delegationDepth
        return depth === undefined || depth === 0
      }
      const agents = ctx.get('agents')
      if (!agents || typeof agents.roots !== 'function') return true
      return agents.roots().some((agent) => agent.id === session.id)
    } catch {
      return false
    }
  }

  const sessionTitle = (session) => {
    try {
      const event = session?.events?.findLast?.((item) => item.type === 'session/title')
      return event ? String(event.data?.title ?? '').trim() : ''
    } catch {
      return ''
    }
  }

  const notify = (category, title, message) => {
    if (throttled(category)) {
      debug(`skip ${category} (throttled)`)
      return
    }
    debug(`notify ${category}: ${title} | ${String(message).slice(0, 160)}`)
    let dir
    try {
      const xml = buildToastXml(title, message, opts.clickUrl)
      dir = mkdtempSync(join(tmpdir(), 'dsh-win-notify-'))
      const xmlPath = join(dir, 'toast.xml')
      writeFileSync(xmlPath, xml, 'utf8')
      const powershell = process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe'
      const child = spawn(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', scriptPath,
        '-XmlPath', xmlPath,
        '-ClickUrl', String(opts.clickUrl ?? ''),
        '-DesktopAumid', String(opts.desktopAumid ?? ''),
      ], { windowsHide: true, stdio: 'ignore' })
      child.once('error', (error) => logger.warn(`[dsh-win-notify] 启动 powershell 失败: ${error.message}`))
      child.once('exit', (code) => {
        debug(`toast.ps1 exit ${code}`)
        if (code !== 0) logger.warn(`[dsh-win-notify] toast.ps1 退出码 ${code}`)
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
      })
    } catch (error) {
      logger.warn(`[dsh-win-notify] 通知发送失败: ${error instanceof Error ? error.message : String(error)}`)
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
      }
    }
  }

  // 会话内最近一条直接用户消息（"任务完成"通知里说明是哪个任务）。
  const lastUserText = new Map()

  // 待处理审批：key = `${sessionId}:${approvalId}`，value = { toolName, reason, count }
  // count 为已发出的重复提醒次数。approval/decided 或会话销毁时清除。
  const pendingApprovals = new Map()

  ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event !== 'object') return
      const root = isRootSession(session)
      if (DEBUG_TYPES.has(event.type)) {
        const header = session?.header
        debug(`event ${event.type} session=${session?.id} root=${root} depth=${header?.delegationDepth} origin=${header?.origin}`)
      }
      if (event.type === 'user/message') {
        if (event.data?.source?.kind === 'user') {
          const text = plainText(event.data.content)
          if (text) lastUserText.set(session.id, text)
        }
        return
      }
      if (!root) {
        // 子代理会话：完成/出错/提问都不通知；审批除外（子代理触发审批时用户
        // 仍必须处理，照常通知）。
        if (event.type !== 'approval/asked' && event.type !== 'approval/decided') return
      }
      switch (event.type) {
        case 'turn/end': {
          const reason = event.data?.reason
          if (!reason) return
          if (reason.kind === 'completed' && opts.onTurnComplete) {
            const detail = sessionTitle(session) || lastUserText.get(session.id) || `第 ${event.data.turn} 轮已完成`
            notify('complete', 'DSH 任务完成', detail)
          } else if (reason.kind === 'error' && opts.onTurnError) {
            const detail = reason.error?.message ? String(reason.error.message) : `第 ${event.data.turn} 轮执行失败`
            notify('error', 'DSH 任务出错', detail)
          }
          break
        }
        case 'tool/call': {
          if (!opts.onUserQuestion) break
          if (event.data?.name !== TOOL_ASK_USER) break
          let question = ''
          try {
            const args = JSON.parse(event.data.arguments ?? '{}')
            const first = Array.isArray(args.questions) ? args.questions[0] : undefined
            question = first?.question || first?.header || ''
          } catch { /* 参数解析失败时用默认文案 */ }
          notify('question', 'DSH 需要你的回答', question || '请在界面中查看问题并选择')
          break
        }
        case 'approval/asked': {
          if (!opts.onApproval) break
          const id = event.data?.id
          const toolName = event.data?.toolName
          const reason = event.data?.reason
          const detail = [toolName, reason].filter(Boolean).join('：') || '请在界面中批准或拒绝'
          notify('approval', 'DSH 需要你的审批', detail)
          // 记录待处理项，启动/继续重复提醒。
          if (opts.approvalReminderMs > 0 && id !== undefined) {
            pendingApprovals.set(`${session.id}:${id}`, { sessionId: session.id, toolName, reason, count: 0 })
          }
          break
        }
        case 'approval/decided': {
          // 无论批准/拒绝/取消，处理完成即停止提醒。
          const id = event.data?.id
          if (id !== undefined) pendingApprovals.delete(`${session.id}:${id}`)
          break
        }
      }
    } catch (error) {
      logger.warn(`[dsh-win-notify] 处理会话事件失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // 会话销毁时清理其待处理审批（审批随会话失效，无需再提醒）。
  ctx.on('session/disposed', (session) => {
    const prefix = `${session.id}:`
    for (const key of [...pendingApprovals.keys()]) {
      if (key.startsWith(prefix)) pendingApprovals.delete(key)
    }
  })

  // 未处理的审批按间隔重复提醒；多条待审批合并为一条通知。
  if (opts.approvalReminderMs > 0) {
    const reminderTimer = setInterval(() => {
      try {
        if (pendingApprovals.size === 0) return
        const items = [...pendingApprovals.values()]
        for (const item of items) item.count += 1
        const first = items[0]
        const summary = items.length === 1
          ? [first.toolName, first.reason].filter(Boolean).join('：') || '请在界面中批准或拒绝'
          : `有 ${items.length} 项审批待处理：${items.map((item) => item.toolName || '未知操作').join('、')}`
        notify('approval-reminder', `DSH 待审批提醒（第 ${first.count} 次）`, summary)
      } catch (error) {
        logger.warn(`[dsh-win-notify] 审批提醒失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, opts.approvalReminderMs)
    ctx.effect(() => () => clearInterval(reminderTimer))
  }

  logger.info('[dsh-win-notify] Windows 通知插件已加载')
}
