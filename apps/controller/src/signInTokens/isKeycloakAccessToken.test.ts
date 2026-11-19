import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { TokenClaims, TokenHeader } from '../identityProvider/index.js';
import { isKeycloakAccessToken } from './isKeycloakAccessToken.js';

const HEADER: TokenHeader = Object.freeze({
	alg: 'RS256',
	kid: 'key-1',
	typ: 'JWT',
});

// The header given to an access token by Keycloak's RFC 9068 option, its payload `typ` left `Bearer`.
const RFC_9068_HEADER: TokenHeader = Object.freeze({
	...HEADER,
	typ: 'at+jwt',
});

// A token's claims with its payload `typ` as given, or none where it is `undefined`.
const claimsTyped = (typ: unknown): TokenClaims =>
	Object.fromEntries(Object.entries({ sub: 'subject-ana', typ }).filter(([, value]) => value !== undefined));

const recognizes = (typ: unknown, header: TokenHeader = HEADER): boolean =>
	isKeycloakAccessToken({ claims: claimsTyped(typ), header });

suite("the Keycloak connector's recognition of an access token", () => {
	test('recognizes a token whose payload typ is Bearer, under a header typ of JWT or of at+jwt', () => {
		assert.equal(recognizes('Bearer'), true);
		assert.equal(recognizes('Bearer', RFC_9068_HEADER), true);
	});

	test("does not recognize any other token issued by Keycloak, by its payload's typ", () => {
		['ID', 'Refresh', 'Offline', 'Logout', 'DPoP', 'Serialized-ID'].forEach((typ) =>
			assert.equal(recognizes(typ), false),
		);
	});

	test('does not recognize a payload typ that is not exactly the text Bearer, or a token carrying none', () => {
		[undefined, 'bearer', 'BEARER', 'Bearer ', 7, ['Bearer'], null].forEach((typ) =>
			assert.equal(recognizes(typ), false),
		);
	});

	test("does not recognize a token by its header's typ, at+jwt in either form included, when its payload's typ is another", () => {
		[RFC_9068_HEADER, { ...HEADER, typ: 'application/at+jwt' }].forEach((header) =>
			assert.equal(recognizes('ID', header), false),
		);
	});
});
