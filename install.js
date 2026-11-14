// dsh-win-notify 安装脚本（手动安装，不依赖 pnpm 解析）。
//
//   node install.js                     # 安装到 <DSH_HOME>/profiles/desktop
//   node install.js --profile web       # 指定 profile
//   node install.js --dsh-home D:\dsh   # 显式指定 DSH 数据家（默认读环境变量 DSH_HOME）
//   node install.js --pack              # 只打包成 tgz（供官方插件管理器安装）
//   node install.js --pack --out D:\tmp # 指定 tgz 输出目录
//
// 做的事：
//   1. 复制插件包到 <DSH_HOME>/profiles/<profile>/node_modules/dsh-win-notify
//   2. 更新 <profile>/package.json：dependencies（file: 相对路径）+ dsh.profile.bundles
//
// 安装后需要重启 DSH 桌面端才生效（index.js 被服务进程缓存；toast.ps1 每次弹
// 通知实时读取，改脚本无需重启）。
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const pluginName = 'dsh-win-notify'
const profile = argValue('--profile', 'desktop')
// DSH_HOME：--dsh-home 参数 > 环境变量 > 本机默认数据家。
// 源码位置与数据家无关，不能再按相对路径推算。
const dshHome = argValue('--dsh-home', process.env.DSH_HOME ?? 'D:\\DeepSeekHarness\\dsh-home')
const profileDir = join(dshHome, 'profiles', profile)

// 打包/安装时排除：安装脚本自身、内部文档、git 元数据、依赖目录。
// 源码改为 git 仓库后 .git 会混进来，必须显式排除（tarball 里见到 .git 会被插件管理器嫌弃）。
const EXCLUDED_TOP = new Set(['install.js', 'AGENTS.md', '.git', '.gitignore', 'node_modules'])
const include = (src) => {
  const rel = relative(here, src)
  return rel === '' || !EXCLUDED_TOP.has(rel.split(sep)[0])
}

// ---- pack 模式：生成 tarball（官方插件管理器可 file: 安装）----
// npm/pnpm 的 tarball 约定：包内容必须位于顶层 `package/` 目录下。
if (args.includes('--pack')) {
  const outDir = argValue('--out', resolve(dshHome, '..', 'downloads'))
  mkdirSync(outDir, { recursive: true })
  const version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version
  const tgz = join(outDir, `${pluginName}-${version}.tgz`)
  rmSync(tgz, { force: true })
  const staging = join(tmpdir(), `dsh-pack-${Date.now()}`)
  const staged = join(staging, 'package')
  mkdirSync(staging, { recursive: true })
  cpSync(here, staged, { recursive: true, filter: include })
  const result = spawnSync('tar.exe', ['-czf', tgz, '-C', staging, 'package'], { stdio: 'inherit' })
  rmSync(staging, { recursive: true, force: true })
  if (result.status !== 0) {
    console.error('tar 打包失败（需要 Windows 自带 tar.exe）')
    process.exit(result.status ?? 1)
  }
  console.log(`packed: ${tgz}`)
  console.log('在 DSH 界面「插件 → 添加插件」里填入下面的 spec（或直接选该文件）：')
  console.log(tgz)
  process.exit(0)
}

// ---- 默认模式：复制安装 ----
if (!existsSync(profileDir)) {
  console.error(`profile 目录不存在: ${profileDir}`)
  console.error(`请确认 DSH_HOME（当前解析为 ${dshHome}）与 profile 名（${profile}）`)
  process.exit(1)
}
const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`profile manifest 不存在: ${manifestPath}`)
  process.exit(1)
}

const targetDir = join(profileDir, 'node_modules', pluginName)
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
cpSync(here, targetDir, { recursive: true, filter: include })
console.log(`copied plugin -> ${targetDir}`)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const dependencies = manifest.dependencies ?? {}
const before = dependencies[pluginName]
// file: 依赖写相对 profile 目录的路径（便于以后 pnpm install 解析）。
const fileSpec = `file:${relative(profileDir, here).replaceAll(sep, '/')}`
dependencies[pluginName] = fileSpec
manifest.dependencies = dependencies
const bundles = manifest.dsh?.profile?.bundles ?? []
if (!bundles.includes(pluginName)) bundles.push(pluginName)
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(
  `updated ${manifestPath}\n  dependencies.${pluginName}: ${before ?? '(none)'} -> ${fileSpec}\n  bundles: ${bundles.join(', ')}`
)
console.log('done. 重启 DSH 桌面端后生效。')
