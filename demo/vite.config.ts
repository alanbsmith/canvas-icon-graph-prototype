import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Without this, if port 5173 is already taken (e.g. a leftover dev
    // server from an earlier session) Vite silently starts on the next free
    // port instead. That's a real problem here: the search-server's CORS
    // allowlist is hardcoded to http://localhost:5173, so a silent port
    // shift makes every API request fail with a confusing CORS error
    // instead of a clear "port already in use" message.
    strictPort: true,
  },
})
