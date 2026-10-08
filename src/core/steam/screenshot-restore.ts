/** 显式写入 Steam：预览快照、无覆盖发布、索引备份和持久化回滚。 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, openSync, fsyncSync, closeSync, linkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { AppError } from '@shared/errors'
import type { SteamScreenshotPreview, SteamScreenshotResult } from '@shared/steam-screenshot'
import { isInsideRoot } from '../library/asset-paths'
import { copyWithHash, hashExistingFile } from '../library/archive'
import { appendScreenshots, screenshotLayout, type RebuiltScreenshot } from './screenshot-index-writer'

export interface SteamScreenshotAsset {
  assetId: string; accountKey: string; gameKey: string; gameName: string
  filename: string; source: string; sha256: string; bytes: number
  width: number | null; height: number | null; capturedAt: string | null
}
interface RestoreItem { asset: SteamScreenshotAsset; index: RebuiltScreenshot; original: string; thumbnail: string; originalExists: boolean; thumbnailExists: boolean }
export interface ScreenshotPlan {
  preview: SteamScreenshotPreview; root: string; accountId: string; target: string
  oldIndex: Buffer | null; newIndex: Buffer; items: RestoreItem[]
  snapshots: Record<string, string | null>; expiresAt: number
}
interface JournalFile { path: string; temporary: string; sha256: string; published: boolean }
interface Journal {
  jobId: string; createdAt: string; status: string; root: string; target: string
  oldIndexHash: string | null; newIndexHash: string; files: JournalFile[]
}
const hashBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const currentHash = async (file: string): Promise<string | null> => existsSync(file) ? hashExistingFile(file) : null

/** 拒绝 UNC、符号链接及 Windows junction；每次文件发布都重查父目录。 */
export function safeSteamPath(root: string, target: string): void {
  const absoluteRoot = resolve(root), absolute = resolve(target)
  if (absoluteRoot.startsWith('\\\\') || !isInsideRoot(absoluteRoot, absolute)) throw new AppError('LIB_PATH_INVALID', '只能写入本机 Steam 目标目录')
  let node = absolute
  for (;;) {
    if (existsSync(node)) {
      if (lstatSync(node).isSymbolicLink() || !isInsideRoot(realpathSync(absoluteRoot), realpathSync(node))) {
        throw new AppError('LIB_PATH_INVALID', '目标目录含链接或重定向')
      }
    }
    if (node === absoluteRoot) break
    const parent = dirname(node)
    if (parent === node) throw new AppError('LIB_PATH_INVALID', '目标目录越界')
    node = parent
  }
}

