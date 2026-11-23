import {
	attachAccess,
	CHALLENGE_ERRORS,
	SUSPENDED_HEADER,
	SUSPENDED_VALUE,
	type UsherRequestAccess,
} from '@overture-stack/usher-types';
import type { NextFunction, Request, Response } from 'express-serve-static-core';

import type { LayerEventName, ResolveOutcome } from '../core/core.js';
import type { BridgeEventData } from '../core/events.js';
import './locals.js';

/** The part of the core used by {@link createUsherMiddleware}. */
export interface LayerCore {
	/** Logs one of the layer's own events. */
	report<Name extends LayerEventName>(name: Name, data: BridgeEventData[Name]): void;

	/** Resolves a request's credential, or `null` for none, to its outcome. */
	resolve(credential: string | null): Promise<ResolveOutcome>;
}

/** What a request carries: no credential, one credential, or none that can be read. */
export type CredentialRead =
	| { credential: string; kind: 'credential' }
	| { kind: 'anonymous' }
	| {
			kind: 'malformed';
			reason: BridgeEventData['credential.malformed']['reason'];
	  };

/** What a host may change about the layer. */
export interface UsherMiddlewareOptions {
	/**
	 * Reads the request's credential in place of the `Authorization` header, as from a cookie; when
	 * omitted, {@link readBearerCredential} reads it.
	 */
	extract?: (request: Request) => CredentialRead;

	/**
	 * The request header that carries the credential, named in `Vary`; `Authorization` when
	 * omitted.
	 */
	varyOn?: string;
}

/** The fixed text of each answer given by the layer itself, never naming the identity. */
export const ANSWERS: Readonly<{
	invalidRequest: string;
	refused: string;
	unavailable: string;
}> = Object.freeze({
	invalidRequest:
		'This request was not served: send one credential, as a Bearer token in the Authorization header, and never in the address.',
	refused: 'Sign in again for a new token, or leave the token out to get the data available to everyone.',
	unavailable: 'This request was not served because access could not be confirmed just now. Try again shortly.',
});

/** How long a client is asked to wait before retrying a 503. */
export const RETRY_AFTER_SECONDS = 5;

// Re-exported so the Bridge's consumers need not import usher-types, where it lives because a
// portal's browser code reads it without Express.
export { SUSPENDED_HEADER };

const BEARER = /^([^ ]+) +(.+)$/su;

/**
 * Reads the credential from the `Authorization` header, passing on a bearer value whatever its
 * characters. A request reads as malformed for any of these, and otherwise as anonymous when it has
 * no `Authorization` header:
 * - an `access_token` query parameter, since a credential in a URL reaches request logs;
 * - two `Authorization` lines;
 * - a scheme other than Bearer, or a Bearer scheme with no value.
 */
export const readBearerCredential = (request: Request): CredentialRead => {
	// Read from the target itself, since the URL parser rejects a target such as `//[`.
	const query = new URLSearchParams(request.originalUrl.split('?').slice(1).join('?'));
	// headersDistinct keeps a second line, which `headers` would drop.
	const lines = request.headersDistinct['authorization'] ?? [];
	const [line] = lines;
	const parts = BEARER.exec(line ?? '');
	const [, scheme, value] = parts ?? [];

	if (query.has('access_token')) {
		return { kind: 'malformed', reason: 'query' };
	}
	if (line === undefined) {
		return { kind: 'anonymous' };
	}
	if (lines.length > 1) {
		return { kind: 'malformed', reason: 'multiple' };
	}
	// The Controller decides which characters a credential may hold.
	return scheme?.toLowerCase() === 'bearer' && value !== undefined
		? { credential: value, kind: 'credential' }
		: { kind: 'malformed', reason: 'scheme' };
};

const answer = (response: Response, status: number, text: string, headers: Readonly<Record<string, string>>): void => {
	if (response.headersSent) {
		return;
	}
	response.status(status).set(headers);
	if ('WWW-Authenticate' in headers) {
		response.append('Access-Control-Expose-Headers', 'WWW-Authenticate');
	}
	response.type('text/plain').send(text);
};

