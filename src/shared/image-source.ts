/**
 * 图片取值决策（纯函数，便于测试）。
 *
 * 相册卡片、游戏封面与查看器缩略图带对清晰度的要求不同：
 * - 卡片与封面在视网膜屏上可达 800px 宽，用来源自带的约 200px 缩略图会明显发虚；
 * - 缩略图带只有约 86px 高，用 200px 缩略图完全够清晰，而且更省内存。
 *
 * 因此取值顺序是：
 *   有自建预览 → 用预览；
 *   迷你通道（缩略图带）→ 优先来源缩略图；
 *   其它通道 → 按用户偏好：优先原图（清晰）或先给来源缩略图（省资源）。
 */

export type ImageSourceKind = 'preview' | 'source-thumbnail' | 'original'

export interface ImageSourceInput {
  /** 是否来自查看器缩略图带（小尺寸通道） */
  readonly wantsMini: boolean
  /** 自建预览是否已生成 */
  readonly hasPreview: boolean
  /** 来源目录里是否有 Steam 自带的缩略图 */
  readonly hasSourceThumbnail: boolean
  /** 用户偏好：宁可占用高一点也要清晰 */
  readonly preferOriginalImages: boolean
}

export function chooseImageSource(input: ImageSourceInput): ImageSourceKind {
  if (input.hasPreview) {
    return 'preview'
  }
  // 缩略图带尺寸很小，200px 的来源缩略图足够清晰，优先省资源
  if (input.wantsMini) {
    return input.hasSourceThumbnail ? 'source-thumbnail' : 'original'
  }
  if (input.preferOriginalImages) {
    return 'original'
  }
  return input.hasSourceThumbnail ? 'source-thumbnail' : 'original'
}
