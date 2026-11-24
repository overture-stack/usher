import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { suite, type TestContext, test } from 'node:test';

import { decodeJwt, decodeProtectedHeader } from 'jose';

import {
	decideNomination,
	addSubmitter,
	type AdminCaller,
	administratorCaller,
	type AdminResponse,
	answerGrant,
	APPLICATION_KEY_MEMBERS,
	APPLICATION_KEY_REVOCATION_REASONS,
	applicationViewOf,
	assertConflict,
	assertCredentialRefused,
	assertForbidden,
	assertNotFound,
	assertProblemSays,
	assertRefused,
	assertRuleBroken,
	assertSucceeded,
	assertUnavailable,
	assertUnreadable,
	assertUnsupportedMediaType,
	auditPageOf,
	BACK_CHANNEL_LOGOUT_EVENT,
	backChannelLogoutUrl,
	BODY_LIMIT_BYTES,
	cacheDirectivesOf,
	categoriesOf,
	changeGrantExpiry,
	changeGrantRole,
	changeRoleCapabilities,
	comparableRefusal,
	comparableSuccess,
	createGrant,
	createSelfGrant,
	decideGrantRequest,
	defineResourceField,
	deleteResource,
	deniedEventReason,
	EXTERNAL_ID_MAXIMUM_LENGTH,
	firstUserCaller,
	GRANT_REVOCATION_REASONS,
	IDENTITY_REVOCATION_REASONS,
	instantOf,
	internalDetailIn,
	issueApplicationKey,
	issuedApplicationKeyOf,
	liftIdentityRevocation,
	listCategories,
	listedGrants,
	listGrantRequests,
	listedResources,
	listOwnGrants,
	listNominations,
	listOwnNominations,
	MANAGEMENT_ROUTES,
	managementRouteOf,
	managementRouteOfOperation,
	listPersonGrants,
	listResourceFields,
	listResourceGrants,
	listResources,
	importFromEgo,
	mintLogoutToken,
	mintManagementToken,
	namesBodyLimit,
	nextCursor,
	pageMembersBeside,
	nominate,
	personCaller,
	revokeNomination,
	PLATFORM_REVOCATION_REASONS,
	postBackChannelLogout,
	type ProblemDetails,
	PROBLEMS,
	readApiDocsContract,
	readApiDocsPage,
	readApplication,
	readAudit,
	readLiveness,
	readReadiness,
	readResource,
	registerApplication,
	registerCategory,
	registeredApplicationOf,
	registerResource,
	removeSubmitter,
	RESOURCE_REVOCATION_REASONS,
	resourceFieldsOf,
	resourceViewOf,
	RESTORATION_REASONS,
	restoreResource,
	retireResource,
	revokeApplicationKey,
	revokedApplicationKeyOf,
	revokeGlobally,
	revokeGrant,
	revokeIdentity,
	revokeResourceUsers,
	sendRaw,
	sendSlowly,
	serveResource,
	stopServingResource,
	stringsIn,
	SUPPRESSION_REASONS,
	suppressResource,
	SYSTEM_ASSIGNED_REASONS,
	updateCategory,
	updateResource,
} from './admin.js';
import { startIdentityProvider } from '../peripherals/identityProvider.js';
import { type RecordingServer, type ScriptedAnswer, startRecordingServer } from '../peripherals/recordingServer.js';

const GRANT = '3f1d9c2e-7a4b-4e1f-9b2c-5d6e7f8a9b0c';

const APPLICATION = '8b2e4f1a-6c3d-4e9b-a7f0-1d5c9e3b2a64';

const APPLICATION_KEY = 'c41a7e93-2b5f-4d08-9e6a-3f1b8d7c0e25';

const SECOND_APPLICATION_KEY = '5e0b3d72-9a1c-4f6e-8b2d-7c4a1e9f3b06';

const recording = async (context: TestContext, answer?: () => ScriptedAnswer): Promise<RecordingServer> => {
	const server = await startRecordingServer(answer);
	context.after(() => server.stop());
	return server;
};

interface Expected {
	body?: object;
	call: (caller: AdminCaller) => Promise<AdminResponse>;
	contentType?: string;
	method: string;
	name: string;
	target: string;
}

