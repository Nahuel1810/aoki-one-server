import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReturnBoxDialog } from './ReturnBoxDialog'
import { makeSlot } from '@/test/factories'
import { renderWithQuery, stubFetch, type FetchCall } from '@/test/render'

const occupiedSlot = makeSlot({
  locationCode: '3X01AA1',
  status: 'OCUPADO',
  currentBox: { id: 'box-1', sourceLocationCode: '3X07AB2' },
})

/** Tiene un cajon encima pero el sistema no sabe de donde salio. */
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
  it('no encola nada con solo abrirse', () => {
    renderWithQuery(<ReturnBoxDialog slot={occupiedSlot} onClose={vi.fn()} />)

    expect(putCalls()).toHaveLength(0)
  })

  it('muestra el destino antes de confirmar', () => {
    renderWithQuery(<ReturnBoxDialog slot={occupiedSlot} onClose={vi.fn()} />)

    expect(screen.getByText('3X07AB2')).toBeInTheDocument()
  })

  it('con cajon en libros no manda targetLocation: lo resuelve el backend', async () => {
    const user = userEvent.setup()
    renderWithQuery(<ReturnBoxDialog slot={occupiedSlot} onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /guardar cajon/i }))

    await waitFor(() => {
      expect(putCalls()).toHaveLength(1)
    })
    expect(putCalls()[0]?.body).toEqual({
      type: 'PUT',
      origin: 'MANUAL',
      locationCode: '3X01AA1',
    })
  })

  it('sin cajon en libros pide el destino y lo manda', async () => {
    const user = userEvent.setup()
    renderWithQuery(<ReturnBoxDialog slot={slotWithoutBox} onClose={vi.fn()} />)

    const input = screen.getByLabelText(/a donde va/i)
    await user.type(input, '3x09ad1')
    await user.click(screen.getByRole('button', { name: /guardar cajon/i }))

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

    expect(screen.getByRole('button', { name: /guardar cajon/i })).toBeDisabled()
  })

  it('avisa al cerrar para que la vista limpie la seleccion', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderWithQuery(<ReturnBoxDialog slot={occupiedSlot} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: /cancelar/i }))

    expect(onClose).toHaveBeenCalled()
  })
})
