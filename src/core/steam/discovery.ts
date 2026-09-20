/**
 * Steam 来源发现。
 *
 * 三条途径：Windows 注册表、常见安装位置、用户手动选择的根目录。
 * 只读：仅检查目录结构与读取配置文件，不改动来源。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AppError } from '@shared/errors'
import { readLoginUsers, type LoginUser } from './vdf-files'

/** `SteamID64 = 76561197960265728 + AccountID`（实测成立，见 docs/evidence）。 */
const STEAM_ID64_BASE = 76561197960265728n

export type SourceKind = 'registry' | 'manual' | 'common'

export interface DiscoveredAccount {
  readonly accountId: string
  readonly steamId64: string
  readonly accountName: string | null
  readonly personaName: string | null
  /** 是否存在 760 目录（截图目录的父级） */
  readonly hasScreenshotDir: boolean
  /** 有截图目录的游戏数量 */
  readonly gameDirectoryCount: number
}

export interface DiscoveredRoot {
  readonly rootPath: string
  readonly kind: SourceKind
  readonly exists: boolean
  readonly readable: boolean
  readonly accounts: readonly DiscoveredAccount[]
}

export function steamId64FromAccountId(accountId: string): string {
  try {
    return (STEAM_ID64_BASE + BigInt(accountId)).toString()
  } catch {
    return ''
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function listDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 宽松校验：目录存在且含 `userdata` 或 `steamapps` 即认为是 Steam 数据根。
 *
 * 这样可以把"只复制了数据的 Steam 目录"（例如离线样本子集）也登记为来源，
 * 而不要求存在 `steam.exe`。
 */
export function isLikelySteamRoot(dir: string): { ok: true } | { ok: false; reason: string } {
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    return { ok: false, reason: '未选择目录' }
  }
  if (!existsSync(dir)) {
    return { ok: false, reason: '目录不存在' }
  }
  if (!isDirectory(dir)) {
    return { ok: false, reason: '不是目录' }
  }
  if (!existsSync(join(dir, 'userdata')) && !existsSync(join(dir, 'steamapps'))) {
    return { ok: false, reason: '既没有 userdata 也没有 steamapps，不像 Steam 数据目录' }
  }
  return { ok: true }
}

function readLoginUsersSafely(rootPath: string): LoginUser[] {
  const file = join(rootPath, 'config', 'loginusers.vdf')
  if (!existsSync(file)) {
    return []
  }
  try {
    return readLoginUsers(file)
  } catch {
    // 账号名只是展示信息，解析失败不影响发现结果
    return []
  }
}

export function inspectRoot(rootPath: string, kind: SourceKind): DiscoveredRoot {
  const absolute = resolve(rootPath)
  const exists = existsSync(absolute)

  if (!exists) {
    return { rootPath: absolute, kind, exists: false, readable: false, accounts: [] }
  }

  const userdata = join(absolute, 'userdata')
  const accounts = listDirectories(userdata)
  const loginUsers = readLoginUsersSafely(absolute)
  const bySteamId64 = new Map(loginUsers.map((user) => [user.steamId64, user]))

  const discovered: DiscoveredAccount[] = []
  let readable = true

  for (const accountId of accounts) {
    if (!/^\d+$/.test(accountId)) {
      continue
    }
    const remote = join(userdata, accountId, '760', 'remote')
    const hasScreenshotDir = existsSync(join(userdata, accountId, '760'))
    const gameDirectoryCount = hasScreenshotDir ? listDirectories(remote).length : 0

    const loginUser = bySteamId64.get(steamId64FromAccountId(accountId))
    discovered.push({
      accountId,
      steamId64: steamId64FromAccountId(accountId),
      accountName: loginUser?.accountName ?? null,
      personaName: loginUser?.personaName ?? null,
      hasScreenshotDir,
      gameDirectoryCount
    })
  }

  if (accounts.length > 0 && !isDirectory(userdata)) {
    readable = false
  }

  discovered.sort((a, b) => a.accountId.localeCompare(b.accountId))
  return { rootPath: absolute, kind, exists: true, readable, accounts: discovered }
}

/** 读取注册表中的 Steam 安装路径；只在 Windows 且注册表可用时返回结果。 */
export function detectRegistrySteamPath(): string | null {
  if (process.platform !== 'win32') {
    return null
  }

  for (const hive of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam']) {
    try {
      const output = execFileSync('reg', ['query', hive, '/v', 'SteamPath'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      })
      const matched = /SteamPath\s+REG_SZ\s+(.+)/.exec(output)
      if (matched?.[1]) {
        const candidate = matched[1].trim().replace(/\//g, '\\')
        if (candidate.length > 0) {
          return candidate
        }
      }
    } catch {
      // 注册表项不存在或无权限，继续尝试下一个位置
    }
  }
  return null
}

/** 常见安装位置，作为注册表缺失时的兜底提示。 */
export function commonSteamPaths(): string[] {
  const candidates = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam',
    'D:\\Program Files (x86)\\Steam',
    'C:\\LocalSpace\\softwares\\Steam'
  ]
  return candidates.filter((candidate) => existsSync(candidate))
}

/**
 * 汇总发现结果：注册表 / 常见位置 / 用户手动登记，按规范化路径去重。
 * 手动登记优先，避免同一目录既被自动发现又被登记两次。
 */
export function discoverSteamRoots(manualRoots: readonly string[] = []): DiscoveredRoot[] {
  const result = new Map<string, DiscoveredRoot>()

  const add = (rootPath: string, kind: SourceKind): void => {
    if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
      return
    }
    const inspected = inspectRoot(rootPath, kind)
    const key = inspected.rootPath.toLowerCase()
    if (!result.has(key)) {
      result.set(key, inspected)
    }
  }

  for (const manual of manualRoots) {
    add(manual, 'manual')
  }

  const registry = detectRegistrySteamPath()
  if (registry) {
    add(registry, 'registry')
  }

  for (const common of commonSteamPaths()) {
    add(common, 'common')
  }

  return [...result.values()]
}

/** 校验并规范化手动登记的来源根。 */
export function validateManualRoot(dir: string): string {
  const check = isLikelySteamRoot(dir)
  if (!check.ok) {
    throw new AppError('LIB_PATH_INVALID', check.reason)
  }
  return resolve(dir)
}
