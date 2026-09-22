import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { useMetrics } from '@/api/queries'
import type { MetricsReport } from '@/api/schemas'
import { EmptyPanel, ErrorPanel, LoadingPanel } from '@/components/feedback/LoadingPanel'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/time'
import {
  PRESETS,
  endOfDay,
  formatRange,
  parseInputValue,
  rangeFromPreset,
  startOfDay,
  toInputValue,
  type PresetId,
  type Range,
} from './range'

function Kpi({
  label,
  value,
  note,
  tone = 'brand',
}: {
  label: string
  value: string
  note?: string
  tone?: 'brand' | 'fault'
}) {
  return (
    <article className="relative grid content-start gap-0.5 overflow-hidden rounded-panel border border-border bg-surface p-4 shadow-card">
      <span
        aria-hidden
        className={cn(
          'absolute inset-x-0 top-0 h-1.5',
          tone === 'fault' ? 'bg-fault' : 'bg-brand-500',
        )}
      />
      <h2 className="mt-1 text-xs font-bold tracking-wide text-ink-muted uppercase">{label}</h2>
      <p
        className={cn(
          'font-code text-4xl font-extrabold',
          tone === 'fault' ? 'text-fault-ink' : 'text-brand-800',
        )}
      >
        {value}
      </p>
      {note && <p className="text-xs text-ink-subtle">{note}</p>}
    </article>
  )
}

