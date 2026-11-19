import { fastify, type FastifyInstance, type FastifyReply } from 'fastify';

import type { ServerSettings } from './types.js';

/** The paths of the health endpoints, which take no credential. */
export const HEALTH_PATHS: Readonly<{ liveness: string; readiness: string }> = Object.freeze({
	liveness: '/health/live',
	readiness: '/health/ready',
});

// The longest path parameter routed, in characters as sent, percent-encodings included: as long as
// the request head Node reads by default, so every path Node accepts reaches its route, which judges
// the parameter by its own rules, rather than going unrouted.
const PATH_PARAMETER_MAXIMUM_LENGTH = 16_384;

// The refusal of a path that cannot be decoded, which names the rule alone, never the path sent.
const UNREADABLE_PATH = JSON.stringify({
	code: 'unreadablePath',
	detail: 'The path holds a percent-encoding that is not UTF-8.',
	status: 400,
	title: 'Path unreadable',
});

/**
 * Creates the Controller's HTTP server, not yet listening, with its health endpoints: liveness
 * answers 200 while the Controller is live and 503 once it is not, whatever readiness answers, and
 * readiness 200 while the Controller can serve and 503 while it cannot. Each asks at every request.
 * Neither carries any detail in its body, and a path the server does not serve is answered 404 with
 * none either, so no answer repeats what a request sent; a path that cannot be decoded is answered
 * 400 in problem details naming that rule alone. A path parameter of any length a request head can
 * carry reaches its route. A route is given each request body as its bytes, whatever its media type,
 * to read as it rules. A request's address is the nearest its trusted proxies did not add.
 *
 * @param settings whether the Controller is live, whether it can serve now, and the trusted proxies.
 */
export const createServer = ({ isLive, isReady, trustedProxies }: ServerSettings): FastifyInstance => {
	const server = fastify({
		frameworkErrors: (_error, _request, reply: FastifyReply) => {
			reply.code(400).header('content-type', 'application/problem+json').send(UNREADABLE_PATH);
		},
		logger: false,
		routerOptions: { maxParamLength: PATH_PARAMETER_MAXIMUM_LENGTH },
		trustProxy: trustedProxies.length === 0 ? false : [...trustedProxies],
	});
	server.removeAllContentTypeParsers();
	server.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
		done(null, body);
	});
	server.get(HEALTH_PATHS.liveness, async (_request, reply) => reply.code(isLive() ? 200 : 503).send());
	server.get(HEALTH_PATHS.readiness, async (_request, reply) => reply.code((await isReady()) ? 200 : 503).send());
	server.setNotFoundHandler(async (_request, reply) => reply.code(404).send());
	return server;
};
