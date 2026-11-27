import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { TokenClaims, TokenHeader } from '../identityProvider/index.js';
import type { FirstUser } from '../settings/index.js';
import { EXCESSIVE_LIFETIME, MISSING_ISSUED_AT } from '../signInTokens/index.js';
import { readManagementClaims } from './readManagementClaims.js';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const MAXIMUM_LIFETIME_SECONDS = 3600;

const SETTINGS = Object.freeze({
	firstUser: { realmRole: 'usher-first-user' },
	managementAudience: 'usher-management',
	managementClients: ['usher-ui', 'usher-cli'],
	serviceAccountRole: 'usher-service-account',
	signInTokenMaximumFor: () => MAXIMUM_LIFETIME_SECONDS,
});

const HEADER: TokenHeader = Object.freeze({
	alg: 'RS256',
	kid: 'key-1',
	typ: 'JWT',
});

// A Keycloak access token's claims for the management UI, its `typ` the one given to an access token
// by Keycloak.
const claimsWith = (departures: Readonly<Record<string, unknown>> = {}): TokenClaims =>
	Object.fromEntries(
		Object.entries({
			aud: ['usher-management'],
			azp: 'usher-ui',
			exp: SECONDS + 300,
			iat: SECONDS - 10,
			preferred_username: 'ana@example.org',
			realm_access: { roles: ['offline_access', 'usher-first-user'] },
			sid: 'session-1',
			sub: 'subject-ana',
			typ: 'Bearer',
			...departures,
		}).filter(([, value]) => value !== undefined),
	);

const read = (departures?: Readonly<Record<string, unknown>>, header: TokenHeader = HEADER) =>
	readManagementClaims({ claims: claimsWith(departures), header }, SETTINGS, NOW);

const readAs = (firstUser: FirstUser, departures?: Readonly<Record<string, unknown>>) =>
	readManagementClaims({ claims: claimsWith(departures), header: HEADER }, { ...SETTINGS, firstUser }, NOW);

const refusal = (reason: string, subject = 'subject-ana') => ({
	kind: 'refused',
	reason,
	subject,
});

