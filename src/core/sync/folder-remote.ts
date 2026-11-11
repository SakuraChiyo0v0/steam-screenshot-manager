/**
 * 把"一个文件夹"当远端用。
 *
 * 为什么需要它：WebDAV 不是每个人都有（NAS 常常只开 SMB，或者早就把共享盘映射成 Z:）。
 * 备份的本质是「把对象放过去、读回来核对、再落一条记录」，这些动作在文件夹上一模一样。
 *
 * 重要：**所有文件操作都走异步 API**。这些目录经常在 SMB / rclone 挂载上，
 * 一次同步 stat 就是几百毫秒；用 Sync 版本会把主进程事件循环整个卡住，界面看起来就是死机。
 */
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { copyWithHash } from '../library/archive'
import { resolveAssetPath } from '../library/asset-paths'
import type { RemoteClient, RemoteEntry } from './remote-client'

const TEMP_SUFFIX = '.ssm-tmp'

export class FolderRemoteClient implements RemoteClient {
  private readonly root: string

  constructor(rootPath: string) {
    this.root = rootPath.replace(/[\\/]+$/, '')
    if (this.root.length === 0) {
      throw new Error('远端文件夹为空')
    }
  }

  get rootPath(): string {
    return this.root
  }

  private absolute(relativePath: string): string {
    if (relativePath.length === 0) {
      return this.root
    }
    return resolveAssetPath(this.root, relativePath)
  }

  async ensureCollection(relativePath: string): Promise<void> {
    await mkdir(this.absolute(relativePath), { recursive: true })
  }

  async ensureParentCollection(relativePath: string): Promise<void> {
    const absolute = this.absolute(relativePath)
    await mkdir(dirname(absolute), { recursive: true })
  }

  private async publish(targetPath: string, write: (temporary: string) => Promise<void>): Promise<number> {
    const temporary = `${targetPath}${TEMP_SUFFIX}`
    try {
      await write(temporary)
      await rename(temporary, targetPath)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    return 201
  }

  async putFile(relativePath: string, filePath: string): Promise<number> {
    await this.ensureParentCollection(relativePath)
    const target = this.absolute(relativePath)
    return this.publish(target, async (temporary) => {
      await copyFile(filePath, temporary)
    })
  }

  async putText(relativePath: string, text: string): Promise<number> {
    await this.ensureParentCollection(relativePath)
    const target = this.absolute(relativePath)
    return this.publish(target, async (temporary) => {
      await writeFile(temporary, text, 'utf8')
    })
  }

  async getText(relativePath: string): Promise<string | null> {
    try {
      return await readFile(this.absolute(relativePath), 'utf8')
    } catch {
      return null
    }
  }

  async downloadToFile(
    relativePath: string,
    targetPath: string
  ): Promise<{ status: number; sha256: string; bytes: number } | null> {
    const source = this.absolute(relativePath)
    try {
      const info = await stat(source)
      if (!info.isFile()) return null
    } catch {
      return null
    }
    const result = await copyWithHash(source, targetPath)
    return { status: 200, sha256: result.sha256, bytes: result.bytes }
  }

  async list(relativePath: string): Promise<{ status: number; hrefs: string[] }> {
    try {
      const entries = await readdir(this.absolute(relativePath), { withFileTypes: true })
      const hrefs = entries
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map((entry) => `${relativePath}/${entry.name}`.replace(/^\/+/, ''))
      return { status: 200, hrefs }
    } catch {
      return { status: 404, hrefs: [] }
    }
  }

  async listEntries(relativePath: string): Promise<RemoteEntry[]> {
    const directory = this.absolute(relativePath)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return []
    }
    const prefix = relativePath.length === 0 ? '' : `${relativePath}/`
    const result: RemoteEntry[] = []
    for (const entry of entries) {
      const path = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        result.push({ name: entry.name, path, isDir: true, size: null, modifiedAt: null })
        continue
      }
      let size: number | null = null
      let modifiedAt: string | null = null
      try {
        const info = await stat(join(directory, entry.name))
        size = info.size
        modifiedAt = info.mtime.toISOString()
      } catch {
        // 读不到大小不影响列举
      }
      result.push({ name: entry.name, path, isDir: false, size, modifiedAt })
    }
    return result
  }

  async deleteFile(relativePath: string): Promise<boolean> {
    const target = this.absolute(relativePath)
    try {
      const info = await stat(target)
      if (!info.isFile()) return false
      await rm(target, { force: true })
      return true
    } catch {
      return false
    }
  }

  async deleteCollection(relativePath: string): Promise<boolean> {
    const target = this.absolute(relativePath)
    try {
      const info = await stat(target)
      if (!info.isDirectory()) return false
      await rm(target, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
}

/** 远端根是否是个可用目录（异步，避免在 SMB 上卡住主线程）。 */
export async function isUsableFolderRoot(path: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (path.trim().length === 0) {
    return { ok: false, reason: '目录为空' }
  }
  try {
    const info = await stat(path)
    if (!info.isDirectory()) {
      return { ok: false, reason: '不是目录' }
    }
    await readdir(path)
    return { ok: true }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    if (code === 'ENOENT') {
      return { ok: false, reason: `目录不存在：${path}` }
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, reason: `没有权限访问：${path}` }
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
