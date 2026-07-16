import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/latin-300.css'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import App from './App'
import { ChartErrorBoundary } from './app/AppProviders'
import { markPerf } from './runtime/performance/perfMarks'

// 禁用浏览器默认右键菜单
document.addEventListener('contextmenu', (e) => e.preventDefault())

markPerf('app.boot.start')
markPerf('app.root.render.requested')

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ChartErrorBoundary>
      <App />
    </ChartErrorBoundary>
  </StrictMode>,
)
