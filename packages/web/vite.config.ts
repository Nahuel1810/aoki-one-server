import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * El backend actual escucha en 3000 (hardcodeado en src/server.js).
 * En dev, Vite proxea la API para que el front consuma rutas relativas
 * igual que en produccion, donde el mismo Express sirve el build.
 */
const API_TARGET = process.env['AOKI_API_URL'] ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    // Lo sirve el mismo proceso Express (T14). Fuera de packages/ para que
    // el backend no tenga que conocer la estructura interna del front.
    outDir: '../../public-dist',
    emptyOutDir: true,
    sourcemap: true,
  },
})
