import { Pause, Play } from 'lucide-react'
import { useState } from 'react'
import { useToggleQueues } from '@/api/mutations'
import { useQueueStatus, useRobots } from '@/api/queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { cn } from '@/lib/cn'

/**
 * Estado del robot y control de marcha, en el header y siempre visible (RF09).
 *
 * Pausar no pide confirmacion: es la accion segura, detiene el robot.
 * Reanudar si la pide, porque vuelve a ponerlo en movimiento.
 */
export function SystemStatus() {
  const queues = useQueueStatus()
  const robots = useRobots()
  const toggle = useToggleQueues()
  const [confirmResume, setConfirmResume] = useState(false)

  const rows = queues.data ?? []
  const robotIds = [
    ...new Set([...(robots.data ?? []).map((r) => r.id), ...rows.map((r) => r.robotId)]),
  ].filter(Boolean)

  const hasRobots = robotIds.length > 0
  const paused = rows.length > 0 && rows.every((row) => row.paused)
  const pending = rows.reduce((total, row) => total + row.queueLength, 0)

  async function apply(nextPaused: boolean) {
    setConfirmResume(false)
    await toggle.mutateAsync({ robotIds, paused: nextPaused })
  }

  return (
    <div className="flex items-center gap-3">
      <div className="hidden items-center gap-2.5 rounded-full bg-white/10 py-1.5 pr-4 pl-3 sm:flex">
        <span
          aria-hidden
          className={cn(
            'size-2.5 rounded-full',
            paused ? 'bg-motion-border' : 'animate-activity bg-online-border',
          )}
        />
        <span className="text-sm font-bold text-white">{paused ? 'Pausado' : 'En marcha'}</span>
        {hasRobots && pending > 0 && (
          <span className="text-sm text-brand-100">
            · {pending} {pending === 1 ? 'pedido' : 'pedidos'}
          </span>
        )}
      </div>

      <Button
        variant="onDark"
        size="compact"
        disabled={!hasRobots || toggle.isPending}
        onClick={() => {
          if (paused) {
            setConfirmResume(true)
          } else {
            void apply(false)
          }
        }}
      >
        {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
        {paused ? 'Reanudar' : 'Pausar'}
      </Button>

      <Dialog open={confirmResume} onOpenChange={setConfirmResume}>
        <DialogContent>
          <DialogHeader
            title="Reanudar el robot"
            description="Va a retomar los pedidos pendientes y empezar a moverse. Verificá que la zona esté despejada."
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancelar</Button>
            </DialogClose>
            <Button onClick={() => void apply(true)} disabled={toggle.isPending}>
              Reanudar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
