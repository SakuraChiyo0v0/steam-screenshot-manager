/**
 * 远端存储的统一接口。
 *
 * 备份（上传对象 + 读回校验 + 发布记录）与恢复（列记录 + 下载校验）都只依赖这一组动作，
 * 因此"远端"不一定是 WebDAV：**一个普通文件夹**（本机盘、NAS 共享、已经映射好的网络盘）
 * 同样能当远端用。
 *
 * 语义约定（两种实现必须一致）：
 * - 路径一律是相对远端根的、以 `/` 分隔的相对路径，越界由实现自己拒绝；
 * - `getText`/`downloadToFile` 在没有该对象时返回 null，不抛错；
 * - `list` 在没有该集合时返回 `{ status: 404, hrefs: [] }`；
 * - `put*` 成功返回状态码（WebDAV 是 201/200/204，文件夹实现固定 201）。
 */

export interface RemoteDownload {
  readonly status: number
  /** 下载过程中算出的 SHA-256（上传后的读回校验靠它） */
  readonly sha256: string
  readonly bytes: number
}

export interface RemoteListing {
  readonly status: number
  readonly hrefs: readonly string[]
}

export interface RemoteClient {
  /** 逐级创建集合；已存在视为成功 */
  ensureCollection(relativePath: string): Promise<void>
  /** 确保某个文件路径的父集合存在 */
  ensureParentCollection(relativePath: string): Promise<void>
  putFile(relativePath: string, filePath: string): Promise<number>
  putText(relativePath: string, text: string): Promise<number>
  getText(relativePath: string): Promise<string | null>
  downloadToFile(relativePath: string, targetPath: string): Promise<RemoteDownload | null>
  list(relativePath: string): Promise<RemoteListing>
  deleteFile(relativePath: string): Promise<boolean>
  /** 删除集合（探测残留、测试目录用） */
  deleteCollection(relativePath: string): Promise<boolean>
}
