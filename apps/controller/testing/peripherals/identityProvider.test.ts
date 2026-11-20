import assert from 'node:assert/strict';
import { suite, type TestContext, test } from 'node:test';

import { createRemoteJWKSet, decodeProtectedHeader, type JWK, jwtVerify, type JWTVerifyResult } from 'jose';

import {
	type IdentityProvider,
	mintServiceAccountToken,
	SERVICE_ACCOUNT,
	startIdentityProvider,
} from './identityProvider.js';

const started = async (context: TestContext): Promise<IdentityProvider> => {
	const provider = await startIdentityProvider();
	context.after(() => provider.stop());
	return provider;
};

const discoveryUrl = (provider: IdentityProvider): string => `${provider.issuer}/.well-known/openid-configuration`;

const jsonAt = async (url: string): Promise<unknown> => (await fetch(url)).json();

const isKeyList = (value: unknown): value is readonly JWK[] =>
	Array.isArray(value) && value.every((key: unknown) => typeof key === 'object' && key !== null);

const keysAt = async (provider: IdentityProvider): Promise<readonly JWK[]> => {
	const keySet = await jsonAt(provider.jwksUri);
	const keys: unknown = typeof keySet === 'object' && keySet !== null ? Reflect.get(keySet, 'keys') : undefined;
	assert.ok(isKeyList(keys));
	return keys;
};

const verifiedBy = (provider: IdentityProvider, token: string): Promise<JWTVerifyResult> =>
	jwtVerify(token, createRemoteJWKSet(new URL(provider.jwksUri)), {
		algorithms: ['ES256', 'PS256', 'RS256'],
		audience: 'arranger-test',
		issuer: provider.issuer,
	});

const connectionErrorCode = async (url: string): Promise<unknown> => {
	const error: unknown = await fetch(url).then(
		() => undefined,
		(failure: unknown) => failure,
	);
	return error instanceof Error && error.cause instanceof Error
		? Object.getOwnPropertyDescriptor(error.cause, 'code')?.value
		: undefined;
};

