import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReturnBoxDialog } from './ReturnBoxDialog'
import { makeSlot } from '@/test/factories'
import { renderWithQuery, stubFetch, type FetchCall } from '@/test/render'

/**
 * Este dialogo solo aparece cuando el sistema no sabe de donde salio el cajon.
 * El caso normal no pasa por aca: tocar un cajon lo manda a guardar directo.
 */
const slotWithoutBox = makeSlot({
  locationCode: '3X01AA2',
  status: 'OCUPADO',
  currentBox: null,
})

let calls: FetchCall[]

beforeEach(() => {
  calls = stubFetch()
})

function putCalls(): FetchCall[] {
  return calls.filter((call) => call.method === 'POST' && call.url === '/api/orders')
}

describe('ReturnBoxDialog', () => {
  it('no manda nada con solo abrirse', () => {
    renderWithQuery(<ReturnBoxDialog slot={slotWithoutBox} onClose={vi.fn()} />)

    expect(putCalls()).toHaveLength(0)
  })

  it('pide el destino y lo manda', async () => {
    const user = userEvent.setup()
    renderWithQuery(<ReturnBoxDialog slot={slotWithoutBox} onClose={vi.fn()} />)

    await user.type(screen.getByLabelText(/ubicación del cajón/i), '3x09ad1')
    await user.click(screen.getByRole('button', { name: /guardar cajón/i }))

    await waitFor(() => {
      expect(putCalls()).toHaveLength(1)
    })
    expect(putCalls()[0]?.body).toEqual({
      type: 'PUT',
      origin: 'MANUAL',
      locationCode: '3X01AA2',
      targetLocation: '3X09AD1',
    })
  })

  it('sin destino no deja confirmar', () => {
    renderWithQuery(<ReturnBoxDialog slot={slotWithoutBox} onClose={vi.fn()} />)

    expect(screen.getByRole('button', { name: /guardar cajón/i })).toBeDisabled()
  })

  it('no se abre cuando no hay slot', () => {
    renderWithQuery(<ReturnBoxDialog slot={null} onClose={vi.fn()} />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('avisa al cerrar para que la vista limpie la seleccion', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderWithQuery(<ReturnBoxDialog slot={slotWithoutBox} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: /cancelar/i }))

    expect(onClose).toHaveBeenCalled()
  })
})
