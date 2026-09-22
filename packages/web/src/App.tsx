import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useState } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { createQueryClient } from '@/api/query-client'
import { AppShell } from '@/components/layout/AppShell'
import { LoadingPanel } from '@/components/feedback/LoadingPanel'
import { PickeoRoute } from '@/routes/pickeo/PickeoRoute'
import { DispositivosRoute } from '@/routes/dispositivos/DispositivosRoute'

// Metricas va en su propio chunk: no se abre en la operacion diaria.
const MetricasRoute = lazy(async () => {
  const mod = await import('@/routes/metricas/MetricasRoute')
  return { default: mod.MetricasRoute }
})

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <PickeoRoute /> },
      { path: 'dispositivos', element: <DispositivosRoute /> },
      {
        path: 'metricas',
        element: (
          <Suspense fallback={<LoadingPanel label="Cargando metricas" />}>
            <MetricasRoute />
          </Suspense>
        ),
      },
      { path: '*', element: <PickeoRoute /> },
    ],
  },
])

export function App() {
  // Una sola instancia por vida de la app, no una por render.
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