suite('the identity provider stand-in', () => {
	test('serves a discovery document naming its realm issuer and its JWKS', async (context) => {
		const provider = await started(context);

		const discovery = await jsonAt(discoveryUrl(provider));

		assert.match(provider.issuer, /^http:\/\/127\.0\.0\.1:\d+\/realms\/usher-test$/u);
		assert.ok(typeof discovery === 'object' && discovery !== null);
		assert.equal(Reflect.get(discovery, 'issuer'), provider.issuer);
		assert.equal(Reflect.get(discovery, 'jwks_uri'), provider.jwksUri);
	});

	test('publishes an RS256 signing key and an RSA-OAEP key for encryption, as a Keycloak realm does', async (context) => {
		const provider = await started(context);

		const keys = await keysAt(provider);

		assert.deepEqual(
			keys.map(({ alg, kty, use }) => ({ alg, kty, use })),
			[
				{ alg: 'RS256', kty: 'RSA', use: 'sig' },
				{ alg: 'RSA-OAEP', kty: 'RSA', use: 'enc' },
			],
		);
		assert.ok(keys.every(({ d, kid }) => d === undefined && typeof kid === 'string'));
	});

	test('mints Keycloak-shaped access tokens that jose verifies against its JWKS', async (context) => {
		const provider = await started(context);
		const [signingKey] = await keysAt(provider);

		const token = await provider.mint();
		const { payload, protectedHeader } = await verifiedBy(provider, token);

		assert.deepEqual(protectedHeader, {
			alg: 'RS256',
			kid: signingKey?.kid,
			typ: 'JWT',
		});
		assert.ok(Array.isArray(payload.aud));
		assert.equal(typeof payload.azp, 'string');
		assert.equal(payload.exp, (payload.iat ?? 0) + 300);
		assert.equal(typeof payload.sub, 'string');
		assert.match(String(payload['email']), /@example\.org$/u);
		assert.deepEqual(payload['realm_access'], {
			roles: ['default-roles-usher-test', 'offline_access', 'uma_authorization'],
		});
	});

	test('mints with the claims and header a test sets, leaving out each one set to undefined', async (context) => {
		const provider = await started(context);

		const token = await provider.mint({
			claims: { email: 'bo@example.org', sid: undefined, sub: 'bo-subject' },
			header: { typ: undefined },
			lifetimeSeconds: 60,
		});
		const { payload, protectedHeader } = await verifiedBy(provider, token);

		assert.equal(payload['email'], 'bo@example.org');
		assert.equal(payload.sub, 'bo-subject');
		assert.equal('sid' in payload, false);
		assert.equal(payload.exp, (payload.iat ?? 0) + 60);
		assert.equal('typ' in protectedHeader, false);
	});

	test('signs with each key it adds, PS256 and ES256, publishing each', async (context) => {
		const provider = await started(context);

		const kids = await Promise.all([provider.addKey('PS256'), provider.addKey('ES256')]);
		const verified = await Promise.all(
			kids.map(async (kid) => (await verifiedBy(provider, await provider.mint({ kid }))).protectedHeader),
		);

		assert.deepEqual(
			verified.map(({ alg, kid }) => ({ alg, kid })),
			[
				{ alg: 'PS256', kid: kids[0] },
				{ alg: 'ES256', kid: kids[1] },
			],
		);
	});

	test('rotates to a new active key, keeping the one it replaced published until it is withdrawn', async (context) => {
		const provider = await started(context);
		const beforeRotation = await provider.mint();
		const replacedKid = decodeProtectedHeader(beforeRotation).kid;
		assert.ok(typeof replacedKid === 'string');

		const activeKid = await provider.rotate();
		const afterRotation = await provider.mint();
		await verifiedBy(provider, beforeRotation);
		provider.withdraw(replacedKid);

		assert.equal(decodeProtectedHeader(afterRotation).kid, activeKid);
		await verifiedBy(provider, afterRotation);
		await assert.rejects(verifiedBy(provider, beforeRotation), {
			code: 'ERR_JWKS_NO_MATCHING_KEY',
		});
		assert.ok(provider.publishedKeys().every(({ kid }) => kid !== replacedKid));
		assert.equal(decodeProtectedHeader(await provider.mint({ kid: replacedKid })).kid, replacedKid);
	});

	test('answers 500 to both documents when told to', async (context) => {
		const provider = await started(context);
		provider.answerWith({ discovery: 'serverError', jwks: 'serverError' });

		const statuses = await Promise.all(
			[discoveryUrl(provider), provider.jwksUri].map(async (url) => (await fetch(url)).status),
		);

		assert.deepEqual(statuses, [500, 500]);
	});

	test('serves malformed JSON for both documents when told to', async (context) => {
		const provider = await started(context);
		provider.answerWith({ discovery: 'malformedJson', jwks: 'malformedJson' });

		await assert.rejects(jsonAt(discoveryUrl(provider)), SyntaxError);
		await assert.rejects(jsonAt(provider.jwksUri), SyntaxError);
	});

	test('serves an empty key set when told to, the discovery document unchanged', async (context) => {
		const provider = await started(context);
		provider.answerWith({ jwks: 'emptyKeySet' });

		assert.deepEqual(await keysAt(provider), []);
		assert.equal((await fetch(discoveryUrl(provider))).status, 200);
	});

	test('refuses connections when told to, and accepts them again on the same port', async (context) => {
		const provider = await started(context);
		await fetch(discoveryUrl(provider));

		await provider.refuseConnections();
		const refusal = await connectionErrorCode(discoveryUrl(provider));
		await provider.acceptConnections();

		assert.equal(refusal, 'ECONNREFUSED');
		assert.equal((await fetch(discoveryUrl(provider))).status, 200);
	});

	test('accepts a connection and never answers when told to, and still stops', async (context) => {
		const provider = await started(context);
		provider.answerWith({ jwks: 'neverAnswer' });

		const held = fetch(provider.jwksUri).then(
			() => 'answered',
			() => 'ended unanswered',
		);
		const timedOut = fetch(provider.jwksUri, {
			signal: AbortSignal.timeout(200),
		}).then(
			() => 'answered',
			(error: unknown) => (error instanceof Error ? error.name : 'unknown'),
		);

		assert.equal(await timedOut, 'TimeoutError');
		await provider.stop();
		assert.equal(await held, 'ended unanswered');
		assert.deepEqual(
			provider.requests.map(({ path }) => path),
			[new URL(provider.jwksUri).pathname, new URL(provider.jwksUri).pathname],
		);
	});

	test('records every request it receives, with its path', async (context) => {
		const provider = await started(context);
		const realmPath = new URL(provider.issuer).pathname;

		await fetch(discoveryUrl(provider));
		await fetch(provider.jwksUri);
		await fetch(`${provider.issuer}/unknown?query=dropped`, { method: 'POST' });

		assert.deepEqual(provider.requests, [
			{ method: 'GET', path: `${realmPath}/.well-known/openid-configuration` },
			{ method: 'GET', path: `${realmPath}/protocol/openid-connect/certs` },
			{ method: 'POST', path: `${realmPath}/unknown` },
		]);
	});

	test('names another realm as its issuer, or no issuer at all, in its discovery document when told to', async (context) => {
		const provider = await started(context);

		provider.answerWith({ discovery: 'namesOtherIssuer' });
		const other = await jsonAt(discoveryUrl(provider));
		provider.answerWith({ discovery: 'namesNoIssuer' });
		const none = await jsonAt(discoveryUrl(provider));

		assert.ok(typeof other === 'object' && other !== null);
		assert.equal(Reflect.get(other, 'issuer'), provider.otherIssuer);
		assert.equal(provider.otherIssuer, provider.issuer.replace(/usher-test$/u, 'not-usher-test'));
		assert.ok(typeof none === 'object' && none !== null);
		assert.equal('issuer' in none, false);
		assert.equal(Reflect.get(none, 'jwks_uri'), provider.jwksUri);
	});

	test('answers its JWKS 404 when told to', async (context) => {
		const provider = await started(context);
		provider.answerWith({ jwks: 'notFound' });

		assert.equal((await fetch(provider.jwksUri)).status, 404);
	});

	test('serves another realm on its host and port, whose tokens name it and verify against its own keys alone', async (context) => {
		const provider = await started(context);

		const other = await provider.addRealm('other');
		const again = await provider.addRealm('other');
		const token = await other.mint({ claims: { sub: 'bo-subject' } });
		const discovery = await jsonAt(`${other.issuer}/.well-known/openid-configuration`);
		const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(other.jwksUri)), {
			audience: 'arranger-test',
			issuer: other.issuer,
		});

		assert.equal(again, other);
		assert.equal(new URL(other.issuer).origin, new URL(provider.issuer).origin);
		assert.match(other.issuer, /\/realms\/other$/u);
		assert.ok(typeof discovery === 'object' && discovery !== null);
		assert.equal(Reflect.get(discovery, 'issuer'), other.issuer);
		assert.equal(payload.sub, 'bo-subject');
		assert.deepEqual(payload['realm_access'], {
			roles: ['default-roles-other', 'offline_access', 'uma_authorization'],
		});
		await assert.rejects(verifiedBy(provider, token), {
			code: 'ERR_JWKS_NO_MATCHING_KEY',
		});
		assert.ok(other.publishedKeys().every(({ kid }) => provider.publishedKeys().every((key) => key.kid !== kid)));
		await assert.rejects(other.mint({ claims: { iss: provider.issuer } }), {
			message: "a realm's tokens always name the realm's own issuer",
		});
	});

	test('names its own issuer with a trailing slash in its discovery document when told to', async (context) => {
		const provider = await started(context);
		provider.answerWith({ discovery: 'namesIssuerWithTrailingSlash' });

		const discovery = await jsonAt(discoveryUrl(provider));

		assert.ok(typeof discovery === 'object' && discovery !== null);
		assert.equal(Reflect.get(discovery, 'issuer'), `${provider.issuer}/`);
		assert.equal(Reflect.get(discovery, 'jwks_uri'), provider.jwksUri);
	});
});

