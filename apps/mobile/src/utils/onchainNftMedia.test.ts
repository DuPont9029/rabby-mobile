import { Buffer } from 'buffer';
import { ethers } from 'ethers';

import { customRPCServiceApi } from '@/core/serviceApi/customRPC';
import {
  __resetOnchainNftMediaCacheForTests,
  ETH_CALL_TIMEOUT_MS,
  loadOnchainNftArtwork,
  loadOnchainNftDetails,
} from './onchainNftMedia';

jest.mock('@/core/serviceApi/customRPC', () => ({
  customRPCServiceApi: { defaultEthRPC: jest.fn() },
}));

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
const TOKEN_URI = `data:application/json;base64,${Buffer.from(
  JSON.stringify({
    name: 'Card',
    image: `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`,
  }),
).toString('base64')}`;
const encodedTokenUri = ethers.utils.defaultAbiCoder.encode(
  ['string'],
  [TOKEN_URI],
);
const ref = (tokenId: string) => ({
  chain: 'eth',
  contractId: '0x8539d33a42cf1f2acdd72debd3e31a75c90c13c9',
  tokenId,
});
const rpc = () => jest.mocked(customRPCServiceApi.defaultEthRPC);

describe('on-chain NFT reads', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    __resetOnchainNftMediaCacheForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('caches a definitive answer for the session', async () => {
    rpc().mockResolvedValue(encodedTokenUri);

    const first = await loadOnchainNftArtwork(ref('1'));
    const second = await loadOnchainNftArtwork(ref('1'));

    expect(first).toEqual({ svg: SVG, transient: false });
    expect(second.svg).toBe(SVG);
    expect(rpc()).toHaveBeenCalledTimes(1);
  });

  it('times out a hung RPC call and does not cache the miss', async () => {
    rpc().mockReturnValue(new Promise(() => {}) as never);

    const pending = loadOnchainNftDetails(ref('2'));
    // tokenURI, then uri(): each call gets its own timeout.
    await jest.advanceTimersByTimeAsync(ETH_CALL_TIMEOUT_MS);
    await jest.advanceTimersByTimeAsync(ETH_CALL_TIMEOUT_MS);
    const details = await pending;

    expect(details).toMatchObject({ tokenUri: null, transient: true });

    // The next request reads the chain again instead of reusing the miss.
    rpc().mockReset();
    rpc().mockResolvedValue(encodedTokenUri);
    const retried = await loadOnchainNftArtwork(ref('2'));
    expect(retried).toEqual({ svg: SVG, transient: false });
    expect(rpc()).toHaveBeenCalledTimes(1);
  });

  it('does not let hung calls block later NFTs forever', async () => {
    rpc().mockReturnValue(new Promise(() => {}) as never);
    const stuck = ['10', '11', '12'].map(id => loadOnchainNftDetails(ref(id)));

    rpc().mockResolvedValue(encodedTokenUri);
    const later = loadOnchainNftArtwork(ref('13'));

    // All call slots are taken by hung requests until their timeouts free
    // them; then the later NFT gets its turn.
    await jest.advanceTimersByTimeAsync(ETH_CALL_TIMEOUT_MS * 2);
    await expect(later).resolves.toEqual({ svg: SVG, transient: false });
    await Promise.all(stuck);
  });

  it('treats an RPC error as temporary', async () => {
    rpc().mockRejectedValue(new Error('rate limited'));

    const artwork = await loadOnchainNftArtwork(ref('3'));

    expect(artwork).toEqual({ svg: null, transient: true });
  });
});
