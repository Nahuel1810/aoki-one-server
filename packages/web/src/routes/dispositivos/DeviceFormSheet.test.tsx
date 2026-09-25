import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { DeviceFormSheet } from './DeviceFormSheet'
import { MAINTENANCE_TOKEN_HEADER } from '@/api/client'
import { Dialog } from '@/components/ui/dialog'
import { renderWithQuery, stubFetch, type FetchCall } from '@/test/render'

let calls: FetchCall[]

beforeEach(() => {
  calls = stubFetch()
})

function abrirAlta() {
  renderWithQuery(
    <Dialog open>
      <DeviceFormSheet
        device={null}
        onDone={() => {
          /* el cierre del panel no es lo que se afirma aca */
        }}
      />
    </Dialog>,
  )
}

async function completarEquipo(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Robot'), '1')
  await user.type(screen.getByLabelText('IP'), '192.168.0.51')
}

/*
 * El agente exige el token de mantenimiento para dar de alta un equipo: esa
 * operacion decide a que PLC le obedece el robot. Sin el header el alta vuelve
 * 401, y el formulario tiene que resolverlo antes de mandar, no despues.
 */
describe('alta de equipo', () => {
  it('no deja mandar el alta sin token', async () => {
    const user = userEvent.setup()
    abrirAlta()

    await completarEquipo(user)

    // Con todo lo demas completo, lo unico que falta es el token.
    expect(screen.getByRole('button', { name: 'Agregar equipo' })).toBeDisabled()
  })

  it('el token viaja como header, no en el cuerpo', async () => {
    const user = userEvent.setup()
    abrirAlta()

    await completarEquipo(user)
    await user.type(screen.getByLabelText('Token de mantenimiento'), 'secreto-del-agente')
    await user.click(screen.getByRole('button', { name: 'Agregar equipo' }))

    const alta = calls.find(
      (call) => call.method === 'POST' && call.url === '/api/devices/register',
    )
    expect(alta?.headers[MAINTENANCE_TOKEN_HEADER]).toBe('secreto-del-agente')

    // En el cuerpo solo va el equipo. El token en el body terminaria en los
    // logs de quien loguee requests, y el agente ni lo mira ahi.
    expect(alta?.body).toEqual({
      robotId: '1',
      type: 'CARRO',
      host: '192.168.0.51',
      port: 502,
    })
  })

  it('el campo del token no se muestra ni se autocompleta', () => {
    abrirAlta()

    const campo = screen.getByLabelText('Token de mantenimiento')
    expect(campo).toHaveAttribute('type', 'password')
    expect(campo).toHaveAttribute('autocomplete', 'off')
  })
})
