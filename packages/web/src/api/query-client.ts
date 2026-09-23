import { QueryClient } from '@tanstack/react-query'
import { ContractError } from './client'

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /*
         * Backoff exponencial con techo (RF21). Un contrato roto no se
         * reintenta: reintentar no lo va a arreglar y solo retrasa el error.
         */
        retry: (failureCount, error) => !(error instanceof ContractError) && failureCount < 3,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),

        // Al volver a la tablet, lo primero que se ve tiene que estar fresco.
        refetchOnWindowFocus: true,

        /*
         * Ante un fallo de refresco se conserva en pantalla el ultimo dato
         * bueno y el aviso de conexion avisa que esta desactualizado. Vaciar
         * el tablero seria peor: el operario se queda sin referencia.
         */
        placeholderData: <T>(previous: T) => previous,
      },
      mutations: {
        retry: false,
      },
    },
  })
}
