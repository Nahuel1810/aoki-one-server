/**
 * Mutex por clave de dispositivo (promise-chaining queue).
 *
 * Garantiza que las operaciones Modbus sobre un mismo socket TCP sean
 * estrictamente secuenciales: una sola operación a la vez por device key.
 *
 * modbus-serial usa un socket TCP half-duplex; si dos requests se intercalan
 * en el mismo socket los frames se corrompen y el resultado es timeout,
 * "port not open" o silencio total del PLC.
 */
class DeviceMutex {
  constructor() {
    /** Cola de promesas activas: key → Promise<void> tail */
    this._queues = new Map();
    /** Contador de operaciones en vuelo por key */
    this._inflight = new Map();
  }

  /**
   * Ejecuta `fn` en exclusión mutua para la `key` dada.
   * Si hay una operación en curso, espera a que termine antes de ejecutar.
   *
   * @template T
   * @param {string} key  Clave del dispositivo, e.g. "1:CARRO"
   * @param {() => Promise<T>} fn  Operación a serializar
   * @returns {Promise<T>}
   */
  run(key, fn) {
    const tail = this._queues.get(key) ?? Promise.resolve();

    const next = tail.then(() => {
      this._inflight.set(key, (this._inflight.get(key) ?? 0) + 1);
      return fn();
    }).finally(() => {
      const remaining = (this._inflight.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this._inflight.delete(key);
        this._queues.delete(key);
      } else {
        this._inflight.set(key, remaining);
      }
    });

    // Guardamos la cola sin propagar el error, para que la siguiente
    // operación no quede bloqueada por el fallo de la anterior.
    this._queues.set(key, next.catch(() => {}));

    return next;
  }

  /**
   * Intenta adquirir el lock sin esperar.
   * Si ya hay una operación en vuelo para esta `key`, retorna `null`
   * inmediatamente en lugar de encolar.
   *
   * Uso recomendado para el monitor de conexión: si el orchestrator está
   * usando el socket, el monitor omite el ciclo en vez de colisionar.
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T|null>}
   */
  tryRun(key, fn) {
    if (this.isLocked(key)) {
      return Promise.resolve(null);
    }

    return this.run(key, fn);
  }

  /**
   * @param {string} key
   * @returns {boolean} true si hay al menos una operación en vuelo.
   */
  isLocked(key) {
    return this._queues.has(key) || (this._inflight.get(key) ?? 0) > 0;
  }

  /** Elimina todas las colas (útil en hard reset). */
  clear() {
    this._queues.clear();
    this._inflight.clear();
  }
}

module.exports = { DeviceMutex };
