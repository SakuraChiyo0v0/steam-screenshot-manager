/** 恢复到 Steam 的界面契约；文件路径与写入计划仅保留在主进程。 */
export interface SteamScreenshotTarget {
  id: string
  label: string
  accounts: { accountId: string; label: string }[]
}
export interface SteamScreenshotPreview {
  planId: string
  accountId: string
  total: number
  added: number
  skipped: number
  conflicts: number
  unsupported: number
  rebuilt: number
  details: { filename: string; game: string; action: string }[]
}
export interface SteamScreenshotResult {
  jobId: string
  restored: number
  skipped: number
  conflicts: number
  unsupported: number
  cancelled: boolean
  rolledBack: boolean
}
export interface SteamScreenshotState {
  running: boolean
  processed: number
  total: number
  result: SteamScreenshotResult | null
  error: string | null
  backups: { jobId: string; createdAt: string; status: string }[]
}
