import { defineConfig, devices } from '@playwright/test'

/**
 * La API se intercepta con `page.route` en vez de MSW: Playwright ya sabe
 * interceptar red sin service worker, archivo publico ni dependencia extra.
 *
 * El viewport es el de la tablet en landscape, que es donde esto corre de
 * verdad. Correr los e2e a 1280x800 y no al default del navegador es parte de
 * lo que se esta verificando.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: process.env['CI'] ? 'dot' : 'list',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, hasTouch: true },
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 5174',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
})