/** Dato de contexto: no merece una tarjeta propia, pero suma al leer. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-2 last:border-0">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="font-code font-bold">{value}</dd>
    </div>
  )
}

function LocationRanking({ report }: { report: MetricsReport }) {
  const [showAll, setShowAll] = useState(false)
  const rows = report.byLocation
  const LIMIT = 12

  if (rows.length === 0) {
    return <EmptyPanel label="No hay pedidos en estas fechas" />
  }

  const max = Math.max(...rows.map((row) => row.total))
  const visible = showAll ? rows : rows.slice(0, LIMIT)

  return (
    <div className="grid gap-3">
      <ul className="grid gap-1.5">
        {visible.map((row) => (
          <li
            key={row.locationCode}
            className="grid grid-cols-[7rem_minmax(0,1fr)_4rem] items-center gap-3 rounded-control border border-border bg-surface px-3 py-2 shadow-sm"
          >
            <span className="font-code font-bold">{row.locationCode}</span>
            <span className="h-2 overflow-hidden rounded-full bg-surface-muted">
              <span
                className="block h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600"
                style={{ width: `${String(Math.round((row.total / max) * 100))}%` }}
              />
            </span>
            <span className="text-right text-sm text-ink-muted">
              {row.total.toLocaleString('es-AR')}
            </span>
          </li>
        ))}
      </ul>

      {rows.length > LIMIT && (
        <Button
          variant="secondary"
          size="compact"
          className="justify-self-start"
          onClick={() => {
            setShowAll((value) => !value)
          }}
        >
          {showAll ? 'Mostrar menos' : `Ver los ${String(rows.length)}`}
        </Button>
      )}
    </div>
  )
}

export function MetricasRoute() {
  const [preset, setPreset] = useState<PresetId | null>('7d')
  const [range, setRange] = useState<Range>(() => rangeFromPreset('7d', new Date()))
  const report = useMetrics(range.from, range.to, true)

  function applyPreset(id: PresetId) {
    setPreset(id)
    setRange(rangeFromPreset(id, new Date()))
  }

  function applyManual(which: 'from' | 'to', value: string) {
    const date = parseInputValue(value)
    if (!date) return

    setPreset(null)
    setRange((current) =>
      which === 'from'
        ? { ...current, from: startOfDay(date) }
        : { ...current, to: endOfDay(date) },
    )
  }

  const summary = report.data?.summary

  return (
    <div className="grid content-start gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-extrabold tracking-tight">Metricas</h1>
        <p className="text-sm text-ink-muted">{formatRange(range)}</p>
      </div>

      {/*
       * Presets y fechas en una sola fila: apilados empujaban el ranking fuera
       * de la pantalla y obligaban a scrollear para ver los datos.
       */}
      <section className="flex flex-wrap items-end gap-3 rounded-panel border border-border bg-surface p-4 shadow-card">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(({ id, label }) => (
            <Button
              key={id}
              variant={preset === id ? 'primary' : 'secondary'}
              size="compact"
              onClick={() => {
                applyPreset(id)
              }}
              aria-pressed={preset === id}
            >
              {label}
            </Button>
          ))}
        </div>

        <span aria-hidden className="mb-3 hidden h-6 w-px bg-border sm:block" />

        <div className="flex min-w-0 flex-1 flex-wrap gap-3">
          <div className="min-w-44 flex-1">
            <Label htmlFor="range-from">Desde</Label>
            <Input
              id="range-from"
              className="mt-1.5"
              type="date"
              value={toInputValue(range.from)}
              onChange={(event) => {
                applyManual('from', event.target.value)
              }}
            />
          </div>
          <div className="min-w-44 flex-1">
            <Label htmlFor="range-to">Hasta</Label>
            <Input
              id="range-to"
              className="mt-1.5"
              type="date"
              value={toInputValue(range.to)}
              onChange={(event) => {
                applyManual('to', event.target.value)
              }}
            />
          </div>
        </div>
      </section>

      {report.isPending ? (
        <LoadingPanel label="Cargando metricas" />
      ) : report.isError && report.data === undefined ? (
        <ErrorPanel
          message={errorMessage(report.error)}
          onRetry={() => {
            void report.refetch()
          }}
        />
      ) : (
        <>
          {/*
           * Arriba, lo que mide si el sistema cumple su proposito: cuantos
           * pedidos se atendieron y cuanto esperó quien vino a buscarlos.
           * El desglose va abajo, como contexto.
           */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              label="Pedidos completados"
              value={(summary?.totalOrders ?? 0).toLocaleString('es-AR')}
            />
            <Kpi
              label="Espera promedio"
              value={formatDuration(summary?.avgTimeToSlotMs ?? 0)}
              note="desde el pedido hasta el cajon en el lugar"
            />
            <Kpi label="Espera mas larga" value={formatDuration(summary?.maxTimeToSlotMs ?? 0)} />
            <Kpi
              label="Pedidos con error"
              value={(summary?.failedOrders ?? 0).toLocaleString('es-AR')}
              tone={(summary?.failedOrders ?? 0) > 0 ? 'fault' : 'brand'}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <section className="grid content-start gap-2.5 rounded-panel border border-border bg-surface p-4 shadow-card">
              <h2 className="text-base font-bold">Cajones mas pedidos</h2>
              <LocationRanking report={report.data} />
            </section>

            <section className="grid content-start gap-1 rounded-panel border border-border bg-surface p-4 shadow-card">
              <h2 className="mb-1 text-base font-bold">Desglose</h2>
              <dl className="grid">
                <Stat
                  label="Desde picking"
                  value={(summary?.pickingOrders ?? 0).toLocaleString('es-AR')}
                />
                <Stat
                  label="Manuales"
                  value={(summary?.manualOrders ?? 0).toLocaleString('es-AR')}
                />
                <Stat
                  label="Movimientos del robot"
                  value={(summary?.totalManoeuvres ?? 0).toLocaleString('es-AR')}
                />
                <Stat
                  label="Movimientos por pedido"
                  value={(summary?.manoeuvresPerOrder ?? 0).toLocaleString('es-AR', {
                    maximumFractionDigits: 1,
                  })}
                />
                {/* Si la espera es casi toda turno, el cuello no es el robot. */}
                <Stat
                  label="De la espera, en turno"
                  value={formatDuration(summary?.avgQueueMs ?? 0)}
                />
              </dl>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
