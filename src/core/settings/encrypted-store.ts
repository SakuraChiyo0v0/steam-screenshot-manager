/**
 * 加密的本地密钥存储。
 *
 * 使用 Electron 的 safeStorage（Windows 走 DPAPI）加密后写到用户数据目录的
 * `credentials/` 下，一个名字一个文件。**不做明文回退**：加密不可用时直接报错，
 * 让用户知道当前环境无法安全保存，而不是悄悄把密钥写成明文。
 *
 * 目前两类内容用它：WebDAV 帐号密码、Steam Web API Key。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { AppError } from '@shared/errors'

const ENCRYPTED_DIR = 'credentials'

/** 名称只用安全字符，避免路径穿越。 */
export function encryptedFilePath(dataDir: string, name: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(name)) {
    throw new AppError('IPC_INVALID_INPUT', '密钥名称非法')
  }
  return join(dataDir, ENCRYPTED_DIR, `${name}.bin`)
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 加密写入；先写临时文件再改名，避免中途失败留下半个文件。 */
export function saveEncrypted(dataDir: string, name: string, payload: string): void {
  if (!isEncryptionAvailable()) {
    throw new AppError('APP_INTERNAL', '当前系统无法安全加密保存密钥，已拒绝以明文写入')
  }
  const file = encryptedFilePath(dataDir, name)
  mkdirSync(join(dataDir, ENCRYPTED_DIR), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, safeStorage.encryptString(payload))
  renameSync(temporary, file)
}

/** 读取并解密；不存在或解密失败都返回 null（换机器、DPAPI 失效属于正常情况）。 */
export function loadEncrypted(dataDir: string, name: string): string | null {
  const file = encryptedFilePath(dataDir, name)
  if (!existsSync(file)) {
    return null
  }
  try {
    return safeStorage.decryptString(readFileSync(file))
  } catch {
    return null
  }
}

export function deleteEncrypted(dataDir: string, name: string): void {
  rmSync(encryptedFilePath(dataDir, name), { force: true })
}
