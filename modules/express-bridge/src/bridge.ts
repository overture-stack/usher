import type { BridgeConfiguration } from './core/configuration.js';
import type { ControllerFetch } from './core/controllerClient.js';
import { type BridgeCore, createBridgeCoreWithSeams } from './core/core.js';
import { defaultSeams } from './core/defaultSeams.js';

/** What a host may hand the bridge beside its configuration. */
export interface BridgeOptions {
  /** A fetch to reach the controller with, in place of the bridge's own. */
  fetch?: ControllerFetch;
}

/**
 * Creates the bridge's core, which turns each request's credential into that request's access,
 * exchanging credentials with the controller over fetch and decrypting each Usher token itself.
 * Creating it checks nothing: `start` checks the configuration.
 *
 * @param options `fetch` reaches the controller in place of undici's fetch through an Agent of the
 *   core's own, which a global dispatcher set by the host never replaces.
 */
export const createBridgeCore = (
  configuration: BridgeConfiguration,
  options: BridgeOptions = {},
): BridgeCore =>
  createBridgeCoreWithSeams(configuration, defaultSeams(options));
