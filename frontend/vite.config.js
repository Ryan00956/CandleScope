import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'
import { realpathSync } from 'node:fs'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { resolve } from 'node:path'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:18080'
const devServerPort = Number(process.env.VITE_DEV_PORT || 15173)
const dependencyRoot = realpathSync(resolve(import.meta.dirname, 'node_modules'))
const replaySoakProjectionEnabled = process.env.VITE_REPLAY_SOAK_PROJECTION_ENABLED === '1'
// The upstream owns its keep-alive deadline (Uvicorn defaults to five seconds),
// while Vite has no authoritative view of that deadline. Reusing a socket at
// the close boundary can turn an otherwise safe API request into a bodyless
// proxy 500, so the development/preview proxy must use a fresh upstream
// connection for every request.
const proxyAgentOptions = { keepAlive: false, maxSockets: 32 }
const apiProxyAgent = new URL(apiProxyTarget).protocol === 'https:'
  ? new HttpsAgent(proxyAgentOptions)
  : new HttpAgent(proxyAgentOptions)
const buildApiProxy = () => ({
  '/api': {
    target: apiProxyTarget,
    // Keep the browser Origin so LIVE local-library access can reject LAN
    // pages even when the TCP peer is Vite on 127.0.0.1. Host may be rewritten
    // to the backend; Origin is not an authentication substitute, but it is
    // the browser identity the backend must see.
    changeOrigin: true,
    ws: true,
    agent: apiProxyAgent,
  },
})

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_DESKTOP_BUILD === '1' ? './' : '/',
  plugins: [react()],
  build: {
    rollupOptions: {
      ...(replaySoakProjectionEnabled
        ? { preserveEntrySignatures: 'strict' }
        : {}),
      input: {
        live: resolve(import.meta.dirname, 'index.html'),
        replay: resolve(import.meta.dirname, 'replay.html'),
        local: resolve(import.meta.dirname, 'local.html'),
        backtest: resolve(import.meta.dirname, 'backtest.html'),
        strategy: resolve(import.meta.dirname, 'strategy.html'), // canonical; local/backtest stay one release cycle
        ...(replaySoakProjectionEnabled
          ? {
              replaySoakProjection: resolve(
                import.meta.dirname,
                'scripts/replay-soak-projection.ts',
              ),
            }
          : {}),
      },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          // `@monaco-editor/react` also contains the word "react" in its path.
          // Keep this check before the generic React bucket so the editor stays
          // behind its lazy boundary instead of making the live shell preload it.
          if (id.includes('monaco-editor') || id.includes('@monaco-editor')) return 'vendor-editor'
          if (id.includes('react')) return 'vendor-react'
          if (id.includes('lightweight-charts')) return 'vendor-charts'
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
    // Git worktrees may share node_modules through a junction. Vite resolves
    // font assets to that junction's real path, so explicitly allow only the
    // frontend root and the resolved dependency root.
    fs: {
      allow: [import.meta.dirname, dependencyRoot],
    },
    proxy: buildApiProxy(),
  },
  preview: {
    host: '127.0.0.1',
    port: devServerPort,
    strictPort: true,
    proxy: buildApiProxy(),
  },
})
