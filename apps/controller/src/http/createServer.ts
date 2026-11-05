import { fastify, type FastifyInstance } from 'fastify';

import type { Readiness } from './types.js';

/** The paths of the health endpoints, which take no credential. */
export const HEALTH_PATHS: Readonly<{ liveness: string; readiness: string }> =
  Object.freeze({
    liveness: '/health/live',
    readiness: '/health/ready',
  });

/**
 * Creates the controller's HTTP server, not yet listening, with its health endpoints: liveness
 * answers 200 for as long as the process runs, and readiness 200 while the controller can serve and
 * 503 while it cannot. Neither carries any detail in its body, and a path the server does not serve
 * is answered 404 with none either, so no answer repeats what a request sent.
 *
 * @param readiness whether the controller can serve now.
 */
export const createServer = ({ isReady }: Readiness): FastifyInstance => {
  const server = fastify({ logger: false });
  server.get(HEALTH_PATHS.liveness, async (_request, reply) =>
    reply.code(200).send(),
  );
  server.get(HEALTH_PATHS.readiness, async (_request, reply) =>
    reply.code(isReady() ? 200 : 503).send(),
  );
  server.setNotFoundHandler(async (_request, reply) => reply.code(404).send());
  return server;
};
