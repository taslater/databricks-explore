import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { queryClient } from './api/queryClient'
import { restoreSession } from './api/restoreSession'
import { initTheme } from './theme'
import './index.css'

initTheme()

// Reconnect to the last profile and warehouse. Runs in the background; the UI renders immediately.
void restoreSession(queryClient)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
