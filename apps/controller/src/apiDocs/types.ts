import type { ControllerConfiguration } from '../configuration/index.js';
import type { EventLog } from '../eventLog/index.js';

/**
 * What the API documentation page reads of the configuration: its client, empty for no page, the clock
 * the cooldown after a failed read of the identity provider's endpoints is measured on, and the
 * identity provider's issuer.
 */
export type ApiDocsSettings = Pick<
  ControllerConfiguration,
  'apiDocsClient' | 'clock' | 'identityProviderIssuer'
>;

/** Where the API documentation page writes a failed read of the identity provider's endpoints. */
export type ApiDocsLog = Pick<EventLog, 'error'>;

/** An OpenAPI document's components, as far as the served contract reads and extends them. */
export interface OpenApiComponents {
  readonly [member: string]: unknown;

  /** The security schemes, by name. */
  readonly securitySchemes: Readonly<Record<string, unknown>>;
}

/** An OpenAPI document, as far as the served contract reads and extends it. */
export interface OpenApiDocument {
  readonly [member: string]: unknown;

  readonly components: OpenApiComponents;

  /** Each path's item, its members by name: its operations by method, among others. */
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
