import { SIGN_OUT_PROBLEMS } from './signOutProblems.js';
import type { LogoutRequest, LogoutRequestReading } from './types.js';

const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

const LOGOUT_TOKEN = 'logout_token';

const REFUSED_BODY: LogoutRequestReading = Object.freeze({
	kind: 'refused',
	problem: SIGN_OUT_PROBLEMS.unreadableBody,
});

const mediaTypeOf = (contentType: string | undefined): string =>
	(contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

const decodedText = (body: Uint8Array): string | undefined => {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(body);
	} catch {
		return undefined;
	}
};

/**
 * Reads the logout token a back-channel logout request carries, as OpenID Connect Back-Channel Logout
 * sends it: the one `logout_token` parameter of an `application/x-www-form-urlencoded` body in UTF-8,
 * its media type matched in any letter case, and any other parameter left unread. A request carrying
 * any query is refused as `unreadableQuery` before its body is read, so a token is never taken from a
 * URL, where proxies and access logs keep it. A body of another media type or of none, one that is not
 * UTF-8, and one holding no `logout_token`, an empty one or more than one, are refused as
 * `unreadableBody`.
 *
 * @param request the request's URL as sent, its content type and its body's bytes.
 */
export const readLogoutRequest = ({ body, contentType, url }: LogoutRequest): LogoutRequestReading => {
	if (url.includes('?')) {
		return { kind: 'refused', problem: SIGN_OUT_PROBLEMS.unreadableQuery };
	}
	if (body === undefined || mediaTypeOf(contentType) !== FORM_MEDIA_TYPE) {
		return REFUSED_BODY;
	}
	const text = decodedText(body);
	const tokens = text === undefined ? [] : new URLSearchParams(text).getAll(LOGOUT_TOKEN);
	const [token] = tokens;
	return tokens.length === 1 && token !== undefined && token !== '' ? { kind: 'read', token } : REFUSED_BODY;
};
