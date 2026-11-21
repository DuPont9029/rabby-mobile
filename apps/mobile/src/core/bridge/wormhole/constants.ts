/**
 * Wormhole mainnet deployment (from @wormhole-foundation/sdk-base
 * `contracts`, checked against the chain in the tests/fixtures).
 */
export const WORMHOLE = {
  /** Wormhole chain ids (not EVM chain ids). */
  solanaChainId: 1,
  ethChainId: 2,
  ethCore: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B',
  ethTokenBridge: '0x3ee18B2214AFF97000D974cf647E7C347E8fa585',
  ethWeth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  solCore: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
  solTokenBridge: 'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb',
  /** Wormhole-wrapped WETH on Solana (8 decimals). */
  solWrappedEthMint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  wrappedDecimals: 8,
  /**
   * Where signed VAAs are downloaded from. Any of them may be used: every
   * VAA is verified locally against the guardian set read from Ethereum.
   */
  vaaApis: [
    'https://api.wormholescan.io',
    'https://wormhole-v2-mainnet-api.mcf.rocks',
    'https://wormhole-v2-mainnet-api.chainlayer.network',
    'https://wormhole-v2-mainnet-api.staking.fund',
  ],
} as const;
