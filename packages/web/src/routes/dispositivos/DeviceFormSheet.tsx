import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { useRegisterDevice } from '@/api/mutations'
import type { Device } from '@/api/schemas'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/dialog'
import { Field, Input, Label } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type DeviceType = 'CARRO' | 'ELEVADOR'

/**
 * Alta y edicion de un equipo.
 *
 * Vive en un panel y no en la pantalla: configurar un PLC se hace una vez por
 * instalacion, y ese formulario se estaba llevando un tercio del espacio que
 * corresponde al diagnostico.
 *
 * El backend hace upsert por (robotId, type), asi que editar es registrar de
 * nuevo con los mismos identificadores.
 *
 * Pide el token de mantenimiento del agente cada vez y no lo guarda: ni en
 * localStorage —la tablet es compartida— ni en el build, que es el JS que se le
 * sirve a cualquiera en la LAN. Configurar un equipo es algo que se hace una vez
 * por instalacion; tipear el token no es friccion, dejarlo a mano si.
 */
export function DeviceFormSheet({ device, onDone }: { device: Device | null; onDone: () => void }) {
  const register = useRegisterDevice()
  const [robotId, setRobotId] = useState(device?.robotId ?? '')
  const [type, setType] = useState<DeviceType>(device?.type ?? 'CARRO')
  const [host, setHost] = useState(device?.host ?? '')
  const [port, setPort] = useState(String(device?.port ?? 502))
  const [token, setToken] = useState('')

  const isEdit = device !== null
  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535
  const canSubmit =
    robotId.trim().length > 0 &&
    host.trim().length > 0 &&
    portValid &&
    token.trim().length > 0 &&
    !register.isPending

  return (
    <Sheet title={isEdit ? `Configurar ${device.type.toLowerCase()}` : 'Agregar equipo'}>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          register.mutate(
            {
              robotId: robotId.trim(),
              type,
              host: host.trim(),
              port: portNumber,
              maintenanceToken: token.trim(),
            },
            { onSuccess: onDone },
          )
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Robot">
            {(props) => (
              <Input
                {...props}
                required
                value={robotId}
                onChange={(event) => {
                  setRobotId(event.target.value)
                }}
                placeholder="1"
                inputMode="numeric"
                autoComplete="off"
                readOnly={isEdit}
              />
            )}
          </Field>

          <div className="grid gap-2">
            <Label htmlFor="device-type">Tipo</Label>
            <Select
              value={type}
              onValueChange={(value) => {
                setType(value as DeviceType)
              }}
              disabled={isEdit}
            >
              <SelectTrigger id="device-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CARRO">Carro</SelectItem>
                <SelectItem value="ELEVADOR">Elevador</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <Field label="IP">
            {(props) => (
              <Input
                {...props}
                required
                value={host}
                onChange={(event) => {
                  setHost(event.target.value)
                }}
                placeholder="192.168.0.50"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>

          <Field label="Puerto" error={port.length > 0 && !portValid ? 'Invalido' : undefined}>
            {(props) => (
              <Input
                {...props}
                required
                value={port}
                onChange={(event) => {
                  setPort(event.target.value)
                }}
                inputMode="numeric"
                autoComplete="off"
              />
            )}
          </Field>
        </div>

        <Field
          label="Token de mantenimiento"
          hint="El que figura en la configuración del agente. No se guarda."
        >
          {(props) => (
            <Input
              {...props}
              required
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value)
              }}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>

        <Button type="submit" disabled={!canSubmit} block>
          {register.isPending ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Agregar equipo'}
        </Button>

        {register.isError && (
          <p role="alert" className="text-sm font-semibold text-fault-ink">
            {errorMessage(register.error)}
          </p>
        )}
      </form>
    </Sheet>
  )
}
