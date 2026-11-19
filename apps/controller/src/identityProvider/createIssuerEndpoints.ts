import { discoveryDocument, failed, issuerEndpoint, obtained, type Step } from './discovery.js';
import type {
	IssuerEndpoints,
	IssuerEndpointsFailure,
	IssuerEndpointsLog,
	IssuerEndpointsReading,
	IssuerEndpointsSettings,
	SignInEndpoints,
} from './types.js';

/** The least time after a failed read of the sign-in endpoints before they are read again, in milliseconds of the configured clock. */
export const ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS = 30_000;

/** The line naming a read of the trusted issuer's sign-in endpoints that failed, and its cause. */
export const ISSUER_ENDPOINTS_UNAVAILABLE = 'identityProvider.endpointsUnavailable';

const readEndpoints = async (issuer: string): Promise<Step<SignInEndpoints, IssuerEndpointsFailure>> => {
	const discovery = await discoveryDocument(issuer);
	if (discovery.kind === 'failed') {
		return discovery;
	}
	const authorization = issuerEndpoint(discovery.value, 'authorization_endpoint', issuer);
	if (authorization.kind === 'failed') {
		return authorization;
	}
	const token = issuerEndpoint(discovery.value, 'token_endpoint', issuer);
	if (token.kind === 'failed') {
		return token;
	}
	return obtained({
		authorizationEndpoint: authorization.value.href,
		tokenEndpoint: token.value.href,
	});
};

interface EndpointsCache {
	endpoints: SignInEndpoints | undefined;
	failedAt: number | undefined;
	inFlight: Promise<IssuerEndpointsReading> | undefined;
}

/**
 * Creates the trusted issuer's sign-in endpoints, reading nothing until they are first asked for. They
 * are read from the issuer's discovery document, which must name the issuer exactly, and an
 * authorization and a token endpoint each reachable over https, or over http to a loopback host, at
 * exactly the issuer's origin. Endpoints once read are held from then on and never read again, and
 * concurrent askers share one read. After a failed read none starts until
 * {@link ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS} have passed on the configured clock, and an ask before
 * then is answered unavailable at once, with the milliseconds left. Each failed read writes
 * {@link ISSUER_ENDPOINTS_UNAVAILABLE} at error naming its fixed cause alone, never a URL or anything
 * the provider answered, so the cooldown bounds the lines as it bounds the reads.
 *
 * @param settings the clock, and the trusted issuer.
 * @param eventLog where a failed read is written.
 */
export const createIssuerEndpoints = (
	{ clock, identityProviderIssuer }: IssuerEndpointsSettings,
	eventLog: IssuerEndpointsLog,
): IssuerEndpoints => {
	const cache: EndpointsCache = {
		endpoints: undefined,
		failedAt: undefined,
		inFlight: undefined,
	};
	const retryInMilliseconds = (): number =>
		cache.failedAt === undefined
			? 0
			: Math.max(0, cache.failedAt + ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS - clock.now());
	const unavailable = (): IssuerEndpointsReading => ({
		kind: 'unavailable',
		retryInMilliseconds: retryInMilliseconds(),
	});
	const readOnce = async (): Promise<IssuerEndpointsReading> => {
		// The read leaves flight however it ends, so no later asker joins one that rejected.
		try {
			// A read that throws is taken as one that had no answer: a connection refused or cut, or no
			// answer within the timeout.
			const outcome = await readEndpoints(identityProviderIssuer).catch((): Step<never, 'unreachable'> =>
				failed('unreachable'),
			);
			if (outcome.kind === 'obtained') {
				cache.endpoints = outcome.value;
				return { endpoints: outcome.value, kind: 'read' };
			}
			cache.failedAt = clock.now();
			eventLog.error(ISSUER_ENDPOINTS_UNAVAILABLE, { cause: outcome.cause });
			return unavailable();
		} finally {
			cache.inFlight = undefined;
		}
	};
	return {
		current: async () => {
			if (cache.endpoints !== undefined) {
				return { endpoints: cache.endpoints, kind: 'read' };
			}
			if (retryInMilliseconds() === 0) {
				cache.inFlight ??= readOnce();
				return cache.inFlight;
			}
			return unavailable();
		},
	};
};
