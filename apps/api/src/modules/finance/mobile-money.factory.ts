import { env } from '../../config/env';
import {
  HttpMobileMoneyProvider,
  type MobileMoneyProvider,
  OperatorsMobileMoneyProvider,
  SimulatorMobileMoneyProvider,
} from './mobile-money.provider';
import { MtnMomoProvider, mtnConfigFromEnv } from './mtn-momo.provider';
import { OrangeMoneyProvider, orangeConfigFromEnv } from './orange-money.provider';

/** Fournisseur Mobile Money retenu par MOBILE_MONEY_PROVIDER. */
export function createMobileMoneyProvider(): MobileMoneyProvider {
  const mode = env().MOBILE_MONEY_PROVIDER;
  if (mode === 'http') return new HttpMobileMoneyProvider();
  if (mode === 'operators') {
    const mtn = mtnConfigFromEnv();
    const orange = orangeConfigFromEnv();
    return new OperatorsMobileMoneyProvider({
      ...(mtn ? { MTN_MOMO: new MtnMomoProvider(mtn) } : {}),
      ...(orange ? { ORANGE_MONEY: new OrangeMoneyProvider(orange) } : {}),
    });
  }
  return new SimulatorMobileMoneyProvider();
}
