import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import { readStoredRefusal } from './readStoredRefusal.js';
import type { StoreReader } from './types.js';

const ISSUER = 'https://auth.example.org/realms/usher';

const ISSUED_AT = Math.floor(Date.UTC(2026, 10, 4, 12, 0, 0) / 1000);

interface Standing {
	liftedSince: boolean;
	revoked: boolean;
	signedOutEveryone: boolean;
	signedOut: boolean;
}

interface Asked {
	text: string;
	values: readonly unknown[] | undefined;
}

const STANDING_NONE: Standing = Object.freeze({
	liftedSince: false,
	revoked: false,
	signedOutEveryone: false,
	signedOut: false,
});

// A store answering every question with the standing given, keeping each question asked.
const answering = (standing: Standing): { asked: Asked[]; store: StoreReader } => {
	const asked: Asked[] = [];
	const query = async (text: string, values?: readonly unknown[]) => {
		asked.push({ text, values });
		return { rows: [standing] };
	};
	// A pool that never connects, its query answered here: the pool's overloads are more than a fake
	// can spell out.
	return { asked, store: Object.assign(new pg.Pool(), { query }) };
};

const SESSION = Object.freeze({ issuedAt: ISSUED_AT, sid: 'session-1' });

suite("reading a principal's standing in the store", () => {
	test('refuses for a standing revocation of the person first, then a revocation of the platform, then a sign-out, and not at all for none', async () => {
		const standings: readonly Standing[] = [
			{ liftedSince: false, revoked: true, signedOutEveryone: true, signedOut: true },
			{ liftedSince: false, revoked: false, signedOutEveryone: true, signedOut: true },
			{ liftedSince: false, revoked: false, signedOutEveryone: false, signedOut: true },
			STANDING_NONE,
		];

		const refusals = await Promise.all(
			standings.map((standing) =>
				readStoredRefusal(answering(standing).store, 'usher', {
					issuer: ISSUER,
					session: SESSION,
					subject: 'subject-ana',
				}),
			),
		);

		assert.deepEqual(refusals, ['revokedPrincipal', 'signedOutEveryone', 'signedOutSession', undefined]);
	});

	test("binds the issuer, the subject, the session and the token's iat as an instant, and none for a token naming no iat or sid", async () => {
		const { asked, store } = answering(STANDING_NONE);

		await readStoredRefusal(store, 'usher', {
			issuer: ISSUER,
			session: SESSION,
			subject: 'subject-ana',
		});
		await readStoredRefusal(store, 'usher', {
			issuer: ISSUER,
			session: {},
			subject: 'subject-ana',
		});

		assert.deepEqual(
			asked.map(({ values }) => values),
			[
				[ISSUER, 'subject-ana', 'session-1', new Date(ISSUED_AT * 1000)],
				[ISSUER, 'subject-ana', null, null],
			],
		);
	});

	test('reads the sign-outs of everyone in the schema named, quoted as an identifier', async () => {
		const { asked, store } = answering(STANDING_NONE);

		await readStoredRefusal(store, 'usher "staging"', {
			issuer: ISSUER,
			session: SESSION,
			subject: 'subject-ana',
		});

		assert.match(asked[0]?.text ?? '', /"usher ""staging"""\.everyone_sign_outs/u);
	});
});
