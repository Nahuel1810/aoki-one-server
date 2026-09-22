import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { useCreatePutOrder } from '@/api/mutations'
import type { Slot } from '@/api/schemas'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/field'

/**
 * El formulario se monta por slot y se desmonta al cerrar: el estado se
 * reinicia solo, sin un efecto que lo limpie a mano.
 */
function ReturnBoxForm({ slot, onDone }: { slot: Slot; onDone: () => void }) {
  const createPut = useCreatePutOrder()
  const [target, setTarget] = useState('')

  // El sistema sabe de donde salio el cajon; solo hace falta preguntarlo
  // cuando no lo tiene registrado (RF12).
  const knownTarget = slot.currentBox?.sourceLocationCode ?? null
  const needsTarget = knownTarget === null
  const box = slot.currentBox?.sourceLocationCode
  const canConfirm = !createPut.isPending && (!needsTarget || target.trim().length > 0)

  return (
    <>
      <div className="mt-5 grid gap-4">
        {/*
         * El cajon se identifica por su ubicacion de origen, que es a donde
         * vuelve: mostrar "origen -> destino" seria el mismo codigo dos veces.
         */}
        <div className="grid justify-items-center gap-1 rounded-control border border-border bg-surface-sunken p-5">
          <span className="font-code text-3xl font-extrabold">{box ?? 'Sin identificar'}</span>
          {knownTarget && <span className="text-sm text-ink-muted">Vuelve a su lugar</span>}
        </div>

        {needsTarget && (
          <Field label="A donde va">
            {(props) => (
              <Input
                {...props}
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value.toUpperCase())
                }}
                placeholder="3X04AA1"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
              />
            )}
          </Field>
        )}

        {createPut.isError && (
          <p role="alert" className="text-sm font-semibold text-fault-ink">
            {errorMessage(createPut.error)}
          </p>
        )}
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">Cancelar</Button>
        </DialogClose>
        <Button
          variant="danger"
          disabled={!canConfirm}
          onClick={() => {
            createPut.mutate(
              {
                slotLocationCode: slot.locationCode,
                // Si el sistema sabe de donde salio el cajon, el destino lo
                // resuelve el backend: mandarlo desde aca seria pisarlo (RF12).
                ...(needsTarget ? { targetLocation: target } : {}),
              },
              { onSuccess: onDone },
            )
          }}
        >
          {createPut.isPending ? 'Enviando…' : 'Guardar cajon'}
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * Confirmacion antes de guardar un cajon (RF06).
 *
 * En el front anterior un toque en cualquier parte del slot lo mandaba directo:
 * en una tablet, con la mano apoyada, eso mueve el carro por accidente.
 */
export function ReturnBoxDialog({ slot, onClose }: { slot: Slot | null; onClose: () => void }) {
  return (
    <Dialog
      open={slot !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader
          title="Guardar el cajon"
          description="El robot lo va a retirar y llevar a su lugar."
        />
        {slot && <ReturnBoxForm key={slot.locationCode} slot={slot} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  )
}
