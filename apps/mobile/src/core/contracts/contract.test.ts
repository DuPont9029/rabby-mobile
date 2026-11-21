import { ethers } from 'ethers';

import {
  buildWriteTx,
  formatResult,
  parseAbi,
  parseArg,
  splitFunctions,
} from './contract';

jest.mock('@/core/helios/node', () => ({
  heliosRpc: jest.fn(),
  isHeliosSupported: () => false,
}));
jest.mock('@/core/serviceApi/customRPC', () => ({
  customRPCServiceApi: { defaultEthRPC: jest.fn() },
}));

const ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function name() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function deposit() payable',
  'function setPair(tuple(address a, uint256 b) p, uint8[] list)',
].map(sig => JSON.parse(ethers.utils.Fragment.from(sig).format('json')));

describe('contract interaction helpers', () => {
  const abi = parseAbi(ABI);
  const { read, write } = splitFunctions(abi);

  it('splits read and write functions', () => {
    expect(read.map(f => f.name)).toEqual(['balanceOf', 'name']);
    expect(write.map(f => f.name)).toEqual(['transfer', 'deposit', 'setPair']);
  });

  it('parses typed arguments', () => {
    const transfer = write[0]!;
    expect(
      parseArg(
        transfer.inputs[0]!,
        '0x8539d33a42cf1f2acdd72debd3e31a75c9f136c6',
      ),
    ).toBe('0x8539D33A42cf1f2ACDD72DEBD3e31A75C9F136C6');
    expect(parseArg(transfer.inputs[1]!, '1000').toString()).toBe('1000');
    expect(parseArg(transfer.inputs[1]!, '0x10').toString()).toBe('16');
    expect(() => parseArg(transfer.inputs[0]!, '0x12')).toThrow();
    expect(() => parseArg(transfer.inputs[1]!, '1.5')).toThrow();
    const setPair = write[2]!;
    const tuple = parseArg(
      setPair.inputs[0]!,
      '["0x8539d33a42cf1f2acdd72debd3e31a75c9f136c6", 7]',
    );
    expect(tuple[1].toString()).toBe('7');
    expect(parseArg(setPair.inputs[1]!, '[1, 2, 3]').map(String)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('encodes write transactions and refuses value on non-payable', () => {
    const tx = buildWriteTx({
      from: '0x0000000000000000000000000000000000000001',
      chainId: 1,
      address: '0x8539d33a42cf1f2acdd72debd3e31a75c9f136c6',
      fragment: write[1]!,
      args: [],
      valueWei: ethers.utils.parseEther('0.1'),
    });
    expect(tx.data).toBe(
      new ethers.utils.Interface(['function deposit() payable']).getSighash(
        'deposit',
      ),
    );
    expect(() =>
      buildWriteTx({
        from: '0x0000000000000000000000000000000000000001',
        chainId: 1,
        address: '0x8539d33a42cf1f2acdd72debd3e31a75c9f136c6',
        fragment: write[0]!,
        args: ['0x8539d33a42cf1f2acdd72debd3e31a75c9f136c6', 1],
        valueWei: ethers.BigNumber.from(1),
      }),
    ).toThrow('not payable');
  });

  it('formats nested results', () => {
    expect(formatResult(ethers.BigNumber.from(5))).toBe('5');
    expect(formatResult([ethers.BigNumber.from(1), ['a', true]])).toBe(
      '["1",["a",true]]',
    );
  });
});
