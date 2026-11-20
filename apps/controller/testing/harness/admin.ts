import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import type { ControllerConfiguration } from './controller.js';
import { mergedHeaders, PEOPLE, type Person } from './exchange.js';
import type { Harness } from './harness.js';
import type { IdentityProvider, MintOptions } from '../peripherals/identityProvider.js';
import { startRecordingServer } from '../peripherals/recordingServer.js';

// Every path, body, answer shape, problem code and reason the tests assume of the Policy Management
// API and the back-channel logout endpoint lives here. The README's table of assumptions lists those
// no design document or ruling fixes.

/** Who calls the API, and where: the Controller's URL and the caller's management token. */
export interface AdminCaller {
	/** The bearer credential; `null` sends no `authorization` header. */
	token: string | null;

	/** The Controller's URL, ending in `/`. */
	url: URL;
}

/** Departures from an operation's own request, for the malformed-request tests. */
export interface AdminOverrides {
	/** A raw body sent in place of the operation's JSON. */
	body?: string;

	/** Members merged over the operation's JSON body. */
	extraMembers?: Readonly<Record<string, unknown>>;

	/** Headers merged over the operation's, by lower-case name; one set to `undefined` is left out. */
	headers?: Readonly<Record<string, string | undefined>>;

	/** Query parameters added to the operation's, each name once. */
	query?: Readonly<Record<string, string>>;
}

/** An RFC 9457 problem details object, as the API answers a refusal, carrying a `code` (C2). */
export interface ProblemDetails {
	code: string;
	detail?: string;
	instance?: string;
	status?: number;
	title?: string;
	type?: string;
}

/** An answer: the status, the headers, the body parsed when it is JSON, and its problem details on a refusal. */
export interface AdminResponse {
	/** The body parsed as JSON, for any JSON media type; `undefined` for an empty or other body. */
	body: unknown;

	headers: Headers;

	/** The body, when it is `application/problem+json` carrying a string `code`. */
	problem: ProblemDetails | undefined;

	status: number;

	/** The body's text, whatever its media type. */
	text: string;
}

/** An answer to a grant's creation, carrying the new grant's id when the API answered with one. */
export interface GrantCreated extends AdminResponse {
	/** The body's `id`, the grant's opaque id, when it is a string; `undefined` otherwise. */
	grantId: string | undefined;
}

/** A resource's access level, its base tier, as the API names it. */
export type AccessLevel = 'grant' | 'open' | 'registered';

/** A grant's holder: a person by subject, or by address, which the Controller resolves and never stores. */
export type Holder = { email: string } | { subject: string };

/**
 * What registering an application sends. The display name is stored trimmed and then normalized to
 * NFC, the form counted against its length limit; the description is stored trimmed, and as `null`
 * when empty once trimmed. The display name is a label, never matched, so two applications may share
 * one; the application's id is generated.
 */
export interface ApplicationRegistration {
	description?: string;
	displayName: string;
}

/**
 * The longest an application's display name may be, in characters once trimmed and normalized to
 * NFC, its stored form: a registration with a longer one, or one empty once trimmed, is refused 422.
 */
export const APPLICATION_DISPLAY_NAME_MAXIMUM_LENGTH = 128;

/** The most live keys one application holds: an issue past it is refused 409 `applicationKeyLimit`. */
export const APPLICATION_LIVE_KEY_LIMIT = 2;

/** What registering a resource sends. */
export interface ResourceRegistration {
	/**
	 * Required: a registration naming none is refused 422 (ruled). Optional here alone, so a test can
	 * send a registration without it.
	 */
	accessLevel?: AccessLevel;

	/** The applications serving it from registration on, by id. */
	applications?: readonly string[];

	description?: string;
	displayName: string;
	externalId: string;

	/** Values of the instance's resource fields, by field name. */
	fields?: Readonly<Record<string, string>>;

	/** Its first owners, written as owner grants in the registration's transaction. */
	owners?: readonly Holder[];
}

/**
 * The longest a resource's externalId may be, in characters after NFC (#211 Q3): a registration with a
 * longer one is refused, and the EGO import reports a study whose id is longer as `tooLong`.
 */
export const EXTERNAL_ID_MAXIMUM_LENGTH = 128;

/** What updating a resource sends, as a JSON Merge Patch: an absent member is left as it is, and `null` clears. */
export interface ResourceUpdate {
	accessLevel?: AccessLevel;
	description?: string | null;
	displayName?: string;

	/** Field values set, or cleared with `null`, by field name. */
	fields?: Readonly<Record<string, string | null>>;
}

/** What registering a global category sends. */
export interface CategoryRegistration {
	description?: string;

	/** Its name alone: `controlled`, which the API answers as `global.controlled`. */
	name: string;
}

/** What updating a category sends, as a JSON Merge Patch. */
export interface CategoryUpdate {
	description?: string | null;
}

/** What defining a resource field sends. */
export interface ResourceFieldDefinition {
	description?: string;
	name: string;
}

/** What creating a grant sends. */
export interface GrantCreation {
	/** A scoped category name, `global.controlled`; absent on an owner's grant, and on a submitter's, which takes the instance's. */
	category?: string;

	/** An instant with an offset; the grant never expires when absent. */
	expiresAt?: string;

	holder: Holder;

	/** By externalId. */
	resource: string;

	role: string;
}

/** What an administrator's self-grant sends: the caller is the holder, and the expiry is required. */
export interface SelfGrantCreation {
	category?: string;
	expiresAt: string;
	resource: string;
	role: string;
}

/** What answering a grant sends: the decision, and the capabilities the person was shown. */
export interface GrantDecision {
	/** As `entity.action` names. */
	capabilities: readonly string[];

	decision: 'accepted' | 'rejected';
}

/** The audit log's query parameters (#214 Q13), each optional. */
export interface AuditQuery {
	actorId?: string;

	/** The page to continue from, as the previous page named it. */
	cursor?: string;

	/** The earliest `time`, inclusive: an instant with an offset. */
	from?: string;

	/** The most events on a page. */
	limit?: number;

	/** A resource, by externalId. */
	resourceId?: string;

	severity?: string;

	/** The latest `time`, exclusive: an instant with an offset. */
	to?: string;

	/** A full event type, such as `bio.overture.grant.creation`. */
	type?: string;
}

/** What a logout token names, for {@link mintLogoutToken}. */
export interface LogoutTokenOptions {
	/** The client the logout token is addressed to, one of the Controller's back-channel logout audiences. */
	audience: string;

	/** Claims and header members over the logout token's own, and the key and lifetime. */
	mint?: MintOptions;

	/** The session ended, as `sid`. */
	sessionId?: string;

	/** The person signed out, as `sub`. */
	subject?: string;
}

/** The back-channel logout event's member in a logout token's `events` claim. */
export const BACK_CHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const JSON_MEDIA = 'application/json';

const MERGE_PATCH_MEDIA = 'application/merge-patch+json';

const PROBLEM_MEDIA = 'application/problem+json';

const FORM_MEDIA = 'application/x-www-form-urlencoded';

// Access-token claims the stand-in adds by default that a logout token never carries.
const ACCESS_TOKEN_ONLY_CLAIMS = Object.freeze({
	acr: undefined,
	azp: undefined,
	email: undefined,
	email_verified: undefined,
	preferred_username: undefined,
	realm_access: undefined,
	scope: undefined,
	sid: undefined,
	sub: undefined,
	typ: undefined,
});

const segment = (value: string): string => encodeURIComponent(value);

const PATHS = {
	apiDocs: 'api-docs',
	apiDocsContract: 'api-docs/openapi.json',
	application: (id: string): string => `admin/applications/${segment(id)}`,
	applicationKey: (id: string, keyId: string): string => `admin/applications/${segment(id)}/keys/${segment(keyId)}`,
	applicationKeys: (id: string): string => `admin/applications/${segment(id)}/keys`,
	applications: 'admin/applications',
	audit: 'admin/audit',
	backChannelLogout: 'backchannel-logout',
	categories: 'admin/categories',
	category: (scopedName: string): string => `admin/categories/${segment(scopedName)}`,
	egoImport: 'admin/imports/ego',
	globalRevocation: 'admin/revocations/global',
	grant: (id: string): string => `admin/grants/${segment(id)}`,
	grantDecisions: (id: string): string => `admin/grants/${segment(id)}/decisions`,
	grantRequestDecisions: (id: string): string => `admin/grant-requests/${segment(id)}/decisions`,
	grantRequests: 'admin/grant-requests',
	grants: 'admin/grants',
	liveness: 'health/live',
	nominationAcceptance: (id: string): string => `admin/nominations/${segment(id)}/acceptance`,
	nominations: 'admin/nominations',
	identityRevocationLifts: 'admin/people/revocations/lifts',
	identityRevocations: 'admin/people/revocations',
	ownGrants: 'admin/me/grants',
	ownNominations: 'admin/me/nominations',
	personGrants: 'admin/people/grants',
	readiness: 'health/ready',
	resource: (externalId: string): string => `admin/resources/${segment(externalId)}`,
	resourceAction: (externalId: string, action: string): string => `admin/resources/${segment(externalId)}/${action}`,
	resourceApplication: (externalId: string, application: string): string =>
		`admin/resources/${segment(externalId)}/applications/${segment(application)}`,
	resourceFields: 'admin/resource-fields',
	resources: 'admin/resources',
	settings: 'admin/settings',
	grantRules: 'admin/settings/grant-rules',
	roleCapabilities: (role: string): string => `admin/roles/${segment(role)}/capabilities`,
	selfGrants: 'admin/grants/self',
} as const;

/** A Management API operation as its route names it: its method and its path's template. */
export interface ManagementRoute {
	method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

	/** The template, its parameters in braces, as the contract writes it: `/admin/grants/{id}`. */
	route: string;
}

const routes = (route: string, methods: readonly ManagementRoute['method'][]): readonly ManagementRoute[] =>
	methods.map((method) => ({ method, route }));

/**
 * Every Management API operation as the contract's routes name them (`openapi.json`, the paths under
 * `/admin`): the `method` and `route` a refused management token's event records for the operation
 * matched (ruled), never anything taken from the request line.
 */
export const MANAGEMENT_ROUTES: readonly ManagementRoute[] = Object.freeze([
	...routes('/admin/applications', ['POST']),
	...routes('/admin/applications/{id}', ['GET']),
	...routes('/admin/applications/{id}/keys', ['POST']),
	...routes('/admin/applications/{id}/keys/{keyId}', ['DELETE']),
	...routes('/admin/audit', ['GET']),
	...routes('/admin/categories', ['GET', 'POST']),
	...routes('/admin/categories/{scopedName}', ['PATCH']),
	...routes('/admin/grant-requests', ['GET']),
	...routes('/admin/grant-requests/{id}/decisions', ['POST']),
	...routes('/admin/grants', ['POST']),
	...routes('/admin/grants/self', ['POST']),
	...routes('/admin/grants/{id}', ['DELETE', 'PATCH']),
	...routes('/admin/grants/{id}/decisions', ['POST']),
	...routes('/admin/me/grants', ['GET']),
	...routes('/admin/me/nominations', ['GET']),
	...routes('/admin/imports/ego', ['POST']),
	...routes('/admin/nominations', ['POST']),
	...routes('/admin/nominations/{id}/acceptance', ['POST']),
	...routes('/admin/people/grants', ['POST']),
	...routes('/admin/people/revocations', ['POST']),
	...routes('/admin/people/revocations/lifts', ['POST']),
	...routes('/admin/resource-fields', ['GET', 'POST']),
	...routes('/admin/resources', ['GET', 'POST']),
	...routes('/admin/resources/{externalId}', ['DELETE', 'GET', 'PATCH']),
	...routes('/admin/resources/{externalId}/applications/{applicationId}', ['DELETE', 'PUT']),
	...routes('/admin/resources/{externalId}/grants', ['GET']),
	...routes('/admin/resources/{externalId}/restoration', ['POST']),
	...routes('/admin/resources/{externalId}/retirement', ['POST']),
	...routes('/admin/resources/{externalId}/revocations', ['POST']),
	...routes('/admin/resources/{externalId}/submitters/removal', ['POST']),
	...routes('/admin/resources/{externalId}/suppression', ['POST']),
	...routes('/admin/revocations/global', ['POST']),
	...routes('/admin/roles/{name}/capabilities', ['PUT']),
	...routes('/admin/settings', ['GET', 'PATCH']),
	...routes('/admin/settings/grant-rules', ['GET', 'PUT']),
]);

const isParameter = (segment: string): boolean => segment.startsWith('{') && segment.endsWith('}');

/**
 * The Management API route a request reaches, matched as a router matches one: segment by segment, a
 * parameter matching any one segment and a literal segment preferred over a parameter, as
 * `/admin/grants/self` is over `/admin/grants/{id}`; `undefined` for a request matching none.
 *
 * @param method the request's method.
 * @param target the request's path, from the Controller's root, with or without a query.
 */
