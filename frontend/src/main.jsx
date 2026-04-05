import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// 禁用浏览器默认右键菜单
document.addEventListener('contextmenu', (e) => e.preventDefault())

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
