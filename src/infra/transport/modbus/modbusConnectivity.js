/**
 * Errores de transporte / socket que deben reintentarse sin fallar el pedido.
 * No incluye excepciones Modbus de aplicación (dirección inválida, etc.).
 */
function isConnectivityError(error) {
  if (!error) {
    return false;
  }

  if (error.connectivity === true) {
    return true;
  }

  const code = error.code;
  const errno = error.errno;
  const transportCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTFOUND",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ESOCKETTIMEDOUT",
    "ERR_SOCKET_CLOSED",
    "EAI_AGAIN",
    "ENOTCONN",
  ]);

  if (code && transportCodes.has(String(code))) {
    return true;
  }

  if (errno !== undefined && errno !== null && transportCodes.has(String(errno))) {
    return true;
  }

  const msg = String(error.message || error).toLowerCase();
  const phrases = [
    "timeout",
    "timed out",
    "econnreset",
    "connection refused",
    "port not open",
    "broken pipe",
    "etimedout",
    "econnrefused",
    "socket",
    "network unreachable",
    "host unreachable",
    "no connection",
    "connection lost",
    "connection closed",
    "write after end",
    "socket hang up",
    "tcp",
  ];

  return phrases.some((p) => msg.includes(p));
}

module.exports = {
  isConnectivityError,
};
