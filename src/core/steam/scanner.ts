/**
 * 截图扫描与内容指纹。
 *
 * 权威来源是**目录枚举**：实测 `screenshots.vdf` 会漏掉 VR 截图，
 * 因此索引只用于补充拍摄时间与尺寸，不能用于决定"有哪些截图"。
 *
 * 全程只读来源：只做 `readdir` / `stat` / 流式读取计算哈希。
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { buildNonSteamNameMap, readNonSteamShortcuts } from './binary-vdf'
import {
  readAppManifest,
  readLibraryFolders,
  readLoginUsers,
  readScreenshotIndex,
  type ScreenshotIndexEntry
} from './vdf-files'
import { steamId64FromAccountId } from './discovery'

export const SUPPORTED_IMAGE_EXTENSIONS: readonly string[] = [
  '.jpg',
  '.jpeg',
  '.png',
  '.avif',
  '.tga'
]

export type CaptureTimeSource = 'screenshot-index' | 'file-time' | 'unknown'
export type GameKind = 'steam' | 'non-steam'
export type GameNameSource = 'app-manifest' | 'shortcut' | 'fallback'

export interface ScanProfile {
  readonly accountId: string
  readonly steamId64: string
  readonly accountName: string | null
  readonly personaName: string | null
}

export interface ScanGame {
  readonly gameKey: string
  readonly appId: string | null
  readonly kind: GameKind
  readonly name: string
  readonly nameSource: GameNameSource
  readonly installed: boolean
}

export interface ScanCandidate {
  readonly accountId: string
  readonly gameKey: string
  readonly sourceId: string
  readonly relativePath: string
  readonly absolutePath: string
  readonly thumbnailAbsolutePath: string | null
  readonly size: number
  readonly mtimeMs: number
  readonly ext: string
  readonly width: number | null
  readonly height: number | null
  readonly capturedAt: string | null
  readonly captureTimeSource: CaptureTimeSource
  readonly sha256: string
}

export interface ScanFailure {
  readonly relativePath: string
  readonly message: string
}

export interface ScanProgress {
  readonly phase: 'enumerating' | 'hashing'
  readonly processed: number
  /** 总量未知时为 null，不伪造百分比 */
  readonly total: number | null
  readonly currentFile: string | null
  readonly failed: number
}

/** 已知哈希：size 与 mtime 未变时可直接复用，避免重复读取整库。 */
export interface KnownHash {
  readonly size: number
  readonly mtimeMs: number
  readonly sha256: string
}

export interface ScanRequest {
  readonly rootPath: string
  readonly sourceId: string
  /** 为空表示扫描全部有截图目录的账号 */
  readonly accountIds: readonly string[]
  readonly knownHashes?: ReadonlyMap<string, KnownHash>
  readonly onProgress?: (progress: ScanProgress) => void
  readonly shouldCancel?: () => boolean
}

