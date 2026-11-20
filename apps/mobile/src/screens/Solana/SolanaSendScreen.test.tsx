import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react-native';
import Clipboard from '@react-native-clipboard/clipboard';

import { SolanaSendScreen } from './SolanaSendScreen';
import { prepareTransfer } from '@/core/solana/transfer';
import { withSolanaSigner } from '@/core/solana/account';

const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const ADDRESS_A = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb';
const ADDRESS_B = '9h1cLBiraaUqM1CdJTaVaew1oQtgQUW24FZ8YdnLLgJY';

jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({
    params: {
      evmAddress: '0x9858effd232b4033e47d90003d41ec34ecaeda94',
      asset: { kind: 'sol', balance: '5000000000' },
    },
  }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      _key: string,
      options: { defaultValue: string; [k: string]: unknown },
    ) =>
      options.defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
        String(options[name]),
      ),
  }),
}));
jest.mock('@/hooks/theme', () => ({
  useTheme2024: () => ({
    styles: new Proxy({}, { get: () => ({}) }),
    colors2024: new Proxy({}, { get: () => '#000' }),
  }),
}));
jest.mock('@/components/Typography', () => ({
  Text: require('react-native').Text,
}));
jest.mock('@/components2024/Button', () => {
  const { TouchableOpacity, Text } = require('react-native');
  const mockReact = require('react');
  return {
    Button: ({ title, onPress, disabled }: any) =>
      mockReact.createElement(
        TouchableOpacity,
        { onPress, disabled, accessibilityState: { disabled } },
        mockReact.createElement(Text, null, title),
      ),
  };
});
jest.mock('@react-native-clipboard/clipboard', () => ({
  getString: jest.fn(),
}));
jest.mock('./useSolana', () => ({
  useSolanaAccount: () => ({
    status: 'ready',
    value: { evmAddress: '0x98', index: 0, address: ME },
  }),
}));
jest.mock('@/core/solana/settings', () => ({
  getSolanaRpc: () => ({ sendTransaction: jest.fn() }),
}));
jest.mock('@/core/solana/account', () => ({
  withSolanaSigner: jest.fn(),
}));
jest.mock('@/core/solana/transfer', () => {
  const actual = jest.requireActual('@/core/solana/transfer');
  return {
    ...actual,
    prepareTransfer: jest.fn(),
    waitForConfirmation: jest.fn(),
  };
});

const preparedFor = (to: string) => ({
  message: {
    bytes: new Uint8Array(1),
    accountKeys: [ME, to],
    numRequiredSignatures: 1,
  },
  lastValidBlockHeight: 1,
  from: ME,
  to,
  asset: { kind: 'sol' },
  amount: 1_000_000_000n,
  feeLamports: 5_000n,
  rentLamports: 0n,
  createsRecipientTokenAccount: false,
  senderLamportsBefore: 5_000_000_000n,
  senderLamportsAfter: 3_999_995_000n,
  transferFeeBasisPoints: null,
  warnings: [],
});

describe('SolanaSendScreen review', () => {
  afterEach(cleanup);

  it('ignores Paste during review, and Edit drops the review before changes', async () => {
    jest
      .mocked(prepareTransfer)
      .mockResolvedValue(preparedFor(ADDRESS_A) as never);
    const view = render(<SolanaSendScreen />);

    fireEvent.changeText(view.getByTestId('solana-send-recipient'), ADDRESS_A);
    fireEvent.changeText(view.getByTestId('solana-send-amount'), '1');
    fireEvent.press(view.getByText('Review'));
    await view.findByTestId('solana-send-review');

    // Paste cannot change what the review (and the signature) refer to.
    jest.mocked(Clipboard.getString).mockResolvedValue(ADDRESS_B);
    fireEvent.press(view.getByText('Paste'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(Clipboard.getString).not.toHaveBeenCalled();
    expect(view.getByTestId('solana-send-recipient').props.value).toBe(
      ADDRESS_A,
    );

    // Editing first drops the review: no confirm button is left.
    fireEvent.press(view.getByTestId('solana-send-edit'));
    await waitFor(() =>
      expect(view.queryByTestId('solana-send-review')).toBeNull(),
    );
    expect(view.queryByText('Confirm and send')).toBeNull();
    fireEvent.press(view.getByText('Paste'));
    await waitFor(() =>
      expect(view.getByTestId('solana-send-recipient').props.value).toBe(
        ADDRESS_B,
      ),
    );
    expect(withSolanaSigner).not.toHaveBeenCalled();
  });

  it('locks the inputs while a review is shown', async () => {
    jest
      .mocked(prepareTransfer)
      .mockResolvedValue(preparedFor(ADDRESS_A) as never);
    const view = render(<SolanaSendScreen />);

    fireEvent.changeText(view.getByTestId('solana-send-recipient'), ADDRESS_A);
    fireEvent.changeText(view.getByTestId('solana-send-amount'), '1');
    fireEvent.press(view.getByText('Review'));
    await view.findByTestId('solana-send-review');

    expect(view.getByTestId('solana-send-recipient').props.editable).toBe(
      false,
    );
    expect(view.getByTestId('solana-send-amount').props.editable).toBe(false);
  });

  it('shows the prepared amount, not the typed text', async () => {
    jest
      .mocked(prepareTransfer)
      .mockResolvedValue(preparedFor(ADDRESS_A) as never);
    const view = render(<SolanaSendScreen />);

    fireEvent.changeText(view.getByTestId('solana-send-recipient'), ADDRESS_A);
    fireEvent.changeText(view.getByTestId('solana-send-amount'), '1,0');
    fireEvent.press(view.getByText('Review'));
    await view.findByTestId('solana-send-review');

    expect(view.getByText('1 SOL')).toBeTruthy();
  });
});
