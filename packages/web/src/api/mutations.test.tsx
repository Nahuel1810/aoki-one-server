import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useCreatePutOrder } from './mutations'
import { renderWithQuery, stubFetch, type FetchCall } from '@/test/render'

let calls: FetchCall[]

beforeEach(() => {
  calls = stubFetch()
})

function GuardarCajon({ target }: { target: string }) {
  const createPut = useCreatePutOrder()

  return (
    <button
      type="button"
      onClick={() => {
        createPut.mutate({ slotLocationCode: '3X02AE1', targetLocation: target })
      }}
    >
      guardar
    </button>
  )
}

describe('useCreatePutOrder', () => {
  /*
   * Sin `targetLocation`, el backend resuelve la devolución contra el propio
   * slot de pickeo: el robot deja el cajón donde ya estaba, la orden termina
   * bien y el slot se marca libre con el cajón todavía encima. El destino
   * tiene que viajar siempre.
   */
  it('manda el destino de la devolución', async () => {
    const user = userEvent.setup()
    renderWithQuery(<GuardarCajon target="3X04AE1" />)

    await user.click(screen.getByRole('button', { name: 'guardar' }))

    const put = calls.find((call) => call.method === 'POST' && call.url === '/api/orders')
    expect(put?.body).toEqual({
      type: 'PUT',
      origin: 'MANUAL',
      locationCode: '3X02AE1',
      targetLocation: '3X04AE1',
    })
  })

  it('el destino nunca es el slot del que sale el cajón', async () => {
    const user = userEvent.setup()
    renderWithQuery(<GuardarCajon target="3X04AE1" />)

    await user.click(screen.getByRole('button', { name: 'guardar' }))

    const put = calls.find((call) => call.method === 'POST' && call.url === '/api/orders')
    const body = put?.body as { locationCode: string; targetLocation: string }
    expect(body.targetLocation).not.toBe(body.locationCode)
  })
})
