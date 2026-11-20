import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the server received, as it arrived. */
export interface RecordedRequest {
	body: string;

	/** By lower-case name, as Node reads them. */
	headers: IncomingMessage['headers'];

	method: string;

	/** The path and query, exactly as sent. */
	target: string;
}

/**
 * How the server answers one request: a status, headers and a body; or `respond`, which writes the
 * whole answer itself, as a stream that stays open does.
 */
export type ScriptedAnswer =
	| {
			body?: string;
			headers?: Readonly<Record<string, string>>;
			status: number;
	  }
	| { respond(response: ServerResponse): void };

/** A loopback server recording every request and answering each as a test scripts it. */
export interface RecordingServer {
	/** Every request received, in order. */
	requests: readonly RecordedRequest[];

	/** Settles once the server has stopped, every connection closed, open ones included. */
	stop(): Promise<void>;

	/** The server's URL, ending in `/`. */
	url: URL;
}

const bodyOf = (request: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});

/**
 * Starts a server on loopback that records each request, body included, before answering it as
 * scripted.
 *
 * @param answer how each request is answered: 204 with no body by default.
 */
export const startRecordingServer = async (
	answer: (request: RecordedRequest) => ScriptedAnswer = () => ({
		status: 204,
	}),
): Promise<RecordingServer> => {
	const requests: RecordedRequest[] = [];
	const server = createServer((incoming, outgoing) => {
		void bodyOf(incoming).then((body) => {
			const recorded: RecordedRequest = {
				body,
				headers: incoming.headers,
				method: incoming.method ?? '',
				target: incoming.url ?? '',
			};
			requests.push(recorded);
			const scripted = answer(recorded);
			if ('respond' in scripted) {
				scripted.respond(outgoing);
				return;
			}
			outgoing.writeHead(scripted.status, scripted.headers ?? {});
			outgoing.end(scripted.body ?? '');
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address() as AddressInfo;
	return {
		requests,
		stop: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
		url: new URL(`http://127.0.0.1:${port}/`),
	};
};