export async function planSteamScreenshots(root: string, accountId: string, assets: readonly SteamScreenshotAsset[]): Promise<ScreenshotPlan> {
  if (!/^[1-9]\d{0,9}$/.test(accountId)) throw new AppError('IPC_INVALID_INPUT', '账号标识不合法')
  root = resolve(root)
  const accountRoot = join(root, 'userdata', accountId), target = join(accountRoot, '760')
  safeSteamPath(root, accountRoot)
  if (!statSync(accountRoot).isDirectory()) throw new AppError('SRC_NOT_FOUND', '本机目标账号不存在')
  const indexPath = join(target, 'screenshots.vdf')
  safeSteamPath(root, indexPath)
  const oldIndex = existsSync(indexPath) ? readFileSync(indexPath) : null
  const text = oldIndex?.toString('utf8') ?? '"screenshots"\r\n{\r\n}\r\n'
  const layout = screenshotLayout(text)
  const indexed = new Map<string, Map<string, string>>()
  for (const game of layout.children) for (const entry of game.children) {
    const name = entry.values.get('filename')?.replace(/\\/g, '/').toLowerCase()
    if (name) {
      if (indexed.has(name)) throw new AppError('SRC_VDF_PARSE', '截图索引包含重复文件引用')
      indexed.set(name, entry.values)
    }
  }
  const preview: SteamScreenshotPreview = { planId: randomUUID(), accountId, total: assets.length, added: 0, skipped: 0, conflicts: 0, unsupported: 0, rebuilt: 0, details: [] }
  const items: RestoreItem[] = [], snapshots: Record<string, string | null> = { [indexPath]: oldIndex ? hashBytes(oldIndex) : null }
  const additions: RebuiltScreenshot[] = [], seen = new Set<string>()
  for (const asset of assets) {
    let action = '待恢复'
    const gameId = /^steam-([1-9]\d{0,9})$/.exec(asset.gameKey)?.[1]
    const creation = asset.capturedAt ? Math.floor(Date.parse(asset.capturedAt) / 1000) : NaN
    if (asset.accountKey !== `steam-${accountId}` || !gameId || !/^[\w][\w.-]*\.jpe?g$/i.test(asset.filename) || /_vr\.jpe?g$/i.test(asset.filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(asset.filename) || !Number.isSafeInteger(creation) || creation <= 0 || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || !asset.width || !asset.height || asset.width <= 0 || asset.height <= 0) {
      preview.unsupported++; action = '不支持：需同账号 JPEG、拍摄时间和尺寸'
    } else {
      const key = `${gameId}/screenshots/${asset.filename}`
      const original = join(target, 'remote', key), thumbnail = join(target, 'remote', gameId, 'screenshots', 'thumbnails', asset.filename)
      safeSteamPath(root, original); safeSteamPath(root, thumbnail)
      const originalHash = await currentHash(original), thumbnailHash = await currentHash(thumbnail)
      snapshots[original] = originalHash; snapshots[thumbnail] = thumbnailHash
      const entry = indexed.get(key.toLowerCase())
      if (seen.has(key.toLowerCase()) || (originalHash !== null && originalHash !== asset.sha256) || (entry && (entry.get('gameid') !== gameId || Number(entry.get('width')) !== asset.width || Number(entry.get('height')) !== asset.height))) {
        preview.conflicts++; action = '冲突：保留目标，跳过'
      } else if (entry && originalHash && thumbnailHash) {
        preview.skipped++; action = '已存在：跳过'
      } else {
        if (!/^[0-9a-f]{64}$/.test(asset.sha256) || !existsSync(asset.source) || statSync(asset.source).size !== asset.bytes || await hashExistingFile(asset.source) !== asset.sha256) {
          throw new AppError('LIB_HASH_MISMATCH', `原图校验失败：${asset.filename}`)
        }
        const rebuilt = { gameId, filename: asset.filename, width: asset.width, height: asset.height, creation }
        items.push({ asset, index: rebuilt, original, thumbnail, originalExists: originalHash !== null, thumbnailExists: thumbnailHash !== null })
        if (!entry) { additions.push(rebuilt); preview.rebuilt++ }
        preview.added++; action = entry ? '补齐本地文件' : '恢复并重建登记'
      }
      seen.add(key.toLowerCase())
    }
    preview.details.push({ filename: asset.filename, game: asset.gameName, action })
  }
  return { preview, root, accountId, target, oldIndex, newIndex: Buffer.from(appendScreenshots(text, additions)), items, snapshots, expiresAt: Date.now() + 10 * 60_000 }
}

function durableWrite(file: string, bytes: Buffer | string): void {
  const fd = openSync(file, 'w')
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
}
function saveJournal(dir: string, journal: Journal): void {
  const temporary = join(dir, 'journal.tmp')
  durableWrite(temporary, JSON.stringify(journal, null, 2))
  renameSync(temporary, join(dir, 'journal.json'))
}
export function listSteamScreenshotBackups(backupRoot: string): { jobId: string; createdAt: string; status: string }[] {
  if (!existsSync(backupRoot)) return []
  // 备份目录由本应用创建，损坏日志不作为可操作任务显示。
  const entries = requireDirectoryNames(backupRoot)
  return entries.flatMap(jobId => {
    try { const journal = readJournal(backupRoot, jobId); return [{ jobId, createdAt: journal.createdAt, status: journal.status }] } catch { return [] }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
import { readdirSync } from 'node:fs'
function requireDirectoryNames(root: string): string[] { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) }
function readJournal(backupRoot: string, jobId: string): Journal {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new AppError('IPC_INVALID_INPUT', '恢复任务标识非法')
  const journal = JSON.parse(readFileSync(join(backupRoot, jobId, 'journal.json'), 'utf8')) as Journal
  if (journal.jobId !== jobId || !Array.isArray(journal.files) || !isInsideRoot(join(journal.root, 'userdata'), journal.target) || !/[/\\]\d+[/\\]760$/.test(journal.target)) throw new AppError('LIB_PATH_INVALID', '恢复日志目标非法')
  return journal
}
export async function rollbackSteamScreenshots(backupRoot: string, jobId: string, assertStopped: () => void): Promise<void> {
  const dir = join(backupRoot, jobId), journal = readJournal(backupRoot, jobId)
  if (journal.status === 'rolled-back') return
  assertStopped()
  const indexPath = join(journal.target, 'screenshots.vdf')
  safeSteamPath(journal.root, indexPath)
  const indexHash = await currentHash(indexPath)
  if (indexHash !== journal.oldIndexHash && indexHash !== journal.newIndexHash) throw new AppError('LIB_HASH_MISMATCH', 'Steam 索引已有外部修改，保留备份并停止回滚')
  for (const file of journal.files) {
    if (!isInsideRoot(journal.target, file.path) || !isInsideRoot(journal.target, file.temporary)) throw new AppError('LIB_PATH_INVALID', '恢复日志文件越界')
    safeSteamPath(journal.root, file.path); safeSteamPath(journal.root, file.temporary)
    if (existsSync(file.path) && await hashExistingFile(file.path) !== file.sha256) throw new AppError('LIB_HASH_MISMATCH', '新增文件已有外部修改，停止回滚')
    if (!file.published && existsSync(file.path) && (!existsSync(file.temporary) || statSync(file.path).ino !== statSync(file.temporary).ino)) throw new AppError('LIB_HASH_MISMATCH', '未确认文件归属，停止回滚')
  }
  assertStopped()
  if (indexHash === journal.newIndexHash && journal.newIndexHash !== journal.oldIndexHash) {
    if (journal.oldIndexHash) {
      const backup = readFileSync(join(dir, 'screenshots.vdf.backup'))
      if (hashBytes(backup) !== journal.oldIndexHash) throw new AppError('LIB_HASH_MISMATCH', '索引备份损坏')
      const temporary = `${indexPath}.ssm-${jobId}`
      durableWrite(temporary, backup); renameSync(temporary, indexPath)
    } else rmSync(indexPath)
  }
  for (const file of [...journal.files].reverse()) {
    assertStopped()
    safeSteamPath(journal.root, file.path)
    if (existsSync(file.path)) rmSync(file.path)
    if (existsSync(file.temporary)) rmSync(file.temporary)
  }
  const indexTemporary = join(journal.target, `.ssm-${jobId}-index.part`)
  safeSteamPath(journal.root, indexTemporary)
  if (existsSync(indexTemporary)) {
    if (await hashExistingFile(indexTemporary) !== journal.newIndexHash) throw new AppError('LIB_HASH_MISMATCH', '索引临时文件已有外部修改')
    rmSync(indexTemporary)
  }
  journal.status = 'rolled-back'; saveJournal(dir, journal)
}

export async function executeSteamScreenshots(plan: ScreenshotPlan, options: {
  backupRoot: string; assertStopped: () => void
  thumbnail: (source: string, width: number, height: number) => Promise<Buffer>
  shouldCancel?: () => boolean; onProgress?: (processed: number, total: number) => void
}): Promise<SteamScreenshotResult> {
  options.assertStopped()
  if (Date.now() > plan.expiresAt) throw new AppError('IPC_INVALID_INPUT', '恢复预览已过期，请重新预览')
  for (const [path, hash] of Object.entries(plan.snapshots)) {
    safeSteamPath(plan.root, path)
    if (await currentHash(path) !== hash) throw new AppError('LIB_HASH_MISMATCH', '目标已在预览后变化，请刷新预览')
  }
  const jobId = randomUUID(), dir = join(options.backupRoot, jobId)
  const journal: Journal = { jobId, createdAt: new Date().toISOString(), status: 'prepared', root: plan.root, target: plan.target, oldIndexHash: plan.oldIndex ? hashBytes(plan.oldIndex) : null, newIndexHash: hashBytes(plan.newIndex), files: [] }
  mkdirSync(dir, { recursive: true })
  if (plan.oldIndex) durableWrite(join(dir, 'screenshots.vdf.backup'), plan.oldIndex)
  saveJournal(dir, journal)
  const result = { jobId, restored: 0, skipped: plan.preview.skipped, conflicts: plan.preview.conflicts, unsupported: plan.preview.unsupported, cancelled: false, rolledBack: false }
  const publish = async (path: string, bytes: Buffer | SteamScreenshotAsset): Promise<void> => {
    options.assertStopped(); safeSteamPath(plan.root, path)
    mkdirSync(dirname(path), { recursive: true })
    const temporary = join(dirname(path), `.ssm-${jobId}-${randomUUID()}.part`)
    try {
      let sha256: string
      if (Buffer.isBuffer(bytes)) { durableWrite(temporary, bytes); sha256 = hashBytes(bytes) }
      else {
        const copied = await copyWithHash(bytes.source, temporary)
        if (copied.sha256 !== bytes.sha256 || copied.bytes !== bytes.bytes) throw new AppError('LIB_HASH_MISMATCH', '来源在预览后变化')
        sha256 = copied.sha256
        const fd = openSync(temporary, 'r+')
        try { fsyncSync(fd) } finally { closeSync(fd) }
      }
      if (await hashExistingFile(temporary) !== sha256) throw new AppError('LIB_HASH_MISMATCH', '临时文件校验失败')
      const file: JournalFile = { path, temporary, sha256, published: false }
      journal.files.push(file); saveJournal(dir, journal)
      options.assertStopped(); safeSteamPath(plan.root, path)
      try { linkSync(temporary, path) } catch (error) {
        journal.files.pop(); saveJournal(dir, journal); throw error
      }
      file.published = true; saveJournal(dir, journal)
    } catch (error) { if (!journal.files.some(file => file.temporary === temporary)) rmSync(temporary, { force: true }); throw error }
  }
  try {
    journal.status = 'applying'; saveJournal(dir, journal)
    for (const item of plan.items) {
      if (options.shouldCancel?.()) { result.cancelled = true; throw new Error('已取消恢复') }
      if (!item.originalExists) await publish(item.original, item.asset)
      if (!item.thumbnailExists) await publish(item.thumbnail, await options.thumbnail(item.asset.source, item.index.width, item.index.height))
      result.restored++; options.onProgress?.(result.restored, plan.items.length)
    }
    if (options.shouldCancel?.()) { result.cancelled = true; throw new Error('已取消恢复') }
    const indexPath = join(plan.target, 'screenshots.vdf')
    for (const file of journal.files) {
      safeSteamPath(plan.root, file.path)
      if (await hashExistingFile(file.path) !== file.sha256) throw new AppError('LIB_HASH_MISMATCH', '发布后文件读回校验失败')
    }
    for (const [path, originalHash] of Object.entries(plan.snapshots)) {
      if (path !== indexPath && originalHash !== null && await currentHash(path) !== originalHash) throw new AppError('LIB_HASH_MISMATCH', '已有文件在恢复期间被修改')
    }
    options.assertStopped(); safeSteamPath(plan.root, indexPath)
    if (await currentHash(indexPath) !== journal.oldIndexHash) throw new AppError('LIB_HASH_MISMATCH', '提交前索引已变化')
    mkdirSync(plan.target, { recursive: true })
    const temporary = join(plan.target, `.ssm-${jobId}-index.part`)
    durableWrite(temporary, plan.newIndex)
    journal.status = 'committing'; saveJournal(dir, journal)
    options.assertStopped()
    if (plan.oldIndex) renameSync(temporary, indexPath)
    else { linkSync(temporary, indexPath); rmSync(temporary) }
    if (await hashExistingFile(indexPath) !== journal.newIndexHash) throw new AppError('LIB_HASH_MISMATCH', '索引读回失败')
    journal.status = 'applied'; saveJournal(dir, journal)
    for (const file of journal.files) rmSync(file.temporary, { force: true })
    return result
  } catch (error) {
    try { await rollbackSteamScreenshots(options.backupRoot, jobId, options.assertStopped); result.rolledBack = true } catch (rollbackError) {
      throw new AppError('APP_INTERNAL', `恢复失败；回滚需处理：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}（任务 ${jobId}）`)
    }
    result.restored = 0
    if (result.cancelled) return result
    throw error
  }
}
