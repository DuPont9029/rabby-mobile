import { useEffect } from 'react';
import { AppState } from 'react-native';

import {
  advanceAllBridgeTransfers,
  getBridgeTransfers,
  isFinal,
} from './transfers';

const TICK_MS = 20_000;

/**
 * Advances pending ETH → Solana transfers in the background while the app is
 * open (receipt, guardian signatures, Solana redeem). Renders nothing.
 */
export const BridgeWatcher = () => {
  useEffect(() => {
    let busy = false;
    const tick = () => {
      if (
        busy ||
        AppState.currentState !== 'active' ||
        !getBridgeTransfers().some(t => !isFinal(t.status))
      ) {
        return;
      }
      busy = true;
      advanceAllBridgeTransfers().finally(() => {
        busy = false;
      });
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        tick();
      }
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return null;
};
