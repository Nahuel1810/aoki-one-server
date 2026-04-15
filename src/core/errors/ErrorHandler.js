class ErrorHandler {
  constructor(options = {}) {
    this.logger = options.logger || console;
  }

  nextBackoffMs(attempt, baseMs = 500) {
    return baseMs * 2 ** Math.max(0, attempt - 1);
  }

  isRetryable(error) {
    if (!error) {
      return false;
    }

    return !error.fatal;
  }

  async sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  capture(stateManager, payload) {
    const errorEntity = stateManager.addError(payload);
    this.logger.error("[error-handler]", errorEntity);
    return errorEntity;
  }
}

module.exports = {
  ErrorHandler,
};