export const managementRouteOf = (method: string, target: string): ManagementRoute | undefined => {
	const sent = (target.split('?')[0] ?? '').split('/').filter(Boolean);
	const literalCount = ({ route }: ManagementRoute): number =>
		route.split('/').filter((part) => part.length > 0 && !isParameter(part)).length;
	return MANAGEMENT_ROUTES.filter((candidate) => {
		const parts = candidate.route.split('/').filter(Boolean);
		return (
			candidate.method === method.toUpperCase() &&
			parts.length === sent.length &&
			parts.every((part, index) => isParameter(part) || part === sent[index])
		);
	}).toSorted((first, second) => literalCount(second) - literalCount(first))[0];
};

/**
 * The Management API route an operation of this module reaches, read from the request it sends: the
 * operation is sent once to a recording server, never to the Controller, and its method and path
 * matched with {@link managementRouteOf}.
 *
 * @param operation the operation, sending through the principal it is given.
 * @throws when the operation sends nothing, or its request matches no route.
 */
export const managementRouteOfOperation = async (
	operation: (recorded: AdminCaller) => Promise<AdminResponse>,
): Promise<ManagementRoute> => {
	const recorder = await startRecordingServer();
	try {
		await operation({ token: null, url: recorder.url });
	} finally {
		await recorder.stop();
	}
	const [sent] = recorder.requests;
	if (sent === undefined) {
		throw new Error('the operation sent nothing');
	}
	const matched = managementRouteOf(sent.method, sent.target);
	if (matched !== undefined) {
		return matched;
	}
	throw new Error(`no route matches ${sent.method} ${sent.target}`);
};

interface Operation {
	/** The body's media type: JSON by default, Merge Patch for an update. */
	contentType?: string;

	/** The JSON body, if the operation sends one. */
	json?: Readonly<Record<string, unknown>>;

	method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
	path: string;
	query?: Readonly<Record<string, string>>;
}

const isProblem = (value: unknown): value is ProblemDetails =>
	typeof value === 'object' && value !== null && typeof Reflect.get(value, 'code') === 'string';

const parsedJson = (text: string): unknown => {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
};

