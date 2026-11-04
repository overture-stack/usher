import './express/locals.js';

export type {
  KeyRegistration,
  OpenKeyRegistration,
  RecordKeyRegistration,
} from '@overture-stack/usher-types';
export { type BridgeOptions, createBridgeCore } from './bridge.js';
export type { Clock } from './core/clocks.js';
export type { BridgeConfiguration, StoreBounds } from './core/configuration.js';
export { CONFIGURATION_DEFAULTS } from './core/configuration.js';
export type {
  BridgeCore,
  LayerEventName,
  ResolveOutcome,
} from './core/core.js';
export type {
  BridgeEventData,
  BridgeLogger,
  BridgeMode,
} from './core/events.js';
export type {
  CredentialRead,
  LayerCore,
  UsherMiddlewareOptions,
} from './express/middleware.js';
export {
  ANSWERS,
  createUsherMiddleware,
  readBearerCredential,
  RETRY_AFTER_SECONDS,
  SUSPENDED_HEADER,
} from './express/middleware.js';
