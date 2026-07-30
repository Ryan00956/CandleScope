import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { resolve } from 'node:path'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:18080'
const devServerPort = Number(process.env.VITE_DEV_PORT || 15173)
const proxyAgentOptions = { keepAlive: true, maxFreeSockets: 8, maxSockets: 32 }
const apiProxyAgent = new URL(apiProxyTarget).protocol === 'https:'
  ? new HttpsAgent(proxyAgentOptions)
  : new HttpAgent(proxyAgentOptions)
const buildApiProxy = () => ({
  '/api': {
    target: apiProxyTarget,
    changeOrigin: true,
    ws: true,
    agent: apiProxyAgent,
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        live: resolve(import.meta.dirname, 'index.html'),
        replay: resolve(import.meta.dirname, 'replay.html'),
      },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react')) return 'vendor-react'
          if (id.includes('lightweight-charts')) return 'vendor-charts'
          if (id.includes('monaco-editor') || id.includes('@monaco-editor')) return 'vendor-editor'
          if (id.includes('html-to-image')) return 'vendor-export'
          return 'vendor'
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: devServerPort,
    strictPort: true,
    proxy: buildApiProxy(),
  },
  preview: {
    host: '127.0.0.1',
    port: devServerPort,
    strictPort: true,
    proxy: buildApiProxy(),
  },
})