suite("a service account's token", () => {
	test("is signed by the stand-in's rightful key and shaped as Keycloak shapes a client-credentials token", async (context) => {
		const provider = await started(context);

		const token = await mintServiceAccountToken(provider, {
			firstUserRole: 'usher-first-user',
			managementAudience: 'usher-management-test',
			managementClients: ['usher-ui-test'],
		});
		const { payload, protectedHeader } = await jwtVerify(token, createRemoteJWKSet(new URL(provider.jwksUri)), {
			audience: 'usher-management-test',
			issuer: provider.issuer,
		});

		assert.equal(protectedHeader.alg, 'RS256');
		assert.equal(payload.sub, SERVICE_ACCOUNT.subject);
		assert.equal(payload['azp'], SERVICE_ACCOUNT.clientId);
		assert.equal(payload['client_id'], SERVICE_ACCOUNT.clientId);
		assert.equal(payload['preferred_username'], `service-account-${SERVICE_ACCOUNT.clientId}`);
		assert.equal(Object.hasOwn(payload, 'email'), false);
		assert.equal(Object.hasOwn(payload, 'email_verified'), false);
		assert.deepEqual(payload['realm_access'], {
			roles: ['default-roles-usher-test', 'offline_access', 'uma_authorization'],
		});
	});
});