/**
 * Creates the Express middleware, which answers these requests itself with the fixed text of
 * {@link ANSWERS}:
 * - 400 for a credential read as malformed, logged as `credential.malformed`;
 * - 401 for a refused credential;
 * - 503 when access cannot be confirmed, and for every failure, synchronous or not, logged as
 *   `bridge.internalError` naming only the stage.
 *
 * Every other request passes on with its access attached at `res.locals.usher`, frozen and
 * read-only, with `Cache-Control: private, no-store` and `Vary` naming the credential source, and
 * with `Usher-Suspended: true`, exposed to a browser, when the principal is suspended. It never hands
 * Express a promise and never calls `next` with an error. It reads no request body, and sets no CORS
 * header beyond adding `WWW-Authenticate` or `Usher-Suspended` to `Access-Control-Expose-Headers`.
 *
 * @param core the Bridge core, or anything resolving and reporting as it does.
 * @param options the host's credential source, when it is not the `Authorization` header. When
 *   omitted, {@link readBearerCredential} reads the credential and `Vary` names `Authorization`.
 */
export const createUsherMiddleware = (
	core: LayerCore,
	options: UsherMiddlewareOptions = {},
): ((request: Request, response: Response, next: NextFunction) => void) => {
	const extract = options.extract ?? readBearerCredential;
	const varyOn = options.varyOn ?? 'Authorization';

	const report = <Name extends LayerEventName>(name: Name, data: BridgeEventData[Name]): void => {
		try {
			core.report(name, data);
		} catch {
			// A core whose report throws must not stop the request being answered.
		}
	};

	const unavailable = (response: Response): void =>
		answer(response, 503, ANSWERS.unavailable, {
			'Cache-Control': 'no-store',
			'Retry-After': String(RETRY_AFTER_SECONDS),
		});

	/**
	 * Logs the stage, then answers 503 with nothing named but the stage. A throw from that 503 is
	 * swallowed: the failure is already logged once, and it must never reach Express's error handler or
	 * leave a rejection unhandled.
	 */
	const fail = (response: Response, stage: BridgeEventData['bridge.internalError']['stage']): void => {
		report('bridge.internalError', { stage });
		try {
			unavailable(response);
		} catch {
			// Nothing more can be answered on a response that throws as it answers.
		}
	};

	/** Runs an answer, failing the request with a 503 and logging `answer` when the answer throws. */
	const answering = (response: Response, write: () => void): void => {
		try {
			write();
		} catch {
			fail(response, 'answer');
		}
	};

	const attached = (response: Response, access: Readonly<UsherRequestAccess>): boolean => {
		try {
			attachAccess(response.locals, access);
			response.set('Cache-Control', 'private, no-store');
			response.vary(varyOn);
			if (access.principal.suspended) {
				response.set(SUSPENDED_HEADER, SUSPENDED_VALUE);
				// Appended, so a value already exposed by the host's CORS layer is kept beside it.
				response.append('Access-Control-Expose-Headers', SUSPENDED_HEADER);
			}
			return true;
		} catch {
			return false;
		}
	};

	const settle = (outcome: ResolveOutcome, response: Response, next: NextFunction): void => {
		switch (outcome.kind) {
			case 'access':
				if (attached(response, outcome.access)) {
					next();
				} else {
					fail(response, 'attach');
				}
				return;
			case 'refused':
				answer(response, 401, ANSWERS.refused, {
					'Cache-Control': 'no-store',
					'WWW-Authenticate': `Bearer error="${CHALLENGE_ERRORS.invalidToken}"`,
				});
				return;
			case 'unavailable':
				unavailable(response);
				return;
		}
	};

	/** Reads the credential, or answers 503 and returns `undefined` when the host's extract throws. */
	const readOrFail = (request: Request, response: Response): CredentialRead | undefined => {
		try {
			return extract(request);
		} catch {
			fail(response, 'extract');
			return undefined;
		}
	};

	return (request, response, next) => {
		const read = readOrFail(request, response);
		if (read === undefined) {
			return;
		}
		if (read.kind === 'malformed') {
			report('credential.malformed', { reason: read.reason });
			answering(response, () =>
				answer(response, 400, ANSWERS.invalidRequest, {
					'Cache-Control': 'no-store',
					'WWW-Authenticate': `Bearer error="${CHALLENGE_ERRORS.invalidRequest}"`,
				}),
			);
			return;
		}
		// Resolving through a promise turns a synchronous throw from the core into a rejection, handled
		// as a failed resolve.
		Promise.resolve()
			.then(() => core.resolve(read.kind === 'credential' ? read.credential : null))
			.then(
				(outcome) => settle(outcome, response, next),
				() => fail(response, 'resolve'),
			)
			.catch(() => fail(response, 'answer'));
	};
};