export interface ScanOutcome {
  readonly profiles: readonly ScanProfile[]
  readonly games: readonly ScanGame[]
  readonly candidates: readonly ScanCandidate[]
  readonly failures: readonly ScanFailure[]
  readonly cancelled: boolean
  readonly scannedAccounts: readonly string[]
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function listDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function listFileNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** 目录名若是超过 2³² 的整数，则是非 Steam 快捷方式的 gameID。 */
export function parseGameDirectory(gameDirName: string): { kind: GameKind; gameId: string } | null {
  if (!/^\d+$/.test(gameDirName)) {
    return null
  }
  const value = BigInt(gameDirName)
  const kind: GameKind = value > 0xffffffffn ? 'non-steam' : 'steam'
  return { kind, gameId: gameDirName }
}

export function gameKeyFor(kind: GameKind, gameId: string): string {
  return kind === 'steam' ? `steam-${gameId}` : `shortcut-${gameId}`
}

/** 账号的逻辑键：`steam-<AccountID>`（docs/architecture.md §6）。 */
export function accountKeyFor(accountId: string): string {
  return `steam-${accountId}`
}

/** 流式计算 SHA-256：分块读取，不把整个文件读入内存。 */
export async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(absolutePath, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** 收集根目录下所有可读的已安装清单：根自身的 steamapps，以及 libraryfolders 中真实存在的库。 */
function collectInstalledApps(rootPath: string): Map<string, string | null> {
  const installed = new Map<string, string | null>()
  const steamappsDirs = [join(rootPath, 'steamapps')]

  const libraryFile = join(rootPath, 'steamapps', 'libraryfolders.vdf')
  if (existsSync(libraryFile)) {
    try {
      for (const folder of readLibraryFolders(libraryFile)) {
        if (existsSync(folder.path) && isDirectory(folder.path)) {
          steamappsDirs.push(join(folder.path, 'steamapps'))
        }
      }
    } catch {
      // 库清单损坏时退化为只读根目录自身的 steamapps
    }
  }

  for (const dir of steamappsDirs) {
    for (const fileName of listFileNames(dir)) {
      if (!/^appmanifest_\d+\.acf$/.test(fileName)) {
        continue
      }
      try {
        const manifest = readAppManifest(join(dir, fileName))
        if (manifest.appId.length > 0) {
          installed.set(manifest.appId, manifest.name)
        }
      } catch {
        // 单个清单损坏不影响其他游戏
      }
    }
  }

  return installed
}

function readScreenshotIndexSafely(accountRoot: string): Map<string, ScreenshotIndexEntry> {
  const file = join(accountRoot, '760', 'screenshots.vdf')
  if (!existsSync(file)) {
    return new Map()
  }
  try {
    return readScreenshotIndex(file)
  } catch {
    return new Map()
  }
}

function readNonSteamNames(accountRoot: string): Map<string, string> {
  const file = join(accountRoot, 'config', 'shortcuts.vdf')
  if (!existsSync(file)) {
    return new Map()
  }
  try {
    return buildNonSteamNameMap(readNonSteamShortcuts(readFileSync(file)))
  } catch {
    return new Map()
  }
}

function readAccountNames(rootPath: string): Map<string, { accountName: string | null; personaName: string | null }> {
  const file = join(rootPath, 'config', 'loginusers.vdf')
  const result = new Map<string, { accountName: string | null; personaName: string | null }>()
  if (!existsSync(file)) {
    return result
  }
  try {
    for (const user of readLoginUsers(file)) {
      result.set(user.steamId64, { accountName: user.accountName, personaName: user.personaName })
    }
  } catch {
    // 昵称只是展示信息
  }
  return result
}

interface PendingFile {
  readonly accountId: string
  readonly gameKey: string
  readonly relativePath: string
  readonly absolutePath: string
  readonly thumbnailAbsolutePath: string | null
  readonly size: number
  readonly mtimeMs: number
  readonly ext: string
  readonly indexEntry: ScreenshotIndexEntry | undefined
}

function resolveCaptureTime(
  indexEntry: ScreenshotIndexEntry | undefined,
  mtimeMs: number
): { value: string | null; source: CaptureTimeSource } {
  if (indexEntry?.creation && indexEntry.creation > 0) {
    return { value: new Date(indexEntry.creation * 1000).toISOString(), source: 'screenshot-index' }
  }
  if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
    return { value: new Date(mtimeMs).toISOString(), source: 'file-time' }
  }
  return { value: null, source: 'unknown' }
}

/**
 * 扫描一个来源根：枚举全部账号的截图，流式计算 SHA-256。
 * 单文件失败只记录，不中断整批。
 */
export async function scanSource(request: ScanRequest): Promise<ScanOutcome> {
  const { rootPath, sourceId, accountIds, knownHashes, onProgress, shouldCancel } = request
  const userdata = join(rootPath, 'userdata')

  const report = (progress: ScanProgress): void => {
    onProgress?.(progress)
  }

  report({ phase: 'enumerating', processed: 0, total: null, currentFile: null, failed: 0 })

  const installedApps = collectInstalledApps(rootPath)
  const accountNames = readAccountNames(rootPath)
  const profiles: ScanProfile[] = []
  const games = new Map<string, ScanGame>()
  const pending: PendingFile[] = []
  const failures: ScanFailure[] = []
  const scannedAccounts: string[] = []

  const wantedAccounts =
    accountIds.length > 0
      ? [...accountIds]
      : listDirectoryNames(userdata).filter((name) => /^\d+$/.test(name))

  for (const accountId of wantedAccounts) {
    const accountRoot = join(userdata, accountId)
    const remote = join(accountRoot, '760', 'remote')
    const screenshotIndex = readScreenshotIndexSafely(accountRoot)
    const nonSteamNames = readNonSteamNames(accountRoot)
    let touched = false

    for (const gameDirName of listDirectoryNames(remote)) {
      const parsed = parseGameDirectory(gameDirName)
      if (!parsed) {
        continue
      }

      const screenshotsDir = join(remote, gameDirName, 'screenshots')
      const thumbnailsDir = join(screenshotsDir, 'thumbnails')
      if (!isDirectory(screenshotsDir)) {
        continue
      }
      touched = true

      const gameKey = gameKeyFor(parsed.kind, parsed.gameId)
      if (!games.has(gameKey)) {
        const manifestName =
          parsed.kind === 'steam' ? (installedApps.get(parsed.gameId) ?? null) : null
        const shortcutName = nonSteamNames.get(parsed.gameId) ?? null
        const name = manifestName ?? shortcutName ?? gameKey
        const nameSource: GameNameSource = manifestName
          ? 'app-manifest'
          : shortcutName
            ? 'shortcut'
            : 'fallback'

        games.set(gameKey, {
          gameKey,
          appId: parsed.kind === 'steam' ? parsed.gameId : null,
          kind: parsed.kind,
          name,
          nameSource,
          installed: installedApps.has(parsed.gameId)
        })
      }

      for (const fileName of listFileNames(screenshotsDir)) {
        const ext = extname(fileName).toLowerCase()
        if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
          continue
        }

        const absolutePath = join(screenshotsDir, fileName)
        // screenshots.vdf 的 filename 字段是相对 760/remote 的索引键，只用于查元数据
        const indexKey = `${gameDirName}/screenshots/${fileName}`
        // 落库的 relative_path 必须相对来源根，才能由 assetId 反查回真实文件
        const relativePath = `userdata/${accountId}/760/remote/${indexKey}`

        let stat
        try {
          stat = statSync(absolutePath)
        } catch (error) {
          failures.push({
            relativePath,
            message: error instanceof Error ? error.message : String(error)
          })
          continue
        }

        const thumbnailPath = join(thumbnailsDir, fileName)
        pending.push({
          accountId,
          gameKey,
          relativePath,
          absolutePath,
          thumbnailAbsolutePath: existsSync(thumbnailPath) ? thumbnailPath : null,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ext,
          indexEntry: screenshotIndex.get(indexKey)
        })
      }
    }

    if (touched) {
      const steamId64 = steamId64FromAccountId(accountId)
      const names = accountNames.get(steamId64)
      scannedAccounts.push(accountId)
      profiles.push({
        accountId,
        steamId64,
        accountName: names?.accountName ?? null,
        personaName: names?.personaName ?? null
      })
    }
  }

