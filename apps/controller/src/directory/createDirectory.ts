import type {
	AccountReading,
	AddressResolution,
	Directory,
	DirectoryAccount,
	DirectoryBounds,
	DirectoryFailure,
	DirectoryLog,
	DirectorySettings,
} from './types.js';

/** The line naming a lookup the directory could not answer, and its fixed cause. */
export const DIRECTORY_UNAVAILABLE = 'directory.unavailable';

/**
 * How far one lookup goes: 5 s of real time from its start to its answer, its token included, and
 * 256 KiB of any one answer's body, room for every account Keycloak lists for one address by
 * default.
 */
export const DIRECTORY_BOUNDS: DirectoryBounds = Object.freeze({
	answerLimitBytes: 262_144,
	deadlineMilliseconds: 5000,
});

// How long before its expiry a token is taken again, in milliseconds of the configured clock; half
// its life for a token living less than twice this.
const TOKEN_RENEWAL_MARGIN_MILLISECONDS = 30_000;

// Paths a subject names no single account by: none, which lists every account, and the two a URL
// resolves to another path.
const NO_SINGLE_ACCOUNT: ReadonlySet<string> = new Set(['', '.', '..']);

const NOT_CONFIGURED: Directory = Object.freeze({
	accountOf: async (): Promise<AccountReading> => ({ kind: 'unconfigured' }),
	resolveAddress: async (): Promise<AddressResolution> => ({
		kind: 'unconfigured',
	}),
});

interface Fault {
	cause: DirectoryFailure;

	/** The status answered, for a fault whose cause is `status`. */
	status?: number;
}

// What one step of a lookup gave: its value, or the fault that ended the lookup.
type Outcome<Value> = { fault: Fault; kind: 'faulted' } | { kind: 'answered'; value: Value };

const answeredWith = <Value>(value: Value): Outcome<Value> => ({
	kind: 'answered',
	value,
});

const faulted = (cause: DirectoryFailure, status?: number): Outcome<never> => ({
	fault: { cause, ...(status === undefined ? {} : { status }) },
	kind: 'faulted',
});

/** A request's answer: its status, and its body read as JSON for a `200`, none for any other. */
interface Answer {
	body: unknown;
	status: number;
}

interface HeldToken {
	/** The configured clock's instant from which it is taken again. */
	renewAt: number;

