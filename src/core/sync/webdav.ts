/**
 * 最小 WebDAV 客户端。
 *
 * 只实现首版需要的动作：MKCOL、PROPFIND(Depth:1)、PUT、GET、DELETE（仅用于自建测试文件）。
 * 设计要求（docs/sync-protocol.md §11、docs/architecture.md §8）：
 * - 跨站重定向一律拒绝，不把凭据带给其它源；
 * - 期待 WebDAV 响应却拿到 HTML（登录页）时判为连接不兼容，不能当成空库或成功；
 * - 超时、断网与可重试的服务端错误归为可重试；认证与权限问题快速失败；
 * - 不做 MOVE / LOCK，也不依赖服务端内容哈希。
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { AppError } from '@shared/errors'

/**
 * 把用户填写的 WebDAV 地址拆成「源」与「根路径」。
 *
 * 例如 `https://host/volume1/@tmp/backup` → baseUrl `https://host`、rootPath `volume1/@tmp/backup`。
 * 这样根路径能走留空路径时的逐级创建逻辑（有些远端不会自动创建 URL 里的目录）。
 */
export function splitDavUrl(rawUrl: string): { baseUrl: string; rootPath: string } {
  const parsed = new URL(rawUrl)
  const segments = parsed.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment))
  return {
    baseUrl: parsed.origin,
    rootPath: segments.join('/')
  }
}

export interface DavCredential {
  readonly username: string
  readonly password: string
}

export interface DavConfig {
  readonly baseUrl: string
  readonly rootPath: string
  readonly credential: DavCredential
  readonly timeoutMs?: number
}

export interface DavResponse {
  readonly status: number
  readonly headers: IncomingMessage['headers']
  readonly text: string
}

export interface DownloadResult {
  readonly status: number
  readonly sha256: string
  readonly bytes: number
}

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 3

/**
 * 生成 Basic 认证头。
 *
 * 用户名与密码都为空时返回 null：这样请求里就不会带 Authorization，
 * 便于把凭据交给前置网关代持（例如本机端口镜像/统一登录网关会自行注入该头；
 * 若调用方自己带了这个头，它会覆盖网关注入的值并导致 401）。
 */
