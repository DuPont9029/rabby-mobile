import { createSolanaRpc } from './rpc';

const reply = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body } as Response);

describe('getParsedTransaction', () => {
  it('asks for version 1 transactions', async () => {
    const versions: number[] = [];
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const { params } = JSON.parse(String(init!.body));
      versions.push(params[1].maxSupportedTransactionVersion);
      return reply({ result: { blockTime: 1, meta: null, transaction: {} } });
    });
    const rpc = createSolanaRpc('https://rpc.example', fetchImpl as never);
    await expect(rpc.getParsedTransaction('sig')).resolves.not.toBeNull();
    expect(versions).toEqual([1]);
  });

  it('falls back to version 0 on endpoints that reject version 1', async () => {
    const versions: number[] = [];
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const { params } = JSON.parse(String(init!.body));
      const version = params[1].maxSupportedTransactionVersion;
      versions.push(version);
      return version === 1
        ? reply({
            error: {
              code: -32602,
              message: 'Invalid params: invalid maxSupportedTransactionVersion',
            },
          })
        : reply({ result: null });
    });
    const rpc = createSolanaRpc('https://rpc.example', fetchImpl as never);
    await expect(rpc.getParsedTransaction('a')).resolves.toBeNull();
    await rpc.getParsedTransaction('b');
    expect(versions).toEqual([1, 0, 0]);
  });

  it('does not downgrade for other errors', async () => {
    const fetchImpl = jest.fn(async () =>
      reply({ error: { code: -32009, message: 'Slot skipped' } }),
    );
    const rpc = createSolanaRpc('https://rpc.example', fetchImpl as never);
    await expect(rpc.getParsedTransaction('a')).rejects.toThrow('Slot skipped');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
