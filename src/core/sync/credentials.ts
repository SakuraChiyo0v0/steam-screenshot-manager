/**
 * WebDAV 凭据的安全保存。
 *
 * 使用 Electron 的 safeStorage（Windows 走 DPAPI）加密后写入用户数据目录；
 * **不做明文回退**：加密不可用时报错，让用户知道当前环境无法安全保存密码。
 * 凭据不写数据库普通字段、不进日志、不进诊断包。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { AppError } from '@shared/errors'

export interface DavCredential {
  readonly username: string
  readonly password: string
}

const CREDENTIAL_DIR = 'credentials'

/** 凭据引用键只用安全字符，避免路径穿越。 */
function credentialFile(dataDir: string, ref: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(ref)) {
    throw new AppError('IPC_INVALID_INPUT', '凭据引用键非法')
  }
  return join(dataDir, CREDENTIAL_DIR, `${ref}.bin`)
}

export function isCredentialStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function saveCredential(dataDir: string, ref: string, credential: DavCredential): void {
  if (!isCredentialStorageAvailable()) {
    throw new AppError(
      'APP_INTERNAL',
      '当前系统无法安全加密保存密码，已拒绝以明文写入'
    )
  }
  const file = credentialFile(dataDir, ref)
  mkdirSync(join(dataDir, CREDENTIAL_DIR), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(credential))
  const temporary = `${file}.tmp`
  writeFileSync(temporary, encrypted)
  writeFileSync(file, encrypted)
  rmSync(temporary, { force: true })
}

export function loadCredential(dataDir: string, ref: string): DavCredential | null {
  // 空引用表示"这台设备当前没有绑定凭据"（例如刚断开），不是错误
  if (ref.length === 0) {
    return null
  }
  const file = credentialFile(dataDir, ref)
  if (!existsSync(file)) {
    return null
  }
  try {
    const decrypted = safeStorage.decryptString(readFileSync(file))
    const parsed: unknown = JSON.parse(decrypted)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as DavCredential).username === 'string' &&
      typeof (parsed as DavCredential).password === 'string'
    ) {
      return parsed as DavCredential
    }
    return null
  } catch {
    // 解密失败（换机器、DPAPI 失效）时按"没有凭据"处理，让用户重新输入
    return null
  }
}

export function deleteCredential(dataDir: string, ref: string): void {
  if (ref.length === 0) {
    return
  }
  rmSync(credentialFile(dataDir, ref), { force: true })
}
