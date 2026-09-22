import { Plus, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { useDevices, useRobots } from '@/api/queries'
import type { Device, Robot } from '@/api/schemas'
import { EmptyPanel, ErrorPanel, LoadingPanel } from '@/components/feedback/LoadingPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { robotStatusLabel } from '@/design/status'
import { cn } from '@/lib/cn'
import { clockTime, timeAgo } from '@/lib/time'
import { DeviceFormSheet } from './DeviceFormSheet'

const DEVICE_LABEL: Record<Device['type'], string> = {
  CARRO: 'Carro',
  ELEVADOR: 'Elevador',
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('size-2.5 shrink-0 rounded-full', ok ? 'bg-ready' : 'bg-fault')}
    />
  )
}

function DeviceRow({ device, onConfigure }: { device: Device; onConfigure: () => void }) {
  const connected = device.status === 'CONNECTED'
  const seen = clockTime(device.lastSeen)

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-control border border-border bg-surface px-3 py-2.5">
      <span className="flex min-w-28 items-center gap-2 font-semibold">
        <StatusDot ok={connected} />
        {DEVICE_LABEL[device.type]}
      </span>

      <span className={cn('text-sm font-medium', connected ? 'text-ready-ink' : 'text-fault-ink')}>
        {connected ? 'Conectado' : 'Sin conexion'}
      </span>

      {/*
       * Lo que resuelve un problema de red es cuando fue la ultima respuesta.
       * La IP queda como dato secundario: se mira solo al configurar.
       */}
      <span className="text-sm text-ink-muted">
        Ultima respuesta {timeAgo(device.lastSeen)}
        {seen && <span className="ml-1 text-ink-subtle">({seen})</span>}
      </span>

      <span className="font-code text-sm text-ink-subtle">
        {device.host ?? 'sin IP'}:{device.port ?? '—'}
      </span>

      <Button
        variant="ghost"
        size="compact"
        className="ml-auto"
        onClick={onConfigure}
        aria-label={`Configurar ${DEVICE_LABEL[device.type]} del robot ${device.robotId}`}
      >
        <Settings2 aria-hidden />
        Configurar
      </Button>
    </li>
  )
}

function RobotCard({
  robot,
  devices,
  onConfigure,
}: {
  robot: Robot
  devices: Device[]
  onConfigure: (device: Device) => void
}) {
  const connected = devices.filter((device) => device.status === 'CONNECTED').length
  const total = devices.length
  const operational = total > 0 && connected === total

  return (
    <section className="grid gap-3 rounded-panel border border-border bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold">Robot {robot.id}</h2>
          <Badge tone={operational ? 'ready' : 'fault'}>
            {total === 0 ? 'Sin equipos' : operational ? 'Operativo' : 'Con problemas'}
          </Badge>
        </div>
        <span className="text-sm text-ink-muted">{robotStatusLabel(robot.status)}</span>
      </div>

      {devices.length === 0 ? (
        <EmptyPanel label="Sin equipos configurados" />
      ) : (
        <ul className="grid gap-2">
          {devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              onConfigure={() => {
                onConfigure(device)
              }}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Esta pantalla se abre para diagnosticar, no para configurar: quien entra
 * quiere saber si el robot esta respondiendo. El alta de equipos vive en un
 * panel, porque se hace una vez por instalacion y estaba ocupando un tercio
 * del espacio que corresponde al diagnostico.
 */
export function DispositivosRoute() {
  const robots = useRobots()
  const devices = useDevices()
  const [editing, setEditing] = useState<Device | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  function openSheet(device: Device | null) {
    setEditing(device)
    setSheetOpen(true)
  }

  const isPending = robots.isPending || devices.isPending
  const failed =
    (robots.isError && robots.data === undefined) || (devices.isError && devices.data === undefined)

  const byRobot = new Map<string, Device[]>()
  for (const device of devices.data ?? []) {
    byRobot.set(device.robotId, [...(byRobot.get(device.robotId) ?? []), device])
  }

  const robotList = robots.data ?? []

  return (
    <div className="grid content-start gap-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-extrabold tracking-tight">Equipos</h1>
        <Button
          variant="secondary"
          size="compact"
          onClick={() => {
            openSheet(null)
          }}
        >
          <Plus aria-hidden />
          Agregar equipo
        </Button>
      </div>

      {isPending ? (
        <LoadingPanel label="Cargando" />
      ) : failed ? (
        <ErrorPanel
          message={errorMessage(robots.error ?? devices.error)}
          onRetry={() => {
            void robots.refetch()
            void devices.refetch()
          }}
        />
      ) : robotList.length === 0 ? (
        <EmptyPanel label="No hay robots" hint="Agrega un equipo para que aparezca su robot." />
      ) : (
        <div className="grid gap-3">
          {robotList.map((robot) => (
            <RobotCard
              key={robot.id}
              robot={robot}
              // /api/devices es la lista completa; robot.devices es el respaldo.
              devices={byRobot.get(robot.id) ?? robot.devices}
              onConfigure={openSheet}
            />
          ))}
        </div>
      )}

      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <DeviceFormSheet
          key={editing?.id ?? 'nuevo'}
          device={editing}
          onDone={() => {
            setSheetOpen(false)
          }}
        />
      </Dialog>
    </div>
  )
}
