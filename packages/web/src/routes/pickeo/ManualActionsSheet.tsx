import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { useCreatePickOrder, useCreatePutOrder, useReleaseSlot } from '@/api/mutations'
import type { Slot } from '@/api/schemas'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Sheet,
} from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Cada accion es una fila: control a la izquierda, boton a la derecha.
 * Puestos uno debajo del otro, las tres acciones no entraban sin scroll en la
 * tablet, y el panel se usa de pie: si hay que scrollear, se usa mal.
 */
function Action({
  title,
  children,
  action,
  feedback,
}: {
  title: string
  children: React.ReactNode
  action: React.ReactNode
  feedback?: React.ReactNode
}) {
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        {action}
      </div>
      {feedback}
    </section>
  )
}

function Feedback({ error, ok }: { error: unknown; ok: string | null }) {
  if (error) {
    return (
      <p role="alert" className="text-sm font-semibold text-fault-ink">
        {errorMessage(error)}
      </p>
    )
  }
  if (ok) {
    return (
      <p role="status" className="text-sm font-semibold text-online">
        {ok}
      </p>
    )
  }
  return null
}

/** Un cajón se identifica por su ubicación de origen. */
function slotOptionLabel(slot: Slot): string {
  return slot.currentBox?.sourceLocationCode ?? 'Cajón sin identificar'
}

function PickForm() {
  const [code, setCode] = useState('')
  const createPick = useCreatePickOrder()

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        createPick.mutate(
          { locationCode: code },
          {
            onSuccess: () => {
              setCode('')
            },
          },
        )
      }}
    >
      <Action
        title="Pedir un cajón"
        action={
          <Button type="submit" disabled={createPick.isPending || code.trim().length === 0}>
            {createPick.isPending ? 'Enviando…' : 'Pedir'}
          </Button>
        }
        feedback={
          <Feedback
            error={createPick.error}
            ok={createPick.isSuccess ? 'El robot ya lo está buscando.' : null}
          />
        }
      >
        <Label htmlFor="pick-code" className="sr-only">
          Ubicación del cajón
        </Label>
        <Input
          id="pick-code"
          required
          value={code}
          onChange={(event) => {
            setCode(event.target.value.toUpperCase())
          }}
          placeholder="3X02AE2"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
      </Action>
    </form>
  )
}

function ManualPutForm({ slots }: { slots: Slot[] }) {
  const [slotCode, setSlotCode] = useState('')
  const [target, setTarget] = useState('')
  const createPut = useCreatePutOrder()

  /*
   * Solo se ofrecen cajones reales. El backend tambien acepta guardar desde un
   * lugar vacío (un cajón que alguien apoyo sin que el sistema lo sepa), pero
   * listar once opciones identicas que dicen "Lugar vacío" no deja elegir
   * ninguna: para ese caso esta el tablero.
   */
  const candidates = slots.filter((slot) => slot.status === 'OCUPADO')
  const selected = candidates.find((slot) => slot.locationCode === slotCode)
  const knownTarget = selected?.currentBox?.sourceLocationCode ?? null
  // Solo se pregunta el destino si el sistema no sabe de donde salio (RF12).
  const needsTarget = selected !== undefined && knownTarget === null

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!selected) return

        createPut.mutate(
          {
            slotLocationCode: selected.locationCode,
            targetLocation: needsTarget ? target : (knownTarget ?? ''),
          },
          {
            onSuccess: () => {
              setSlotCode('')
              setTarget('')
            },
          },
        )
      }}
    >
      <Action
        title="Guardar un cajón"
        action={
          <Button
            type="submit"
            disabled={
              !selected || createPut.isPending || (needsTarget && target.trim().length === 0)
            }
          >
            {createPut.isPending ? 'Enviando…' : 'Guardar'}
          </Button>
        }
        feedback={
          <>
            {selected && !needsTarget && (
              <p className="text-sm text-ink-muted">
                Vuelve a <span className="font-code font-bold text-ink">{knownTarget}</span>
              </p>
            )}
            {needsTarget && (
              <div className="grid gap-1.5">
                <Label htmlFor="put-target">A dónde va</Label>
                <Input
                  id="put-target"
                  required
                  value={target}
                  onChange={(event) => {
                    setTarget(event.target.value.toUpperCase())
                  }}
                  placeholder="3X04AA1"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </div>
            )}
            <Feedback
              error={createPut.error}
              ok={createPut.isSuccess ? 'El robot ya lo está guardando.' : null}
            />
          </>
        }
      >
        <Label htmlFor="manual-put-slot" className="sr-only">
          Cajón a guardar
        </Label>
        <Select value={slotCode} onValueChange={setSlotCode} disabled={candidates.length === 0}>
          <SelectTrigger id="manual-put-slot">
            <SelectValue placeholder={candidates.length === 0 ? 'No hay cajones' : 'Elegir…'} />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((slot) => (
              <SelectItem key={slot.locationCode} value={slot.locationCode}>
                {slotOptionLabel(slot)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Action>
    </form>
  )
}

function ReleaseSlotForm({ slots }: { slots: Slot[] }) {
  const [slotCode, setSlotCode] = useState('')
  const [confirming, setConfirming] = useState(false)
  const release = useReleaseSlot()

  const occupied = slots.filter((slot) => slot.status === 'OCUPADO')
  const selected = occupied.find((slot) => slot.locationCode === slotCode)

  return (
    <Action
      title="Corregir un lugar"
      action={
        <Button
          variant="danger"
          disabled={slotCode.length === 0 || release.isPending}
          onClick={() => {
            setConfirming(true)
          }}
        >
          Vaciar
        </Button>
      }
      feedback={
        <>
          <Feedback error={release.error} ok={release.isSuccess ? 'Listo.' : null} />

          <Dialog open={confirming} onOpenChange={setConfirming}>
            <DialogContent>
              <DialogHeader
                title={`Vaciar ${selected ? slotOptionLabel(selected) : 'el lugar'}`}
                description="El robot no se mueve. Si el cajón sigue apoyado ahí, el sistema deja de saberlo."
              />
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Cancelar</Button>
                </DialogClose>
                <Button
                  variant="danger"
                  onClick={() => {
                    release.mutate(slotCode, {
                      onSuccess: () => {
                        setConfirming(false)
                        setSlotCode('')
                      },
                    })
                  }}
                >
                  Vaciar
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      }
    >
      <Label htmlFor="release-slot" className="sr-only">
        Cajón que ya no está
      </Label>
      <Select value={slotCode} onValueChange={setSlotCode} disabled={occupied.length === 0}>
        <SelectTrigger id="release-slot">
          <SelectValue placeholder={occupied.length === 0 ? 'No hay cajones' : 'Elegir…'} />
        </SelectTrigger>
        <SelectContent>
          {occupied.map((slot) => (
            <SelectItem key={slot.locationCode} value={slot.locationCode}>
              {slotOptionLabel(slot)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Action>
  )
}

/**
 * Acciones que no son de rutina (RF10-RF11): van detras de un toque porque el
 * flujo normal entra por la app de picking.
 */
export function ManualActionsSheet({ slots }: { slots: Slot[] }) {
  return (
    <Sheet title="Pedir o guardar">
      <div className="divide-y divide-border [&>*]:py-5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        <PickForm />
        <ManualPutForm slots={slots} />
        <ReleaseSlotForm slots={slots} />
      </div>
    </Sheet>
  )
}