suite("reading a verified management token's claims", () => {
	test('accepts a person holding the first-user role as the first user, with the session the token names', () => {
		assert.deepEqual(read(), {
			kind: 'accepted',
			principal: {
				firstUser: true,
				signIn: {},
				subject: 'subject-ana',
				tokenLifetimeSeconds: 310,
				type: 'human',
			},
			session: { issuedAt: SECONDS - 10, sid: 'session-1' },
		});
	});

	test('takes the person whose subject the first user names as the first user, whatever roles the token holds', () => {
		const reading = readAs({ subject: 'subject-ana' }, { realm_access: { roles: ['offline_access'] } });

		assert.deepEqual(reading.kind === 'accepted' ? reading.principal.firstUser : undefined, true);
	});

	test('takes no one holding the first-user realm role as the first user, when the first user is named by subject', () => {
		const reading = readAs({ subject: 'subject-other' });

		assert.deepEqual(reading.kind === 'accepted' ? reading.principal.firstUser : undefined, false);
	});

	test('reads a person without the first-user role, or holding it in another letter case, as no first user', () => {
		const readings = [
			read({ realm_access: { roles: ['offline_access'] } }),
			read({ realm_access: { roles: ['Usher-First-User'] } }),
		];

		assert.deepEqual(
			readings.map((reading) => (reading.kind === 'accepted' ? reading.principal.firstUser : undefined)),
			[false, false],
		);
	});

	test('reads no admin status from a token, whatever realm role it holds', () => {
		const reading = read({
			realm_access: { roles: ['usher-platform-admin', 'usher-first-user'] },
		});

		assert.deepEqual(reading.kind === 'accepted' ? Object.keys(reading.principal) : [], [
			'firstUser',
			'signIn',
			'subject',
			'tokenLifetimeSeconds',
			'type',
		]);
	});

	test('reads a token holding the service-account realm role beside the first-user role as a service account', () => {
		const reading = read({
			realm_access: {
				roles: ['offline_access', 'usher-first-user', 'usher-service-account'],
			},
		});

		assert.deepEqual(reading.kind === 'accepted' ? reading.principal : undefined, {
			firstUser: true,
			signIn: {},
			subject: 'subject-ana',
			tokenLifetimeSeconds: 310,
			type: 'serviceAccount',
		});
	});

	test("reads the sign-in's level from acr and its time from auth_time, in milliseconds", () => {
		const reading = read({ acr: 'confirmation', auth_time: SECONDS - 30 });

		assert.deepEqual(reading.kind === 'accepted' ? reading.principal.signIn : undefined, {
			authenticatedAt: (SECONDS - 30) * 1000,
			level: 'confirmation',
		});
	});

	test('reads no level from an acr that is not text, and no time from an auth_time that is not a number, refusing neither', () => {
		const reading = read({ acr: 2, auth_time: String(SECONDS) });

		assert.deepEqual(reading.kind === 'accepted' ? reading.principal.signIn : undefined, {});
	});

	test('refuses a verified token other than an access token, an ID token among them, as otherType, naming its subject', () => {
		['ID', 'Refresh', 'Logout', 'DPoP', undefined].forEach((typ) =>
			assert.deepEqual(read({ typ }), refusal('otherType')),
		);
	});

	test('accepts an access token whatever its header typ, JWT or at+jwt', () => {
		[HEADER, { ...HEADER, typ: 'at+jwt' }].forEach((header) => assert.equal(read({}, header).kind, 'accepted'));
	});

	test('judges the names before the type, and the type before the times, the audience and the client', () => {
		assert.deepEqual(read({ sub: undefined, typ: 'ID' }), {
			kind: 'unreadable',
		});
		assert.deepEqual(read({ sid: 'session\u0000', typ: 'ID' }), {
			kind: 'unrepresentable',
		});
		assert.deepEqual(read({ aud: 'account', azp: 'portal', exp: SECONDS - 60, typ: 'ID' }), refusal('otherType'));
	});

	test('refuses a token naming no expiry, or one that is not a number, as missingExpiry', () => {
		assert.deepEqual(read({ exp: undefined }), refusal('missingExpiry'));
		assert.deepEqual(read({ exp: String(SECONDS + 300) }), refusal('missingExpiry'));
	});

	test('refuses a token past its expiry by more than the clock tolerance as expiredToken, and accepts one within it', () => {
		const tolerance = CLOCK_TOLERANCE_MILLISECONDS / 1000;

		assert.deepEqual(read({ exp: SECONDS - tolerance }), refusal('expiredToken'));
		assert.deepEqual(read({ exp: SECONDS - 60 }), refusal('expiredToken'));
		assert.equal(read({ exp: SECONDS - tolerance + 1 }).kind, 'accepted');
	});

	test('refuses a token whose nbf is ahead by more than the clock tolerance as notYetValid, and one whose nbf is no number', () => {
		const tolerance = CLOCK_TOLERANCE_MILLISECONDS / 1000;

		assert.deepEqual(read({ nbf: SECONDS + 120 }), refusal('notYetValid'));
		assert.deepEqual(read({ nbf: 'soon' }), refusal('notYetValid'));
		assert.equal(read({ nbf: SECONDS + tolerance }).kind, 'accepted');
	});

	test('refuses a token naming no iat, or one that is not a number, as missingIssuedAt, naming its subject', () => {
		[undefined, String(SECONDS - 10), null].forEach((iat) =>
			assert.deepEqual(read({ iat }), refusal(MISSING_ISSUED_AT)),
		);
	});

	test('accepts a token whose exp falls exactly the maximum lifetime after its iat, and refuses one a second or more past it as excessiveLifetime, with no clock tolerance, naming its subject', () => {
		const iat = SECONDS - 10;

		assert.equal(read({ exp: iat + MAXIMUM_LIFETIME_SECONDS, iat }).kind, 'accepted');
		[MAXIMUM_LIFETIME_SECONDS + 1, MAXIMUM_LIFETIME_SECONDS * 24].forEach((lifetime) =>
			assert.deepEqual(read({ exp: iat + lifetime, iat }), refusal(EXCESSIVE_LIFETIME)),
		);
	});

	test('judges the expiry, then the iat, then the lifetime, each before the nbf, the audience and the client', () => {
		const iat = SECONDS - 10;
		const overLong = iat + MAXIMUM_LIFETIME_SECONDS + 1;
		const longPast = SECONDS - 3600 - MAXIMUM_LIFETIME_SECONDS - 1;

		assert.deepEqual(
			[
				read({ exp: undefined, iat: undefined }),
				read({ exp: undefined, iat: longPast }),
				read({ exp: SECONDS - 3600, iat: undefined }),
				read({ exp: SECONDS - 3600, iat: longPast }),
				read({ exp: SECONDS + MAXIMUM_LIFETIME_SECONDS * 24, iat: undefined }),
				read({ iat: undefined, nbf: SECONDS + 3600 }),
				read({ aud: 'account', azp: 'portal', iat: undefined }),
				read({ exp: overLong, iat, nbf: SECONDS + 3600 }),
				read({ aud: 'account', azp: 'portal', exp: overLong, iat }),
			],
			[
				refusal('missingExpiry'),
				refusal('missingExpiry'),
				refusal('expiredToken'),
				refusal('expiredToken'),
				refusal(MISSING_ISSUED_AT),
				refusal(MISSING_ISSUED_AT),
				refusal(MISSING_ISSUED_AT),
				refusal(EXCESSIVE_LIFETIME),
				refusal(EXCESSIVE_LIFETIME),
			],
		);
	});

	test('accepts an aud naming the management API as a string or among others, and refuses every other as otherAudience', () => {
		const accepted = [read({ aud: 'usher-management' }), read({ aud: ['account', 'usher-management'] })];
		const refused = [undefined, 'account', ['account'], 'usher-management-staging', []].map((aud) => read({ aud }));

		accepted.forEach((reading) => assert.equal(reading.kind, 'accepted'));
		refused.forEach((reading) => assert.deepEqual(reading, refusal('otherAudience')));
	});

	test('accepts each configured management client as azp, and refuses any other or none as otherAudience', () => {
		assert.equal(read({ azp: 'usher-cli' }).kind, 'accepted');
		[undefined, 'portal', ['usher-ui']].forEach((azp) => assert.deepEqual(read({ azp }), refusal('otherAudience')));
	});

	test('names the refused subject whatever its length, leaving its omission to the event', () => {
		const subject = 'b'.repeat(300);

		assert.deepEqual(read({ exp: undefined, sub: subject }), refusal('missingExpiry', subject));
	});

	test('reads a token naming no subject, or an empty or non-text one, as unreadable', () => {
		[undefined, '', 7].forEach((sub) => assert.deepEqual(read({ sub }), { kind: 'unreadable' }));
	});

	test('reads a subject or session holding text that cannot be stored as unrepresentable, before judging anything else', () => {
		const readings = [
			read({ sub: 'ana\u0000' }),
			read({ exp: undefined, sub: '\uD800ana' }),
			read({ sid: 'session\u0000' }),
		];

		readings.forEach((reading) => assert.deepEqual(reading, { kind: 'unrepresentable' }));
	});

	test('reads a sid that is not text as unrepresentable, since a session it cannot name cannot be matched against a sign-out of it', () => {
		[42, null, true, ['session-1'], { id: 'session-1' }].forEach((sid) =>
			assert.deepEqual(read({ sid }), { kind: 'unrepresentable' }),
		);
	});
});
