import { discoveryUrl } from './discoveryUrl.js';
import type { KeySetFetchFailure } from './types.js';

// A fetch the provider never answers ends here, in real time, so one silent provider holds no request
// open for long.
const FETCH_TIMEOUT_MILLISECONDS = 5000;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * What one step of a fetch gave: its value, or the fixed cause it failed for, one of the key set's
 * causes unless another set of causes is named.
 */
export type Step<Value, Cause extends string = KeySetFetchFailure> =
	{ cause: Cause; kind: 'failed' } | { kind: 'obtained'; value: Value };

/**
 * A step that failed, for the fixed cause given.
 *
 * @param cause why it failed.
 */
export const failed = <Cause extends string>(cause: Cause): Step<never, Cause> => ({
	cause,
	kind: 'failed',
});

/**
 * A step that gave a value, and so fails for no cause.
 *
 * @param value what it gave.
 */
export const obtained = <Value>(value: Value): Step<Value, never> => ({
	kind: 'obtained',
	value,
});

/**
 * Whether a value is a JSON object, neither null nor an array.
 *
 * @param value the value.
 */
export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

// A URL reached over https, or over http to a loopback host alone, so it crosses no network in the
// clear.
const isSecure = (url: URL): boolean =>
	url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));

const parsedJson = <Cause extends string>(text: string, unreadable: Cause): Step<unknown, Cause> => {
	try {
		return obtained(JSON.parse(text));
	} catch {
		return failed(unreadable);
	}
};

/**
 * Fetches the JSON a URL answers, waiting a fixed time at most and following no redirect. An answer
 * other than 200, a redirect among them, fails as `status`, and a body that is not JSON fails for the
 * cause given. It rejects when no answer comes.
 *
 * @param url where to fetch from.
 * @param unreadable the cause a body that is not JSON fails for.
 */
export const fetchedJson = async <Cause extends string>(
	url: URL,
	unreadable: Cause,
): Promise<Step<unknown, Cause | 'status'>> => {
	const response = await fetch(url, {
		headers: { accept: 'application/json' },
		redirect: 'manual',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
	});
	if (response.status === 200) {
		return parsedJson(await response.text(), unreadable);
	}
	await response.body?.cancel();
	return failed('status');
};

/** An issuer's discovery document: a JSON object, its members as the provider named them. */
export type DiscoveryDocument = Readonly<Record<string, unknown>>;

/**
 * Fetches an issuer's OpenID Connect Discovery document, waiting a fixed time at most and following no
 * redirect, and gives it only when it is a JSON object whose `issuer` is the issuer given, exactly. Any
 * other document fails as `discoveryIssuer`, and an answer other than 200, a redirect among them, as
 * `status`. It rejects when no answer comes.
 *
 * @param issuer the trusted issuer, as its tokens carry it.
 */
export const discoveryDocument = async (
	issuer: string,
): Promise<Step<DiscoveryDocument, 'discoveryIssuer' | 'status'>> => {
	const discovery = await fetchedJson(discoveryUrl(issuer), 'discoveryIssuer');
	if (discovery.kind === 'failed') {
		return discovery;
	}
	return isRecord(discovery.value) && discovery.value['issuer'] === issuer
		? obtained(discovery.value)
		: failed('discoveryIssuer');
};

/**
 * Where a discovery document's `jwks_uri` locates the key set: a URL reached over https, or over http
 * to a loopback host, at any origin. Anything else fails as `keySetLocation`.
 *
 * @param discovery the issuer's discovery document.
 */
export const keySetUrl = (discovery: DiscoveryDocument): Step<URL> => {
	const named = discovery['jwks_uri'];
	const url = typeof named === 'string' ? URL.parse(named) : null;
	return url !== null && isSecure(url) ? obtained(url) : failed('keySetLocation');
};

/**
 * The endpoint a discovery document names under the member given: a URL reached over https, or over
 * http to a loopback host, carrying no user name or password, at exactly the issuer's origin. One
 * missing, not a string, not a URL, reached otherwise or carrying a user name or password fails as
 * `endpointLocation`, and one at any other origin as `endpointOrigin`.
 *
 * @param discovery the issuer's discovery document.
 * @param member the member naming the endpoint, such as `token_endpoint`.
 * @param issuer the trusted issuer, whose origin the endpoint must have.
 */
export const issuerEndpoint = (
	discovery: DiscoveryDocument,
	member: string,
	issuer: string,
): Step<URL, 'endpointLocation' | 'endpointOrigin'> => {
	const named = discovery[member];
	const url = typeof named === 'string' ? URL.parse(named) : null;
	if (url !== null && isSecure(url) && url.username === '' && url.password === '') {
		return url.origin === new URL(issuer).origin ? obtained(url) : failed('endpointOrigin');
	}
	return failed('endpointLocation');
};
