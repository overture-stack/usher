import type { ControllerConfiguration } from '../configuration/index.js';

/** What the API documentation page reads of the configuration: its client, empty for no page, and the identity provider's issuer. */
export type ApiDocsSettings = Pick<
  ControllerConfiguration,
  'apiDocsClient' | 'identityProviderIssuer'
>;

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
