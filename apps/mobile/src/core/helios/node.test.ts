import RNFS from '@rabby-wallet/react-native-fs';

import {
  DEFAULT_HELIOS_EXECUTION_RPCS,
  getHeliosExecutionRpcs,
  heliosRpc,
  HeliosRpcError,
  setCustomHeliosExecutionRpc,
  waitForHelios,
} from './node';

const mockStore = new Map<string, unknown>();

jest.mock('@/core/storage/mmkv', () => ({
  appJsonStore: {
    getItem: (key: string, fallback: unknown) =>
      mockStore.has(key) ? mockStore.get(key) : fallback,
    setItem: (key: string, value: unknown) => mockStore.set(key, value),
  },
}));

jest.mock('@rabby-wallet/react-native-fs', () => ({
  __esModule: true,
  default: {
    isHeliosAvailable: jest.fn(() => true),
    heliosDataDirectory: jest.fn(() => '/cache/helios-mainnet'),
    heliosStart: jest.fn(() => 0),
    heliosStop: jest.fn(),
    heliosStatus: jest.fn(() => ({ state: 'synced', error: null })),
    heliosRequest: jest.fn(),
  },
}));

const native = jest.mocked(RNFS) as unknown as {
  isHeliosAvailable: jest.Mock;
  heliosStart: jest.Mock;
  heliosStatus: jest.Mock;
  heliosRequest: jest.Mock;
};

describe('helios node', () => {
  beforeEach(() => {
    mockStore.clear();
    jest.clearAllMocks();
    native.isHeliosAvailable.mockReturnValue(true);
    native.heliosStatus.mockReturnValue({ state: 'synced', error: null });
  });

  it('returns the verified result', async () => {
    native.heliosRequest.mockResolvedValue(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1234' }),
    );
    await expect(heliosRpc('eth_call', [{}, 'latest'])).resolves.toBe('0x1234');
    const sent = JSON.parse(native.heliosRequest.mock.calls[0][0]);
    expect(sent).toMatchObject({ method: 'eth_call', params: [{}, 'latest'] });
  });

  it('marks reverts as definitive and upstream errors as transient', async () => {
    native.heliosRequest.mockResolvedValueOnce(
      JSON.stringify({ error: { code: 3, message: 'execution reverted' } }),
    );
    await expect(heliosRpc('eth_call', [])).rejects.toMatchObject({
      transient: false,
      code: 3,
    });
    native.heliosRequest.mockResolvedValueOnce(
      JSON.stringify({ error: { code: 1, message: 'evm error: server' } }),
    );
    await expect(heliosRpc('eth_call', [])).rejects.toMatchObject({
      transient: true,
    });
  });

  it('starts a stopped node and waits for sync', async () => {
    native.heliosStatus
      .mockReturnValueOnce({ state: 'stopped', error: null })
      .mockReturnValueOnce({ state: 'syncing', error: null })
      .mockReturnValue({ state: 'synced', error: null });
    await waitForHelios(5_000);
    expect(native.heliosStart).toHaveBeenCalledWith({
      executionRpcs: DEFAULT_HELIOS_EXECUTION_RPCS,
      consensusRpcs: expect.any(Array),
      dataDir: '/cache/helios-mainnet',
    });
  });

  it('reports a failed sync as a transient error', async () => {
    native.heliosStatus.mockReturnValue({ state: 'failed', error: 'boom' });
    await expect(waitForHelios(1_000)).rejects.toBeInstanceOf(HeliosRpcError);
  });

  it('puts a custom execution RPC first and keeps the public fallbacks', () => {
    setCustomHeliosExecutionRpc('https://my-node.example/rpc');
    expect(getHeliosExecutionRpcs()).toEqual([
      'https://my-node.example/rpc',
      ...DEFAULT_HELIOS_EXECUTION_RPCS,
    ]);
    expect(() => setCustomHeliosExecutionRpc('http://evil.example')).toThrow();
    setCustomHeliosExecutionRpc(null);
    expect(getHeliosExecutionRpcs()).toEqual(DEFAULT_HELIOS_EXECUTION_RPCS);
  });

  it('is unavailable without the native module', async () => {
    native.isHeliosAvailable.mockReturnValue(false);
    await expect(heliosRpc('eth_blockNumber', [])).rejects.toMatchObject({
      transient: false,
    });
  });
});
