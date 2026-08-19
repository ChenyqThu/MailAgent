import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import tailwind from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import baseConfig from '../../tailwind.config'

const frontend = path.resolve(__dirname, '../..')

// mockup 专用：复用主仓 tailwind 主题（token 一字不差），只把扫描范围换成本目录。
export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@shared': path.join(frontend, 'src/shared'),
      '@renderer': path.join(frontend, 'src/electron/renderer')
    }
  },
  css: {
    postcss: {
      plugins: [
        tailwind({
          ...baseConfig,
          content: [
            path.join(__dirname, 'index.html'),
            path.join(__dirname, '**/*.{ts,tsx}'),
            path.join(frontend, 'src/shared/**/*.{ts,tsx}')
          ]
        }),
        autoprefixer()
      ]
    }
  },
  plugins: [react()],
  server: { port: 5200, strictPort: true }
})