export function basicAuthHeader(credential: DavCredential): string | null {
  if (credential.username.length === 0 && credential.password.length === 0) {
    return null
  }
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}`
}

/**
 * 拼接远端路径：根路径 + 相对路径。
 * 拒绝 `..`、绝对路径与空字节，避免把请求打出图库范围。
 */
export function joinRemotePath(rootPath: string, relativePath: string): string {
  if (relativePath.includes('\u0000')) {
    throw new AppError('LIB_PATH_INVALID', '远端路径包含非法字符')
  }
  if (relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) {
    throw new AppError('LIB_PATH_INVALID', '远端路径必须是相对路径')
  }

  const segments = relativePath.split('/').filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '..')) {
    throw new AppError('LIB_PATH_INVALID', '远端路径不允许包含上级目录')
  }

  const rootSegments = rootPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  const all = [...rootSegments, ...segments]
  const encoded = all.map((segment) => encodeURIComponent(segment)).join('/')
  return `/${encoded}`
}

/** 解析 Retry-After（秒或 HTTP 日期），返回毫秒。 */
export function parseRetryAfterMs(headers: IncomingMessage['headers']): number | null {
  const raw = headers['retry-after']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) {
    return null
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 5 * 60 * 1000)
  }
  const date = Date.parse(value)
  if (Number.isFinite(date)) {
    return Math.max(0, Math.min(date - Date.now(), 5 * 60 * 1000))
  }
  return null
}

function isRetriableStatus(status: number): boolean {
  // 423 Locked：真实服务在自身索引/杀毒扫描期间会短暂返回，属于可重试
  return (
    status === 408 ||
    status === 423 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  )
}

/** 把 HTTP 状态与响应内容映射成稳定错误码。 */
export function classifyDavFailure(
  status: number,
  context: { contentType: string; bodyHead: string; retryAfterMs: number | null }
): AppError {
  const looksLikeHtml = context.contentType.includes('text/html') || /^\s*<(!doctype|html)/i.test(context.bodyHead)

  if (status === 401) {
    return new AppError('DAV_AUTH', '远端返回 401')
  }
  if (status === 403) {
    return new AppError('DAV_FORBIDDEN', '远端返回 403')
  }
  if (status === 429) {
    const wait = context.retryAfterMs ? `，建议等待 ${Math.round(context.retryAfterMs / 1000)} 秒` : ''
    return new AppError('DAV_RATE_LIMIT', `远端返回 429${wait}`, { retryAfterMs: context.retryAfterMs ?? undefined })
  }
  if (status === 409) {
    // 父目录不存在：不是认证问题，也不该当成可重试的服务端错误
    return new AppError('LIB_PATH_INVALID', '远端父目录不存在（HTTP 409）')
  }
  if (status === 507) {
    return new AppError('DAV_CAPACITY', '远端返回 507')
  }
  if (looksLikeHtml) {
    // 200 的登录页也不能当成成功
    return new AppError('DAV_NOT_WEBDAV', `远端返回网页内容（HTTP ${status}）`)
  }
  if (isRetriableStatus(status)) {
    // 可重试的服务端错误与超时同组处理，与架构 7.1 表的分类一致
    return new AppError('DAV_TIMEOUT', `远端返回可重试状态 ${status}`)
  }
  return new AppError('APP_INTERNAL', `远端返回意外状态 ${status}`)
}

interface RawRequestOptions {
  readonly method: string
  /** true 表示 relativePath 相对 baseUrl 起算（不再拼 rootPath），用于创建基础路径本身 */
  readonly fromBase?: boolean
  readonly relativePath: string
  readonly headers?: Record<string, string>
  readonly bodyText?: string
  readonly bodyFile?: string
  readonly bodyBytes?: number
  readonly expectDav?: boolean
  readonly collectBody?: boolean
  readonly downloadTo?: string
  /** 这些状态码直接返回给调用方处理，不当作错误抛出（例如 MKCOL 已存在时的 405/301） */
  readonly tolerateStatuses?: readonly number[]
}

interface RawResponse {
  readonly status: number
  readonly headers: IncomingMessage['headers']
  readonly text: string
  readonly sha256: string | null
  readonly bytes: number
}

export class DavClient {
  private readonly base: URL
  private readonly timeoutMs: number

  constructor(private readonly config: DavConfig) {
    try {
      this.base = new URL(config.baseUrl)
    } catch {
      throw new AppError('IPC_INVALID_INPUT', '远端地址不是合法 URL')
    }
    if (this.base.protocol !== 'https:' && this.base.protocol !== 'http:') {
      throw new AppError('IPC_INVALID_INPUT', '远端地址必须是 http 或 https')
    }
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async raw(options: RawRequestOptions): Promise<RawResponse> {
    const path = joinRemotePath(options.fromBase ? '' : this.config.rootPath, options.relativePath)
    let attempt = 0
    let currentPath = path
    let currentUrl = new URL(this.base.toString())
    currentUrl.pathname = `${currentUrl.pathname.replace(/\/$/, '')}${currentPath}`

    for (;;) {
      const response = await this.sendOnce(currentUrl, options)

      const location = response.headers['location']
      if (response.status >= 300 && response.status < 400 && location) {
        if (attempt >= MAX_REDIRECTS) {
          throw new AppError('DAV_REDIRECT_REJECTED', '重定向次数过多')
        }
        const target = new URL(Array.isArray(location) ? location[0]! : location, currentUrl)
        const sameOrigin =
          target.protocol === this.base.protocol &&
          target.hostname === this.base.hostname &&
          target.port === this.base.port
        if (!sameOrigin) {
          // 不能把凭据带到别的源
          throw new AppError('DAV_REDIRECT_REJECTED', `重定向到其它源：${target.origin}`)
        }
        attempt += 1
        currentUrl = target
        currentPath = target.pathname
        continue
      }

      const contentType = String(response.headers['content-type'] ?? '')
      const bodyHead = response.text.slice(0, 200)

      if (options.expectDav && contentType.includes('text/html')) {
        throw new AppError('DAV_NOT_WEBDAV', `远端返回网页内容（HTTP ${response.status}）`)
      }

      if (response.status >= 400) {
        if (response.status === 404 || options.tolerateStatuses?.includes(response.status)) {
          return response
        }
        throw classifyDavFailure(response.status, {
          contentType,
          bodyHead,
          retryAfterMs: parseRetryAfterMs(response.headers)
        })
      }

      // 期待 WebDAV 却拿到 200 的 HTML 登录页
      if (options.expectDav && response.status === 200 && /^\s*<(!doctype|html)/i.test(bodyHead)) {
        throw new AppError('DAV_NOT_WEBDAV', '远端返回登录页而不是 WebDAV 响应')
      }

      return response
    }
  }

  private sendOnce(url: URL, options: RawRequestOptions): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      const isHttps = url.protocol === 'https:'
      const headers: Record<string, string> = { ...(options.headers ?? {}) }
      const authorization = basicAuthHeader(this.config.credential)
      if (authorization) {
        headers['authorization'] = authorization
      }

      if (options.bodyFile) {
        const info = statSync(options.bodyFile)
        headers['content-length'] = String(options.bodyBytes ?? info.size)
      } else if (options.bodyText !== undefined) {
        headers['content-length'] = String(Buffer.byteLength(options.bodyText))
      }

      const requester = isHttps ? httpsRequest : httpRequest
      const request = requester(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: options.method,
          headers
        },
        (response) => {
          const chunks: Buffer[] = []
          const hash = options.downloadTo ? createHash('sha256') : null
          let bytes = 0
          const output = options.downloadTo ? createWriteStream(options.downloadTo) : null

          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (output) {
              output.write(chunk)
              hash?.update(chunk)
            } else {
              chunks.push(chunk)
            }
          })

          response.on('end', () => {
            if (output) {
              output.end(() => {
                resolve({
                  status: response.statusCode ?? 0,
                  headers: response.headers,
                  text: '',
                  sha256: hash ? hash.digest('hex') : null,
                  bytes
                })
              })
              return
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text: Buffer.concat(chunks).toString('utf8'),
              sha256: null,
              bytes
            })
          })

          response.on('error', (error) => {
            output?.destroy()
            reject(this.mapNetworkError(error))
          })
        }
      )

      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new AppError('DAV_TIMEOUT', '远端请求超时'))
      })
      request.on('error', (error) => reject(this.mapNetworkError(error)))

      if (options.bodyFile) {
        createReadStream(options.bodyFile).pipe(request)
      } else if (options.bodyText !== undefined) {
        request.end(options.bodyText)
      } else {
        request.end()
      }
    })
  }

  private mapNetworkError(error: unknown): AppError {
    if (error instanceof AppError) {
      return error
    }
    const detail = error instanceof Error ? error.message : String(error)
    return new AppError('DAV_TIMEOUT', `网络错误：${detail}`)
  }

  /** MKCOL：已存在（405/301）视为成功。 */
  async createCollection(relativePath: string): Promise<void> {
    // 已存在时不同服务端返回 405 或 301，都按"已存在"处理
    const response = await this.raw({
      method: 'MKCOL',
      relativePath,
      expectDav: true,
      tolerateStatuses: [405, 301]
    })
    if (response.status === 405 || response.status === 301) {
      return
    }
    if (response.status !== 201 && response.status !== 200) {
      throw new AppError('APP_INTERNAL', `创建目录返回 ${response.status}`)
    }
  }

  /**
   * 确保基础路径（baseUrl 里的路径）存在。
   *
   * 有些远端不会自动创建 URL 里的目录，直接 MKCOL 子目录会返回 409（父目录不存在），
   * 因此连接时先把基础路径逐级建出来。
   */
  async ensureBaseCollection(): Promise<void> {
    const segments = this.config.rootPath
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
    if (segments.length === 0) {
      return
    }
    let current = ''
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`
      // 注意：这里要相对 baseUrl 起算，否则会拼成 <基础路径>/<基础路径第一段>
      const response = await this.raw({
        method: 'MKCOL',
        relativePath: current,
        fromBase: true,
        expectDav: true,
        tolerateStatuses: [405, 301]
      })
      if (response.status !== 201 && response.status !== 200 && response.status !== 405 && response.status !== 301) {
        throw new AppError('LIB_PATH_INVALID', `创建远端目录返回 ${response.status}`)
      }
    }
  }

  /** 本次运行已经确认存在的集合，避免每个文件都重复逐级 MKCOL。 */
  private readonly ensuredCollections = new Set<string>()

  /** 逐级创建目录；已建过的层级不再重复请求。 */
  async ensureCollection(relativePath: string): Promise<void> {
    const segments = relativePath.split('/').filter((segment) => segment.length > 0)
    let current = ''
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`
      if (this.ensuredCollections.has(current)) {
        continue
      }
      await this.createCollection(current)
      this.ensuredCollections.add(current)
    }
  }

  /** 确保某个文件路径的父集合存在（真实 WebDAV 不会自动创建父目录）。 */
  async ensureParentCollection(relativePath: string): Promise<void> {
    const index = relativePath.lastIndexOf('/')
    if (index <= 0) {
      return
    }
    await this.ensureCollection(relativePath.slice(0, index))
  }

  async list(relativePath: string): Promise<{ status: number; hrefs: string[] }> {
    const response = await this.raw({
      method: 'PROPFIND',
      relativePath,
      headers: { depth: '1', 'content-type': 'application/xml' },
      bodyText: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
      expectDav: true
    })
    if (response.status === 404) {
      return { status: 404, hrefs: [] }
    }
    const hrefs = [...response.text.matchAll(/<[^>]*href[^>]*>([^<]+)</gi)].map((match) =>
      decodeURIComponent(match[1]!.trim())
    )
    return { status: response.status, hrefs }
  }

  async putFile(relativePath: string, filePath: string): Promise<number> {
    const response = await this.raw({
      method: 'PUT',
      relativePath,
      bodyFile: filePath,
      headers: { 'content-type': 'application/octet-stream' },
      expectDav: true
    })
    if (response.status !== 201 && response.status !== 200 && response.status !== 204) {
      throw new AppError('APP_INTERNAL', `上传返回 ${response.status}`)
    }
    return response.status
  }

  async putText(relativePath: string, text: string): Promise<number> {
    const response = await this.raw({
      method: 'PUT',
      relativePath,
      bodyText: text,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      expectDav: true
    })
    if (response.status !== 201 && response.status !== 200 && response.status !== 204) {
      throw new AppError('APP_INTERNAL', `写入返回 ${response.status}`)
    }
    return response.status
  }

  /** 读取文本；404 返回 null。非 WebDAV 内容会抛出可识别错误。 */
  async getText(relativePath: string): Promise<string | null> {
    const response = await this.raw({ method: 'GET', relativePath, expectDav: true })
    if (response.status === 404) {
      return null
    }
    return response.text
  }

  /** 下载到本地文件并同时计算 SHA-256；404 返回 null。 */
  async downloadToFile(relativePath: string, targetPath: string): Promise<DownloadResult | null> {
    const response = await this.raw({
      method: 'GET',
      relativePath,
      downloadTo: targetPath,
      expectDav: true
    })
    if (response.status === 404) {
      return null
    }
    if (response.sha256 === null) {
      throw new AppError('APP_INTERNAL', '下载未产生内容')
    }
    return { status: response.status, sha256: response.sha256, bytes: response.bytes }
  }

  /** 删除远端文件；只允许删除本次运行自己写入的测试对象。 */
  async deleteFile(relativePath: string): Promise<boolean> {
    const response = await this.raw({ method: 'DELETE', relativePath, expectDav: true })
    return response.status !== 404
  }
}

export interface CapabilityItem {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

/**
 * 兼容探测：在用户指定的新建随机子目录里逐项测试（docs/sync-protocol.md §11）。
 * 不测试 MOVE/LOCK，因为它们不是首版必需能力。
 */
export async function probeCapabilities(
  client: DavClient,
  baseRelativePath: string
): Promise<CapabilityItem[]> {
  const items: CapabilityItem[] = []
  const prefix = baseRelativePath.replace(/^\/+|\/+$/g, '')
  const probeDir = `${prefix.length > 0 ? `${prefix}/` : ''}dav-probe-${Date.now().toString(36)}`

  const record = async (name: string, run: () => Promise<string>): Promise<void> => {
    try {
      items.push({ name, ok: true, detail: await run() })
    } catch (error) {
      items.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }

  await record('创建目录（MKCOL）', async () => {
    await client.ensureCollection(probeDir)
    return '可创建嵌套目录'
  })

  await record('列目录（PROPFIND Depth:1）', async () => {
    const result = await client.list(probeDir)
    if (result.status !== 207 && result.status !== 200) {
      throw new AppError('APP_INTERNAL', `返回 ${result.status}`)
    }
    return `返回 ${result.hrefs.length} 项`
  })

  await record('读写文件（PUT/GET）', async () => {
    const relative = `${probeDir}/probe.txt`
    const payload = 'steam-screenshot-manager probe'
    await client.putText(relative, payload)
    const readBack = await client.getText(relative)
    if (readBack !== payload) {
      throw new AppError('APP_INTERNAL', '读回内容与写入不一致')
    }
    await client.deleteFile(relative)
    return '写入、读回、删除均正常'
  })

  await record('中文与空格文件名', async () => {
    const relative = `${probeDir}/中文 名称 测试.txt`
    const payload = '中文与空格'
    await client.putText(relative, payload)
    const readBack = await client.getText(relative)
    if (readBack !== payload) {
      throw new AppError('APP_INTERNAL', '中文路径读回不一致')
    }
    await client.deleteFile(relative)
    return '中文与空格路径可用'
  })

  await record('确认无 MOVE 也能工作', async () => {
    return '上传管线只使用唯一路径，不依赖 MOVE/LOCK'
  })

  return items
}
