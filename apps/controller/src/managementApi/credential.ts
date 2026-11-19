/**
 * The credential a request carries: none, one bearer token, or a form that cannot be read as exactly
 * one, which is refused as unreadable rather than as a refused credential.
 */
export type Credential = { kind: 'absent' } | { kind: 'bearer'; token: string } | { kind: 'malformed' };

// RFC 6750's credential: a scheme, Bearer in any letter case, then one token68.
const SCHEME_AND_TOKEN = /^(?<scheme>[A-Za-z]+) +(?<token>[A-Za-z0-9._~+/-]+=*)$/u;

// The query parameter RFC 6750 names for a credential sent in the URI, which is refused here since a
// URI reaches logs and histories a header does not.
const QUERY_CREDENTIAL = 'access_token';

/**
 * Reads a request's credential from its raw header lines, counted as sent, since the parsed headers
 * keep one `Authorization` of several, and from its query: exactly one `Authorization` header holding
 * one Bearer credential is read, and two such headers, another scheme, a scheme with no credential, or
 * a credential in the query are malformed.
 *
 * @param rawHeaders the request's header names and values, alternating, as Node gives them.
 * @param queryNames the names of the request's query parameters.
 */
export const readCredential = (rawHeaders: readonly string[], queryNames: readonly string[]): Credential => {
	const values = rawHeaders.flatMap((name, index) =>
		index % 2 === 0 && name.toLowerCase() === 'authorization' ? [rawHeaders[index + 1] ?? ''] : [],
	);
	if (queryNames.includes(QUERY_CREDENTIAL) || values.length > 1) {
		return { kind: 'malformed' };
	}
	const [value] = values;
	if (value === undefined) {
		return { kind: 'absent' };
	}
	const { scheme, token } = SCHEME_AND_TOKEN.exec(value.trim())?.groups ?? {};
	return scheme?.toLowerCase() === 'bearer' && token !== undefined
		? { kind: 'bearer', token }
		: { kind: 'malformed' };
};

/**
 * A request's query parameters, each name and value decoded, in the order sent, a parameter sent
 * twice listed twice.
 *
 * @param url the request's target, its path and query.
 */
export const queryParametersOf = (url: string): readonly (readonly [name: string, value: string])[] => {
	const query = url.indexOf('?');
	return query === -1 ? [] : [...new URLSearchParams(url.slice(query + 1))];
};

/**
 * The names of a request's query parameters, each as many times as it is sent.
 *
 * @param url the request's target, its path and query.
 */
export const queryNamesOf = (url: string): readonly string[] => queryParametersOf(url).map(([name]) => name);
