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
function AskTargetForm({ slot, onDone }: { slot: Slot; onDone: () => void }) {
  const createPut = useCreatePutOrder()
  const [target, setTarget] = useState('')

  return (
    <>
      <div className="mt-5">
        <Field label="Ubicación del cajón">
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

        {createPut.isError && (
          <p role="alert" className="mt-3 text-sm font-semibold text-fault-ink">
            {errorMessage(createPut.error)}
          </p>
        )}
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">Cancelar</Button>
        </DialogClose>
        <Button
          disabled={createPut.isPending || target.trim().length === 0}
          onClick={() => {
            createPut.mutate(
              { slotLocationCode: slot.locationCode, targetLocation: target },
              { onSuccess: onDone },
            )
          }}
        >
          {createPut.isPending ? 'Enviando…' : 'Guardar cajón'}
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * Solo aparece cuando el sistema no sabe de dónde salió el cajón.
 *
 * El caso normal no pasa por acá: tocar un cajón lo manda a guardar directo y
 * el pedido queda cancelable desde la lista. Acá se pregunta porque falta un
 * dato que el sistema no tiene de ninguna otra forma.
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
          title="¿A dónde va este cajón?"
          description="El sistema no tiene registrado de dónde salió, así que hay que indicarlo."
        />
        {slot && <AskTargetForm key={slot.locationCode} slot={slot} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  )
}
