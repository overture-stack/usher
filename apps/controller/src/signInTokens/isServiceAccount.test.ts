import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { TokenClaims } from '../identityProvider/index.js';
import { isServiceAccount } from './isServiceAccount.js';

const SERVICE_ACCOUNT_ROLE = 'usher-service-account';

// A person's access token's claims, holding a realm role other than the service-account role.
const claimsWith = (departures: Readonly<Record<string, unknown>> = {}): TokenClaims =>
	Object.fromEntries(
		Object.entries({
			azp: 'usher-ui',
			preferred_username: 'ana@example.org',
			realm_access: { roles: ['offline_access', 'usher-platform-admin'] },
			sub: 'subject-ana',
			typ: 'Bearer',
			...departures,
		}).filter(([, value]) => value !== undefined),
	);

suite("telling a service account's token apart", () => {
	test("marks a token by either sign of Keycloak's client credentials, whatever other realm roles it holds", () => {
		assert.deepEqual(
			[
				claimsWith({ client_id: 'lyric-svc' }),
				claimsWith({ preferred_username: 'service-account-lyric-svc' }),
			].map((claims) => isServiceAccount(claims, SERVICE_ACCOUNT_ROLE)),
			[true, true],
		);
	});

	test('marks a token holding the service-account realm role, and neither sign of client credentials', () => {
		const claims = claimsWith({
			realm_access: { roles: ['offline_access', SERVICE_ACCOUNT_ROLE] },
		});

		assert.equal(isServiceAccount(claims, SERVICE_ACCOUNT_ROLE), true);
	});

	test('takes the configured service-account role as the mark, and the default name then as any other role', () => {
		const marked = (roles: readonly string[]): boolean =>
			isServiceAccount(claimsWith({ realm_access: { roles } }), 'lyric-service');

		assert.deepEqual(
			[marked(['offline_access', 'lyric-service']), marked(['offline_access', SERVICE_ACCOUNT_ROLE])],
			[true, false],
		);
	});

	test("reads a token as a person's when it carries neither sign of client credentials nor a realm role named exactly as the service-account role", () => {
		const people = [
			claimsWith(),
			claimsWith({ realm_access: { roles: ['offline_access'] } }),
			claimsWith({ realm_access: undefined }),
			claimsWith({
				realm_access: {
					roles: [
						'Usher-Service-Account',
						'usher-service-account-x',
						' usher-service-account',
						[SERVICE_ACCOUNT_ROLE],
					],
				},
			}),
			claimsWith({ realm_access: { roles: SERVICE_ACCOUNT_ROLE } }),
			claimsWith({ resource_access: { roles: [SERVICE_ACCOUNT_ROLE] } }),
			claimsWith({ preferred_username: 'ana-service-account-x' }),
			claimsWith({ client_id: 42 }),
			claimsWith({ client_id: null }),
		];

		assert.deepEqual(
			people.map((claims) => isServiceAccount(claims, SERVICE_ACCOUNT_ROLE)),
			people.map(() => false),
		);
	});
});
