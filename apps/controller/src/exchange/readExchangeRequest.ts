import type { Problem } from '../http/index.js';
import { readStrictJson } from '../strictJson/index.js';
import { EXCHANGE_PROBLEMS, unreadableBody } from './exchangeProblems.js';

/** The one payload version the Controller serves. */
export const SERVED_PAYLOAD_VERSION = 1;

/**
 * What reading an exchange request gave: the credential it carries, absent for the anonymous
 * exchange, or the refusal it earned.
 */
export type ExchangeRequestReading = { credential?: string; kind: 'read' } | { kind: 'refused'; problem: Problem };

const JSON_MEDIA_TYPE = 'application/json';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isPayloadVersion = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 1;

// The versions a request lists: a non-empty list of whole numbers of at least 1, or none readable.
const listedVersionsOf = (value: unknown): readonly number[] | undefined =>
	Array.isArray(value) && value.length > 0 && value.every(isPayloadVersion) ? value : undefined;

// JSON in UTF-8, the one encoding RFC 8259 allows: a charset parameter naming any other is refused.
const isJson = (contentType: string | undefined): boolean => {
	const [mediaType = '', ...parameters] = (contentType ?? '').split(';');
	return (
		mediaType.trim().toLowerCase() === JSON_MEDIA_TYPE &&
		parameters.every((parameter) => {
			const [name = '', value = ''] = parameter.split('=');
			return (
				name.trim().toLowerCase() !== 'charset' || value.trim().replaceAll('"', '').toLowerCase() === 'utf-8'
			);
		})
	);
};

const decoded = (bytes: Uint8Array): string | undefined => {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
};

const refused = (problem: Problem): ExchangeRequestReading => ({
	kind: 'refused',
	problem,
});

// The request's members once its body has read as one JSON object: every check needing nothing but
// the body comes before the version is negotiated, so a body broken twice is refused for its shape.
const membersOf = ({ credential, payloadVersions }: Readonly<Record<string, unknown>>): ExchangeRequestReading => {
	if (payloadVersions === undefined) {
		return refused(unreadableBody('lacks the member payloadVersions'));
	}
	const versions = listedVersionsOf(payloadVersions);
	if (versions === undefined) {
		return refused(
			unreadableBody(
				'holds payloadVersions as something other than a non-empty list of whole numbers of at least 1',
			),
		);
	}
	if (credential !== undefined && typeof credential !== 'string') {
		return refused(unreadableBody('holds credential as something other than a string'));
	}
	if (versions.includes(SERVED_PAYLOAD_VERSION)) {
		return credential === undefined ? { kind: 'read' } : { credential, kind: 'read' };
	}
	return refused(EXCHANGE_PROBLEMS.payloadVersionUnserved);
};

/**
 * Reads an exchange request's body: `application/json` in UTF-8, valid UTF-8, and strict JSON holding
 * one object, naming no member twice and none `__proto__`, else `400 unreadableBody`. Its
 * `payloadVersions` must be a non-empty list of whole numbers of at least 1, and its `credential`, when
 * present, a string, else `400 unreadableBody`; then `payloadVersions` must list version 1, the one
 * served, else `406 payloadVersionUnserved`. Every other member is ignored. A credential is taken as
 * given, empty or not, for the judgement to refuse. A refusal names the rule broken and never a value
 * the body held.
 *
 * @param request the body as received, or none, and the request's `content-type`.
 */
export const readExchangeRequest = ({
	body,
	contentType,
}: {
	body: Uint8Array | undefined;
	contentType: string | undefined;
}): ExchangeRequestReading => {
	if (!isJson(contentType)) {
		return refused(unreadableBody('is not application/json in UTF-8'));
	}
	const text = body === undefined ? '' : decoded(body);
	if (text === undefined) {
		return refused(unreadableBody('is not UTF-8'));
	}
	const json = readStrictJson(text);
	if (json.kind === 'refused') {
		return refused(unreadableBody(json.rule));
	}
	return isRecord(json.value) ? membersOf(json.value) : refused(unreadableBody('is not one JSON object'));
};