  const candidates: ScanCandidate[] = []
  let processed = 0

  for (const file of pending) {
    if (shouldCancel?.()) {
      return {
        profiles,
        games: [...games.values()],
        candidates,
        failures,
        cancelled: true,
        scannedAccounts
      }
    }

    const known = knownHashes?.get(file.relativePath)
    let sha256: string | null = null

    if (known && known.size === file.size && Math.abs(known.mtimeMs - file.mtimeMs) < 1) {
      sha256 = known.sha256
    } else {
      try {
        sha256 = await hashFile(file.absolutePath)
      } catch (error) {
        failures.push({
          relativePath: file.relativePath,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }

    processed += 1
    report({
      phase: 'hashing',
      processed,
      total: pending.length,
      currentFile: file.relativePath,
      failed: failures.length
    })

    if (sha256 === null) {
      continue
    }

    const captureTime = resolveCaptureTime(file.indexEntry, file.mtimeMs)

    candidates.push({
      accountId: file.accountId,
      gameKey: file.gameKey,
      sourceId,
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      thumbnailAbsolutePath: file.thumbnailAbsolutePath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      ext: file.ext,
      width: file.indexEntry?.width ?? null,
      height: file.indexEntry?.height ?? null,
      capturedAt: captureTime.value,
      captureTimeSource: captureTime.source,
      sha256
    })
  }

  return {
    profiles,
    games: [...games.values()],
    candidates,
    failures,
    cancelled: false,
    scannedAccounts
  }
}
