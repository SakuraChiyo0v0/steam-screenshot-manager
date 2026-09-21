/**
 * 真实数据 → 界面视图模型。
 *
 * 这里集中处理四个"真实离线数据填不上"的字段（与用户确认过的映射）：
 *   - 类型筛选 → 改为账号与安装状态筛选（真实维度）
 *   - 英文名   → 显示 steam-<AppID> / shortcut-<gameID>（gameKey 本身）
 *   - 截图标题 → 显示原文件名，并给出拍摄时间来源
 *   - 游戏封面 → 该游戏最近一张真实截图
 */

import type { CaptureTimeSourceType, GalleryAssetDto, GalleryGameDto } from '@shared/types'

export interface GameCard {
  readonly key: string
  readonly name: string
  /** 副标题：gameKey（steam-<AppID> 或 shortcut-<gameID>） */
  readonly keyLabel: string
  readonly installed: boolean
  readonly assetCount: number
  readonly bytes: number
  readonly bytesLabel: string
  readonly updatedLabel: string
  readonly coverUrl: string | null
  readonly accounts: readonly string[]
}

export interface ViewerItem {
  readonly id: string
  readonly title: string
  readonly src: string
  readonly thumbSrc: string
  readonly date: string
  readonly dateSource: string
  readonly filename: string
  readonly gameName: string
  readonly available: boolean
  readonly archived: boolean
  readonly width: number | null
  readonly height: number | null
  readonly bytes: number
  readonly bytesLabel: string
}

export const CAPTURE_SOURCE_LABELS: Record<CaptureTimeSourceType, string> = {
  'screenshot-index': '截图索引（Steam 记录）',
  'file-time': '文件修改时间（推断）',
  unknown: '未知'
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '未知'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** ISO → `YYYY-MM-DD HH:mm`；无效或缺失返回"未知"。 */
export function formatCapturedAt(iso: string | null): string {
  if (!iso) {
    return '未知'
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return '未知'
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function toGameCard(game: GalleryGameDto): GameCard {
  return {
    key: game.gameKey,
    name: game.name,
    keyLabel: game.appKeyLabel,
    installed: game.installed,
    assetCount: game.assetCount,
    bytes: game.bytes,
    bytesLabel: formatBytes(game.bytes),
    updatedLabel: formatCapturedAt(game.latestCapturedAt).slice(5, 10).replace('-', '/'),
    coverUrl: game.coverUrl,
    accounts: game.accounts
  }
}

export function toViewerItem(asset: GalleryAssetDto): ViewerItem {
  return {
    id: asset.assetId,
    title: asset.fileName,
    src: asset.imageUrl,
    thumbSrc: asset.thumbnailUrl,
    date: formatCapturedAt(asset.capturedAt),
    dateSource: CAPTURE_SOURCE_LABELS[asset.captureTimeSource] ?? '未知',
    filename: asset.fileName,
    gameName: asset.gameName,
    available: asset.available,
    archived: asset.archived,
    width: asset.width,
    height: asset.height,
    bytes: asset.bytes,
    bytesLabel: formatBytes(asset.bytes)
  }
}

/** 账号键 → 展示名：优先昵称，其次原始键。 */
export function accountLabel(accountKey: string, displayName: string | null): string {
  return displayName && displayName.length > 0 ? displayName : accountKey
}
