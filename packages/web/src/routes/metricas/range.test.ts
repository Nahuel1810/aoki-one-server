import { describe, expect, it } from 'vitest'
import { endOfDay, parseInputValue, rangeFromPreset, startOfDay, toInputValue } from './range'

describe('parseInputValue', () => {
  it('interpreta la fecha en hora local', () => {
    const date = parseInputValue('2026-01-05')

    // `new Date('2026-01-05')` la tomaria como UTC y en Argentina (UTC-3)
    // caeria el 4 de enero. Ese corrimiento desplazaria todo el reporte un dia.
    expect(date?.getFullYear()).toBe(2026)
    expect(date?.getMonth()).toBe(0)
    expect(date?.getDate()).toBe(5)
  })

  it('rechaza valores incompletos', () => {
    expect(parseInputValue('')).toBeNull()
    expect(parseInputValue('2026-01')).toBeNull()
  })
})

describe('toInputValue', () => {
  it('va y vuelve sin perder el dia', () => {
    const original = '2026-03-09'
    const parsed = parseInputValue(original)

    expect(parsed).not.toBeNull()
    expect(toInputValue(parsed?.getTime() ?? 0)).toBe(original)
  })

  it('rellena mes y dia con cero', () => {
    expect(toInputValue(new Date(2026, 0, 5).getTime())).toBe('2026-01-05')
  })
})

describe('rangeFromPreset', () => {
  const today = new Date(2026, 8, 21)

  it('hoy cubre un solo dia completo', () => {
    const range = rangeFromPreset('hoy', today)

    expect(range.from).toBe(startOfDay(today))
    expect(range.to).toBe(endOfDay(today))
  })

  it('7 dias incluye el dia de hoy, por eso resta 6', () => {
    const range = rangeFromPreset('7d', today)

    expect(toInputValue(range.from)).toBe('2026-09-15')
    expect(toInputValue(range.to)).toBe('2026-09-21')
  })

  it('30 dias cruza el cambio de mes', () => {
    const range = rangeFromPreset('30d', today)

    expect(toInputValue(range.from)).toBe('2026-08-23')
  })

  it('el rango termina al final del dia, no al empezar', () => {
    const range = rangeFromPreset('hoy', today)

    // Si `to` fuera medianoche, todas las maniobras del dia quedarian afuera.
    expect(new Date(range.to).getHours()).toBe(23)
    expect(new Date(range.to).getMinutes()).toBe(59)
  })
})