	token: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const decoded = (chunks: readonly Uint8Array[]): Outcome<unknown> => {
	try {
		return answeredWith(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
	} catch {
		return faulted('malformedAnswer');
	}
};

// Reads a body as JSON, stopping, and cancelling the rest, once it passes the limit.
const boundedJson = async (response: Response, limit: number): Promise<Outcome<unknown>> => {
	if (Number(response.headers.get('content-length')) > limit) {
		await response.body?.cancel();
		return faulted('answerTooLarge');
	}
	const reader = response.body?.getReader();
	if (reader === undefined) {
		return faulted('malformedAnswer');
	}
	const readOn = async (chunks: readonly Uint8Array[], size: number): Promise<Outcome<unknown>> => {
		const { done, value } = await reader.read();
		if (done) {
			return decoded(chunks);
		}
		const total = size + value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return faulted('answerTooLarge');
		}
		return readOn([...chunks, value], total);
	};
	return readOn([], 0);
};

// A text member an answer may leave out: the text, `null` for none, or `undefined` for a member
// holding anything else.
const optionalText = (record: Readonly<Record<string, unknown>>, member: string): string | null | undefined => {
	const value = record[member];
	if (value === undefined || value === null) {
		return null;
	}
	return typeof value === 'string' ? value : undefined;
};

interface Holder {
	email: string | null;
	emailVerified: boolean;
	id: string;
}

// The accounts one search lists, or undefined for an answer that is not a list of accounts each
// holding an id.
const holdersIn = (body: unknown): readonly Holder[] | undefined => {
	if (!Array.isArray(body)) {
		return undefined;
	}
	const holders = body.flatMap((item: unknown): readonly Holder[] => {
		if (!isRecord(item)) {
			return [];
		}
		const { emailVerified = false, id } = item;
		const email = optionalText(item, 'email');
		return typeof id === 'string' && id !== '' && email !== undefined && typeof emailVerified === 'boolean'
			? [{ email, emailVerified, id }]
			: [];
	});
	return holders.length === body.length ? holders : undefined;
};

// The account an answer by id gives, or undefined for one naming another id or holding a member it
// cannot read.
const accountIn = (body: unknown, subject: string): DirectoryAccount | undefined => {
	if (!isRecord(body) || body['id'] !== subject) {
		return undefined;
	}
	const email = optionalText(body, 'email');
	const familyName = optionalText(body, 'lastName');
	const givenName = optionalText(body, 'firstName');
	return email === undefined || familyName === undefined || givenName === undefined
		? undefined
		: { email, familyName, givenName };
};

/**
 * Creates the directory: the identity provider's accounts, read through Keycloak's admin API at
 * `<directoryUrl>/admin/realms/<directoryRealm>`, asking nothing until a lookup does. Its token
 * comes from the client credentials grant at the realm's token endpoint, the client authenticated
 * by HTTP Basic, and is taken for every lookup until 30 s before it expires on the configured
 * clock, or half its life before for a token living less than a minute; concurrent lookups share
 * one fetch of it. A token the admin API refuses with `401` is replaced by a fresh one once, and a
 * fresh one refused too fails the lookup.
 *
 * An address resolves only when exactly one account holds it as its address, compared in any letter
 * case, and has verified it; a disabled account counts. Anything else the search lists, none,
 * several, an unverified one or a near match, is no single account. The search sends the address as
 * given, `exact=true`, and reads no character of it as a wildcard. A subject's account is read by
 * its id, a `404` reading as no account; a subject naming no single path segment is answered so
 * without asking.
 *
 * Each lookup is bounded by `bounds`, in real time and in the bytes of each answer read, and
 * follows no redirect. Any failure to get a usable answer, a refused connection, the deadline, a
 * status it does not take, a credential refused or an answer it cannot read, answers `unavailable`
 * and writes {@link DIRECTORY_UNAVAILABLE} at error naming its fixed cause, the lookup's kind and
 * any status, never a URL, a host, a port, the realm, the secret, a token or the address. An empty
 * `directoryUrl` is no directory, answering `unconfigured` and asking nothing.
 *
 * @param settings the clock, and the directory's URL, realm, client and secret.
 * @param eventLog where a lookup that could not be answered is written.
 * @param bounds the deadline and the answer limit: {@link DIRECTORY_BOUNDS} by default.
 */
export const createDirectory = (
	{ clock, directoryClientId, directoryClientSecret, directoryRealm, directoryUrl }: DirectorySettings,
	eventLog: DirectoryLog,
	bounds: DirectoryBounds = DIRECTORY_BOUNDS,
): Directory => {
	if (directoryUrl === '') {
		return NOT_CONFIGURED;
	}
	const base = directoryUrl.endsWith('/') ? directoryUrl : `${directoryUrl}/`;
	const realm = encodeURIComponent(directoryRealm);
	const tokenUrl = new URL(`realms/${realm}/protocol/openid-connect/token`, base);
	const usersPath = `admin/realms/${realm}/users`;
	const basic = Buffer.from(
		`${encodeURIComponent(directoryClientId)}:${encodeURIComponent(directoryClientSecret)}`,
	).toString('base64');
	const cache: {
		held: HeldToken | undefined;
		inFlight: Promise<Outcome<HeldToken>> | undefined;
	} = { held: undefined, inFlight: undefined };

	// Sends one request, reading the body of a 200 alone; nothing it meets is thrown on.
	const send = async (url: URL, init: RequestInit, signal: AbortSignal): Promise<Outcome<Answer>> => {
		try {
			const response = await fetch(url, {
				...init,
				redirect: 'manual',
				signal,
			});
			if (response.status !== 200) {
				await response.body?.cancel();
				return answeredWith({ body: undefined, status: response.status });
			}
			const body = await boundedJson(response, bounds.answerLimitBytes);
			return body.kind === 'answered' ? answeredWith({ body: body.value, status: 200 }) : body;
		} catch {
			return faulted(signal.aborted ? 'timeout' : 'unreachable');
		}
	};

	const fetchToken = async (signal: AbortSignal): Promise<Outcome<HeldToken>> => {
		const sent = await send(
			tokenUrl,
			{
				body: 'grant_type=client_credentials',
				headers: {
					accept: 'application/json',
					authorization: `Basic ${basic}`,
					'content-type': 'application/x-www-form-urlencoded',
				},
				method: 'POST',
			},
			signal,
		);
		if (sent.kind === 'faulted') {
			return sent;
		}
		const { body, status } = sent.value;
		if (status === 400 || status === 401) {
			return faulted('credentialRefused');
		}
		if (status !== 200) {
			return faulted('status', status);
		}
		const token = isRecord(body) ? body['access_token'] : undefined;
		const lifetime = isRecord(body) ? body['expires_in'] : undefined;
		if (
			typeof token === 'string' &&
			token !== '' &&
			typeof lifetime === 'number' &&
			Number.isFinite(lifetime) &&
			lifetime > 0
		) {
			const lifetimeMilliseconds = lifetime * 1000;
			return answeredWith({
				renewAt:
					clock.now() +
					lifetimeMilliseconds -
					Math.min(TOKEN_RENEWAL_MARGIN_MILLISECONDS, lifetimeMilliseconds / 2),
				token,
			});
		}
		return faulted('malformedAnswer');
	};

	const currentToken = async (signal: AbortSignal): Promise<Outcome<string>> => {
		const { held } = cache;
		if (held !== undefined && clock.now() < held.renewAt) {
			return answeredWith(held.token);
		}
		// The fetch leaves flight however it ends, so no later lookup joins one that has ended.
		cache.inFlight ??= fetchToken(signal)
			.then((fetched) => {
				cache.held = fetched.kind === 'answered' ? fetched.value : undefined;
				return fetched;
			})
			.finally(() => {
				cache.inFlight = undefined;
			});
		const fetched = await cache.inFlight;
		return fetched.kind === 'answered' ? answeredWith(fetched.value.token) : fetched;
	};

	// Reads the admin API under the token held, and once more under a fresh token when it is refused.
	const adminGet = async (url: URL, signal: AbortSignal): Promise<Outcome<Answer>> => {
		const ask = (token: string): Promise<Outcome<Answer>> =>
			send(
				url,
				{
					headers: {
						accept: 'application/json',
						authorization: `Bearer ${token}`,
					},
					method: 'GET',
				},
				signal,
			);
		const held = await currentToken(signal);
		if (held.kind === 'faulted') {
			return held;
		}
		const first = await ask(held.value);
		if (first.kind === 'faulted' || first.value.status !== 401) {
			return first;
		}
		if (cache.held?.token === held.value) {
			cache.held = undefined;
		}
		const fresh = await currentToken(signal);
		if (fresh.kind === 'faulted') {
			return fresh;
		}
		const again = await ask(fresh.value);
		return again.kind === 'answered' && again.value.status === 401 ? faulted('credentialRefused') : again;
	};

	const unavailable = (lookup: 'account' | 'address', { cause, status }: Fault): { kind: 'unavailable' } => {
		eventLog.error(DIRECTORY_UNAVAILABLE, {
			cause,
			lookup,
			...(status === undefined ? {} : { status }),
		});
		return { kind: 'unavailable' };
	};

	const resolveAddress = async (address: string): Promise<AddressResolution> => {
		const url = new URL(usersPath, base);
		url.searchParams.set('email', address);
		url.searchParams.set('exact', 'true');
		const answer = await adminGet(url, AbortSignal.timeout(bounds.deadlineMilliseconds));
		if (answer.kind === 'faulted') {
			return unavailable('address', answer.fault);
		}
		const { body, status } = answer.value;
		if (status !== 200) {
			return unavailable('address', { cause: 'status', status });
		}
		const listed = holdersIn(body);
		if (listed === undefined) {
			return unavailable('address', { cause: 'malformedAnswer' });
		}
		const holders = listed.filter(({ email }) => email?.toLowerCase() === address.toLowerCase());
		const [holder] = holders;
		return holders.length === 1 && holder?.emailVerified === true
			? { kind: 'resolved', subject: holder.id }
			: { kind: 'unheld' };
	};

	const accountOf = async (subject: string): Promise<AccountReading> => {
		if (NO_SINGLE_ACCOUNT.has(subject)) {
			return { kind: 'absent' };
		}
		const answer = await adminGet(
			new URL(`${usersPath}/${encodeURIComponent(subject)}`, base),
			AbortSignal.timeout(bounds.deadlineMilliseconds),
		);
		if (answer.kind === 'faulted') {
			return unavailable('account', answer.fault);
		}
		const { body, status } = answer.value;
		if (status === 404) {
			return { kind: 'absent' };
		}
		if (status !== 200) {
			return unavailable('account', { cause: 'status', status });
		}
		const account = accountIn(body, subject);
		return account === undefined ? unavailable('account', { cause: 'malformedAnswer' }) : { account, kind: 'held' };
	};

	return { accountOf, resolveAddress };
};
