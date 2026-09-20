import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 使用 .mts 扩展名：本项目不使用 "type": "module"（沙箱化的 preload 需要 CommonJS），
// 测试配置因此单独以 ESM 形式声明，避免 Vite 的 configLoader 告警。
// ESM 下没有 __dirname，使用 import.meta.dirname（Node 20.11+）。
const projectRoot = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(projectRoot, 'src/shared'),
      '@core': resolve(projectRoot, 'src/core')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 测试只覆盖纯逻辑与数据库行为，不启动 Electron 运行时。
    // 渲染层越权访问的验证方式见 design.md 的 D7。
    passWithNoTests: false
  }
})
