// Repositorios del agente, uno por entidad (RF23).

import { noImplementado } from '@aoki-one/domain'

import type { BaseDelAgente } from './database.js'
import type { DeviceRepository } from './deviceRepository.js'
import type { EventRepository } from './eventRepository.js'
import type { OrderRepository } from './orderRepository.js'
import type { OrderStepRepository } from './orderStepRepository.js'
import type { RobotRepository } from './robotRepository.js'
import type { SlotRepository } from './slotRepository.js'

export * from './database.js'
export * from './deviceRepository.js'
export * from './eventRepository.js'
export * from './orderRepository.js'
export * from './orderStepRepository.js'
export * from './robotRepository.js'
export * from './slotRepository.js'

/** Los repositorios que consumen el orquestador y la API. */
export interface RepositoriosDelAgente {
  readonly robots: RobotRepository
  readonly ordenes: OrderRepository
  readonly pasos: OrderStepRepository
  readonly slots: SlotRepository
  readonly eventos: EventRepository
  /** Los CARRO / ELEVADOR dados de alta. Es lo que consultan la API y el monitor. */
  readonly dispositivos: DeviceRepository
}

export function crearRepositorios(base: BaseDelAgente): RepositoriosDelAgente {
  return noImplementado('crearRepositorios', { base })
}
