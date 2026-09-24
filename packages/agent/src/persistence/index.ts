// Repositorios del agente, uno por entidad (RF23).


import { crearClientRepository } from './clientRepository.js'
import { crearDeviceRepository } from './deviceRepository.js'
import { crearEventRepository } from './eventRepository.js'
import { crearMetricsRepository } from './metricsRepository.js'
import type { MetricsRepository } from './metricsRepository.js'
import { crearOrderRepository } from './orderRepository.js'
import { crearOrderStepRepository } from './orderStepRepository.js'
import { crearRobotRepository } from './robotRepository.js'
import { crearSlotRepository } from './slotRepository.js'
import type { BaseDelAgente } from './database.js'
import type { ClientRepository } from './clientRepository.js'
import type { DeviceRepository } from './deviceRepository.js'
import type { EventRepository } from './eventRepository.js'
import type { OrderRepository } from './orderRepository.js'
import type { OrderStepRepository } from './orderStepRepository.js'
import type { RobotRepository } from './robotRepository.js'
import type { SlotRepository } from './slotRepository.js'

export * from './clientRepository.js'
export * from './database.js'
export * from './deviceRepository.js'
export * from './eventRepository.js'
export * from './metricsRepository.js'
export * from './orderRepository.js'
export * from './orderStepRepository.js'
export * from './retencion.js'
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
  readonly metricas: MetricsRepository
  /** Quien llama a la API local, y a quien se le corto el acceso (RF22). */
  readonly clientes: ClientRepository
}

export function crearRepositorios(base: BaseDelAgente): RepositoriosDelAgente {
  return {
    robots: crearRobotRepository(base),
    ordenes: crearOrderRepository(base),
    pasos: crearOrderStepRepository(base),
    slots: crearSlotRepository(base),
    eventos: crearEventRepository(base),
    dispositivos: crearDeviceRepository(base),
    metricas: crearMetricsRepository(base),
    clientes: crearClientRepository(base),
  }
}