const mediaTypeIn = (headers: Headers): string =>
	(headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

/**
 * An answer's media type: its `content-type` without parameters, lower-cased; empty when it has none.
 *
 * @param response the answer.
 */
export const mediaTypeOf = (response: Pick<AdminResponse, 'headers'>): string => mediaTypeIn(response.headers);

const answerOf = (status: number, headers: Headers, text: string): AdminResponse => {
	const mediaType = mediaTypeIn(headers);
	const body = mediaType === JSON_MEDIA || mediaType.endsWith('+json') ? parsedJson(text) : undefined;
	return {
		body,
		headers,
		problem: mediaType === PROBLEM_MEDIA && isProblem(body) ? body : undefined,
		status,
		text,
	};
};

const responseOf = async (response: Response): Promise<AdminResponse> =>
	answerOf(response.status, response.headers, await response.text());

const urlFor = (base: URL, path: string, query: Readonly<Record<string, string>>): URL => {
	const url = new URL(path, base);
	Object.entries(query).forEach(([name, value]) => url.searchParams.set(name, value));
	return url;
};

const send = async (
	{ token, url }: AdminCaller,
	{ contentType = JSON_MEDIA, json, method, path, query = {} }: Operation,
	{ body, extraMembers = {}, headers = {}, query: extraQuery = {} }: AdminOverrides = {},
): Promise<AdminResponse> => {
	const sentBody =
		body ??
		(json === undefined && Object.keys(extraMembers).length === 0
			? undefined
			: JSON.stringify({ ...json, ...extraMembers }));
	const response = await fetch(urlFor(url, path, { ...query, ...extraQuery }), {
		...(sentBody === undefined ? {} : { body: sentBody }),
		headers: mergedHeaders(
			{
				accept: `${JSON_MEDIA}, ${PROBLEM_MEDIA}`,
				...(token === null ? {} : { authorization: `Bearer ${token}` }),
				...(sentBody === undefined ? {} : { 'content-type': contentType }),
			},
			headers,
		),
		method,
		redirect: 'manual',
	});
	return responseOf(response);
};

const withGrantId = (response: AdminResponse): GrantCreated => {
	const id: unknown =
		typeof response.body === 'object' && response.body !== null ? Reflect.get(response.body, 'id') : undefined;
	return { ...response, grantId: typeof id === 'string' ? id : undefined };
};

/**
 * Fails unless an answer succeeded, naming the operation, the status and the problem's code.
 *
 * @param response the operation's answer.
 * @param operation what the test asked for, for the failure's message.
 * @throws when the status is outside 200 to 299.
 */
export const assertSucceeded = (response: AdminResponse, operation: string): void => {
	if (response.status >= 200 && response.status < 300) {
		return;
	}
	throw new Error(
		`${operation} was answered ${response.status}${response.problem === undefined ? '' : ` ${response.problem.code}`}`,
	);
};

/**
 * The back-channel logout endpoint's URL (#210 Q8), as an identity provider is configured with it:
 * `backchannel-logout`, relative to the Controller's URL.
 *
 * @param controllerUrl the Controller's URL, ending in `/`.
 */
export const backChannelLogoutUrl = (controllerUrl: URL): URL => new URL(PATHS.backChannelLogout, controllerUrl);

/**
 * Registers an application and issues its first key, for platform administrators:
 * `POST /admin/applications`, answered 201 with `{ id, displayName, description, key: { id, value } }`
 * and `Cache-Control: no-store`. The key's value is in this answer alone;
 * {@link registeredApplicationOf} reads it.
 *
 * @param caller the Controller and the principal's token.
 * @param registration the display name and the description.
 * @param overrides departures from the request.
 */
export const registerApplication = (
	caller: AdminCaller,
	registration: ApplicationRegistration,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(caller, { json: { ...registration }, method: 'POST', path: PATHS.applications }, overrides);

/**
 * Issues another key for an application, for platform administrators, sending no body:
 * `POST /admin/applications/{id}/keys`, the id percent-encoded, answered 201 with `{ id, value }` and
 * `Cache-Control: no-store`. An application holds at most {@link APPLICATION_LIVE_KEY_LIMIT} live keys.
 *
 * @param caller the Controller and the principal's token.
 * @param applicationId the application's id.
 * @param overrides departures from the request.
 */
export const issueApplicationKey = (
	caller: AdminCaller,
	applicationId: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> => send(caller, { method: 'POST', path: PATHS.applicationKeys(applicationId) }, overrides);

/**
 * Revokes one of an application's keys, for platform administrators:
 * `DELETE /admin/applications/{id}/keys/{keyId}`, each id percent-encoded, carrying a body only when a
 * reason is given. Answered 200 naming the key's id, the revoker and the time, never the key's value.
 *
 * @param caller the Controller and the principal's token.
 * @param applicationId the application's id.
 * @param keyId the key's id.
 * @param options the reason, one of {@link APPLICATION_KEY_REVOCATION_REASONS}, which is optional.
 * @param overrides departures from the request.
 */
export const revokeApplicationKey = (
	caller: AdminCaller,
	applicationId: string,
	keyId: string,
	{ reason }: { reason?: string } = {},
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			...(reason === undefined ? {} : { json: { reason } }),
			method: 'DELETE',
			path: PATHS.applicationKey(applicationId, keyId),
		},
		overrides,
	);

/**
 * Reads an application and every key it was issued, for platform administrators:
 * `GET /admin/applications/{id}`, the id percent-encoded. No answer holds a key's value;
 * {@link applicationViewOf} reads it.
 *
 * @param caller the Controller and the principal's token.
 * @param applicationId the application's id.
 * @param overrides departures from the request.
 */
export const readApplication = (
	caller: AdminCaller,
	applicationId: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> => send(caller, { method: 'GET', path: PATHS.application(applicationId) }, overrides);

/**
 * Registers a resource: `POST /admin/resources`.
 *
 * @param caller the Controller and the caller's token.
 * @param registration the resource.
 * @param overrides departures from the request.
 */
export const registerResource = (
	caller: AdminCaller,
	registration: ResourceRegistration,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(caller, { json: { ...registration }, method: 'POST', path: PATHS.resources }, overrides);

/**
 * Reads a resource: `GET /admin/resources/{externalId}`, the externalId percent-encoded.
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the resource.
 * @param overrides departures from the request.
 */
export const readResource = (
	caller: AdminCaller,
	externalId: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> => send(caller, { method: 'GET', path: PATHS.resource(externalId) }, overrides);

/**
 * Updates a resource's details, access level and field values: `PATCH /admin/resources/{externalId}`
 * as a JSON Merge Patch.
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the resource.
 * @param update the members changed.
 * @param overrides departures from the request.
 */
export const updateResource = (
	caller: AdminCaller,
	externalId: string,
	update: ResourceUpdate,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			contentType: MERGE_PATCH_MEDIA,
			json: { ...update },
			method: 'PATCH',
			path: PATHS.resource(externalId),
		},
		overrides,
	);

/**
 * Lists the resources the caller may see: `GET /admin/resources`.
 *
 * @param caller the Controller and the caller's token.
 * @param overrides departures from the request, its paging parameters included.
 */
export const listResources = (caller: AdminCaller, overrides?: AdminOverrides): Promise<AdminResponse> =>
	send(caller, { method: 'GET', path: PATHS.resources }, overrides);

/** An optional reason, beside the departures from an operation's own request. */
export interface ReasonedOverrides extends AdminOverrides {
	/** Sent as the body's `reason`; no body is sent without one. */
	reason?: string;
}

/**
 * Suppresses a resource: `POST /admin/resources/{externalId}/suppression`, carrying a body only when
 * a reason is given. With none, the Controller records `unspecified` (ruled).
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the resource.
 * @param request the reason, one of {@link SUPPRESSION_REASONS}, which is optional, and departures
 *   from the request.
 */
export const suppressResource = (
	caller: AdminCaller,
	externalId: string,
	{ reason, ...overrides }: ReasonedOverrides = {},
): Promise<AdminResponse> =>
	send(
		caller,
		{
			...(reason === undefined ? {} : { json: { reason } }),
			method: 'POST',
			path: PATHS.resourceAction(externalId, 'suppression'),
		},
		overrides,
	);

/**
 * Restores a suppressed resource: `POST /admin/resources/{externalId}/restoration`, carrying a body
 * only when a reason is given. With none, the Controller records `unspecified` (ruled).
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the resource.
 * @param request the reason, one of {@link RESTORATION_REASONS}, which is optional, and departures
 *   from the request.
 */
export const restoreResource = (
	caller: AdminCaller,
	externalId: string,
	{ reason, ...overrides }: ReasonedOverrides = {},
): Promise<AdminResponse> =>
	send(
		caller,
		{
			...(reason === undefined ? {} : { json: { reason } }),
			method: 'POST',
			path: PATHS.resourceAction(externalId, 'restoration'),
		},
		overrides,
	);

/**
 * Retires a resource no live grant or pending invitation names (#320 B):
 * `POST /admin/resources/{externalId}/retirement`.
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the resource.
 * @param overrides departures from the request.
 */
export const retireResource = (
	caller: AdminCaller,
	externalId: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(caller, { method: 'POST', path: PATHS.resourceAction(externalId, 'retirement') }, overrides);

/**
 * Deletes a registration that never held a grant or an invitation (#320 D):
 * `DELETE /admin/resources/{externalId}`.
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the resource.
 * @param overrides departures from the request.
 */
export const deleteResource = (
	caller: AdminCaller,
	externalId: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> => send(caller, { method: 'DELETE', path: PATHS.resource(externalId) }, overrides);

/**
 * Adds one application to a resource's served set (#211 Q5), succeeding without a write when it is
 * already there: `PUT /admin/resources/{externalId}/applications/{applicationId}`.
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the resource.
 * @param application the application's id.
 * @param overrides departures from the request.
 */
export const serveResource = (
	caller: AdminCaller,
	externalId: string,
	application: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(caller, { method: 'PUT', path: PATHS.resourceApplication(externalId, application) }, overrides);

/**
 * Removes one application from a resource's served set:
 * `DELETE /admin/resources/{externalId}/applications/{applicationId}`.
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the resource.
 * @param application the application's id.
 * @param overrides departures from the request.
 */
export const stopServingResource = (
	caller: AdminCaller,
	externalId: string,
	application: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			method: 'DELETE',
			path: PATHS.resourceApplication(externalId, application),
		},
		overrides,
	);

/**
 * Registers a global category (#211 Q8): `POST /admin/categories`.
 *
 * @param caller the Controller and the caller's token.
 * @param registration the category.
 * @param overrides departures from the request.
 */
export const registerCategory = (
	caller: AdminCaller,
	registration: CategoryRegistration,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(caller, { json: { ...registration }, method: 'POST', path: PATHS.categories }, overrides);

/**
 * Updates a category (#211 Q8): `PATCH /admin/categories/{scopedName}` as a JSON Merge Patch.
 *
 * @param caller the Controller and the caller's token.
 * @param scopedName the category, as `global.controlled`.
 * @param update the members changed.
 * @param overrides departures from the request.
 */
export const updateCategory = (
	caller: AdminCaller,
	scopedName: string,
	update: CategoryUpdate,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			contentType: MERGE_PATCH_MEDIA,
			json: { ...update },
			method: 'PATCH',
			path: PATHS.category(scopedName),
		},
		overrides,
	);

/**
 * Lists the categories (#211 Q8): `GET /admin/categories`.
 *
 * @param caller the Controller and the caller's token.
 * @param overrides departures from the request.
 */
export const listCategories = (caller: AdminCaller, overrides?: AdminOverrides): Promise<AdminResponse> =>
	send(caller, { method: 'GET', path: PATHS.categories }, overrides);

/**
 * Defines a resource field, instance-wide (#207 Q8): `POST /admin/resource-fields`. A resource's
 * values are set and cleared through {@link updateResource}.
 *
 * @param caller the Controller and the caller's token.
 * @param definition the field.
 * @param overrides departures from the request.
 */
export const defineResourceField = (
	caller: AdminCaller,
	definition: ResourceFieldDefinition,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(caller, { json: { ...definition }, method: 'POST', path: PATHS.resourceFields }, overrides);

/**
 * Lists the resource fields: `GET /admin/resource-fields`.
 *
 * @param caller the Controller and the caller's token.
 * @param overrides departures from the request.
 */
export const listResourceFields = (caller: AdminCaller, overrides?: AdminOverrides): Promise<AdminResponse> =>
	send(caller, { method: 'GET', path: PATHS.resourceFields }, overrides);

/**
 * Creates a grant, its holder by subject or by address (#212 Q1): `POST /admin/grants`.
 *
 * @param caller the Controller and the caller's token.
 * @param creation the grant.
 * @param overrides departures from the request.
 * @returns the answer, with the new grant's id read from its body's `id`.
 */
export const createGrant = async (
	caller: AdminCaller,
	creation: GrantCreation,
	overrides?: AdminOverrides,
): Promise<GrantCreated> =>
	withGrantId(await send(caller, { json: { ...creation }, method: 'POST', path: PATHS.grants }, overrides));

/**
 * Adds a submitter to a study by address: a grant of the `submitter` role naming no category, which
 * takes the instance's submitter category (#212 Q6), through `POST /admin/grants`.
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the study.
 * @param email the submitter's address.
 * @param overrides departures from the request.
 */
export const addSubmitter = (
	caller: AdminCaller,
	externalId: string,
	email: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	createGrant(caller, { holder: { email }, resource: externalId, role: 'submitter' }, overrides);

/**
 * Removes a submitter from a study by address, the address in the body (#212 Q1):
 * `POST /admin/resources/{externalId}/submitters/removal`.
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the study.
 * @param email the submitter's address.
 * @param overrides departures from the request.
 */
export const removeSubmitter = (
	caller: AdminCaller,
	externalId: string,
	email: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			json: { email },
			method: 'POST',
			path: PATHS.resourceAction(externalId, 'submitters/removal'),
		},
		overrides,
	);

/**
 * Creates the caller's own grant, which is its acceptance (#212 Q14): `POST /admin/grants/self`.
 *
 * @param caller the Controller and the caller's token.
 * @param creation the grant.
 * @param overrides departures from the request.
 * @returns the answer, with the new grant's id read from its body's `id`.
 */
export const createSelfGrant = async (
	caller: AdminCaller,
	creation: SelfGrantCreation,
	overrides?: AdminOverrides,
): Promise<GrantCreated> =>
	withGrantId(await send(caller, { json: { ...creation }, method: 'POST', path: PATHS.selfGrants }, overrides));

/**
 * Decides a grant request, granting or refusing it (ruled): `POST
 * /admin/grant-requests/{id}/decisions`, its body `{ decision }`. A request granted answers with
 * the grant written, whose id is read from its body's `id` as `grantId`.
 *
 * @param caller the controller and the decider's token.
 * @param requestId the request's id.
 * @param decision `granted` or `refused`.
 * @param overrides departures from the request.
 */
export const decideGrantRequest = async (
	caller: AdminCaller,
	requestId: string,
	decision: 'granted' | 'refused',
	overrides?: AdminOverrides,
): Promise<GrantCreated> =>
	withGrantId(
		await send(
			caller,
			{
				json: { decision },
				method: 'POST',
				path: PATHS.grantRequestDecisions(requestId),
			},
			overrides,
		),
	);

/**
 * Lists the grant requests the caller may decide, pending and unlapsed, and the caller's own in any
 * state (ruled): `GET /admin/grant-requests`.
 *
 * @param caller the controller and the caller's token.
 * @param overrides departures from the request, its paging parameters included.
 */
export const listGrantRequests = (caller: AdminCaller, overrides?: AdminOverrides): Promise<AdminResponse> =>
	send(caller, { method: 'GET', path: PATHS.grantRequests }, overrides);

/**
 * Revokes a grant: `DELETE /admin/grants/{id}`, carrying a body only when a reason is given.
 *
 * @param caller the Controller and the caller's token.
 * @param grantId the grant's id.
 * @param options the reason, which is optional (#212 Q11).
 * @param overrides departures from the request.
 */
export const revokeGrant = (
	caller: AdminCaller,
	grantId: string,
	{ reason }: { reason?: string } = {},
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			...(reason === undefined ? {} : { json: { reason } }),
			method: 'DELETE',
			path: PATHS.grant(grantId),
		},
		overrides,
	);

/**
 * Answers a grant as its recipient: `POST /admin/grants/{id}/decisions`.
 *
 * @param caller the Controller and the recipient's token.
 * @param grantId the grant's id.
 * @param decision the answer, and the capabilities shown.
 * @param overrides departures from the request.
 */
export const answerGrant = (
	caller: AdminCaller,
	grantId: string,
	decision: GrantDecision,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			json: { ...decision },
			method: 'POST',
			path: PATHS.grantDecisions(grantId),
		},
		overrides,
	);

/**
 * Changes a grant's expiry, or removes it with `null`: `PATCH /admin/grants/{id}` as a JSON Merge
 * Patch.
 *
 * @param caller the Controller and the caller's token.
 * @param grantId the grant's id.
 * @param expiresAt an instant with an offset, or `null` for none.
 * @param overrides departures from the request.
 */
export const changeGrantExpiry = (
	caller: AdminCaller,
	grantId: string,
	expiresAt: string | null,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			contentType: MERGE_PATCH_MEDIA,
			json: { expiresAt },
			method: 'PATCH',
			path: PATHS.grant(grantId),
		},
		overrides,
	);

/**
 * Changes a grant's role: `PATCH /admin/grants/{id}` as a JSON Merge Patch.
 *
 * @param caller the Controller and the caller's token.
 * @param grantId the grant's id.
 * @param role the role's name.
 * @param overrides departures from the request.
 */
export const changeGrantRole = (
	caller: AdminCaller,
	grantId: string,
	role: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			contentType: MERGE_PATCH_MEDIA,
			json: { role },
			method: 'PATCH',
			path: PATHS.grant(grantId),
		},
		overrides,
	);

/**
 * Lists the grants on a resource (#213): `GET /admin/resources/{externalId}/grants`.
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the resource.
 * @param overrides departures from the request, its paging parameters included.
 */
export const listResourceGrants = (
	caller: AdminCaller,
	externalId: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(caller, { method: 'GET', path: PATHS.resourceAction(externalId, 'grants') }, overrides);

/**
 * Lists a person's grants by exact address, the address in the body (#213 Q2):
 * `POST /admin/people/grants`.
 *
 * @param caller the Controller and the caller's token.
 * @param email the person's address.
 * @param overrides departures from the request.
 */
export const listPersonGrants = (
	caller: AdminCaller,
	email: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> => send(caller, { json: { email }, method: 'POST', path: PATHS.personGrants }, overrides);

/**
 * Lists the caller's own grants (#213 Q3): `GET /admin/me/grants`.
 *
 * @param caller the Controller and the caller's token.
 * @param overrides departures from the request.
 */
export const listOwnGrants = (caller: AdminCaller, overrides?: AdminOverrides): Promise<AdminResponse> =>
	send(caller, { method: 'GET', path: PATHS.ownGrants }, overrides);

/**
 * Nominates Usher's first administrator, as the first user: `POST /admin/nominations`, taking
 * `{ nominee: { subject } }`.
 *
 * @param caller the Controller and the caller's token.
 * @param nomination the nominee, by subject.
 * @param overrides departures from the request.
 */
export const nominate = (
	caller: AdminCaller,
	nomination: { nominee: { subject: string } },
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(caller, { json: { ...nomination }, method: 'POST', path: PATHS.nominations }, overrides);

/**
 * Accepts a nomination naming the caller: `POST /admin/nominations/{id}/acceptance`, taking no
 * body.
 *
 * @param caller the Controller and the caller's token.
 * @param nominationId the nomination's id.
 * @param overrides departures from the request.
 */
export const acceptNomination = (
	caller: AdminCaller,
	nominationId: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(caller, { method: 'POST', path: PATHS.nominationAcceptance(nominationId) }, overrides);

/**
 * Lists the nominations naming the caller: `GET /admin/me/nominations`.
 *
 * @param caller the Controller and the caller's token.
 * @param overrides departures from the request.
 */
export const listOwnNominations = (caller: AdminCaller, overrides?: AdminOverrides): Promise<AdminResponse> =>
	send(caller, { method: 'GET', path: PATHS.ownNominations }, overrides);

/**
 * Revokes a principal's identity entirely (#210 Q1, #212): `POST /admin/people/revocations`, the
 * subject in the body.
 *
 * @param caller the Controller and the caller's token.
 * @param revocation the principal's subject, and the reason.
 * @param overrides departures from the request.
 */
export const revokeIdentity = (
	caller: AdminCaller,
	revocation: { reason: string; subject: string },
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			json: { ...revocation },
			method: 'POST',
			path: PATHS.identityRevocations,
		},
		overrides,
	);

/**
 * Lifts a principal's standing revocation: `POST /admin/people/revocations/lifts`, the subject in
 * the body.
 *
 * @param caller the Controller and the caller's token.
 * @param subject the principal's subject.
 * @param overrides departures from the request.
 */
export const liftIdentityRevocation = (
	caller: AdminCaller,
	subject: string,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(caller, { json: { subject }, method: 'POST', path: PATHS.identityRevocationLifts }, overrides);

/**
 * Revokes every user of a resource at once (#210 Q1): `POST /admin/resources/{externalId}/revocations`.
 *
 * @param caller the Controller and the caller's token.
 * @param externalId the resource.
 * @param revocation the reason.
 * @param overrides departures from the request.
 */
export const revokeResourceUsers = (
	caller: AdminCaller,
	externalId: string,
	revocation: { reason: string },
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			json: { ...revocation },
			method: 'POST',
			path: PATHS.resourceAction(externalId, 'revocations'),
		},
		overrides,
	);

/**
 * Revokes globally, confirmed in the request (#210 Q1): `POST /admin/revocations/global`.
 *
 * @param caller the Controller and the caller's token.
 * @param revocation the reason.
 * @param overrides departures from the request, such as a body without the confirmation.
 */
export const revokeGlobally = (
	caller: AdminCaller,
	revocation: { reason: string },
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			json: { confirm: true, ...revocation },
			method: 'POST',
			path: PATHS.globalRevocation,
		},
		overrides,
	);

/**
 * Replaces the capabilities a role carries: `PUT /admin/roles/{name}/capabilities`.
 *
 * @param caller the Controller and the caller's token.
 * @param role the role's name.
 * @param capabilities every capability it carries afterwards, as `entity.action` names.
 * @param overrides departures from the request.
 */
export const changeRoleCapabilities = (
	caller: AdminCaller,
	role: string,
	capabilities: readonly string[],
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			json: { capabilities },
			method: 'PUT',
			path: PATHS.roleCapabilities(role),
		},
		overrides,
	);

/**
 * Reads the audit log (#214): `GET /admin/audit`, with the parameters given.
 *
 * @param caller the Controller and the caller's token.
 * @param query the filters and the page.
 * @param overrides departures from the request, such as a parameter the API does not know.
 */
export const readAudit = (
	caller: AdminCaller,
	query: AuditQuery = {},
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			method: 'GET',
			path: PATHS.audit,
			query: Object.fromEntries(Object.entries(query).map(([name, value]) => [name, String(value)])),
		},
		overrides,
	);

/**
 * Reads the grant rules: `GET /admin/settings/grant-rules`.
 *
 * @param caller the Controller and an administrator's token.
 * @param overrides departures from the request.
 */
export const readGrantRules = (caller: AdminCaller, overrides?: AdminOverrides): Promise<AdminResponse> =>
	send(caller, { method: 'GET', path: PATHS.grantRules }, overrides);

/**
 * Replaces the whole list of grant rules: `PUT /admin/settings/grant-rules`.
 *
 * @param caller the Controller and an administrator's token.
 * @param grantRules the list, sent as the request's `grantRules` member.
 * @param overrides departures from the request.
 */
export const changeGrantRules = (
	caller: AdminCaller,
	grantRules: unknown,
	overrides?: AdminOverrides,
): Promise<AdminResponse> => send(caller, { json: { grantRules }, method: 'PUT', path: PATHS.grantRules }, overrides);

/**
 * Reads every setting but the grant rules: `GET /admin/settings`.
 *
 * @param caller the Controller and an administrator's token.
 * @param overrides departures from the request.
 */
export const readSettings = (caller: AdminCaller, overrides?: AdminOverrides): Promise<AdminResponse> =>
	send(caller, { method: 'GET', path: PATHS.settings }, overrides);

/**
 * Changes some settings, all or nothing: `PATCH /admin/settings`, in `application/merge-patch+json`.
 *
 * @param caller the Controller and an administrator's token.
 * @param update the settings changed, by name.
 * @param overrides departures from the request.
 */
export const updateSettings = (
	caller: AdminCaller,
	update: Readonly<Record<string, unknown>>,
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			contentType: 'application/merge-patch+json',
			json: update,
			method: 'PATCH',
			path: PATHS.settings,
		},
		overrides,
	);

/**
 * Imports EGO's study groups from an export of them, as assumed: `POST /admin/imports/ego`, for
 * administrators alone, taking `{ audiences, export }` and running dry unless `apply: true` is
 * added beside them. `audiences` names, by id, the applications serving each resource the run
 * registers (ruled): an empty list is refused 422 `importNeedsAnAudience`, and an id naming no
 * registered application 422 `unknownApplication`. Either run answers 200 with the import's
 * report as its JSON body, returned unread; a dry run is a read-only transaction writing nothing,
 * its audit row included (#216 Q16). The export is sent as given, so this function holds no view of
 * its format.
 *
 * @param caller the Controller and an administrator's token.
 * @param egoExport the export, sent unchanged as the request's `export` member.
 * @param run the audiences, by id, and `apply: true` for a real run.
 * @param overrides departures from the request.
 */
export const importFromEgo = (
	caller: AdminCaller,
	egoExport: unknown,
	{ apply = false, audiences }: { apply?: boolean; audiences: readonly string[] },
	overrides?: AdminOverrides,
): Promise<AdminResponse> =>
	send(
		caller,
		{
			json: {
				...(apply ? { apply } : {}),
				audiences: [...audiences],
				export: egoExport,
			},
			method: 'POST',
			path: PATHS.egoImport,
		},
		overrides,
	);

/**
 * Posts a logout token to the back-channel logout endpoint (#210 Q8): `POST /backchannel-logout`,
 * form-encoded as one `logout_token` parameter, with no `authorization` header.
 *
 * @param controllerUrl the Controller's URL, ending in `/`.
 * @param logoutToken the logout token.
 * @param overrides departures from the request, such as a JSON body or the token in the query.
 */
export const postBackChannelLogout = async (
	controllerUrl: URL,
	logoutToken: string,
	{ body, headers = {}, query = {} }: AdminOverrides = {},
): Promise<AdminResponse> => {
	const response = await fetch(urlFor(controllerUrl, PATHS.backChannelLogout, query), {
		body: body ?? new URLSearchParams({ logout_token: logoutToken }).toString(),
		headers: mergedHeaders({ 'content-type': FORM_MEDIA }, headers),
		method: 'POST',
		redirect: 'manual',
	});
	return responseOf(response);
};

const unauthenticatedGet = async (
	controllerUrl: URL,
	path: string,
	{ headers = {}, query = {} }: AdminOverrides = {},
): Promise<AdminResponse> =>
	responseOf(
		await fetch(urlFor(controllerUrl, path, query), {
			headers: mergedHeaders({}, headers),
			method: 'GET',
			redirect: 'manual',
		}),
	);

/**
 * Asks for the API documentation page: `GET /api-docs`, unauthenticated.
 *
 * @param controllerUrl the Controller's URL, ending in `/`.
 * @param overrides departures from the request.
 */
export const readApiDocsPage = (controllerUrl: URL, overrides?: AdminOverrides): Promise<AdminResponse> =>
	unauthenticatedGet(controllerUrl, PATHS.apiDocs, overrides);

/**
 * Asks for the contract the API documentation page shows: `GET /api-docs/openapi.json`,
 * unauthenticated.
 *
 * @param controllerUrl the Controller's URL, ending in `/`.
 * @param overrides departures from the request.
 */
export const readApiDocsContract = (controllerUrl: URL, overrides?: AdminOverrides): Promise<AdminResponse> =>
	unauthenticatedGet(controllerUrl, PATHS.apiDocsContract, overrides);

/**
 * Asks whether the Controller is ready to serve (#214 Q18): `GET /health/ready`, unauthenticated,
 * answered 200 or 503 with no detail in the body.
 *
 * @param controllerUrl the Controller's URL, ending in `/`.
 * @param overrides departures from the request.
 */
export const readReadiness = (controllerUrl: URL, overrides?: AdminOverrides): Promise<AdminResponse> =>
	unauthenticatedGet(controllerUrl, PATHS.readiness, overrides);

/**
 * Asks whether the Controller's process should go on running (#214 Q18): `GET /health/live`,
 * unauthenticated, answered 200 until the Controller's log stream fails a write and 503 after, with
 * no detail in the body.
 *
 * @param controllerUrl the Controller's URL, ending in `/`.
 * @param overrides departures from the request.
 */
export const readLiveness = (controllerUrl: URL, overrides?: AdminOverrides): Promise<AdminResponse> =>
	unauthenticatedGet(controllerUrl, PATHS.liveness, overrides);

/**
 * Mints a logout token from the identity provider stand-in, shaped as OpenID Connect Back-Channel
 * Logout 1.0 §2.4 has it: `aud` the client, `events` holding the back-channel logout member as an
 * empty object, `sub` and `sid` as given, header `typ` `logout+jwt`, and none of an access token's
 * own claims. `iss`, `iat`, `exp` and `jti` are the stand-in's.
 *
 * @param provider the stand-in.
 * @param options the client, the subject and the session, and anything over them.
 */
export const mintLogoutToken = (
	provider: IdentityProvider,
	{ audience, mint = {}, sessionId, subject }: LogoutTokenOptions,
): Promise<string> =>
	provider.mint({
		lifetimeSeconds: 120,
		...mint,
		claims: {
			...ACCESS_TOKEN_ONLY_CLAIMS,
			aud: [audience],
			events: { [BACK_CHANNEL_LOGOUT_EVENT]: {} },
			...(sessionId === undefined ? {} : { sid: sessionId }),
			...(subject === undefined ? {} : { sub: subject }),
			...mint.claims,
		},
		header: { typ: 'logout+jwt', ...mint.header },
	});

/** What a management token needs from the configuration. */
export type ManagementTokenConfiguration = Pick<
	ControllerConfiguration,
	'firstUserRole' | 'managementAudience' | 'managementClients'
>;

/**
 * The claims of a management token over the stand-in's Keycloak-shaped defaults (#212 Q3): `aud`
 * the management API, `azp` the first configured management client, the person's subject and
 * address, and Keycloak's default realm roles, with the first-user role beside them for the first
 * user. A token makes no administrator: the store holds who administers.
 *
 * @param provider the stand-in, whose realm names the default roles.
 * @param configuration the management audience and clients, and the first-user role.
 * @param person who calls.
 * @param firstUser whether the token carries the first-user role.
 */
export const managementClaims = (
	provider: IdentityProvider,
	{ firstUserRole, managementAudience, managementClients }: ManagementTokenConfiguration,
	person: Person,
	firstUser: boolean,
): Readonly<Record<string, unknown>> => {
	const [client] = managementClients;
	if (client !== undefined) {
		const realm = new URL(provider.issuer).pathname.split('/').at(-1) ?? '';
		return {
			aud: [managementAudience],
			azp: client,
			email: person.email,
			preferred_username: person.email,
			realm_access: {
				roles: [
					`default-roles-${realm}`,
					'offline_access',
					'uma_authorization',
					...(firstUser ? [firstUserRole] : []),
				],
			},
			sub: person.subject,
		};
	}
	throw new Error('a management token needs a configured management client');
};

/**
 * Mints a management token from the identity provider stand-in.
 *
 * @param provider the stand-in.
 * @param configuration the management audience and clients, and the first-user role.
 * @param person who calls.
 * @param options whether the token carries the first-user role, and anything over its claims.
 */
export const mintManagementToken = (
	provider: IdentityProvider,
	configuration: ManagementTokenConfiguration,
	person: Person,
	{ firstUser = false, mint = {} }: { firstUser?: boolean; mint?: MintOptions } = {},
): Promise<string> =>
	provider.mint({
		...mint,
		claims: {
			...managementClaims(provider, configuration, person, firstUser),
			...mint.claims,
		},
	});

const problem = <Code extends string, Status extends number>(
	code: Code,
	status: Status,
): Readonly<{ code: Code; status: Status }> => Object.freeze({ code, status });

/**
 * Every problem code a refusal of the Policy Management API carries, with the status it comes with:
 * C2's mapping as the rulings amend it. Every refusal is RFC 9457 problem details carrying a `code`
 * and no internal detail, and never repeats a value the caller sent.
 *
 * - 400, no code ruled: a body or query unreadable by its shape (not JSON, not an object, a
 *   required member missing, a member of the wrong type, or a member the operation does not take,
 *   other than those named in its 422), but for a resource registration naming no `accessLevel`,
 *   which is refused 422 (ruled).
 * - 401, no code ruled: any refused credential, with `WWW-Authenticate: Bearer`.
 * - 403: `noAdministratorYet`, every operation but nominating, accepting and a nominee's listing,
 *   to everyone, a service account included, until Usher's first administrator has accepted;
 *   `notFirstUser`, a nomination by a principal whose token lacks the first-user role, before its
 *   body is read; `serviceAccountNotPermitted`, a service account's token, on every operation
 *   before any lookup; `administratorOnly`, an administrator-only operation (retiring, deleting,
 *   serving, a category's update, asking for revoked grants or retired resources), to everyone
 *   else before any lookup, so identical whether or not the resource exists;
 *   `ownersAndAdministratorsOnly`, the category listing, to a caller neither owning a resource nor
 *   administering; `administratorGrantsNoConsumerAccess`, an administrator granting someone
 *   consumer access, which is the owner's (#212 Q4); `administratorSelfOwnership`, an
 *   administrator naming themself owner; `noAuthorityOnResource`, a caller who may see the resource
 *   and holds no authority for the operation on it.
 * - 404: `resourceNotFound`, a resource the caller may not see or that does not exist;
 *   `holderNotFound`, no account, only once the caller's authority on the resource is established;
 *   `grantNotFound`, any grant id the caller may not act on; `applicationNotFound`, an unregistered
 *   application in a path, its id unknown or malformed, after the 403 for a non-administrator;
 *   `applicationKeyNotFound`, a key id in a revocation's path that is unknown, malformed or names
 *   another application's key, one answer for all three; `nomineeNotFound`, a nominee who is
 *   neither the caller nor a person Usher has met; `nominationNotFound`, a nomination id that is
 *   malformed, unknown or names someone other than the caller, one answer for all three.
 * - 409: `alreadyExists`; `alreadyHolds`; `doesNotHold`, a key revoked already among them;
 *   `grantsOrInvitationsRemain`, retiring while a non-owner live grant or a pending invitation
 *   remains, its text saying to revoke them first; `resourceNeedsAnOwner`, revoking or declining a
 *   resource's last owner grant; `importInProgress`, a run of the EGO import while another holds
 *   its lock; `applicationKeyLimit`, an issue for an application holding
 *   {@link APPLICATION_LIVE_KEY_LIMIT} live keys already; `firstAdministratorAccepted`, a
 *   nomination or an acceptance once Usher's first administrator has accepted;
 *   `nominationSuperseded`, an acceptance of a nomination a later one replaced.
 * - 413: `bodyTooLarge`, a body over its endpoint's limit ({@link BODY_LIMIT_BYTES}), the detail
 *   naming the limit and holding nothing of the body (ruled, "#216: faults mid-run, 401 and 413"
 *   4).
 * - 415: `unsupportedMediaType`, a body in a media type other than `application/json`, or in none.
 * - 422, a well-formed request breaking a rule, a member named by the operation's 422 included:
 *   `registrationHasHistory`, deleting a registration that ever held a grant or an invitation, its
 *   text saying to retire it instead; `unknownApplication`, an unregistered application in a
 *   registration's body, the whole registration refused, or in an EGO import's `audiences`;
 *   `importNeedsAnAudience`, an EGO import whose `audiences` is empty (ruled);
 *   `ownerGrantsDoNotExpire`, an owner grant given an expiry. Other 422s carry no code the rulings
 *   name.
 * - 503: `directoryUnavailable`, an address operation the directory cannot answer;
 *   `importNotConfigured`, a run of the EGO import while its settings are missing, before its
 *   export is read; `storeUnavailable`, an operation that would write on a Controller whose
 *   database role may only read, failing closed with no partial effect (#216's refusals and the
 *   read-only role).
 */
export const PROBLEMS = Object.freeze({
	administratorGrantsNoConsumerAccess: problem('administratorGrantsNoConsumerAccess', 403),
	administratorOnly: problem('administratorOnly', 403),
	administratorSelfOwnership: problem('administratorSelfOwnership', 403),
	alreadyExists: problem('alreadyExists', 409),
	alreadyHolds: problem('alreadyHolds', 409),
	alreadyRequested: problem('alreadyRequested', 409),
	applicationKeyLimit: problem('applicationKeyLimit', 409),
	applicationKeyNotFound: problem('applicationKeyNotFound', 404),
	applicationNotFound: problem('applicationNotFound', 404),
	bodyTooLarge: problem('bodyTooLarge', 413),
	directoryUnavailable: problem('directoryUnavailable', 503),
	doesNotHold: problem('doesNotHold', 409),
	firstAdministratorAccepted: problem('firstAdministratorAccepted', 409),
	grantNotFound: problem('grantNotFound', 404),
	grantReplaced: problem('grantReplaced', 409),
	grantsOrInvitationsRemain: problem('grantsOrInvitationsRemain', 409),
	holderNotFound: problem('holderNotFound', 404),
	importInProgress: problem('importInProgress', 409),
	importNeedsAnAudience: problem('importNeedsAnAudience', 422),
	importNotConfigured: problem('importNotConfigured', 503),
	noAdministratorYet: problem('noAdministratorYet', 403),
	noAuthorityOnResource: problem('noAuthorityOnResource', 403),
	nominationNotFound: problem('nominationNotFound', 404),
	nominationSuperseded: problem('nominationSuperseded', 409),
	nomineeNotFound: problem('nomineeNotFound', 404),
	notFirstUser: problem('notFirstUser', 403),
	ownRequest: problem('ownRequest', 403),
	ownerGrantsDoNotExpire: problem('ownerGrantsDoNotExpire', 422),
	ownersAndAdministratorsOnly: problem('ownersAndAdministratorsOnly', 403),
	registrationHasHistory: problem('registrationHasHistory', 422),
	requestDecided: problem('requestDecided', 409),
	requestLapsed: problem('requestLapsed', 409),
	requestNotFound: problem('requestNotFound', 404),
	resourceNeedsAnOwner: problem('resourceNeedsAnOwner', 409),
	resourceNotFound: problem('resourceNotFound', 404),
	selfGrantExpiryRequired: problem('selfGrantExpiryRequired', 422),
	selfGrantTooLong: problem('selfGrantTooLong', 422),
	selfWideningNotPermitted: problem('selfWideningNotPermitted', 403),
	serviceAccountNotPermitted: problem('serviceAccountNotPermitted', 403),
	storeUnavailable: problem('storeUnavailable', 503),
	unknownApplication: problem('unknownApplication', 422),
	unsupportedMediaType: problem('unsupportedMediaType', 415),
});

type Problems = typeof PROBLEMS;

/** A problem code, of the status given or of any. */
export type ProblemCode<Status extends number = number> = {
	[Name in keyof Problems]: Problems[Name]['status'] extends Status ? Problems[Name]['code'] : never;
}[keyof Problems];

/**
 * The reason a denied event records for a refusal (ruled): the code the caller received, except where
 * a `resourceNotFound` or a `grantNotFound` stands in for a refusal of authority, so the caller cannot
 * tell a resource or grant they may not act on from an absent one; there the event records
 * `noAuthorityOnResource`, since the trail must say what happened. A resource or grant genuinely
 * absent records its not-found code.
 *
 * @param received the problem code the caller received.
 * @param standsInForAuthority whether the not-found answer hid a refusal of authority on something
 *   that exists.
 */
export const deniedEventReason = (received: ProblemCode, standsInForAuthority: boolean): ProblemCode =>
	standsInForAuthority && (received === PROBLEMS.resourceNotFound.code || received === PROBLEMS.grantNotFound.code)
		? PROBLEMS.noAuthorityOnResource.code
		: received;

/**
 * The reasons a caller may give for revoking a grant (ruled): a fixed code each, sent as `reason` and
 * recorded on its `grant.revocation`.
 */
export const GRANT_REVOCATION_REASONS = Object.freeze({
	accessNoLongerNeeded: 'accessNoLongerNeeded',
	accessReview: 'accessReview',
	custodianRequest: 'custodianRequest',
	grantedInError: 'grantedInError',
	holderLeftProject: 'holderLeftProject',
	requestedByHolder: 'requestedByHolder',
	termsViolation: 'termsViolation',
} as const);

/**
 * The reasons the Controller alone assigns, each refused when a caller sends it (ruled): `unspecified`,
 * recorded for a grant revocation, a suppression or a restoration given no reason; and
 * `resourceRetired`, recorded for each owner grant a retirement ends.
 */
export const SYSTEM_ASSIGNED_REASONS = Object.freeze({
	resourceRetired: 'resourceRetired',
	unspecified: 'unspecified',
} as const);

/**
 * The reasons for revoking an application key, recorded on its `applicationKey.revocation`: optional,
 * and `compromised` records the revocation at `critical`, every other at `info`. Any other value is
 * refused 422.
 */
export const APPLICATION_KEY_REVOCATION_REASONS = Object.freeze({
	compromised: 'compromised',
	retired: 'retired',
	rotated: 'rotated',
} as const);

/** The reasons for revoking every user of a resource (ruled), recorded on its `resource.revocation`. */
export const RESOURCE_REVOCATION_REASONS = Object.freeze({
	credentialCompromise: 'credentialCompromise',
	custodianRequest: 'custodianRequest',
	keyCompromise: 'keyCompromise',
	securityIncident: 'securityIncident',
} as const);

/** The reasons for a global revocation (ruled), recorded on its `platform.revocation`. */
export const PLATFORM_REVOCATION_REASONS = Object.freeze({
	credentialCompromise: 'credentialCompromise',
	keyCompromise: 'keyCompromise',
	securityIncident: 'securityIncident',
} as const);

/**
 * The reasons for revoking a principal's identity (ruled), recorded on its `identity.revocation`. A
 * system-assigned `accountDeleted` joins them only if automatic revocation of a deleted account is
 * decided.
 */
export const IDENTITY_REVOCATION_REASONS = Object.freeze({
	accountClosed: 'accountClosed',
	credentialCompromise: 'credentialCompromise',
	securityIncident: 'securityIncident',
	termsViolation: 'termsViolation',
} as const);

/** The reasons a caller may give for suppressing a resource (ruled); optional, `unspecified` recorded when absent. */
export const SUPPRESSION_REASONS = Object.freeze({
	consentWithdrawn: 'consentWithdrawn',
	custodianRequest: 'custodianRequest',
	dataQualityIssue: 'dataQualityIssue',
	legalRequest: 'legalRequest',
	securityIncident: 'securityIncident',
} as const);

/** The reasons a caller may give for restoring a resource (ruled); optional, `unspecified` recorded when absent. */
export const RESTORATION_REASONS = Object.freeze({
	custodianRequest: 'custodianRequest',
	issueResolved: 'issueResolved',
} as const);

/**
 * The member a grant's creation would name a field category by. The first release takes none
 * (#212 Q16). A grant has a field category (schema.md's `field_category_id`), so a body carrying one
 * breaks a rule and is refused 422, not 400 (#211 review point 3); the name is assumed, since no ruling
 * names it.
 */
export const FIELD_CATEGORY_MEMBER = 'fieldCategory';

/**
 * The largest request body each endpoint reads, in bytes (ruled, "#216's reasons, export size and
 * prefixes" 2): 10 MiB for the EGO import's endpoint alone, which checks the administrator before
 * it reads the body; 64 KiB for every other, as #208 Q13 set for the exchange. A body over its limit
 * is refused 413 `bodyTooLarge` in problem details whose detail names the limit and holds nothing of
 * the body (ruled, "#216: faults mid-run, 401 and 413" 4); {@link namesBodyLimit} reads the detail.
 */
export const BODY_LIMIT_BYTES = Object.freeze({
	egoImport: 10_485_760,
	everyOther: 65_536,
});

/**
 * Whether a refusal's detail names a body limit, written as its number of bytes in digits standing
 * alone, so 65536 is not found inside 655360: the ruling puts the limit in a `bodyTooLarge` refusal's
 * detail, and this form of it is assumed.
 *
 * @param problem the refusal's problem details.
 * @param limit the limit, in bytes, such as one of {@link BODY_LIMIT_BYTES}.
 */
export const namesBodyLimit = (problem: ProblemDetails | undefined, limit: number): boolean =>
	new RegExp(`(?<!\\d)${String(limit)}(?!\\d)`, 'u').test(problem?.detail ?? '');

/**
 * The query parameters a listing takes (#213 Q4, Q5, Q10): the page's cursor and size, as the audit
 * log names them (#214 Q13), and the two an administrator sends, each as `true`, to see revoked
 * grants and retired resources; anyone else asking is refused 403 `administratorOnly`.
 */
export const LISTING_QUERY = Object.freeze({
	cursor: 'cursor',
	includeRetired: 'includeRetired',
	includeRevoked: 'includeRevoked',
	limit: 'limit',
} as const);

/** The overrides asking a listing for revoked grants (#213 Q4). */
export const INCLUDING_REVOKED: AdminOverrides = Object.freeze({
	query: { [LISTING_QUERY.includeRevoked]: 'true' },
});

/** The overrides asking a listing for retired resources (#213 Q10). */
export const INCLUDING_RETIRED: AdminOverrides = Object.freeze({
	query: { [LISTING_QUERY.includeRetired]: 'true' },
});

/** A grant's state as a listing names it (#213 Q4); `accepted` and `rejected` as decisions name them (#212 Q15). */
export const GRANT_STATES = Object.freeze({
	accepted: 'accepted',
	expired: 'expired',
	pending: 'pending',
	rejected: 'rejected',
	revoked: 'revoked',
} as const);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const member = (value: unknown, name: string): unknown =>
	isRecord(value) && Object.hasOwn(value, name) ? value[name] : undefined;

const recordsIn = (value: unknown): readonly Readonly<Record<string, unknown>>[] | undefined =>
	Array.isArray(value) && value.every(isRecord) ? value : undefined;

const sortedIfList = (value: unknown): unknown => (Array.isArray(value) ? value.map(String).toSorted() : value);

/** A capability as the caller's own listing shows what a grant would let them do (#213). */
export interface CapabilityView {
	description: unknown;
	displayName: unknown;

	/** As `entity.action`. */
	name: unknown;
}

/** A grant's latest decision as a listing shows it: what was decided, when, and what was shown. */
export interface DecisionView {
	capabilities: unknown;
	decidedAt: unknown;
	decision: unknown;
}

/**
 * A grant's holder as a listing shows one, `{ subject, email, hasAccount }`: the address the directory
 * holds now, resolved at read time and never stored (#213 Q1), absent for a holder the directory no
 * longer knows, whose `hasAccount` is `false`.
 */
export interface HolderView {
	email: unknown;
	hasAccount: unknown;
	subject: unknown;
}

/**
 * A grant as a listing shows it, each member as the answer holds it: `capabilities` (the caller's own
 * listing: `name`, `displayName`, `description`), `category` (scoped, `null` for the wildcard),
 * `decision` (`decision`, `decidedAt`, `capabilities`), `expiresAt` (`null` for none), `grantedAt`,
 * `grantedBy` (`{ subject }` to an administrator, `{ name }` to an owner and a recipient, #213 Q7 and
 * Q9), `holder`, `id` (the opaque id), `resource` (the externalId), `revokedAt`, `role`, `selfGrant`
 * (`true` for an administrator's own grant) and `state` (one of {@link GRANT_STATES}).
 */
export interface GrantView {
	capabilities: readonly CapabilityView[] | undefined;
	category: unknown;
	decision: DecisionView | undefined;
	expiresAt: unknown;
	grantedAt: unknown;

	/** The member whole, for a test asserting what it holds and nothing more. */
	grantedBy: unknown;

	granterName: unknown;
	granterSubject: unknown;
	holder: HolderView | undefined;
	id: unknown;
	resource: unknown;
	revokedAt: unknown;
	role: unknown;
	selfGrant: unknown;
	state: unknown;
}

/**
 * A resource as a registration's answer, a read's and a listing's entry show it, each member as the
 * answer holds it: the registration's members (`externalId`, `displayName`, `description`,
 * `accessLevel`, `applications` by id, `fields` as values by field name), `categories` (the resource's
 * own, scoped), `registeredAt` and `updatedAt` (instants), `registeredBy` (`{ subject }`), `suppressed`,
 * `retired` (`true` for a retired resource, listed only to an administrator asking, #213 Q10),
 * `grants` (its grants, holders included) and `grantSummary`: to administrators and owners alone, the
 * holders of each role counted, a holder being an accepted, unexpired, unrevoked grant, pending and
 * declined ones left out (#213 Q8); a holder who owns nothing gets no such member.
 */
export interface ResourceView {
	accessLevel: unknown;

	/** Sorted, when the member is a list. */
	applications: unknown;

	/** Sorted, when the member is a list. */
	categories: unknown;

	/** `null` whether the member is `null` or absent, as a cleared description reads either way. */
	description: unknown;

	displayName: unknown;
	externalId: unknown;

	/** `{}` when the member is no object; a cleared value is absent. */
	fields: Readonly<Record<string, unknown>>;

	grants: readonly GrantView[] | undefined;
	grantSummary: unknown;
	registeredAt: unknown;

	/** The `subject` of the `registeredBy` object; `undefined` when the member is no object. */
	registrantSubject: unknown;

	retired: unknown;
	suppressed: unknown;
	updatedAt: unknown;
}

const capabilityView = (value: unknown): CapabilityView => ({
	description: member(value, 'description'),
	displayName: member(value, 'displayName'),
	name: member(value, 'name'),
});

const decisionView = (value: unknown): DecisionView | undefined =>
	isRecord(value)
		? {
				capabilities: member(value, 'capabilities'),
				decidedAt: member(value, 'decidedAt'),
				decision: member(value, 'decision'),
			}
		: undefined;

const holderView = (value: unknown): HolderView | undefined =>
	isRecord(value)
		? {
				email: member(value, 'email'),
				hasAccount: member(value, 'hasAccount'),
				subject: member(value, 'subject'),
			}
		: undefined;

/**
 * A grant entry read as a {@link GrantView}.
 *
 * @param value one entry of a listing's grants.
 */
export const grantView = (value: unknown): GrantView => ({
	capabilities: recordsIn(member(value, 'capabilities'))?.map(capabilityView),
	category: member(value, 'category'),
	decision: decisionView(member(value, 'decision')),
	expiresAt: member(value, 'expiresAt'),
	grantedAt: member(value, 'grantedAt'),
	grantedBy: member(value, 'grantedBy'),
	granterName: member(member(value, 'grantedBy'), 'name'),
	granterSubject: member(member(value, 'grantedBy'), 'subject'),
	holder: holderView(member(value, 'holder')),
	id: member(value, 'id'),
	resource: member(value, 'resource'),
	revokedAt: member(value, 'revokedAt'),
	role: member(value, 'role'),
	selfGrant: member(value, 'selfGrant'),
	state: member(value, 'state'),
});

/**
 * A resource entry, or a registration's or a read's body, read as a {@link ResourceView}.
 *
 * @param value the entry.
 */
export const resourceView = (value: unknown): ResourceView => {
	const fields = member(value, 'fields');
	return {
		accessLevel: member(value, 'accessLevel'),
		applications: sortedIfList(member(value, 'applications')),
		categories: sortedIfList(member(value, 'categories')),
		description: member(value, 'description') ?? null,
		displayName: member(value, 'displayName'),
		externalId: member(value, 'externalId'),
		fields: isRecord(fields) ? fields : {},
		grants: recordsIn(member(value, 'grants'))?.map(grantView),
		grantSummary: member(value, 'grantSummary'),
		registeredAt: member(value, 'registeredAt'),
		registrantSubject: member(member(value, 'registeredBy'), 'subject'),
		retired: member(value, 'retired'),
		suppressed: member(value, 'suppressed'),
		updatedAt: member(value, 'updatedAt'),
	};
};

/**
 * An answer's body as a JSON object, failing the test when it is not one.
 *
 * @param response the answer.
 * @param label what the answer was to, for the failure's message.
 */
export const bodyObjectOf = (response: AdminResponse, label: string): Readonly<Record<string, unknown>> =>
	isRecord(response.body) ? response.body : assert.fail(`${label} answered no JSON object`);

/**
 * A registration's or a read's answer as a {@link ResourceView}, failing the test unless its body is
 * a JSON object.
 *
 * @param response the answer.
 * @param label what the answer was to, for the failure's message.
 */
export const resourceViewOf = (response: AdminResponse, label: string): ResourceView =>
	resourceView(bodyObjectOf(response, label));

/**
 * Reads a resource, failing the test unless the read succeeds, and gives it as the answer shows it.
 *
 * @param caller who reads.
 * @param externalId the resource.
 */
export const readResourceView = async (caller: AdminCaller, externalId: string): Promise<ResourceView> => {
	const response = await readResource(caller, externalId);
	assertSucceeded(response, `reading ${externalId}`);
	return resourceViewOf(response, `reading ${externalId}`);
};

/** An application key in the answer to its issue: the one answer holding its value. */
export interface IssuedApplicationKey {
	/** The key's id, a uuid. */
	id: string;

	/** The key: 32 bytes as 43 base64url characters, for the application's Bridge. */
	value: string;
}

/** An application in the answer to its registration, carrying its first key. */
export interface RegisteredApplication {
	/** `null` for none, and for one empty once trimmed. */
	description: string | null;

	displayName: string;

	/** The application's generated id, a uuid: its audience. */
	id: string;

	key: IssuedApplicationKey;
}

const stringMember = (value: unknown, name: string, label: string): string => {
	const held = member(value, name);
	return typeof held === 'string' ? held : assert.fail(`${label} answered no string ${name}`);
};

const nullableStringMember = (value: unknown, name: string, label: string): string | null => {
	const held = member(value, name);
	return held === null ? null : stringMember(value, name, label);
};

const issuedKeyIn = (value: unknown, label: string): IssuedApplicationKey => ({
	id: stringMember(value, 'id', label),
	value: stringMember(value, 'value', label),
});

/**
 * The key in the answer to an issue, `{ id, value }`, failing the test unless the body is a JSON
 * object holding both as strings.
 *
 * @param response the answer.
 * @param label what the answer was to, for the failure's message.
 */
export const issuedApplicationKeyOf = (response: AdminResponse, label: string): IssuedApplicationKey =>
	issuedKeyIn(bodyObjectOf(response, label), label);

/**
 * The application in the answer to a registration, `{ id, displayName, description, key }`, failing
 * the test unless each member is there with its type: strings, `description` a string or `null`, and
 * `key` an object holding a string `id` and `value`.
 *
 * @param response the answer.
 * @param label what the answer was to, for the failure's message.
 */
export const registeredApplicationOf = (response: AdminResponse, label: string): RegisteredApplication => {
	const body = bodyObjectOf(response, label);
	return {
		description: nullableStringMember(body, 'description', label),
		displayName: stringMember(body, 'displayName', label),
		id: stringMember(body, 'id', label),
		key: issuedKeyIn(member(body, 'key'), `${label}, its key`),
	};
};

/** The member names of a key in an application's read, sorted: never its value. */
export const APPLICATION_KEY_MEMBERS: readonly string[] = Object.freeze([
	'confirmedAt',
	'id',
	'issuedAt',
	'issuedBy',
	'revokedAt',
	'revokedBy',
]);

/** A key in an application's read, each member taken from the answer unchanged. */
export interface ApplicationKeyView {
	/**
	 * When the first exchange carrying a channel assertion verified under the key was answered, whatever
	 * the answer, a 403 for its sign-in token included; `null` until then.
	 */
	confirmedAt: unknown;

	id: unknown;
	issuedAt: unknown;

	/** The member whole: `{ subject }`. */
	issuedBy: unknown;

	/** Every member name held by the entry, sorted, for a test finding one beyond {@link APPLICATION_KEY_MEMBERS}. */
	members: readonly string[];

	/** `null` for a live key. */
	revokedAt: unknown;

	/** The member whole: `{ subject }`, or `null` for a live key. */
	revokedBy: unknown;
}

/** An application in its read, each member taken from the answer unchanged. */
export interface ApplicationView {
	description: unknown;
	displayName: unknown;
	id: unknown;

	/** In the answer's order, which is `issuedAt`'s; `undefined` when the member is no list of objects. */
	keys: readonly ApplicationKeyView[] | undefined;

	registeredAt: unknown;

	/** The member whole: `{ subject }`. */
	registeredBy: unknown;
}

/** A key in the answer to its revocation, each member taken from the answer unchanged. */
export interface RevokedApplicationKeyView {
	id: unknown;

	/** Every member name held by the answer, sorted. */
	members: readonly string[];

	revokedAt: unknown;

	/** The member whole: `{ subject }`. */
	revokedBy: unknown;
}

const memberNames = (value: unknown): readonly string[] => (isRecord(value) ? Object.keys(value).toSorted() : []);

const applicationKeyView = (value: unknown): ApplicationKeyView => ({
	confirmedAt: member(value, 'confirmedAt'),
	id: member(value, 'id'),
	issuedAt: member(value, 'issuedAt'),
	issuedBy: member(value, 'issuedBy'),
	members: memberNames(value),
	revokedAt: member(value, 'revokedAt'),
	revokedBy: member(value, 'revokedBy'),
});

/**
 * An application's read, `{ id, displayName, description, registeredAt, registeredBy, keys }`, read
 * as an {@link ApplicationView}.
 *
 * @param value the answer's body.
 */
export const applicationView = (value: unknown): ApplicationView => ({
	description: member(value, 'description'),
	displayName: member(value, 'displayName'),
	id: member(value, 'id'),
	keys: recordsIn(member(value, 'keys'))?.map(applicationKeyView),
	registeredAt: member(value, 'registeredAt'),
	registeredBy: member(value, 'registeredBy'),
});

/**
 * A read's answer as an {@link ApplicationView}, failing the test unless its body is a JSON object.
 *
 * @param response the answer.
 * @param label what the answer was to, for the failure's message.
 */
export const applicationViewOf = (response: AdminResponse, label: string): ApplicationView =>
	applicationView(bodyObjectOf(response, label));

/**
 * Reads an application, failing the test unless the read succeeds, and gives its
 * {@link ApplicationView}.
 *
 * @param caller who reads: a platform administrator.
 * @param applicationId the application's id.
 */
export const readApplicationView = async (caller: AdminCaller, applicationId: string): Promise<ApplicationView> => {
	const response = await readApplication(caller, applicationId);
	assertSucceeded(response, `reading application ${applicationId}`);
	return applicationViewOf(response, `reading application ${applicationId}`);
};

/**
 * A revocation's answer, `{ id, revokedAt, revokedBy }`, read as a {@link RevokedApplicationKeyView},
 * failing the test unless its body is a JSON object.
 *
 * @param response the answer.
 * @param label what the answer was to, for the failure's message.
 */
export const revokedApplicationKeyOf = (response: AdminResponse, label: string): RevokedApplicationKeyView => {
	const body = bodyObjectOf(response, label);
	return {
		id: member(body, 'id'),
		members: memberNames(body),
		revokedAt: member(body, 'revokedAt'),
		revokedBy: member(body, 'revokedBy'),
	};
};

/**
 * The directives of an answer's `Cache-Control`, each lower-cased with any argument left out, in
 * order; none without the header. An answer carrying an application key's value holds `no-store`.
 *
 * @param response the answer.
 */
export const cacheDirectivesOf = (response: Pick<AdminResponse, 'headers'>): readonly string[] =>
	(response.headers.get('cache-control') ?? '')
		.split(',')
		.map((directive) => (directive.split('=')[0] ?? '').trim().toLowerCase())
		.filter((directive) => directive.length > 0);

const listed = (response: AdminResponse, name: string): readonly Readonly<Record<string, unknown>>[] => {
	assertSucceeded(response, `the listing of ${name}`);
	const entries = recordsIn(member(response.body, name));
	if (entries !== undefined) {
		return entries;
	}
	throw new Error(`the listing answered ${response.status} with no list of ${name}`);
};

/**
 * The resources a resource listing's page answered, in its order: the body's `resources`. A page is
 * `{ resources, next }` and holds no other member.
 *
 * @param response the answer, which must have succeeded.
 */
export const listedResources = (response: AdminResponse): readonly ResourceView[] =>
	listed(response, 'resources').map(resourceView);

/**
 * The grants a grants listing answered, in its order: the body's `grants`, for a resource's grants, a
 * person's and the caller's own.
 *
 * @param response the answer, which must have succeeded.
 */
export const listedGrants = (response: AdminResponse): readonly GrantView[] =>
	listed(response, 'grants').map(grantView);

/**
 * The externalIds a resource listing's page answered, in its order.
 *
 * @param response the answer, which must have succeeded.
 */
export const listedExternalIds = (response: AdminResponse): readonly unknown[] =>
	listedResources(response).map(({ externalId }) => externalId);

/**
 * One resource of a resource listing's page, by externalId.
 *
 * @param response the answer, which must have succeeded.
 * @param externalId the resource.
 * @throws when the page holds no such resource.
 */
export const listedResource = (response: AdminResponse, externalId: string): ResourceView => {
	const found = listedResources(response).find((resource) => resource.externalId === externalId);
	if (found !== undefined) {
		return found;
	}
	throw new Error(`the listing holds no ${externalId}`);
};

/**
 * The cursor of the page after this one, the body's `next`, absent or `null` on the last page
 * (#213 Q5, and the audit log's alike).
 *
 * @param response a page.
 */
export const nextCursor = (response: AdminResponse): string | undefined => {
	const next = member(response.body, 'next');
	return typeof next === 'string' ? next : undefined;
};

/**
 * The members a page holds beside its list and `next`, which a page never holds.
 *
 * @param response a page.
 * @param list the page's list: `resources`, `grants` or `events`.
 */
export const pageMembersBeside = (
	response: AdminResponse,
	list: 'events' | 'grants' | 'resources',
): readonly string[] =>
	isRecord(response.body) ? Object.keys(response.body).filter((name) => name !== list && name !== 'next') : [];

/**
 * Every page of the resource listing, each of a given size at most, from the first to the one naming
 * no next page, following each page's cursor.
 *
 * @param caller the Controller and the caller's token.
 * @param options the page size, and the most pages read before the listing is taken to never end.
 */
export const resourcePages = async (
	caller: AdminCaller,
	{ limit, maximumPages = 20 }: { limit: number; maximumPages?: number },
): Promise<readonly AdminResponse[]> => {
	const from = async (
		cursor: string | undefined,
		read: readonly AdminResponse[],
	): Promise<readonly AdminResponse[]> => {
		const page = await listResources(caller, {
			query: {
				...(cursor === undefined ? {} : { [LISTING_QUERY.cursor]: cursor }),
				[LISTING_QUERY.limit]: String(limit),
			},
		});
		assertSucceeded(page, `page ${read.length + 1} of the resources`);
		const pages = [...read, page];
		const next = nextCursor(page);
		if (next === undefined) {
			return pages;
		}
		if (pages.length < maximumPages) {
			return from(next, pages);
		}
		throw new Error(`the listing went on past ${maximumPages} pages`);
	};
	return from(undefined, []);
};

/**
 * The members a grant's holder is listed by: its subject, its address, and whether it is marked as
 * having no account.
 *
 * @param grant the listed grant.
 */
export const holderOf = (grant: GrantView): { email: string | undefined; noAccount: boolean; subject: unknown } => {
	const email = grant.holder?.email;
	return {
		email: typeof email === 'string' ? email : undefined,
		noAccount: grant.holder?.hasAccount === false,
		subject: grant.holder?.subject,
	};
};

/**
 * A grant summary's roles holding anyone, with their counts: every role counted above zero.
 *
 * @param summary the `grantSummary` member.
 */
export const rolesHeld = (summary: unknown): Readonly<Record<string, unknown>> =>
	isRecord(summary)
		? Object.fromEntries(Object.entries(summary).filter(([, count]) => typeof count !== 'number' || count > 0))
		: {};

/**
 * Whether a read's body carries a grant summary at all, which one read by a holder who owns nothing
 * does not (#213 Q8, ruled).
 *
 * @param body the read's body.
 */
export const carriesGrantSummary = (body: unknown): boolean => isRecord(body) && Object.hasOwn(body, 'grantSummary');

/** A category as the category listing shows it: its scoped name and its description. */
export interface CategoryView {
	description: unknown;
	name: unknown;
}

const namedEntries = (response: AdminResponse, list: string): readonly { description: unknown; name: unknown }[] => {
	const entries = bodyObjectOf(response, `listing ${list}`)[list];
	assert.ok(Array.isArray(entries), `the listing holds a list of ${list}`);
	return entries
		.map((entry: unknown) => ({
			description: member(entry, 'description') ?? null,
			name: member(entry, 'name'),
		}))
		.toSorted((first, second) => String(first.name).localeCompare(String(second.name)));
};

/**
 * The categories a category listing answers, `{ categories: [{ name, description }] }`, each name
 * scoped, sorted by name.
 *
 * @param response the listing's answer.
 */
export const categoriesOf = (response: AdminResponse): readonly CategoryView[] => namedEntries(response, 'categories');

/** A resource field as the field listing shows it: its name and its description. */
export interface ResourceFieldView {
	description: unknown;
	name: unknown;
}

/**
 * The resource fields a field listing answers, `{ fields: [{ name, description }] }`, sorted by name.
 *
 * @param response the listing's answer.
 */
export const resourceFieldsOf = (response: AdminResponse): readonly ResourceFieldView[] =>
	namedEntries(response, 'fields');

/** One page of `GET /admin/audit`. */
export interface AuditPage {
	/** The page's events, each as the API answers it. */
	events: readonly Readonly<Record<string, unknown>>[];

	/** The cursor to the next page, absent on the last. */
	next: string | undefined;
}

/**
 * A page of the audit log, `{ events, next }`, read from a 200's body, `next` named as the listings
 * name their cursor and absent or `null` on the last page.
 *
 * @param response the answer.
 */
export const auditPageOf = (response: AdminResponse): AuditPage => {
	assert.equal(response.status, 200, 'the audit log was read');
	const events = member(response.body, 'events');
	assert.ok(Array.isArray(events), 'the page holds an events list');
	return {
		events: events.map((event: unknown) =>
			isRecord(event) ? event : assert.fail('a page entry is not an object'),
		),
		next: nextCursor(response),
	};
};

/** What two refusals are compared by: everything a caller can tell apart but the `instance`. */
export interface ComparableRefusal {
	/** The `www-authenticate` header, or `null`. */
	authenticate: string | null;

	/** The body parsed when it is JSON, its `instance` left out; the text otherwise. */
	body: unknown;

	mediaType: string;
	status: number;
}

/**
 * A refusal as two are compared for being identical (ruled): the same status, media type,
 * `WWW-Authenticate` and body, only RFC 9457's `instance` left out, since it names one occurrence. No
 * value is masked: a refusal never repeats a value the caller sent, so one that does differs.
 *
 * @param response the answer.
 */
export const comparableRefusal = (response: AdminResponse): ComparableRefusal => {
	const parsed = response.body ?? response.text;
	return {
		authenticate: response.headers.get('www-authenticate'),
		body: isRecord(parsed)
			? Object.fromEntries(Object.entries(parsed).filter(([name]) => name !== 'instance'))
			: parsed,
		mediaType: mediaTypeOf(response),
		status: response.status,
	};
};

/** The shape of a JSON value: each member's name and the shape of its value, and each value's JSON type. */
export type Shape = readonly Shape[] | string | { readonly [member: string]: Shape };

/**
 * A JSON value's shape, for answers that must be indistinguishable whatever values they carry.
 *
 * @param value the parsed value.
 */
export const shapeOf = (value: unknown): Shape => {
	if (Array.isArray(value)) {
		return value.map((item: unknown) => shapeOf(item));
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.toSorted(([first], [second]) => first.localeCompare(second))
				.map(([name, held]): [string, Shape] => [name, shapeOf(held)]),
		);
	}
	return value === null ? 'null' : typeof value;
};

/** What two successful answers are compared by for being indistinguishable. */
export interface ComparableSuccess {
	/** Every header's name, lower-cased and sorted, so a header sent for one outcome alone tells them apart. */
	headerNames: readonly string[];

	mediaType: string;

	/** The body's {@link shapeOf}; `string` for a body that is no JSON. */
	shape: Shape;

	status: number;
}

/**
 * A successful answer as two are compared for being indistinguishable, such as an owner's addition
 * by an address an account holds and by one none holds (#212 Q7): the status, the media type, every
 * header's name and the body's shape. Values differ legitimately between the two, so they are left
 * out; a header such as `location` sent only when a row was written is not.
 *
 * @param response the answer.
 */
export const comparableSuccess = (response: AdminResponse): ComparableSuccess => ({
	headerNames: [...new Set(response.headers.keys())].toSorted(),
	mediaType: mediaTypeOf(response),
	shape: response.body === undefined ? typeof response.text : shapeOf(response.body),
	status: response.status,
});

/** A refusal as a test expects it: its status, and its problem's code where a ruling names one. */
export interface ExpectedRefusal {
	code?: string;
	status: number;
}

const outcomeOf = (response: AdminResponse): string =>
	`${response.status}${response.problem === undefined ? '' : ` ${response.problem.code}`}`;

/**
 * Fails unless an answer is the refusal expected (C2): its status; RFC 9457 problem details, as
 * `application/problem+json` carrying a string `code`; the code expected, where one is; and
 * `WWW-Authenticate` naming the Bearer scheme on a 401.
 *
 * @param response the answer.
 * @param expected the status, and the code where a ruling names one.
 * @param label what was refused, for the failure's message.
 */
export const assertRefused = (response: AdminResponse, { code, status }: ExpectedRefusal, label: string): void => {
	assert.equal(response.status, status, `${label}: answered ${outcomeOf(response)}`);
	assert.equal(mediaTypeOf(response), PROBLEM_MEDIA, `${label}: media type`);
	assert.equal(typeof response.problem?.code, 'string', `${label}: a problem's code`);
	if (code !== undefined) {
		assert.equal(response.problem?.code, code, `${label}: the problem's code`);
	}
	if (status === 401) {
		assert.match(
			response.headers.get('www-authenticate') ?? '',
			/^Bearer(?:\s|,|$)/u,
			`${label}: WWW-Authenticate names the Bearer scheme`,
		);
	}
};

/**
 * Fails unless an answer refuses a request unreadable by its shape: 400 (C2).
 *
 * @param response the answer.
 * @param label what was refused, for the failure's message.
 */
export const assertUnreadable = (response: AdminResponse, label: string): void =>
	assertRefused(response, { status: 400 }, label);

/**
 * Fails unless an answer refuses the credential: 401 with `WWW-Authenticate: Bearer` (C2).
 *
 * @param response the answer.
 * @param label what was refused, for the failure's message.
 */
export const assertCredentialRefused = (response: AdminResponse, label: string): void =>
	assertRefused(response, { status: 401 }, label);

/**
 * Fails unless an answer is a 403 carrying the code given (C2).
 *
 * @param response the answer.
 * @param label what was refused, for the failure's message.
 * @param code the problem's code.
 */
export const assertForbidden = (response: AdminResponse, label: string, code: ProblemCode<403>): void =>
	assertRefused(response, { code, status: 403 }, label);

/**
 * Fails unless an answer is a 404 carrying the code given (C2).
 *
 * @param response the answer.
 * @param label what was refused, for the failure's message.
 * @param code the problem's code.
 */
export const assertNotFound = (response: AdminResponse, label: string, code: ProblemCode<404>): void =>
	assertRefused(response, { code, status: 404 }, label);

/**
 * Fails unless an answer is a 409 carrying the code given (C2).
 *
 * @param response the answer.
 * @param label what was refused, for the failure's message.
 * @param code the problem's code.
 */
export const assertConflict = (response: AdminResponse, label: string, code: ProblemCode<409>): void =>
	assertRefused(response, { code, status: 409 }, label);

/**
 * Fails unless an answer refuses a body's media type: 415 `unsupportedMediaType` (ruled).
 *
 * @param response the answer.
 * @param label what was refused, for the failure's message.
 */
export const assertUnsupportedMediaType = (response: AdminResponse, label: string): void =>
	assertRefused(response, PROBLEMS.unsupportedMediaType, label);

/**
 * Fails unless an answer refuses a well-formed request for breaking a rule: 422, with the code given
 * where a ruling names one.
 *
 * @param response the answer.
 * @param label what was refused, for the failure's message.
 * @param code the problem's code, if a ruling names one.
 */
export const assertRuleBroken = (response: AdminResponse, label: string, code?: ProblemCode<422>): void =>
	assertRefused(response, { ...(code === undefined ? {} : { code }), status: 422 }, label);

/**
 * Fails unless an answer is a 503, with the code given where a ruling names one, such as
 * `directoryUnavailable`.
 *
 * @param response the answer.
 * @param label what was refused, for the failure's message.
 * @param code the problem's code, if a ruling names one.
 */
export const assertUnavailable = (response: AdminResponse, label: string, code?: ProblemCode<503>): void =>
	assertRefused(response, { ...(code === undefined ? {} : { code }), status: 503 }, label);

/**
 * Fails unless a refusal's problem details say, in their `title` or `detail`, what a pattern
 * matches: what the caller can do next, where a ruling names it.
 *
 * @param response the answer.
 * @param pattern what the text must say.
 * @param label what was refused, for the failure's message.
 */
export const assertProblemSays = (response: AdminResponse, pattern: RegExp, label: string): void =>
	assert.match(
		[response.problem?.title ?? '', response.problem?.detail ?? ''].join('\n'),
		pattern,
		`${label}: the problem's text`,
	);

/** Departures from an operation's own request that `fetch` cannot send. */
export interface RawDepartures {
	/**
	 * Every `authorization` line sent, in order, each a header line of its own: the caller's bearer
	 * credential once by default; none for an empty list.
	 */
	authorizations?: readonly string[];

	/** The `content-type` sent: the operation's own by default; `null` sends no such header at all. */
	contentType?: string | null;
}

const REPLAYED_APART: ReadonlySet<string> = new Set([
	'authorization',
	'connection',
	'content-length',
	'content-type',
	'host',
]);

const replayed = (
	url: URL,
	{
		body,
		headers,
		method,
	}: {
		body: string;
		headers: Readonly<Record<string, string | readonly string[]>>;
		method: string;
	},
): Promise<AdminResponse> =>
	new Promise((resolve, reject) => {
		const outgoing = httpRequest(
			url,
			{
				headers: Object.fromEntries(
					Object.entries(headers).map(([name, value]) => [
						name,
						typeof value === 'string' ? value : [...value],
					]),
				),
				method,
			},
			(incoming) => {
				const chunks: Buffer[] = [];
				incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
				incoming.on('end', () => {
					const received = new Headers();
					incoming.rawHeaders.forEach((value, index, raw) => {
						if (index % 2 === 1) {
							received.append(raw[index - 1] ?? '', value);
						}
					});
					resolve(answerOf(incoming.statusCode ?? 0, received, Buffer.concat(chunks).toString('utf8')));
				});
				incoming.on('error', reject);
			},
		);
		outgoing.on('error', reject);
		outgoing.end(body);
	});

interface ReplayedRequest {
	/** The body the operation sent. */
	body: string;

	/** The headers to send, `content-length` aside: the operation's own, with the departures. */
	headers: Readonly<Record<string, string | readonly string[]>>;

	method: string;
	url: URL;
}

// The operation is first sent to a recording server, so its path, its other headers and its body
// stay this module's, then replayed to the Controller with the departures.
const recordedOperation = async (
	caller: AdminCaller,
	operation: (recorded: AdminCaller) => Promise<AdminResponse>,
	{ authorizations, contentType }: RawDepartures,
): Promise<ReplayedRequest> => {
	const recorder = await startRecordingServer();
	try {
		await operation({ token: caller.token, url: recorder.url });
	} finally {
		await recorder.stop();
	}
	const [sent] = recorder.requests;
	if (sent === undefined) {
		throw new Error('the operation sent nothing');
	}
	const authorizationLines = authorizations ?? (caller.token === null ? [] : [`Bearer ${caller.token}`]);
	const sentContentType = contentType === undefined ? sent.headers['content-type'] : contentType;
	const kept = Object.fromEntries(
		Object.entries(sent.headers).flatMap(([name, value]) =>
			REPLAYED_APART.has(name) || value === undefined ? [] : [[name, value]],
		),
	);
	return {
		body: sent.body,
		headers: {
			...kept,
			...(authorizationLines.length === 0 ? {} : { authorization: authorizationLines }),
			...(sentContentType === undefined || sentContentType === null ? {} : { 'content-type': sentContentType }),
		},
		method: sent.method,
		url: new URL(sent.target.replace(/^\//u, ''), caller.url),
	};
};

/**
 * Sends one operation with departures `fetch` cannot make: several `authorization` lines, which
 * `fetch` would join into one, or a body with no `content-type` at all, where `fetch` would add its
 * own. The operation is first sent to a recording server, so its path, its other headers and its body
 * stay this module's, then replayed to the Controller at the socket with the departures, and its
 * answer read as every other operation's is.
 *
 * @param caller the Controller and the caller's token.
 * @param operation the operation, as a call through this module given a caller.
 * @param departures the `authorization` lines and the `content-type` sent in place of the operation's.
 */
export const sendRaw = async (
	caller: AdminCaller,
	operation: (recorded: AdminCaller) => Promise<AdminResponse>,
	departures: RawDepartures = {},
): Promise<AdminResponse> => {
	const { body, headers, method, url } = await recordedOperation(caller, operation, departures);
	return replayed(url, {
		body,
		headers: {
			...headers,
			'content-length': String(Buffer.byteLength(body)),
		},
		method,
	});
};

/** A large body, and how slowly it is sent. */
export interface SlowBody extends RawDepartures {
	/** The body sent in place of the operation's own, as bytes. */
	body: Uint8Array;

	/** How many bytes each write sends: 64 KiB by default. */
	chunkBytes?: number;

	/** How long to wait after each write before the next, in milliseconds: 20 by default. */
	intervalMs?: number;
}

/** What a slowly sent operation was answered, and how much of its body had gone when the answer came. */
export interface SlowlySent extends AdminResponse {
	/** Whether the answer's status line arrived before the last of the body had been written. */
	answeredBeforeBodyEnded: boolean;

	/** How many of the body's bytes had been written when the answer's status line arrived. */
	bytesSentBeforeAnswer: number;

	/** The body's length in bytes, as its `content-length` announced it. */
	bodyBytes: number;
}

/**
 * Sends one operation with a large body slowly: its headers at once, `content-length` announcing the
 * whole body, then the body a chunk at a time, waiting after each, and records whether the answer
 * arrived before the body ended. Once the answer arrives, nothing more of the body is written, and the
 * connection ends once the answer has been read. For a test that a body is refused without being read
 * (ruled: the EGO import's endpoint checks the administrator before it reads the body). The
 * operation's path and headers are its own, recorded as {@link sendRaw} records them, with the
 * departures given.
 *
 * @param caller the Controller and the caller's token.
 * @param operation the operation, as a call through this module given a caller.
 * @param slow the body, its chunks and their spacing, and the `authorization` lines and the
 *   `content-type` sent in place of the operation's.
 */
export const sendSlowly = async (
	caller: AdminCaller,
	operation: (recorded: AdminCaller) => Promise<AdminResponse>,
	{ body, chunkBytes = 65_536, intervalMs = 20, ...departures }: SlowBody,
): Promise<SlowlySent> => {
	const { headers, method, url } = await recordedOperation(caller, operation, departures);
	return new Promise((resolve, reject) => {
		const state: { bytesAtAnswer: number | undefined; written: number } = {
			bytesAtAnswer: undefined,
			written: 0,
		};
		const outgoing = httpRequest(url, {
			headers: {
				...Object.fromEntries(
					Object.entries(headers).map(([name, value]) => [
						name,
						typeof value === 'string' ? value : [...value],
					]),
				),
				'content-length': String(body.byteLength),
			},
			method,
		});
		outgoing.on('response', (incoming) => {
			state.bytesAtAnswer = state.written;
			const chunks: Buffer[] = [];
			incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
			incoming.on('error', reject);
			incoming.on('end', () => {
				const received = new Headers();
				incoming.rawHeaders.forEach((value, index, raw) => {
					if (index % 2 === 1) {
						received.append(raw[index - 1] ?? '', value);
					}
				});
				outgoing.destroy();
				resolve({
					...answerOf(incoming.statusCode ?? 0, received, Buffer.concat(chunks).toString('utf8')),
					answeredBeforeBodyEnded: (state.bytesAtAnswer ?? body.byteLength) < body.byteLength,
					bodyBytes: body.byteLength,
					bytesSentBeforeAnswer: state.bytesAtAnswer ?? body.byteLength,
				});
			});
		});
		outgoing.on('error', (error) => {
			if (state.bytesAtAnswer === undefined) {
				reject(error);
			}
		});
		const writeFrom = async (offset: number): Promise<void> => {
			if (state.bytesAtAnswer !== undefined || outgoing.destroyed) {
				return;
			}
			if (offset >= body.byteLength) {
				outgoing.end();
				return;
			}
			const chunk = body.subarray(offset, offset + chunkBytes);
			outgoing.write(chunk);
			state.written = offset + chunk.byteLength;
			await delay(intervalMs);
			await writeFrom(offset + chunk.byteLength);
		};
		outgoing.flushHeaders();
		void writeFrom(0);
	});
};

/**
 * What an answer would show only by leaking the Controller's internals, anchored to the wording of
 * the software that writes it so plain English never matches, "the description violates the length
 * rule" included: PostgreSQL's errors (a constraint broken, a key's detail, a relation, a default
 * constraint or index name, `SQLSTATE`, a catalogue), SQL itself, a JSON parser's own texts, a stack
 * frame, a source path, and a socket's error codes.
 */
export const INTERNAL_DETAIL: readonly RegExp[] = Object.freeze([
	/duplicate key value violates unique constraint "/u,
	/violates (?:unique|foreign key|check|not-null|exclusion) constraint/u,
	/null value in column "/u,
	/\bKey \([^)]*\)=\(/u,
	/\b(?:DETAIL|HINT):/u,
	/\brelation "/u,
	/\bcolumn "[^"]*" (?:does not exist|of relation)/u,
	/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:check|excl|fkey|idx|key|pkey|unique)\b/u,
	/\bSQLSTATE\b/u,
	/\bpg_[a-z_]+/u,
	/\bSELECT\b[^]*\bFROM\b/u,
	/\bINSERT INTO\b/u,
	/\bUPDATE\s+\S+\s+SET\b/u,
	/\bDELETE FROM\b/u,
	/Unexpected end of JSON input/u,
	/\bJSON at position \d+/u,
	/Unexpected token \S+(?:,| in JSON)/u,
	/is not valid JSON/u,
	/\bSyntaxError\b/u,
	/\n\s+at\s/u,
	/node:internal/u,
	/node_modules/u,
	/\.[cm]?[jt]s:\d+/u,
	/\bE(?:CONNREFUSED|CONNRESET|PIPE|TIMEDOUT)\b/u,
]);

/**
 * What a text shows of the Controller's internals: each {@link INTERNAL_DETAIL} pattern it matches,
 * and each internal identifier it holds, in any letter case.
 *
 * @param text an answer's body, or any text a caller receives.
 * @param internalIds identifiers that never leave Usher, such as policy.ts's `internalIdsInStore`.
 */
export const internalDetailIn = (text: string, internalIds: readonly string[] = []): readonly string[] => [
	...INTERNAL_DETAIL.filter((pattern) => pattern.test(text)).map(String),
	...internalIds.filter((id) => text.toLowerCase().includes(id.toLowerCase())),
];

/**
 * Every member name and every scalar a parsed JSON value holds, at every depth, strings as they are
 * and numbers and booleans as text, so a search for a subject, an address or an id reads the value as
 * decoded rather than as an encoder escaped it.
 *
 * @param value a parsed value.
 */
export const stringsIn = (value: unknown): readonly string[] => {
	if (typeof value === 'string') {
		return [value];
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return [String(value)];
	}
	if (Array.isArray(value)) {
		return value.flatMap(stringsIn);
	}
	if (isRecord(value)) {
		return Object.entries(value).flatMap(([name, held]) => [name, ...stringsIn(held)]);
	}
	return [];
};

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

/**
 * An instant named in an answer, as milliseconds since the Unix epoch, failing the test unless it
 * is an RFC 3339 instant in UTC, ending in `Z`: `null`, an absent member, a date alone, a time with
 * no offset, any other offset and a lowercase `z` all fail.
 *
 * @param value a member read from an answer.
 * @param label what the member is, for the failure's message.
 */
export const instantOf = (value: unknown, label = 'the member'): number => {
	const milliseconds = typeof value === 'string' && UTC_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
	return Number.isFinite(milliseconds) ? milliseconds : assert.fail(`${label} is no UTC instant ending in Z`);
};

/** Who a caller is beyond the default, and where it calls. */
export interface CallerOptions {
	/** Claims and options over the management token's. */
	mint?: MintOptions;

	/** The instance called: the harness's Controller by default. */
	url?: URL;
}

/**
 * An administrator calling the API, with a fresh management token, the person seeded as an
 * administrator in the harness's store first, since a token makes no administrator.
 *
 * @param harness the harness.
 * @param options who calls, the cast's administrator by default; claims over the token's; and the
 *   instance called.
 */
export const administratorCaller = async (
	harness: Pick<Harness, 'tokens' | 'url'>,
	{ mint = {}, person = PEOPLE.administrator, url }: CallerOptions & { person?: Person } = {},
): Promise<AdminCaller> => ({
	token: await harness.tokens.administrator(person, mint),
	url: url ?? harness.url,
});

/**
 * The first user calling the API, with a fresh management token carrying the configured first-user
 * role.
 *
 * @param harness the harness.
 * @param person who calls.
 * @param options claims over the token's, and the instance called.
 */
export const firstUserCaller = async (
	harness: Pick<Harness, 'tokens' | 'url'>,
	person: Person,
	{ mint = {}, url }: CallerOptions = {},
): Promise<AdminCaller> => ({
	token: await harness.tokens.firstUser(person, mint),
	url: url ?? harness.url,
});

/**
 * A person calling the API, with a fresh management token carrying no role beyond Keycloak's
 * defaults, so an administrator only where the store holds them as one.
 *
 * @param harness the harness.
 * @param person who calls.
 * @param options claims over the token's, and the instance called.
 */
export const personCaller = async (
	harness: Pick<Harness, 'tokens' | 'url'>,
	person: Person,
	{ mint = {}, url }: CallerOptions = {},
): Promise<AdminCaller> => ({
	token: await harness.tokens.management(person, mint),
	url: url ?? harness.url,
});
