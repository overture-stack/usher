import type { SignInEndpoints } from '../identityProvider/index.js';
import type { OpenApiDocument } from './types.js';

const MANAGEMENT_SCHEME = 'managementToken';

const SIGN_IN_SCHEME = 'identityProviderSignIn';

const OPENID_SCOPE_DESCRIPTION = 'Sign in through the identity provider.';

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
 * The contract the API documentation page serves: the committed one, plus an OAuth 2.0 security
 * scheme, `identityProviderSignIn`, naming one flow, `authorizationCode`, at the authorization and
 * token endpoints given, with the `openid` scope alone, and, right after every security requirement
 * naming `managementToken`, the alternative `{ "identityProviderSignIn": [] }`. Nothing else is added,
 * and the committed contract is left as it was.
 *
 * @param committed the committed contract.
 * @param endpoints the identity provider's authorization and token endpoints.
 */
export const servedSpec = (
	committed: OpenApiDocument,
	{ authorizationEndpoint, tokenEndpoint }: SignInEndpoints,
): OpenApiDocument => ({
	...committed,
	components: {
		...committed.components,
		securitySchemes: {
			...committed.components.securitySchemes,
			[SIGN_IN_SCHEME]: {
				flows: {
					authorizationCode: {
						authorizationUrl: authorizationEndpoint,
						scopes: { openid: OPENID_SCOPE_DESCRIPTION },
						tokenUrl: tokenEndpoint,
					},
				},
				type: 'oauth2',
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
