import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: `npm run dev` serves on :5173 and forwards /api to the Flask server.
// Prod: `npm run build` writes web/dist, which Flask serves at /.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8765',
    },
  },
})