const OPERATIONS: readonly Expected[] = [
	{
		body: {
			description: 'Search for the surveillance portal',
			displayName: 'Search portal',
		},
		call: (caller) =>
			registerApplication(caller, {
				description: 'Search for the surveillance portal',
				displayName: 'Search portal',
			}),
		method: 'POST',
		name: 'registerApplication',
		target: '/admin/applications',
	},
	{
		call: (caller) => issueApplicationKey(caller, APPLICATION),
		method: 'POST',
		name: 'issueApplicationKey',
		target: `/admin/applications/${APPLICATION}/keys`,
	},
	{
		call: (caller) => revokeApplicationKey(caller, APPLICATION, APPLICATION_KEY),
		method: 'DELETE',
		name: 'revokeApplicationKey',
		target: `/admin/applications/${APPLICATION}/keys/${APPLICATION_KEY}`,
	},
	{
		body: { reason: 'compromised' },
		call: (caller) =>
			revokeApplicationKey(caller, APPLICATION, APPLICATION_KEY, {
				reason: 'compromised',
			}),
		method: 'DELETE',
		name: 'revokeApplicationKey with a reason',
		target: `/admin/applications/${APPLICATION}/keys/${APPLICATION_KEY}`,
	},
	{
		call: (caller) => readApplication(caller, 'app/1 x'),
		method: 'GET',
		name: 'readApplication',
		target: '/admin/applications/app%2F1%20x',
	},
	{
		body: {
			applications: ['arranger-clinical'],
			displayName: 'Cardiac Outcomes',
			externalId: 'STUDY-A1',
			fields: { organization: 'Institut Exemple du Sud' },
		},
		call: (caller) =>
			registerResource(caller, {
				applications: ['arranger-clinical'],
				displayName: 'Cardiac Outcomes',
				externalId: 'STUDY-A1',
				fields: { organization: 'Institut Exemple du Sud' },
			}),
		method: 'POST',
		name: 'registerResource',
		target: '/admin/resources',
	},
	{
		call: (caller) => readResource(caller, 'STUDY A/1'),
		method: 'GET',
		name: 'readResource',
		target: '/admin/resources/STUDY%20A%2F1',
	},
	{
		body: { description: null, fields: { organization: null } },
		call: (caller) =>
			updateResource(caller, 'STUDY-A1', {
				description: null,
				fields: { organization: null },
			}),
		contentType: 'application/merge-patch+json',
		method: 'PATCH',
		name: 'updateResource',
		target: '/admin/resources/STUDY-A1',
	},
	{
		call: (caller) => listResources(caller, { query: { limit: '50' } }),
		method: 'GET',
		name: 'listResources',
		target: '/admin/resources?limit=50',
	},
	{
		call: (caller) => suppressResource(caller, 'STUDY-A1'),
		method: 'POST',
		name: 'suppressResource',
		target: '/admin/resources/STUDY-A1/suppression',
	},
	{
		call: (caller) => restoreResource(caller, 'STUDY-A1'),
		method: 'POST',
		name: 'restoreResource',
		target: '/admin/resources/STUDY-A1/restoration',
	},
	{
		call: (caller) => retireResource(caller, 'STUDY-A1'),
		method: 'POST',
		name: 'retireResource',
		target: '/admin/resources/STUDY-A1/retirement',
	},
	{
		call: (caller) => deleteResource(caller, 'STUDY-A1'),
		method: 'DELETE',
		name: 'deleteResource',
		target: '/admin/resources/STUDY-A1',
	},
	{
		call: (caller) => serveResource(caller, 'STUDY-A1', 'arranger-clinical'),
		method: 'PUT',
		name: 'serveResource',
		target: '/admin/resources/STUDY-A1/applications/arranger-clinical',
	},
	{
		call: (caller) => stopServingResource(caller, 'STUDY-A1', 'arranger-clinical'),
		method: 'DELETE',
		name: 'stopServingResource',
		target: '/admin/resources/STUDY-A1/applications/arranger-clinical',
	},
	{
		body: { description: 'Controlled records', name: 'controlled' },
		call: (caller) =>
			registerCategory(caller, {
				description: 'Controlled records',
				name: 'controlled',
			}),
		method: 'POST',
		name: 'registerCategory',
		target: '/admin/categories',
	},
	{
		body: { description: 'Records under review' },
		call: (caller) =>
			updateCategory(caller, 'global.controlled', {
				description: 'Records under review',
			}),
		contentType: 'application/merge-patch+json',
		method: 'PATCH',
		name: 'updateCategory',
		target: '/admin/categories/global.controlled',
	},
	{
		call: (caller) => listCategories(caller),
		method: 'GET',
		name: 'listCategories',
		target: '/admin/categories',
	},
	{
		body: { name: 'organization' },
		call: (caller) => defineResourceField(caller, { name: 'organization' }),
		method: 'POST',
		name: 'defineResourceField',
		target: '/admin/resource-fields',
	},
	{
		call: (caller) => listResourceFields(caller),
		method: 'GET',
		name: 'listResourceFields',
		target: '/admin/resource-fields',
	},
	{
		body: {
			category: 'global.controlled',
			expiresAt: '2027-01-01T00:00:00-05:00',
			holder: { email: 'gil@example.org' },
			resource: 'STUDY-A1',
			role: 'viewer',
		},
		call: (caller) =>
			createGrant(caller, {
				category: 'global.controlled',
				expiresAt: '2027-01-01T00:00:00-05:00',
				holder: { email: 'gil@example.org' },
				resource: 'STUDY-A1',
				role: 'viewer',
			}),
		method: 'POST',
		name: 'createGrant',
		target: '/admin/grants',
	},
	{
		body: {
			holder: { email: 'bo@example.org' },
			resource: 'STUDY-A1',
			role: 'submitter',
		},
		call: (caller) => addSubmitter(caller, 'STUDY-A1', 'bo@example.org'),
		method: 'POST',
		name: 'addSubmitter',
		target: '/admin/grants',
	},
	{
		body: { email: 'bo@example.org' },
		call: (caller) => removeSubmitter(caller, 'STUDY-A1', 'bo@example.org'),
		method: 'POST',
		name: 'removeSubmitter',
		target: '/admin/resources/STUDY-A1/submitters/removal',
	},
	{
		body: {
			expiresAt: '2026-10-24T00:00:00Z',
			resource: 'STUDY-A1',
			role: 'curator',
		},
		call: (caller) =>
			createSelfGrant(caller, {
				expiresAt: '2026-10-24T00:00:00Z',
				resource: 'STUDY-A1',
				role: 'curator',
			}),
		method: 'POST',
		name: 'createSelfGrant',
		target: '/admin/grants/self',
	},
	{
		body: { decision: 'grant' },
		call: (caller) => decideGrantRequest(caller, GRANT, 'grant'),
		method: 'POST',
		name: 'decideGrantRequest',
		target: `/admin/grant-requests/${GRANT}/decisions`,
	},
	{
		call: (caller) => listGrantRequests(caller, { query: { limit: '50' } }),
		method: 'GET',
		name: 'listGrantRequests',
		target: '/admin/grant-requests?limit=50',
	},
	{
		call: (caller) => revokeGrant(caller, GRANT),
		method: 'DELETE',
		name: 'revokeGrant',
		target: `/admin/grants/${GRANT}`,
	},
	{
		body: { reason: 'left the study' },
		call: (caller) => revokeGrant(caller, GRANT, { reason: 'left the study' }),
		method: 'DELETE',
		name: 'revokeGrant with a reason',
		target: `/admin/grants/${GRANT}`,
	},
	{
		body: {
			capabilities: ['record.count', 'record.view'],
			decision: 'accept',
		},
		call: (caller) =>
			answerGrant(caller, GRANT, {
				capabilities: ['record.count', 'record.view'],
				decision: 'accept',
			}),
		method: 'POST',
		name: 'answerGrant',
		target: `/admin/grants/${GRANT}/decisions`,
	},
	{
		body: { expiresAt: null },
		call: (caller) => changeGrantExpiry(caller, GRANT, null),
		contentType: 'application/merge-patch+json',
		method: 'PATCH',
		name: 'changeGrantExpiry',
		target: `/admin/grants/${GRANT}`,
	},
	{
		body: { role: 'editor' },
		call: (caller) => changeGrantRole(caller, GRANT, 'editor'),
		contentType: 'application/merge-patch+json',
		method: 'PATCH',
		name: 'changeGrantRole',
		target: `/admin/grants/${GRANT}`,
	},
	{
		call: (caller) => listResourceGrants(caller, 'STUDY-A1'),
		method: 'GET',
		name: 'listResourceGrants',
		target: '/admin/resources/STUDY-A1/grants',
	},
	{
		body: { email: 'Bo.B@Example.org' },
		call: (caller) => listPersonGrants(caller, 'Bo.B@Example.org'),
		method: 'POST',
		name: 'listPersonGrants',
		target: '/admin/people/grants',
	},
	{
		call: (caller) => listOwnGrants(caller),
		method: 'GET',
		name: 'listOwnGrants',
		target: '/admin/me/grants',
	},
	{
		call: (caller) => listOwnNominations(caller),
		method: 'GET',
		name: 'listOwnNominations',
		target: '/admin/me/nominations',
	},
	{
		body: { nominee: { subject: 'bo-0001' } },
		call: (caller) => nominate(caller, { nominee: { subject: 'bo-0001' } }),
		method: 'POST',
		name: 'nominate',
		target: '/admin/nominations',
	},
	{
		call: (caller) => listNominations(caller),
		method: 'GET',
		name: 'listNominations',
		target: '/admin/nominations',
	},
	{
		body: { decision: 'accept' },
		call: (caller) => decideNomination(caller, GRANT, 'accept'),
		method: 'POST',
		name: 'decideNomination',
		target: `/admin/nominations/${GRANT}/decisions`,
	},
	{
		call: (caller) => revokeNomination(caller, GRANT),
		method: 'DELETE',
		name: 'revokeNomination',
		target: `/admin/nominations/${GRANT}`,
	},
	{
		body: { reason: 'compromised account', subject: 'auth0|bo+test/=' },
		call: (caller) =>
			revokeIdentity(caller, {
				reason: 'compromised account',
				subject: 'auth0|bo+test/=',
			}),
		method: 'POST',
		name: 'revokeIdentity',
		target: '/admin/people/revocations',
	},
	{
		body: { subject: 'auth0|bo+test/=' },
		call: (caller) => liftIdentityRevocation(caller, 'auth0|bo+test/='),
		method: 'POST',
		name: 'liftIdentityRevocation',
		target: '/admin/people/revocations/lifts',
	},
	{
		body: { reason: 'data breach' },
		call: (caller) => revokeResourceUsers(caller, 'STUDY-A1', { reason: 'data breach' }),
		method: 'POST',
		name: 'revokeResourceUsers',
		target: '/admin/resources/STUDY-A1/revocations',
	},
	{
		body: { confirm: true, reason: 'key compromise' },
		call: (caller) => revokeGlobally(caller, { reason: 'key compromise' }),
		method: 'POST',
		name: 'revokeGlobally',
		target: '/admin/revocations/global',
	},
	{
		body: { capabilities: ['record.view'] },
		call: (caller) => changeRoleCapabilities(caller, 'viewer', ['record.view']),
		method: 'PUT',
		name: 'changeRoleCapabilities',
		target: '/admin/roles/viewer/capabilities',
	},
	{
		call: (caller) =>
			readAudit(caller, {
				actorId: 'admin-0001',
				from: '2026-10-22T10:00:00+05:00',
				limit: 100,
				type: 'bio.overture.grant.creation',
			}),
		method: 'GET',
		name: 'readAudit',
		target: '/admin/audit?actorId=admin-0001&from=2026-10-22T10%3A00%3A00%2B05%3A00&limit=100&type=bio.overture.grant.creation',
	},
	{
		body: { audiences: [APPLICATION], export: { policies: [] } },
		call: (caller) => importFromEgo(caller, { policies: [] }, { audiences: [APPLICATION] }),
		method: 'POST',
		name: 'importFromEgo, a dry run',
		target: '/admin/imports/ego',
	},
	{
		body: {
			apply: true,
			audiences: [APPLICATION],
			export: { policies: [] },
		},
		call: (caller) => importFromEgo(caller, { policies: [] }, { apply: true, audiences: [APPLICATION] }),
		method: 'POST',
		name: 'importFromEgo, applied',
		target: '/admin/imports/ego',
	},
];

