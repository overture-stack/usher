import { discoveryUrl } from '../identityProvider/index.js';
import type { OpenApiDocument } from './types.js';

const MANAGEMENT_SCHEME = 'managementToken';

const SIGN_IN_SCHEME = 'identityProviderSignIn';

// The members of a path item that are operations, by the method each is called with.
const OPERATION_METHODS: ReadonlySet<string> = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const withSignInAlternatives = (operation: unknown): unknown =>
  isRecord(operation) && Array.isArray(operation['security'])
    ? {
        ...operation,
        security: operation['security'].flatMap((requirement: unknown) =>
          isRecord(requirement) && Object.hasOwn(requirement, MANAGEMENT_SCHEME)
            ? [requirement, { [SIGN_IN_SCHEME]: [] }]
            : [requirement],
        ),
      }
    : operation;

/**
 * The contract the API documentation page serves: the committed one, plus an OpenID Connect security
 * scheme, `identityProviderSignIn`, naming the discovery document at the issuer as the controller
 * finds it, and, right after every security requirement naming `managementToken`, the alternative
 * `{ "identityProviderSignIn": [] }`. Nothing else is added, and the committed contract is left as it
 * was.
 *
 * @param committed the committed contract.
 * @param issuer the identity provider's issuer, as its tokens carry it.
 */
export const servedSpec = (
  committed: OpenApiDocument,
  issuer: string,
): OpenApiDocument => ({
  ...committed,
  components: {
    ...committed.components,
    securitySchemes: {
      ...committed.components.securitySchemes,
      [SIGN_IN_SCHEME]: {
        openIdConnectUrl: discoveryUrl(issuer).href,
        type: 'openIdConnect',
      },
    },
  },
  paths: Object.fromEntries(
    Object.entries(committed.paths).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item).map(([member, value]) => [
          member,
          OPERATION_METHODS.has(member) ? withSignInAlternatives(value) : value,
        ]),
      ),
    ]),
  ),
});
