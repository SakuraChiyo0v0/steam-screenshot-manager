/**
 * 应用更新里那些「不依赖 Electron」的判断：错误翻译、更新源选择。
 *
 * 单独放这里是为了能直接跑单测：electron-updater 只在主进程里用。
 */

/** electron-updater 报错里能翻译成中文的几类 */
export function friendlyUpdateError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  // 匹配时把 code 也算进来：electron-updater 有时只把 ETIMEDOUT 放在 code 上
  const haystack = `${message} ${typeof code === 'string' ? code : ''}`
  if (isNoReleaseError(error)) return '更新源上还没有可用的版本'
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(haystack)) {
    return '连不上更新服务器，检查一下网络或代理'
  }
  if (/ETIMEDOUT|TIMED_OUT|ESOCKETTIMEDOUT|timeout/i.test(haystack)) {
    return '连接更新服务器超时'
  }
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ECONNRESET/i.test(haystack)) {
    return '更新服务器拒绝了连接'
  }
  if (/\b403\b|rate limit/i.test(haystack)) return 'GitHub 暂时限制了访问，稍后再试'
  if (/sha512|checksum/i.test(haystack)) return '下载的安装包校验没通过，已丢弃'
  if (typeof code === 'string' && code.startsWith('ERR_UPDATER_')) return '检查或下载更新时出错，详情见日志'
  return '检查或下载更新时出错，详情见日志'
}

/** 仓库一个 Release 都没有：对用户来说就是「还没有更新」，不是失败。 */
export function isNoReleaseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (
    typeof code === 'string' &&
    (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
      code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
      code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /No published versions/i.test(message)
}

/**
 * 什么情况下接真实更新源。
 * - 工具模式（自检 / 各类验证入口）：不接，别让测试去问 GitHub
 * - 开发模式（没打包）：默认不接；设了 SSM_UPDATE_URL 就接这个地址，用来本机演练整条链路
 * - 打包后：走 electron-builder 写进 resources/app-update.yml 的 GitHub Releases
 */
export type UpdateSource =
  | { readonly kind: 'off' }
  | { readonly kind: 'github' }
  | { readonly kind: 'generic'; readonly url: string }

export function updateSource(input: {
  packaged: boolean
  toolMode: boolean
  env: Record<string, string | undefined>
}): UpdateSource {
  if (input.toolMode) return { kind: 'off' }
  const override = input.env['SSM_UPDATE_URL']?.trim()
  if (override) {
    // 只认 http(s)：这个地址是更新包的来源，别让别的协议混进来
    if (!/^https?:\/\//i.test(override)) return { kind: 'off' }
    return { kind: 'generic', url: override }
  }
  return input.packaged ? { kind: 'github' } : { kind: 'off' }
}