suite('the Policy Management API client', () => {
	test("sends each operation to its path, with its method, its body and the caller's token", async (context) => {
		const server = await recording(context);
		const caller: AdminCaller = { token: 'management-token', url: server.url };

		await OPERATIONS.reduce<Promise<unknown>>(async (earlier, { call }) => {
			await earlier;
			return call(caller);
		}, Promise.resolve());

		assert.deepEqual(
			server.requests.map(({ body, headers, method, target }) => ({
				authorization: headers.authorization,
				body: body === '' ? undefined : (JSON.parse(body) as unknown),
				contentType: headers['content-type'],
				method,
				target,
			})),
			OPERATIONS.map(({ body, contentType, method, target }) => ({
				authorization: 'Bearer management-token',
				body,
				contentType: body === undefined ? undefined : (contentType ?? 'application/json'),
				method,
				target,
			})),
		);
	});

	test('sends no authorization for a caller holding no token, and what a malformed-request test asks for', async (context) => {
		const server = await recording(context);

		await readResource({ token: null, url: server.url }, 'STUDY-A1');
		await registerResource(
			{ token: 'management-token', url: server.url },
			{ displayName: 'A1', externalId: 'STUDY-A1' },
			{
				extraMembers: { registeredBy: 'someone-else' },
				headers: { 'content-type': 'text/plain' },
				query: { dryRun: 'true' },
			},
		);
		await createGrant(
			{ token: 'management-token', url: server.url },
			{ holder: { subject: 'gil' }, resource: 'STUDY-A1', role: 'viewer' },
			{ body: '{"holder":{"subject":"gil"},"holder":{"subject":"admin"}}' },
		);
		const [unsigned, extra, raw] = server.requests;

		assert.equal(unsigned?.headers.authorization, undefined);
		assert.equal(extra?.target, '/admin/resources?dryRun=true');
		assert.equal(extra?.headers['content-type'], 'text/plain');
		assert.deepEqual(JSON.parse(extra?.body ?? ''), {
			displayName: 'A1',
			externalId: 'STUDY-A1',
			registeredBy: 'someone-else',
		});
		assert.equal(raw?.body, '{"holder":{"subject":"gil"},"holder":{"subject":"admin"}}');
	});

	test('reads a refusal as problem details carrying a code, and any other body as it is', async (context) => {
		const answers: ScriptedAnswer[] = [
			{
				body: JSON.stringify({
					code: 'resourceNotFound',
					status: 404,
					title: 'Not found',
				}),
				headers: { 'content-type': 'application/problem+json; charset=utf-8' },
				status: 404,
			},
			{
				body: JSON.stringify({ title: 'no code' }),
				headers: { 'content-type': 'application/problem+json' },
				status: 400,
			},
			{
				body: JSON.stringify({ externalId: 'STUDY-A1' }),
				headers: { 'content-type': 'application/json' },
				status: 200,
			},
			{
				body: 'not json',
				headers: { 'content-type': 'text/plain' },
				status: 502,
			},
		];
		const server = await recording(context, () => answers.shift() ?? { status: 500 });
		const caller: AdminCaller = { token: 'management-token', url: server.url };

		const notFound = await readResource(caller, 'STUDY-Z9');
		const codeless = await readResource(caller, 'STUDY-Z9');
		const found = await readResource(caller, 'STUDY-A1');
		const plain = await readResource(caller, 'STUDY-A1');

		assert.deepEqual(notFound.problem, {
			code: 'resourceNotFound',
			status: 404,
			title: 'Not found',
		});
		assert.equal(codeless.problem, undefined);
		assert.deepEqual(codeless.body, { title: 'no code' });
		assert.deepEqual(found.body, { externalId: 'STUDY-A1' });
		assert.equal(found.problem, undefined);
		assert.equal(plain.body, undefined);
		assert.equal(plain.text, 'not json');
	});
});

suite("the Management API's routes", () => {
	test("matches every admin operation of the client to the contract's route for its method, a literal segment before a parameter", () => {
		const admin = OPERATIONS.filter(({ target }) => target.startsWith('/admin/'));

		admin.forEach(({ method, name, target }) =>
			assert.ok(managementRouteOf(method, target), `${name} reaches a route`),
		);
		assert.deepEqual(
			[
				['POST', '/admin/grants/self'],
				['DELETE', `/admin/grants/${GRANT}`],
				['GET', '/admin/resources/STUDY-A1/grants?limit=2'],
				['PUT', `/admin/resources/STUDY%20A1/applications/${APPLICATION}`],
			].map(([method = '', target = '']) => managementRouteOf(method, target)),
			[
				{ method: 'POST', route: '/admin/grants/self' },
				{ method: 'DELETE', route: '/admin/grants/{grantId}' },
				{ method: 'GET', route: '/admin/resources/{externalId}/grants' },
				{
					method: 'PUT',
					route: '/admin/resources/{externalId}/applications/{applicationId}',
				},
			],
		);
		assert.equal(managementRouteOf('GET', '/admin/grants'), undefined);
		assert.equal(managementRouteOf('POST', '/backchannel-logout'), undefined);
		assert.equal(
			new Set(MANAGEMENT_ROUTES.map(({ method, route }) => `${method} ${route}`)).size,
			MANAGEMENT_ROUTES.length,
		);
	});

	test("reads an operation's route from the request it sends, reaching no controller", async () => {
		assert.deepEqual(await managementRouteOfOperation((caller) => revokeGrant(caller, GRANT)), {
			method: 'DELETE',
			route: '/admin/grants/{grantId}',
		});
		assert.deepEqual(
			await managementRouteOfOperation((caller) =>
				createSelfGrant(caller, {
					category: 'global.controlled',
					expiresAt: '2026-11-04T12:00:00Z',
					resource: 'STUDY-A1',
					role: 'viewer',
				}),
			),
			{ method: 'POST', route: '/admin/grants/self' },
		);
	});
});

