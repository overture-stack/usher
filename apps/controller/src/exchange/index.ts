export {
  createExchange,
  EXCHANGE_PATH,
  EXCHANGE_STORE_FAILED,
  EXCHANGE_UNEXPECTED_FAILURE,
} from './createExchange.js';
export {
  createKeyConfirmations,
  KEY_CONFIRMATION_FAILED,
} from './createKeyConfirmations.js';
export type {
  CredentialJudge,
  Exchange,
  ExchangeAssertionVerifier,
  ExchangeKey,
  ExchangeLog,
  ExchangeSettings,
  KeyConfirmations,
  KeyConfirmationSettings,
  RejectionCounter,
} from './types.js';
