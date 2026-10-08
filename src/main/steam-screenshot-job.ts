import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { AppError } from '@shared/errors'
import type { SteamScreenshotState, SteamScreenshotTarget } from '@shared/steam-screenshot'
import { discoverSteamRoots } from '@core/steam/discovery'
import { listSources } from '@core/library/index-writer'
import { resolveExistingAssetPath } from '@core/library/asset-paths'
import { readSettings } from '@core/settings/settings-store'
import { executeSteamScreenshots, listSteamScreenshotBackups, planSteamScreenshots, rollbackSteamScreenshots, type ScreenshotPlan, type SteamScreenshotAsset } from '@core/steam/screenshot-restore'
import { getAppContext } from './app-context'
import { getScanStatus } from './scan-job'
import { getArchiveStatus } from './archive-job'
import { getRestoreStatus } from './restore-job'

const targets = new Map<string, string>()
let cachedPlan: ScreenshotPlan | null = null
let cancel = false
const state: SteamScreenshotState = { running: false, processed: 0, total: 0, result: null, error: null, backups: [] }
const backupRoot = (): string => join(getAppContext().paths.dataDir, 'steam-restore')

export function assertSteamStopped(): void {
  if (process.platform !== 'win32') throw new AppError('IPC_INVALID_INPUT', '恢复到 Steam 仅支持 Windows')
  for (const image of ['steam.exe', 'steamwebhelper.exe']) {
    let output: string
    try { output = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }) }
    catch { throw new AppError('APP_INTERNAL', '无法检测 Steam 运行状态，拒绝写入') }
    if (output.split(/\r?\n/).some(line => line.split(',')[0]?.trim().toLowerCase() === `"${image}"`)) throw new AppError('JOB_RUNNING', '请完全退出 Steam 后再执行或回滚，不会自动关闭客户端')
  }
}
export function assertScreenshotRestoreIdle(): void {
  if (state.running) throw new AppError('JOB_RUNNING', '恢复到 Steam 正在执行，请稍后再操作')
}
export function isSteamScreenshotRestoreRunning(): boolean { return state.running }
function ensureIdle(): void {
  assertScreenshotRestoreIdle()
  if (getScanStatus().running || getArchiveStatus().running || getRestoreStatus().running) throw new AppError('JOB_RUNNING', '请等待扫描、归档或图库恢复完成')
}
export function getSteamScreenshotTargets(): SteamScreenshotTarget[] {
  const { database } = getAppContext()
  if (process.platform !== 'win32') return []
  return discoverSteamRoots(listSources(database.db).map(source => source.rootPath))
    .filter(root => root.exists && root.readable && !root.rootPath.startsWith('\\\\') && existsSync(join(root.rootPath, 'steam.exe')))
    .map(root => {
      // 路径仅由发现接口登记，执行输入不接受任意路径。
      const id = String(targets.size + 1)
      const existing = [...targets.entries()].find(([, path]) => path === root.rootPath)
      const key = existing?.[0] ?? id
      targets.set(key, root.rootPath)
      return { id: key, label: root.rootPath, accounts: root.accounts.map(account => ({ accountId: account.accountId, label: account.personaName ?? account.accountName ?? account.accountId })) }
    })
}
export async function previewSteamScreenshotRestore(input: { targetId: string; accountId: string; gameKeys: string[] }) {
  ensureIdle()
  const root = targets.get(input.targetId)
  if (!root || !getSteamScreenshotTargets().some(target => target.id === input.targetId && target.accounts.some(account => account.accountId === input.accountId))) throw new AppError('IPC_INVALID_INPUT', '请选择本机 Steam 与目标账号')
  const { database } = getAppContext()
  const settings = readSettings(database.db)
  if (!settings.libraryRoot) throw new AppError('LIB_PATH_INVALID', '先选择图库目录并归档或从远端恢复原图')
  const rows = database.db.prepare(`SELECT a.asset_id AS assetId, a.account_key AS accountKey,
    a.game_key AS gameKey, g.name AS gameName, a.original_filename AS filename, a.sha256,
    a.bytes, a.width, a.height, a.captured_at AS capturedAt, lc.relative_path AS relativePath
    FROM assets a JOIN games g ON g.game_key = a.game_key
    JOIN local_copies lc ON lc.asset_id = a.asset_id AND lc.present = 1 AND lc.library_root = ?
    WHERE a.account_key = ? ORDER BY a.game_key, a.asset_id`).all(settings.libraryRoot, `steam-${input.accountId}`)
  const selected = new Set(input.gameKeys)
  const assets: SteamScreenshotAsset[] = []
  for (const row of rows) {
    if (!selected.has(String(row.gameKey))) continue
    assets.push({ assetId: String(row.assetId), accountKey: String(row.accountKey), gameKey: String(row.gameKey), gameName: String(row.gameName), filename: String(row.filename ?? ''), source: await resolveExistingAssetPath(settings.libraryRoot, String(row.relativePath)), sha256: String(row.sha256), bytes: Number(row.bytes), width: row.width === null ? null : Number(row.width), height: row.height === null ? null : Number(row.height), capturedAt: row.capturedAt === null ? null : String(row.capturedAt) })
  }
  if (!assets.length) throw new AppError('IPC_INVALID_INPUT', '所选账号和游戏没有可用图库副本；请先归档或恢复到独立图库')
  cachedPlan = await planSteamScreenshots(root, input.accountId, assets)
  state.error = null
  return cachedPlan.preview
}
export function getSteamScreenshotState(): SteamScreenshotState {
  return { ...state, backups: listSteamScreenshotBackups(backupRoot()) }
}
export function cancelSteamScreenshotRestore(): void { cancel = true }
export async function runSteamScreenshotRestore(planId: string) {
  ensureIdle()
  const plan = cachedPlan
  if (!plan || plan.preview.planId !== planId || !plan.items.length) throw new AppError('IPC_INVALID_INPUT', '请重新预览恢复内容')
  if (listSteamScreenshotBackups(backupRoot()).some(backup => !['applied', 'rolled-back'].includes(backup.status))) throw new AppError('JOB_RUNNING', '存在未完成恢复，请先从备份列表回滚')
  assertSteamStopped()
  cachedPlan = null; cancel = false
  state.running = true; state.processed = 0; state.total = plan.items.length; state.result = null; state.error = null
  try {
    const result = await executeSteamScreenshots(plan, {
      backupRoot: backupRoot(), assertStopped: assertSteamStopped,
      shouldCancel: () => cancel, onProgress: (processed, total) => { state.processed = processed; state.total = total },
      thumbnail: async (source, width, height) => {
        const image = nativeImage.createFromPath(source)
        const actual = image.getSize()
        if (image.isEmpty() || actual.width !== width || actual.height !== height) throw new AppError('LIB_HASH_MISMATCH', '图片尺寸与记录不一致')
        return image.resize({ width: 200, height: Math.max(1, Math.round(height * 200 / width)), quality: 'best' }).toJPEG(90)
      }
    })
    state.result = result
    return result
  } catch (error) { state.error = error instanceof Error ? error.message : String(error); throw error }
  finally { state.running = false }
}
export async function undoSteamScreenshotRestore(jobId: string): Promise<void> {
  ensureIdle(); state.running = true
  try { await rollbackSteamScreenshots(backupRoot(), jobId, assertSteamStopped); state.result = null; state.error = null }
  finally { state.running = false; cachedPlan = null }
}
