import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.js'
import { ModalProvider } from './components/modal/ModalProvider.js'
import './style.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('apps/web: #root element is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    {/* WEB-15/WEB-16: one modal mounted once, for the whole app — see
        `ModalProvider.tsx`'s own module comment for why every screen
        shares this instead of mounting a dialog of its own. */}
    <ModalProvider>
      <App />
    </ModalProvider>
  </StrictMode>
)
