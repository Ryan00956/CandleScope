import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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
