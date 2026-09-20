import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')
const core = resolve(__dirname, 'src/core')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared, '@core': core } },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // electron 必须保持外部依赖：它在运行时由 Electron 自身提供，
        // 若被打进产物，会连带 electron 包的 index.js（内含二进制下载逻辑）一起打包。
        external: ['electron'],
        // 主进程与预加载统一输出 CommonJS：
        // - sandbox: true 下的 preload 不被 Electron 支持为 ESM；
        // - package.json 的 main 指向 .js，需与产物扩展名一致。
        output: { format: 'cjs', entryFileNames: 'index.js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'index.js' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': shared } },
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
