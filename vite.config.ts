import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    root: 'apps/web',
    build: {
      outDir: '../../dist/web',
      emptyOutDir: true,
    },
    server: {
      host: '127.0.0.1',
      port: Number(process.env.WEB_PORT || env.WEB_PORT || 5173),
      proxy: {
        '/api': {
          target: `http://localhost:${process.env.PORT || env.PORT || 3000}`,
          changeOrigin: true,
        },
      },
    },
  }
})
