/**
 * 把"一个文件夹"当远端用。
 *
 * 为什么需要它：WebDAV 不是每个人都有（NAS 常常只开 SMB，或者早就把共享盘映射成 `Z:`）。
 * 备份的本质是「把对象放过去、读回来核对、再落一条记录」，这些动作在文件夹上一模一样，
 * 不带凭据、不依赖服务端能力，还比 HTTP 快得多。
 *
 * 安全边界：
 * - 远端根在构造时 resolve 成绝对路径，之后每次拼接都过一遍 `resolveAssetPath`
 *   （拒绝 `..`、绝对路径、盘符），不会写到根之外；
 * - 写入一律「同目录临时文件 + 改名」，避免留下半截对象被当成已备份。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { copyWithHash } from '../library/archive'
import { resolveAssetPath } from '../library/asset-paths'
import type { RemoteClient, RemoteEntry } from './remote-client'

/** 往目标写文件时的临时后缀：同目录改名保证原子性。 */
const TEMP_SUFFIX = '.ssm-tmp'

export class FolderRemoteClient implements RemoteClient {
  private readonly root: string

  constructor(rootPath: string) {
    this.root = rootPath.replace(/[\\/]+$/, '')
    if (this.root.length === 0) {
      throw new Error('远端文件夹为空')
    }
  }

  /** 远端根目录（已去掉结尾分隔符）。 */
  get rootPath(): string {
    return this.root
  }

  /** 相对路径 → 绝对路径；越界直接抛 LIB_PATH_INVALID。 */
  private absolute(relativePath: string): string {
    if (relativePath.length === 0) {
      return this.root
    }
    return resolveAssetPath(this.root, relativePath)
  }

  async ensureCollection(relativePath: string): Promise<void> {
    mkdirSync(this.absolute(relativePath), { recursive: true })
  }

  async ensureParentCollection(relativePath: string): Promise<void> {
    const absolute = this.absolute(relativePath)
    const index = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
    if (index > this.root.length) {
      mkdirSync(absolute.slice(0, index), { recursive: true })
    }
  }

  /** 先写同目录临时文件再改名：中途失败不会留下一个"看起来已备份"的半截对象。 */
  private publish(targetPath: string, write: (temporary: string) => void): number {
    const temporary = `${targetPath}${TEMP_SUFFIX}`
    try {
      write(temporary)
      renameSync(temporary, targetPath)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    return 201
  }

  async putFile(relativePath: string, filePath: string): Promise<number> {
    await this.ensureParentCollection(relativePath)
    const target = this.absolute(relativePath)
    return this.publish(target, (temporary) => copyFileSync(filePath, temporary))
  }

  async putText(relativePath: string, text: string): Promise<number> {
    await this.ensureParentCollection(relativePath)
    const target = this.absolute(relativePath)
    return this.publish(target, (temporary) => writeFileSync(temporary, text, 'utf8'))
  }

  async getText(relativePath: string): Promise<string | null> {
    try {
      return readFileSync(this.absolute(relativePath), 'utf8')
    } catch {
      return null
    }
  }

  async downloadToFile(relativePath: string, targetPath: string): Promise<{ status: number; sha256: string; bytes: number } | null> {
    const source = this.absolute(relativePath)
    if (!existsSync(source)) {
      return null
    }
    // 复用归档里的流式复制：边写边算 SHA-256，不把整图读进内存
    const result = await copyWithHash(source, targetPath)
    return { status: 200, sha256: result.sha256, bytes: result.bytes }
  }

  async list(relativePath: string): Promise<{ status: number; hrefs: string[] }> {
    const directory = this.absolute(relativePath)
    try {
      const entries = readdirSync(directory, { withFileTypes: true })
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
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return []
    }
    const prefix = relativePath.length === 0 ? '' : `${relativePath}/`
    return entries.map((entry) => {
      const path = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        return { name: entry.name, path, isDir: true, size: null, modifiedAt: null }
      }
      let size: number | null = null
      let modifiedAt: string | null = null
      try {
        const info = statSync(join(directory, entry.name))
        size = info.size
        modifiedAt = info.mtime.toISOString()
      } catch {
        // 读不到大小就当未知，不影响列举
      }
      return { name: entry.name, path, isDir: false, size, modifiedAt }
    })
  }

  async deleteFile(relativePath: string): Promise<boolean> {
    const target = this.absolute(relativePath)
    if (!existsSync(target)) {
      return false
    }
    rmSync(target, { force: true })
    return true
  }

  async deleteCollection(relativePath: string): Promise<boolean> {
    const target = this.absolute(relativePath)
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      return false
    }
    rmSync(target, { recursive: true, force: true })
    return true
  }
}

/** 远端根是否是个可用目录（存在、可列出）。 */
export function isUsableFolderRoot(path: string): { ok: true } | { ok: false; reason: string } {
  if (path.trim().length === 0) {
    return { ok: false, reason: '目录为空' }
  }
  if (!existsSync(path)) {
    return { ok: false, reason: `目录不存在：${path}` }
  }
  try {
    readdirSync(path)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
