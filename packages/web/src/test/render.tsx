import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'

export function renderWithQuery(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

export type FetchCall = {
  url: string
  method: string
  body: unknown
  /** Nombres en minuscula, como los normaliza `Headers`. */
  headers: Record<string, string>
}

/**
 * Reemplaza `fetch` y registra lo que la app manda. Se mira el body enviado,
 * no el resultado, porque lo que importa es que la UI construya el pedido
 * correcto: del otro lado hay un robot que se mueve.
 */
export function stubFetch(): FetchCall[] {
  const calls: FetchCall[] = []

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })

    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) satisfies typeof fetch

  return calls
}
