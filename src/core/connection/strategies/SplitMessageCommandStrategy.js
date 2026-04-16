class SplitMessageCommandStrategy {
  constructor(options = {}) {
    this.defaultResponseRegister = options.defaultResponseRegister ?? Number(process.env.MODBUS_RESPONSE_REGISTER ?? 2);
    this.defaultVerifyRegister = options.defaultVerifyRegister ?? Number(process.env.MODBUS_VERIFY_REGISTER ?? 1);
  }

  async execute(context) {
    const { client, device, command, decodeResponse, matchesExpectedResponse } = context;

    const messageInRegister = Number(device.messageInRegister);
    const messageOutRegister = Number(command.responseAddress ?? device.messageOutRegister ?? this.defaultResponseRegister);
    const newDataInRegister = Number(device.newDataInRegister);
    const newDataOutRegister = Number(command.verifyAddress ?? device.newDataOutRegister ?? this.defaultVerifyRegister);

    await client.writeSingleRegister(messageInRegister, Number(command.value));
    await client.writeSingleRegister(newDataInRegister, 1);

    try {
      const responseValues = await client.readHoldingRegisters(messageOutRegister, 1);
      const responseCode = responseValues[0] ?? null;
      const decoded = decodeResponse(responseCode);

      const verifyValues = await client.readHoldingRegisters(newDataOutRegister, 1);
      const verifyValue = verifyValues[0] ?? null;

      const verifyOk = Number(verifyValue) === 1;
      const responseOk = matchesExpectedResponse(responseCode, command.expectedResponses || [100]);

      return {
        verifyValue,
        responseCode,
        decoded,
        stateOk: verifyOk && responseOk,
        strategy: "split-message",
      };
    } finally {
      await client.writeSingleRegister(newDataInRegister, 0);
    }
  }
}

module.exports = {
  SplitMessageCommandStrategy,
};
