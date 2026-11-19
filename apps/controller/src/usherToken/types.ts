import type { KeyObject } from 'node:crypto';

import type { PermissionsPayload } from '@overture-stack/usher-types';

/** A payload as version 1 of the payload contract defines it: the version the Controller seals. */
export type VersionOnePayload = PermissionsPayload & { payloadVersion: 1 };

/** The key an Usher token is sealed under, as each live application key holds it. */
export interface TokenSealingKey {
  /** The application's token subkey, derived under `usher/v1/token-encryption`: AES-256-GCM. */
  token: KeyObject;
}
