class SingleRegisterCommandStrategy {
  constructor(options = {}) {
    this.defaultCommandRegister = options.defaultCommandRegister ?? Number(process.env.MODBUS_COMMAND_REGISTER ?? 0);
    this.defaultResponseRegister = options.defaultResponseRegister ?? Number(process.env.MODBUS_RESPONSE_REGISTER ?? 2);
    this.defaultVerifyRegister = options.defaultVerifyRegister ?? Number(process.env.MODBUS_VERIFY_REGISTER ?? 1);
  }

  async execute(context) {
    const { client, device, command, decodeResponse, matchesExpectedResponse } = context;

    const commandAddress = Number(command.address ?? device.commandRegister ?? this.defaultCommandRegister);
    await client.writeSingleRegister(commandAddress, command.value);

    const responseAddress = Number(command.responseAddress ?? device.responseRegister ?? this.defaultResponseRegister);
    const responseValues = await client.readHoldingRegisters(responseAddress, 1);
    const responseCode = responseValues[0] ?? null;
    const decoded = decodeResponse(responseCode);

    const verifyAddress = Number(command.verifyAddress ?? device.verifyRegister ?? this.defaultVerifyRegister);
    const verifyValues = await client.readHoldingRegisters(verifyAddress, 1);
    const verifyValue = verifyValues[0] ?? null;

    const verifyOk = verifyValue === command.expectedValue;
    const responseOk = matchesExpectedResponse(responseCode, command.expectedResponses || [100]);

    return {
      verifyValue,
      responseCode,
      decoded,
      stateOk: verifyOk && responseOk,
      strategy: "single-register",
    };
  }
}

module.exports = {
  SingleRegisterCommandStrategy,
};
