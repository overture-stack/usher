import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { suite, test, type TestContext } from 'node:test';

import { discoveryDocument, issuerEndpoint, keySetUrl } from './discovery.js';

const ISSUER = 'https://auth.example.org/realms/usher';

const LOOPBACK_ISSUER = 'http://127.0.0.1:8080/realms/usher';

const DISCOVERY_PATH = '/realms/usher/.well-known/openid-configuration';

const isAddress = (address: unknown): address is AddressInfo =>
	typeof address === 'object' && address !== null && 'port' in address;

// A provider answering its discovery document with the status and the body given for its issuer,
// every other path 404, and the issuer it listens as.
const providerAnswering = async (
	context: TestContext,
	body: (issuer: string) => string,
	status = 200,
): Promise<string> => {
	const listened = { issuer: '' };
	const server = createServer((request, response) => {
		if (request.url === DISCOVERY_PATH) {
			response.writeHead(status, { 'content-type': 'application/json' });
			response.end(body(listened.issuer));
		} else {
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	context.after(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	);
	const address = server.address();
	assert.ok(isAddress(address));
	listened.issuer = `http://127.0.0.1:${address.port}/realms/usher`;
	return listened.issuer;
};

suite("reading the issuer's discovery document", () => {
	test('gives the document when it is a JSON object naming the issuer exactly', async (context) => {
		const issuer = await providerAnswering(context, (named) =>
			JSON.stringify({ issuer: named, token_endpoint: `${named}/token` }),
		);

		const reading = await discoveryDocument(issuer);

		assert.deepEqual(reading, {
			kind: 'obtained',
			value: { issuer, token_endpoint: `${issuer}/token` },
		});
	});

	test('refuses as discoveryIssuer a document naming another issuer, the issuer with a trailing slash, or no issuer, and one that is no JSON object', async (context) => {
		const bodies: readonly ((issuer: string) => string)[] = [
			() => JSON.stringify({ issuer: ISSUER }),
			(issuer) => JSON.stringify({ issuer: `${issuer}/` }),
			() => JSON.stringify({ token_endpoint: `${ISSUER}/token` }),
			(issuer) => JSON.stringify([{ issuer }]),
			() => '{"issuer": "http://127.0.0.1/realms/',
		];

		const readings = await Promise.all(
			bodies.map(async (body) => discoveryDocument(await providerAnswering(context, body))),
		);

		assert.deepEqual(
			readings,
			bodies.map(() => ({ cause: 'discoveryIssuer', kind: 'failed' })),
		);
	});

	test('refuses as status a document answered with any status other than 200, a redirect among them', async (context) => {
		const statuses = [201, 302, 404, 503];

		const readings = await Promise.all(
			statuses.map(async (status) =>
				discoveryDocument(await providerAnswering(context, (issuer) => JSON.stringify({ issuer }), status)),
			),
		);

		assert.deepEqual(
			readings,
			statuses.map(() => ({ cause: 'status', kind: 'failed' })),
		);
	});
});

suite("an endpoint the issuer's discovery document names", () => {
	test("gives an endpoint reached over https at the issuer's origin, as a URL", () => {
		const endpoint = `${ISSUER}/protocol/openid-connect/auth`;

		const reading = issuerEndpoint(
			{ authorization_endpoint: endpoint, issuer: ISSUER },
			'authorization_endpoint',
			ISSUER,
		);

		assert.equal(reading.kind, 'obtained');
		assert.equal(reading.kind === 'obtained' ? reading.value.href : undefined, endpoint);
	});

	test("gives an endpoint reached over http at a loopback issuer's own origin", () => {
		const endpoint = `${LOOPBACK_ISSUER}/protocol/openid-connect/token`;

		const reading = issuerEndpoint({ token_endpoint: endpoint }, 'token_endpoint', LOOPBACK_ISSUER);

		assert.equal(reading.kind === 'obtained' ? reading.value.href : undefined, endpoint);
	});

	test("refuses as endpointLocation an endpoint at the issuer's origin that carries a user name or a password", () => {
		const named: readonly string[] = [
			'https://someone@auth.example.org/realms/usher/protocol/openid-connect/token',
			'https://someone:secret@auth.example.org/realms/usher/protocol/openid-connect/token',
			'https://:secret@auth.example.org/realms/usher/protocol/openid-connect/token',
		];

		const readings = named.map((endpoint) =>
			issuerEndpoint({ token_endpoint: endpoint }, 'token_endpoint', ISSUER),
		);

		assert.deepEqual(
			readings,
			named.map(() => ({ cause: 'endpointLocation', kind: 'failed' })),
		);
	});

	test('refuses as endpointLocation an endpoint missing, not a string, not a URL, or reachable neither over https nor over http to a loopback host', () => {
		const named: readonly unknown[] = [
			undefined,
			null,
			42,
			[`${ISSUER}/token`],
			{ href: `${ISSUER}/token` },
			'',
			'not a url',
			'/realms/usher/protocol/openid-connect/token',
			'http://auth.example.org/realms/usher/protocol/openid-connect/token',
			'ftp://auth.example.org/realms/usher/token',
			'javascript:alert(document.domain)',
		];

		const readings = named.map((endpoint) =>
			issuerEndpoint(endpoint === undefined ? {} : { token_endpoint: endpoint }, 'token_endpoint', ISSUER),
		);

		assert.deepEqual(
			readings,
			named.map(() => ({ cause: 'endpointLocation', kind: 'failed' })),
		);
	});

	test("refuses as endpointOrigin a secure endpoint at any origin other than the issuer's: another host, a subdomain, another port or another scheme", () => {
		const cases: readonly { endpoint: string; issuer: string }[] = [
			{ endpoint: 'https://elsewhere.example.org/token', issuer: ISSUER },
			{ endpoint: 'https://login.auth.example.org/token', issuer: ISSUER },
			{ endpoint: 'https://auth.example.org:8443/token', issuer: ISSUER },
			{ endpoint: 'http://localhost:8080/token', issuer: LOOPBACK_ISSUER },
			{ endpoint: 'http://127.0.0.1:8081/token', issuer: LOOPBACK_ISSUER },
			{ endpoint: 'https://127.0.0.1:8080/token', issuer: LOOPBACK_ISSUER },
		];

		const readings = cases.map(({ endpoint, issuer }) =>
			issuerEndpoint({ token_endpoint: endpoint }, 'token_endpoint', issuer),
		);

		assert.deepEqual(
			readings,
			cases.map(() => ({ cause: 'endpointOrigin', kind: 'failed' })),
		);
	});
});

suite("the key set's location the discovery document names", () => {
	test('gives a key set reached over https at any origin, or over http to a loopback host', () => {
		const locations = [
			'https://keys.example.net/realms/usher/certs',
			`${ISSUER}/protocol/openid-connect/certs`,
			'http://127.0.0.1:9000/certs',
			'http://localhost/certs',
			'http://[::1]:9000/certs',
		];

		const readings = locations.map((location) => keySetUrl({ issuer: ISSUER, jwks_uri: location }));

		assert.deepEqual(
			readings.map((reading) => (reading.kind === 'obtained' ? reading.value.href : reading)),
			locations,
		);
	});

	test('refuses as keySetLocation a key set missing, not a string, not a URL, or reachable neither over https nor over http to a loopback host', () => {
		const named: readonly unknown[] = [
			undefined,
			42,
			'not a url',
			'/realms/usher/certs',
			'http://auth.example.org/realms/usher/certs',
		];

		const readings = named.map((location) => keySetUrl(location === undefined ? {} : { jwks_uri: location }));

		assert.deepEqual(
			readings,
			named.map(() => ({ cause: 'keySetLocation', kind: 'failed' })),
		);
	});
});