suite('the back-channel logout endpoint', () => {
	test('receives a logout token form-encoded as one logout_token parameter, with no authorization', async (context) => {
		const server = await recording(context);

		await postBackChannelLogout(server.url, 'header.payload.signature');
		await postBackChannelLogout(server.url, 'header.payload.signature', {
			body: '{"logout_token":"header.payload.signature"}',
			headers: { 'content-type': 'application/json' },
			query: { logout_token: 'header.payload.signature' },
		});
		const [form, json] = server.requests;

		assert.equal(form?.method, 'POST');
		assert.equal(form?.target, '/backchannel-logout');
		assert.equal(form?.headers['content-type'], 'application/x-www-form-urlencoded');
		assert.equal(form?.headers.authorization, undefined);
		assert.equal(form?.body, 'logout_token=header.payload.signature');
		assert.equal(json?.target, '/backchannel-logout?logout_token=header.payload.signature');
		assert.equal(json?.headers['content-type'], 'application/json');
	});

	test("mints a logout token as Back-Channel Logout has it, carrying none of an access token's claims", async (context) => {
		const provider = await startIdentityProvider();
		context.after(() => provider.stop());

		const token = await mintLogoutToken(provider, {
			audience: 'portal-test',
			sessionId: 'session-1',
			subject: 'ana-subject',
		});
		const claims = decodeJwt(token);

		assert.deepEqual(Object.keys(claims).sort(), ['aud', 'events', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
		assert.deepEqual(claims.aud, ['portal-test']);
		assert.deepEqual(claims['events'], { [BACK_CHANNEL_LOGOUT_EVENT]: {} });
		assert.equal(claims.sub, 'ana-subject');
		assert.equal(claims['sid'], 'session-1');
		assert.equal(decodeProtectedHeader(token).typ, 'logout+jwt');
		assert.equal((claims.exp ?? 0) - (claims.iat ?? 0), 120);
	});
});

suite('management tokens', () => {
	test('address the management API from the first management client, and carry the first-user role only for the first user', async (context) => {
		const provider = await startIdentityProvider();
		context.after(() => provider.stop());
		const configuration = {
			firstUserRole: 'ims-usher-first-user',
			managementAudience: 'usher-management-test',
			managementClients: ['usher-ui-test', 'usher-cli-test'],
		};
		const person = { email: 'admin.one@example.org', subject: 'admin-0001' };

		const administrator = decodeJwt(
			await mintManagementToken(provider, configuration, person, {
				firstUser: true,
			}),
		);
		const owner = decodeJwt(
			await mintManagementToken(provider, configuration, {
				email: 'owner.ana@example.org',
				subject: 'ana-subject',
			}),
		);

		assert.deepEqual(administrator.aud, ['usher-management-test']);
		assert.equal(administrator['azp'], 'usher-ui-test');
		assert.equal(administrator.sub, 'admin-0001');
		assert.deepEqual(administrator['realm_access'], {
			roles: ['default-roles-usher-test', 'offline_access', 'uma_authorization', 'ims-usher-first-user'],
		});
		assert.deepEqual(owner['realm_access'], {
			roles: ['default-roles-usher-test', 'offline_access', 'uma_authorization'],
		});
		assert.equal(owner['email'], 'owner.ana@example.org');
	});
});

suite('reading what an operation answered', () => {
	test("carries a created grant's id from the answer's body, and none when the body names none", async (context) => {
		const answers: ScriptedAnswer[] = [
			{
				body: JSON.stringify({ id: GRANT, role: 'viewer' }),
				headers: { 'content-type': 'application/json' },
				status: 201,
			},
			{
				body: JSON.stringify({ code: 'alreadyHolds' }),
				headers: { 'content-type': 'application/problem+json' },
				status: 409,
			},
		];
		const server = await recording(context, () => answers.shift() ?? { status: 500 });
		const caller: AdminCaller = { token: 'management-token', url: server.url };
		const creation = {
			category: 'global.controlled',
			holder: { subject: 'gil' },
			resource: 'STUDY-A1',
			role: 'viewer',
		};

		const created = await createGrant(caller, creation);
		const refused = await createGrant(caller, creation);

		assert.equal(created.grantId, GRANT);
		assert.equal(created.status, 201);
		assert.equal(refused.grantId, undefined);
		assert.doesNotThrow(() => assertSucceeded(created, 'creating the grant'));
		assert.throws(() => assertSucceeded(refused, 'creating the grant'), {
			message: 'creating the grant was answered 409 alreadyHolds',
		});
	});

	test("gives the back-channel logout endpoint's URL, relative to the controller's", () => {
		assert.equal(
			backChannelLogoutUrl(new URL('http://127.0.0.1:8443/usher/')).href,
			'http://127.0.0.1:8443/usher/backchannel-logout',
		);
	});
});

suite('the API documentation page', () => {
	test('asks for the page and its contract at their paths, with no credential', async (context) => {
		const server = await recording(context, () => ({ status: 404 }));

		const page = await readApiDocsPage(server.url);
		const contract = await readApiDocsContract(server.url);

		assert.deepEqual(
			server.requests.map(({ headers, method, target }) => ({
				authorization: headers.authorization,
				method,
				target,
			})),
			[
				{ authorization: undefined, method: 'GET', target: '/api-docs' },
				{
					authorization: undefined,
					method: 'GET',
					target: '/api-docs/openapi.json',
				},
			],
		);
		assert.deepEqual([page.status, contract.status], [404, 404]);
	});
});

suite('the health endpoints', () => {
	test('asks for readiness and liveness at their paths, with no credential', async (context) => {
		const server = await recording(context, () => ({ status: 503 }));

		const ready = await readReadiness(server.url);
		const live = await readLiveness(server.url);

		assert.deepEqual(
			server.requests.map(({ headers, method, target }) => ({
				authorization: headers.authorization,
				method,
				target,
			})),
			[
				{ authorization: undefined, method: 'GET', target: '/health/ready' },
				{ authorization: undefined, method: 'GET', target: '/health/live' },
			],
		);
		assert.equal(ready.status, 503);
		assert.equal(live.status, 503);
	});
});

const answersTo = async (
	context: TestContext,
	scripted: readonly ScriptedAnswer[],
): Promise<readonly AdminResponse[]> => {
	const server = await recording(
		context,
		(() => {
			const queue = [...scripted];
			return () => queue.shift() ?? { status: 500 };
		})(),
	);
	const caller: AdminCaller = { token: 'management-token', url: server.url };
	return [...scripted.keys()].reduce<Promise<readonly AdminResponse[]>>(
		async (earlier, index) => [...(await earlier), await readResource(caller, `STUDY-${index}`)],
		Promise.resolve([]),
	);
};

const refusal = (
	status: number,
	body: Readonly<Record<string, unknown>>,
	headers: Readonly<Record<string, string>> = {},
): ScriptedAnswer => ({
	body: JSON.stringify(body),
	headers: { 'content-type': 'application/problem+json', ...headers },
	status,
});

const json = (body: unknown, headers: Readonly<Record<string, string>> = {}): ScriptedAnswer => ({
	body: JSON.stringify(body),
	headers: { 'content-type': 'application/json', ...headers },
	status: 200,
});

suite('the problem codes and reason vocabularies', () => {
	test('holds every code C2 and the rulings name, each with its status', () => {
		const byStatus = Object.values(PROBLEMS).reduce<Readonly<Record<number, readonly string[]>>>(
			(grouped, { code, status }) => ({
				...grouped,
				[status]: [...(grouped[status] ?? []), code].toSorted(),
			}),
			{},
		);

		assert.deepEqual(byStatus, {
			403: [
				'administratorGrantsNoConsumerAccess',
				'administratorOnly',
				'administratorSelfOwnership',
				'noAdministratorYet',
				'noAuthorityOnResource',
				'notFirstUser',
				'ownRequest',
				'ownersAndAdministratorsOnly',
				'selfWideningNotPermitted',
				'serviceAccountNotPermitted',
			],
			404: [
				'administratorNotFound',
				'applicationKeyNotFound',
				'applicationNotFound',
				'grantNotFound',
				'holderNotFound',
				'nominationNotFound',
				'nomineeNotFound',
				'requestNotFound',
				'resourceNotFound',
			],
			409: [
				'alreadyExists',
				'alreadyHolds',
				'alreadyRequested',
				'applicationKeyLimit',
				'doesNotHold',
				'grantReplaced',
				'grantsOrInvitationsRemain',
				'importInProgress',
				'lastAdministrator',
				'nominationAlreadyDecided',
				'nominationReplaced',
				'nominationRevoked',
				'nomineeAlreadyAdministrator',
				'nomineeAlreadyNominated',
				'requestDecided',
				'requestLapsed',
				'resourceNeedsAnOwner',
			],
			413: ['bodyTooLarge'],
			415: ['unsupportedMediaType'],
			422: [
				'importNeedsAnAudience',
				'orphanedResourceExpiryRequired',
				'orphanedResourceGrantTooLong',
				'ownerGrantsDoNotExpire',
				'registrationHasHistory',
				'selfGrantExpiryRequired',
				'selfGrantTooLong',
				'unknownApplication',
				'unknownDecision',
			],
			503: ['directoryNotConfigured', 'directoryUnavailable', 'importNotConfigured', 'storeUnavailable'],
		});
		assert.ok(Object.entries(PROBLEMS).every(([name, { code }]) => name === code));
	});

	test('keeps the system-assigned reasons apart from every reason a caller may give', () => {
		const vocabularies = {
			applicationKey: APPLICATION_KEY_REVOCATION_REASONS,
			grant: GRANT_REVOCATION_REASONS,
			identity: IDENTITY_REVOCATION_REASONS,
			platform: PLATFORM_REVOCATION_REASONS,
			resource: RESOURCE_REVOCATION_REASONS,
			restoration: RESTORATION_REASONS,
			suppression: SUPPRESSION_REASONS,
		};
		const accepted = Object.fromEntries(
			Object.entries(vocabularies).map(([name, reasons]) => [name, Object.values(reasons).toSorted()]),
		);

		assert.deepEqual(accepted, {
			applicationKey: ['compromised', 'retired', 'rotated'],
			grant: [
				'accessNoLongerNeeded',
				'accessReview',
				'custodianRequest',
				'grantedInError',
				'holderLeftProject',
				'requestedByHolder',
				'termsViolation',
			],
			identity: ['accountClosed', 'credentialCompromise', 'securityIncident', 'termsViolation'],
			platform: ['credentialCompromise', 'keyCompromise', 'securityIncident'],
			resource: ['credentialCompromise', 'custodianRequest', 'keyCompromise', 'securityIncident'],
			restoration: ['custodianRequest', 'issueResolved'],
			suppression: [
				'consentWithdrawn',
				'custodianRequest',
				'dataQualityIssue',
				'legalRequest',
				'securityIncident',
			],
		});
		assert.deepEqual(Object.values(SYSTEM_ASSIGNED_REASONS).toSorted(), ['resourceRetired', 'unspecified']);
		assert.ok(
			Object.values(vocabularies)
				.flatMap((reasons) => Object.entries(reasons))
				.every(
					([name, reason]) =>
						name === reason && !Object.values<string>(SYSTEM_ASSIGNED_REASONS).includes(reason),
				),
		);
	});

	test('records noAuthorityOnResource where a not-found answer hid a refusal of authority, and the code received otherwise', () => {
		assert.equal(deniedEventReason('resourceNotFound', true), 'noAuthorityOnResource');
		assert.equal(deniedEventReason('grantNotFound', true), 'noAuthorityOnResource');
		assert.equal(deniedEventReason('resourceNotFound', false), 'resourceNotFound');
		assert.equal(deniedEventReason('grantNotFound', false), 'grantNotFound');
		assert.equal(deniedEventReason('administratorOnly', true), 'administratorOnly');
	});
});

suite('reading what the API answers', () => {
	test('reads a resource with its registrant as an object, its lists sorted and a cleared description as null', async (context) => {
		const [registered, other] = await answersTo(context, [
			json({
				accessLevel: 'grant',
				applications: ['lyric-test', 'arranger-test'],
				categories: ['resource.panel', 'resource.board'],
				displayName: 'Cardiac Outcomes',
				externalId: 'STUDY-A1',
				fields: { organization: 'Institut Exemple du Sud' },
				registeredAt: '2026-10-01T12:00:00Z',
				registeredBy: { subject: 'admin-0001' },
				suppressed: false,
				updatedAt: '2026-10-02T12:00:00+02:00',
			}),
			json(['not', 'an', 'object']),
		]);
		assert.ok(registered);
		assert.ok(other);

		const view = resourceViewOf(registered, 'registering STUDY-A1');

		assert.deepEqual(view.applications, ['arranger-test', 'lyric-test']);
		assert.deepEqual(view.categories, ['resource.board', 'resource.panel']);
		assert.equal(view.description, null);
		assert.equal(view.registrantSubject, 'admin-0001');
		assert.deepEqual(view.fields, { organization: 'Institut Exemple du Sud' });
		assert.equal(view.grants, undefined);
		assert.throws(() => resourceViewOf(other, 'a list'), {
			message: 'a list answered no JSON object',
		});
	});

	test("reads a listing's page, its cursor, and any member a page never holds", async (context) => {
		const [first, last] = await answersTo(context, [
			json({
				next: 'cursor-2',
				resources: [
					{
						externalId: 'STUDY-A1',
						grantSummary: { owner: 1, viewer: 0 },
						grants: [
							{
								grantedBy: { name: 'Ana Example' },
								holder: { hasAccount: false, subject: 'gone-0001' },
								id: 'grant-1',
								state: 'accepted',
							},
						],
					},
				],
				total: 9,
			}),
			json({ grants: [{ id: 'grant-2', state: 'pending' }], next: null }),
		]);
		assert.ok(first);
		assert.ok(last);

		const [resource] = listedResources(first);
		const [grant] = resource?.grants ?? [];

		assert.equal(nextCursor(first), 'cursor-2');
		assert.equal(nextCursor(last), undefined);
		assert.deepEqual(pageMembersBeside(first, 'resources'), ['total']);
		assert.deepEqual(pageMembersBeside(last, 'grants'), []);
		assert.equal(grant?.granterName, 'Ana Example');
		assert.equal(grant?.holder?.hasAccount, false);
		assert.deepEqual(
			listedGrants(last).map(({ id, state }) => ({ id, state })),
			[{ id: 'grant-2', state: 'pending' }],
		);
	});

	test('reads the category and field listings, sorted by name, and an audit page', async (context) => {
		const [categories, fields, audit] = await answersTo(context, [
			json({
				categories: [
					{ description: 'Controlled', name: 'global.controlled' },
					{ name: 'global.community-governed' },
				],
			}),
			json({ fields: [{ description: 'Who runs it', name: 'organization' }] }),
			json({ events: [{ id: 'event-1' }], next: 'cursor-3' }),
		]);
		assert.ok(categories);
		assert.ok(fields);
		assert.ok(audit);

		assert.deepEqual(categoriesOf(categories), [
			{ description: null, name: 'global.community-governed' },
			{ description: 'Controlled', name: 'global.controlled' },
		]);
		assert.deepEqual(resourceFieldsOf(fields), [{ description: 'Who runs it', name: 'organization' }]);
		assert.deepEqual(auditPageOf(audit), {
			events: [{ id: 'event-1' }],
			next: 'cursor-3',
		});
	});

	test('reads an instant only when it is in UTC, ending in Z', () => {
		assert.equal(instantOf('2026-10-01T12:00:00Z'), Date.UTC(2026, 9, 1, 12, 0, 0));
		assert.equal(instantOf('2026-10-01T12:00:00.250Z'), Date.UTC(2026, 9, 1, 12, 0, 0, 250));
		[
			null,
			undefined,
			1_790_000_000,
			'2026-10-01',
			'2026-10-01T12:00:00',
			'2026-10-01T14:00:00.250+02:00',
			'2026-10-01T12:00:00+00:00',
			'2026-10-01T12:00:00z',
		].forEach((value) => {
			assert.throws(() => instantOf(value, 'expiresAt'), {
				message: 'expiresAt is no UTC instant ending in Z',
			});
		});
	});

	test('finds every member name and every scalar of a parsed value, at any depth', () => {
		assert.deepEqual(
			stringsIn({
				holder: { subject: 'a"b\\c' },
				list: [1, true, null, 'x'],
			}),
			['holder', 'subject', 'a"b\\c', 'list', '1', 'true', 'x'],
		);
	});
});

suite('reading what the application operations answer', () => {
	test("reads a registration's answer and an issue's, the key's value included, and fails one missing a member or holding one of another type", async (context) => {
		const value = randomBytes(32).toString('base64url');
		const key = { id: APPLICATION_KEY, value };
		const [registered, undescribed, numericValue, issued] = await answersTo(context, [
			json({
				description: null,
				displayName: 'Search portal',
				id: APPLICATION,
				key,
			}),
			json({ displayName: 'Search portal', id: APPLICATION, key }),
			json({
				description: 'Search',
				displayName: 'Search portal',
				id: APPLICATION,
				key: { id: APPLICATION_KEY, value: 7 },
			}),
			json(key),
		]);
		assert.ok(registered);
		assert.ok(undescribed);
		assert.ok(numericValue);
		assert.ok(issued);

		assert.deepEqual(registeredApplicationOf(registered, 'registering'), {
			description: null,
			displayName: 'Search portal',
			id: APPLICATION,
			key,
		});
		assert.throws(() => registeredApplicationOf(undescribed, 'registering'), {
			message: 'registering answered no string description',
		});
		assert.throws(() => registeredApplicationOf(numericValue, 'registering'), {
			message: 'registering, its key answered no string value',
		});
		assert.deepEqual(issuedApplicationKeyOf(issued, 'issuing'), key);
	});

	test("reads an application's keys in the answer's order with every member held by each, and a revocation's answer", async (context) => {
		const live = {
			confirmedAt: null,
			id: APPLICATION_KEY,
			issuedAt: '2026-11-03T12:00:00Z',
			issuedBy: { subject: 'admin-0001' },
			revokedAt: null,
			revokedBy: null,
		};
		const [read, revoked] = await answersTo(context, [
			json({
				description: 'Search',
				displayName: 'Search portal',
				id: APPLICATION,
				keys: [
					live,
					{
						...live,
						id: SECOND_APPLICATION_KEY,
						value: 'a value no answer holds',
					},
				],
				registeredAt: '2026-11-03T12:00:00Z',
				registeredBy: { subject: 'admin-0001' },
			}),
			json({
				id: APPLICATION_KEY,
				revokedAt: '2026-11-03T13:00:00Z',
				revokedBy: { subject: 'admin-0001' },
			}),
		]);
		assert.ok(read);
		assert.ok(revoked);

		const view = applicationViewOf(read, 'reading');
		const [first, second] = view.keys ?? [];

		assert.deepEqual(view.registeredBy, { subject: 'admin-0001' });
		assert.deepEqual(
			(view.keys ?? []).map(({ id }) => id),
			[APPLICATION_KEY, SECOND_APPLICATION_KEY],
		);
		assert.deepEqual(first?.members, APPLICATION_KEY_MEMBERS);
		assert.equal(first?.revokedBy, null);
		assert.deepEqual(second?.members, [...APPLICATION_KEY_MEMBERS, 'value']);
		assert.deepEqual(revokedApplicationKeyOf(revoked, 'revoking'), {
			id: APPLICATION_KEY,
			members: ['id', 'revokedAt', 'revokedBy'],
			revokedAt: '2026-11-03T13:00:00Z',
			revokedBy: { subject: 'admin-0001' },
		});
	});

	test("reads Cache-Control's directives lower-cased and without their arguments, and none from an answer without the header", async (context) => {
		const [storing, plain] = await answersTo(context, [
			json({}, { 'cache-control': 'No-Store, max-age=0' }),
			json({}),
		]);
		assert.ok(storing);
		assert.ok(plain);

		assert.deepEqual(cacheDirectivesOf(storing), ['no-store', 'max-age']);
		assert.deepEqual(cacheDirectivesOf(plain), []);
	});
});

suite('comparing two answers', () => {
	test('tells two refusals apart by anything but their instance', async (context) => {
		const body = { code: 'resourceNotFound', status: 404, title: 'Not found' };
		const [first, second, otherBody, otherChallenge, otherMedia] = await answersTo(context, [
			refusal(404, { ...body, instance: '/requests/1' }),
			refusal(404, { ...body, instance: '/requests/2' }),
			refusal(404, { ...body, detail: 'STUDY-A1 is not visible to you' }),
			refusal(404, body, { 'www-authenticate': 'Bearer' }),
			{
				body: JSON.stringify(body),
				headers: { 'content-type': 'application/json' },
				status: 404,
			},
		]);
		assert.ok(first && second && otherBody && otherChallenge && otherMedia);

		assert.deepEqual(comparableRefusal(first), comparableRefusal(second));
		[otherBody, otherChallenge, otherMedia].forEach((other) => {
			assert.notDeepEqual(comparableRefusal(other), comparableRefusal(first));
		});
	});

	test('tells two successful answers apart by a header sent for one alone, and not by the values they carry', async (context) => {
		const [held, unheld, located] = await answersTo(context, [
			json({ added: true, id: 'one' }),
			json({ added: false, id: 'two' }),
			json({ added: true, id: 'three' }, { location: '/admin/grants/three' }),
		]);
		assert.ok(held && unheld && located);

		assert.deepEqual(comparableSuccess(held), comparableSuccess(unheld));
		assert.notDeepEqual(comparableSuccess(located), comparableSuccess(unheld));
	});
});

suite("C2's refusals, asserted", () => {
	test('accepts each refusal of its status and code, and fails one of another', async (context) => {
		const answers = await answersTo(context, [
			refusal(400, { code: 'unreadableBody' }),
			refusal(401, { code: 'refusedCredential' }, { 'www-authenticate': 'Bearer realm="usher"' }),
			refusal(403, { code: 'administratorOnly' }),
			refusal(404, { code: 'grantNotFound' }),
			refusal(409, {
				code: 'resourceNeedsAnOwner',
				detail: 'Add another owner first.',
			}),
			refusal(415, { code: 'unsupportedMediaType' }),
			refusal(422, { code: 'ownerGrantsDoNotExpire' }),
			refusal(503, { code: 'directoryUnavailable' }),
		]);
		const [unreadable, refused, forbidden, notFound, conflict, media, rule, unavailable] = answers;
		assert.ok(unreadable && refused && forbidden && notFound && conflict);
		assert.ok(media && rule && unavailable);

		assertUnreadable(unreadable, 'a body of the wrong shape');
		assertCredentialRefused(refused, 'an expired token');
		assertForbidden(forbidden, 'a retirement by an owner', 'administratorOnly');
		assertNotFound(notFound, "another's grant", 'grantNotFound');
		assertConflict(conflict, 'the last owner revoked', 'resourceNeedsAnOwner');
		assertProblemSays(conflict, /another owner/u, 'the last owner revoked');
		assertUnsupportedMediaType(media, 'a text body');
		assertRuleBroken(rule, 'an expiring owner grant', 'ownerGrantsDoNotExpire');
		assertRuleBroken(rule, 'an expiring owner grant');
		assertUnavailable(unavailable, 'an address lookup', 'directoryUnavailable');
		assert.throws(() => assertNotFound(forbidden, 'a forbidden answer', 'resourceNotFound'));
		assert.throws(() => assertForbidden(forbidden, 'another code', 'noAuthorityOnResource'));
	});

	test('requires problem details carrying a code, and the Bearer scheme on a 401', async (context) => {
		const [plain, codeless, unchallenged] = await answersTo(context, [
			{
				body: '{"code":"administratorOnly"}',
				headers: { 'content-type': 'application/json' },
				status: 403,
			},
			refusal(403, { title: 'Forbidden' }),
			refusal(401, { code: 'refusedCredential' }),
		]);
		assert.ok(plain && codeless && unchallenged);

		assert.throws(() => assertRefused(plain, { status: 403 }, 'plain JSON'), {
			message: /media type/u,
		});
		assert.throws(() => assertRefused(codeless, { status: 403 }, 'no code'), {
			message: /a problem's code/u,
		});
		assert.throws(() => assertCredentialRefused(unchallenged, 'no challenge'), {
			message: /Bearer scheme/u,
		});
	});
});

interface RawReceived {
	body: string;
	method: string;

	/** Every header line as sent, name and value, in order. */
	rawHeaders: readonly string[];

	target: string;
}

const rawRecording = async (context: TestContext): Promise<{ received: readonly RawReceived[]; url: URL }> => {
	const received: RawReceived[] = [];
	const server = createServer((incoming, outgoing) => {
		const chunks: Buffer[] = [];
		incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
		incoming.on('end', () => {
			received.push({
				body: Buffer.concat(chunks).toString('utf8'),
				method: incoming.method ?? '',
				rawHeaders: incoming.rawHeaders,
				target: incoming.url ?? '',
			});
			outgoing.writeHead(415, { 'content-type': 'application/problem+json' });
			outgoing.end(JSON.stringify({ code: 'unsupportedMediaType' }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const { port } = server.address() as AddressInfo;
	return { received, url: new URL(`http://127.0.0.1:${port}/`) };
};

const linesNamed = (raw: readonly string[], name: string): readonly string[] =>
	raw.flatMap((value, index) => (index % 2 === 1 && raw[index - 1]?.toLowerCase() === name ? [value] : []));

suite('a request fetch cannot send', () => {
	test("sends two authorization lines, no content-type at all, or any media type, keeping the operation's path and body", async (context) => {
		const server = await rawRecording(context);
		const caller: AdminCaller = { token: 'management-token', url: server.url };
		const grant = (recorded: AdminCaller): Promise<AdminResponse> =>
			createGrant(recorded, {
				holder: { subject: 'gil' },
				resource: 'STUDY-A1',
				role: 'viewer',
			});

		const twice = await sendRaw(caller, grant, {
			authorizations: ['Bearer management-token', 'Bearer management-token'],
		});
		await sendRaw(caller, grant, { contentType: null });
		await sendRaw(caller, grant, { contentType: 'text/plain' });
		const [doubled, untyped, typed] = server.received;

		assert.deepEqual(linesNamed(doubled?.rawHeaders ?? [], 'authorization'), [
			'Bearer management-token',
			'Bearer management-token',
		]);
		assert.deepEqual(linesNamed(untyped?.rawHeaders ?? [], 'content-type'), []);
		assert.deepEqual(linesNamed(untyped?.rawHeaders ?? [], 'authorization'), ['Bearer management-token']);
		assert.deepEqual(linesNamed(typed?.rawHeaders ?? [], 'content-type'), ['text/plain']);
		assert.deepEqual(
			server.received.map(({ body, method, target }) => ({
				body: JSON.parse(body) as unknown,
				method,
				target,
			})),
			Array.from({ length: 3 }, () => ({
				body: {
					holder: { subject: 'gil' },
					resource: 'STUDY-A1',
					role: 'viewer',
				},
				method: 'POST',
				target: '/admin/grants',
			})),
		);
		assertUnsupportedMediaType(twice, 'the replayed answer');
	});
});

// A server answering each request as it is told: at once, before reading its body, or once it has
// read all of it; it records each request's method, target, headers and the bytes it read.
const bodyReader = async (
	context: TestContext,
	answers: 'atOnce' | 'afterBody',
): Promise<{ received: readonly RawReceived[]; url: URL }> => {
	const received: RawReceived[] = [];
	const server = createServer((incoming, outgoing) => {
		const chunks: Buffer[] = [];
		const record = (): void => {
			received.push({
				body: Buffer.concat(chunks).toString('utf8'),
				method: incoming.method ?? '',
				rawHeaders: incoming.rawHeaders,
				target: incoming.url ?? '',
			});
		};
		incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
		if (answers === 'atOnce') {
			record();
			outgoing.writeHead(401, {
				'content-type': 'application/problem+json',
				'www-authenticate': 'Bearer',
			});
			outgoing.end(JSON.stringify({ code: 'unauthenticated' }));
			return;
		}
		incoming.on('end', () => {
			record();
			outgoing.writeHead(200, { 'content-type': 'application/json' });
			outgoing.end(JSON.stringify({ read: Buffer.concat(chunks).length }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const { port } = server.address() as AddressInfo;
	return { received, url: new URL(`http://127.0.0.1:${port}/`) };
};

suite('a large body sent slowly', () => {
	const body = new Uint8Array(512 * 1024).fill(0x20);
	const importRequest = (recorded: AdminCaller): Promise<AdminResponse> =>
		importFromEgo(recorded, { formatVersion: 1 }, { audiences: [APPLICATION] });

	test("sends the operation's headers at once, and tells an answer arriving before the body ended", async (context) => {
		const server = await bodyReader(context, 'atOnce');
		const caller: AdminCaller = { token: null, url: server.url };

		const sent = await sendSlowly(caller, importRequest, {
			authorizations: [],
			body,
			chunkBytes: 64 * 1024,
			intervalMs: 30,
		});
		const [request] = server.received;

		assert.equal(sent.status, 401);
		assert.equal(sent.problem?.code, 'unauthenticated');
		assert.equal(sent.answeredBeforeBodyEnded, true);
		assert.ok(sent.bytesSentBeforeAnswer < sent.bodyBytes);
		assert.equal(sent.bodyBytes, body.byteLength);
		assert.equal(request?.method, 'POST');
		assert.equal(request?.target, '/admin/imports/ego');
		assert.deepEqual(linesNamed(request?.rawHeaders ?? [], 'authorization'), []);
		assert.deepEqual(linesNamed(request?.rawHeaders ?? [], 'content-length'), [String(body.byteLength)]);
	});

	test('tells an answer that waited for the whole body, every byte of it read', async (context) => {
		const server = await bodyReader(context, 'afterBody');
		const caller: AdminCaller = { token: 'management-token', url: server.url };

		const sent = await sendSlowly(caller, importRequest, {
			body,
			chunkBytes: 64 * 1024,
			intervalMs: 10,
		});

		assert.equal(sent.status, 200);
		assert.deepEqual(sent.body, { read: body.byteLength });
		assert.equal(sent.answeredBeforeBodyEnded, false);
		assert.equal(sent.bytesSentBeforeAnswer, body.byteLength);
		assert.deepEqual(linesNamed(server.received[0]?.rawHeaders ?? [], 'authorization'), [
			'Bearer management-token',
		]);
	});

	test('allows the EGO import 10 MiB of body and every other endpoint 64 KiB (ruled)', () => {
		assert.deepEqual(BODY_LIMIT_BYTES, {
			egoImport: 10 * 1024 * 1024,
			everyOther: 64 * 1024,
		});
	});

	test("finds a body limit in a refusal's detail as its number of bytes standing alone, and nowhere else", () => {
		const refusal = (detail?: string): ProblemDetails => ({
			code: PROBLEMS.bodyTooLarge.code,
			...(detail === undefined ? {} : { detail }),
		});

		assert.equal(namesBodyLimit(refusal('a body is read up to 65536 bytes'), BODY_LIMIT_BYTES.everyOther), true);
		assert.equal(namesBodyLimit(refusal('a body is read up to 655360 bytes'), BODY_LIMIT_BYTES.everyOther), false);
		assert.equal(namesBodyLimit(refusal('the body is too large'), 65_536), false);
		assert.equal(namesBodyLimit(refusal(), 65_536), false);
		assert.equal(namesBodyLimit(undefined, 65_536), false);
		assert.equal(PROBLEMS.bodyTooLarge.status, 413);
	});

	test('holds the longest externalId #211 allows in one place: 128 characters', () => {
		assert.equal(EXTERNAL_ID_MAXIMUM_LENGTH, 128);
	});
});

suite('internal detail in an answer', () => {
	test("finds PostgreSQL's and a JSON parser's own wording and an internal id, and no plain English", () => {
		const leaks = [
			'duplicate key value violates unique constraint "resources_external_id_key"',
			'new row violates check constraint "grants_holder_check"',
			'null value in column "name" of relation "resources" violates not-null constraint',
			'Key (external_id)=(STUDY-A1) already exists.',
			'Unexpected end of JSON input',
			'Unexpected token \'o\', "not json" is not valid JSON',
			'Unexpected token o in JSON at position 1',
			'error: SELECT id FROM usher.resources',
			'at createGrant (/srv/app/src/grants.ts:42:7)\n    at process',
		];
		const plain = [
			'The description violates the length rule.',
			'Revoke the remaining grants and invitations first.',
			'Select a resource from the list.',
			'The token is unexpected here.',
		];
		const id = '3F1D9C2E-7A4B-4E1F-9B2C-5D6E7F8A9B0C';

		leaks.forEach((text) => {
			assert.ok(internalDetailIn(text).length > 0, text);
		});
		plain.forEach((text) => {
			assert.deepEqual(internalDetailIn(text), [], text);
		});
		assert.deepEqual(internalDetailIn(`grant ${id.toLowerCase()} refused`, [id]), [id]);
	});
});

suite('callers', () => {
	test("gives an administrator's, the first user's and a person's token for the harness's controller, or another instance", async () => {
		const minted: string[] = [];
		const harness = {
			tokens: {
				administrator: async (person: { subject: string }) => {
					minted.push(`administrator ${person.subject}`);
					return 'administrator-token';
				},
				firstUser: async (person: { subject: string }) => {
					minted.push(`first user ${person.subject}`);
					return 'first-user-token';
				},
				management: async (person: { subject: string }) => {
					minted.push(`person ${person.subject}`);
					return 'person-token';
				},
				signIn: async () => 'sign-in-token',
			},
			url: new URL('http://127.0.0.1:1/'),
		};
		const beside = new URL('http://127.0.0.1:2/');

		const administrator = await administratorCaller(harness);
		const elsewhere = await administratorCaller(harness, {
			person: { email: 'eli@example.org', subject: 'eli-0001' },
			url: beside,
		});
		const person = await personCaller(harness, {
			email: 'bo@example.org',
			subject: 'bo-0001',
		});
		const firstUser = await firstUserCaller(
			harness,
			{ email: 'ana@example.org', subject: 'ana-0001' },
			{ url: beside },
		);

		assert.deepEqual(administrator, {
			token: 'administrator-token',
			url: harness.url,
		});
		assert.deepEqual(elsewhere, { token: 'administrator-token', url: beside });
		assert.deepEqual(person, { token: 'person-token', url: harness.url });
		assert.deepEqual(firstUser, { token: 'first-user-token', url: beside });
		assert.deepEqual(minted, [
			'administrator admin-0001',
			'administrator eli-0001',
			'person bo-0001',
			'first user ana-0001',
		]);
	});
});

suite('a suppression and a restoration', () => {
	test('send a reason only when one is given', async (context) => {
		const server = await recording(context);
		const caller: AdminCaller = { token: 'management-token', url: server.url };

		await suppressResource(caller, 'STUDY-A1', {
			reason: SUPPRESSION_REASONS.dataQualityIssue,
		});
		await restoreResource(caller, 'STUDY-A1');
		await restoreResource(caller, 'STUDY-A1', {
			headers: { 'x-test': 'kept' },
			reason: RESTORATION_REASONS.issueResolved,
		});

		assert.deepEqual(
			server.requests.map(({ body, headers, target }) => ({
				body,
				contentType: headers['content-type'],
				extra: headers['x-test'],
				target,
			})),
			[
				{
					body: '{"reason":"dataQualityIssue"}',
					contentType: 'application/json',
					extra: undefined,
					target: '/admin/resources/STUDY-A1/suppression',
				},
				{
					body: '',
					contentType: undefined,
					extra: undefined,
					target: '/admin/resources/STUDY-A1/restoration',
				},
				{
					body: '{"reason":"issueResolved"}',
					contentType: 'application/json',
					extra: 'kept',
					target: '/admin/resources/STUDY-A1/restoration',
				},
			],
		);
	});
});
