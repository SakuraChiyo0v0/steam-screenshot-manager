/**
 * 备份目标的合理性检查。
 *
 * 真实踩到的配置：图库目录是 \\NAS\share\Steam截图，备份远端又选了同一个目录
 * （同一个共享用 UNC 和映射盘各写了一遍），结果备份把原图又复制进自己里面的
 * steam-gallery-v1/，白白翻倍，而且"已备份"看着像真的。
 *
 * 规则：文件夹远端不能与图库目录相同，也不能互相包含。
 */

import { isSameOrInside } from '../settings/library-root'

export type RemoteTargetProblem = string | null

export function checkBackupTarget(input: {
  readonly kind: 'webdav' | 'folder'
  /** WebDAV 是 URL；文件夹是绝对路径 */
  readonly address: string
  readonly libraryRoot: string | null
}): RemoteTargetProblem {
  if (input.kind !== 'folder' || !input.libraryRoot) {
    return null
  }
  const library = input.libraryRoot
  const remote = input.address
  if (isSameOrInside(library, remote) || isSameOrInside(remote, library)) {
    return `备份目标不能和本机图库是同一个目录（或互相包含）：${remote}`
  }
  return null
}
