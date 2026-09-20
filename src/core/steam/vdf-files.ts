/**
 * Steam 文本 VDF / ACF 读取。
 *
 * 使用 `@node-steam/vdf@2.2.0`（MIT）解析，不写只适配单一缩进的正则。
 * 所有读取函数都容忍字段缺失：解析失败抛出带稳定错误码的异常，由调用方决定是否中断。
 */

import { readFileSync } from 'node:fs'
import { parse } from '@node-steam/vdf'
import { AppError } from '@shared/errors'

type VdfNode = Record<string, unknown>

function isRecord(value: unknown): value is VdfNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFile(file: string): VdfNode {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AppError('SRC_UNREADABLE', `无法读取 ${file}：${detail}`)
  }

  try {
    const parsed: unknown = parse(text)
    if (!isRecord(parsed)) {
      throw new AppError('SRC_VDF_PARSE', '解析结果不是对象')
    }
    return parsed
  } catch (error) {
    if (error instanceof AppError) {
      throw error
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new AppError('SRC_VDF_PARSE', `${file}：${detail}`)
  }
}

/** VDF 中的路径通常已转义为 `D:\\path`，这里统一还原为单反斜杠。 */
export function normalizeVdfPath(value: string): string {
  return value.replace(/\\\\/g, '\\')
}

export interface SteamLibraryFolder {
  readonly path: string
  /** libraryfolders.vdf 的 apps 子表：AppID → 占用字节数 */
  readonly appIds: readonly string[]
}

/**
 * 读取 libraryfolders.vdf。
 *
 * 注意实测格式为带 apps 子表的新结构（docs/evidence/real-data-structure.md §2）：
 * `libraryfolders -> "0" -> { path, apps: { "<AppID>": bytes } }`。
 */
export function readLibraryFolders(file: string): SteamLibraryFolder[] {
  const root = parseFile(file)
  const container = root['libraryfolders']
  if (!isRecord(container)) {
    return []
  }

  const folders: SteamLibraryFolder[] = []
  for (const entry of Object.values(container)) {
    if (!isRecord(entry)) {
      continue
    }
    const rawPath = entry['path']
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      continue
    }
    const apps = isRecord(entry['apps']) ? Object.keys(entry['apps']) : []
    folders.push({ path: normalizeVdfPath(rawPath), appIds: apps })
  }
  return folders
}

export interface AppManifest {
  readonly appId: string
  readonly name: string | null
}

/** 读取 appmanifest_<AppID>.acf 的 appid 与 name。 */
export function readAppManifest(file: string): AppManifest {
  const root = parseFile(file)
  const state = root['AppState']
  const node = isRecord(state) ? state : root

  const appId = node['appid']
  const name = node['name']

  return {
    appId: typeof appId === 'string' ? appId : String(appId ?? ''),
    name: typeof name === 'string' && name.length > 0 ? name : null
  }
}

export interface ScreenshotIndexEntry {
  /** 与磁盘文件对应的相对路径，形如 `<gameId>/screenshots/<file>` */
  readonly relativePath: string
  readonly creation: number | null
  readonly width: number | null
  readonly height: number | null
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * 读取 screenshots.vdf，返回 relativePath → 条目 的映射。
 *
 * 注意：该索引**不完整**（实测漏掉 VR 截图），只能用于补充元数据，
 * 目录枚举才是截图发现的权威来源。
 */
export function readScreenshotIndex(file: string): Map<string, ScreenshotIndexEntry> {
  const root = parseFile(file)
  const container = root['screenshots']
  const result = new Map<string, ScreenshotIndexEntry>()

  if (!isRecord(container)) {
    return result
  }

  for (const gameEntry of Object.values(container)) {
    if (!isRecord(gameEntry)) {
      continue
    }
    for (const item of Object.values(gameEntry)) {
      if (!isRecord(item)) {
        continue
      }
      const filename = item['filename']
      if (typeof filename !== 'string' || filename.length === 0) {
        continue
      }
      const relativePath = filename.replace(/\\/g, '/')
      result.set(relativePath, {
        relativePath,
        creation: toNumberOrNull(item['creation']),
        width: toNumberOrNull(item['width']),
        height: toNumberOrNull(item['height'])
      })
    }
  }

  return result
}

export interface LoginUser {
  readonly steamId64: string
  readonly accountName: string | null
  readonly personaName: string | null
}

/** 读取 config/loginusers.vdf：SteamID64 → 账号名与昵称。 */
export function readLoginUsers(file: string): LoginUser[] {
  const root = parseFile(file)
  const users = root['users']
  if (!isRecord(users)) {
    return []
  }

  const result: LoginUser[] = []
  for (const [steamId64, value] of Object.entries(users)) {
    if (!isRecord(value)) {
      continue
    }
    const accountName = value['AccountName']
    const personaName = value['PersonaName']
    result.push({
      steamId64,
      accountName: typeof accountName === 'string' ? accountName : null,
      personaName: typeof personaName === 'string' ? personaName : null
    })
  }
  return result
}
