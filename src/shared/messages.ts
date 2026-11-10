/**
 * 把错误码翻成人话。
 *
 * 界面以前直接显示 `DAV_PATH_INVALID：远端路径不可用：创建目录返回 404…`：
 * 错误码、技术细节全糊在一起，用户既看不懂也不知道下一步该干嘛。
 * 这里给每个错误码一句"是什么"和一句"怎么办"；原始细节保留在后面，方便排查。
 */

export interface HumanError {
  /** 一句话说清发生了什么 */
  readonly title: string
  /** 下一步该做什么 */
  readonly hint: string
  /** 原始细节（可能为空） */
  readonly detail: string
}

const MESSAGES: Record<string, { title: string; hint: string }> = {
  DAV_AUTH: {
    title: '远端账号或密码不对',
    hint: '检查用户名和应用专用密码；有些 NAS 需要单独开 WebDAV 账号。'
  },
  DAV_FORBIDDEN: {
    title: '远端不允许写入',
    hint: '换一个目录，或在 NAS 上给这个账号开该共享目录的写权限。'
  },
  DAV_PATH_INVALID: {
    title: '远端这个路径用不了',
    hint: '用「浏览」直接选一个能写的目录，别手写路径。'
  },
  DAV_TIMEOUT: {
    title: '连不上远端',
    hint: '确认 NAS 在线、地址和端口正确；外网请检查中继或端口转发。'
  },
  DAV_NOT_WEBDAV: {
    title: '这个地址不是 WebDAV 入口',
    hint: '地址要填到 WebDAV 的实际入口，例如 http://<NAS>:<端口>/webdav/<目录>。'
  },
  DAV_REDIRECT_REJECTED: {
    title: '远端把请求跳到了别的站点',
    hint: '为了不让密码外泄，应用拒绝了这次跳转；换成直连地址再试。'
  },
  DAV_RATE_LIMIT: {
    title: '远端限流了',
    hint: '等一会儿再试；网盘类服务建议降低并发或改为夜间备份。'
  },
  DAV_CAPACITY: {
    title: '远端空间不足',
    hint: '清理远端，或换一个更大的目录作为备份目标。'
  },
  LIB_PATH_INVALID: {
    title: '这个目录不合适',
    hint: '图库目录不能和来源重叠，也不能指向应用自己的数据目录。'
  },
  LIB_HASH_MISMATCH: {
    title: '文件内容对不上',
    hint: '源文件可能正在被写入；重新扫描一次再归档。'
  },
  LIB_DISK_FULL: {
    title: '磁盘空间不足',
    hint: '清理本机磁盘，或把图库换到空间更大的盘。'
  },
  LIB_DB_CORRUPT: {
    title: '数据库读取失败',
    hint: '先关掉应用并备份 %APPDATA%\\steam-screenshot-manager，再重新打开。'
  },
  SRC_NOT_FOUND: {
    title: '来源文件找不到了',
    hint: '截图可能已被 Steam 或你手动删除；重新扫描会更新索引。'
  },
  SRC_UNREADABLE: {
    title: '来源目录读不了',
    hint: '检查目录权限，或确认网络盘还连着。'
  },
  SRC_VDF_PARSE: {
    title: 'Steam 的索引文件解析失败',
    hint: 'Steam 可能正在写文件；等它空闲后重新扫描。'
  },
  JOB_RUNNING: {
    title: '已经有任务在跑',
    hint: '在「任务」里看看进度，或者先把它停掉。'
  },
  IPC_INVALID_INPUT: {
    title: '填写的内容不合法',
    hint: '检查必填项与格式后重试。'
  },
  APP_INTERNAL: {
    title: '应用内部出错了',
    hint: '重试一次；如果反复出现，把这条信息连同操作步骤反馈给作者。'
  }
}

const CODE_PATTERN = /^([A-Z][A-Z0-9_]{3,40})[：:]([\s\S]*)$/

/** 从 "CODE：detail" 或裸错误码里认错误码。 */
export function splitErrorCode(raw: string): { code: string | null; detail: string } {
  const text = raw.trim()
  const match = CODE_PATTERN.exec(text)
  if (match) {
    return { code: match[1]!, detail: match[2]!.trim() }
  }
  if (MESSAGES[text]) {
    return { code: text, detail: '' }
  }
  return { code: null, detail: text }
}

/**
 * 把任意报错转成"是什么 + 怎么办 + 细节"。
 * 认不出的错误原样保留，不吞信息。
 */
export function humanizeError(raw: string): HumanError {
  const { code, detail } = splitErrorCode(raw)
  if (!code || !MESSAGES[code]) {
    return { title: detail || '出错了', hint: '', detail: '' }
  }
  const meta = MESSAGES[code]!
  return { title: meta.title, hint: meta.hint, detail }
}

/** 一行式的用户可见文案：优先说人话，细节放括号里。 */
export function describeError(raw: string): string {
  const human = humanizeError(raw)
  if (!human.hint && !human.detail) {
    return human.title
  }
  const parts = [human.title]
  if (human.hint) parts.push(human.hint)
  if (human.detail) parts.push(`（${human.detail}）`)
  return parts.join(' ')
}
