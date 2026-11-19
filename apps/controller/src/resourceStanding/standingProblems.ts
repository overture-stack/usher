import { problem } from '../http/index.js';

/**
 * The refusals of a principal for their standing on a resource: `resourceNotFound`, to one who may
 * not see it, answered exactly as for a resource that does not exist; and `noAuthorityOnResource`,
 * to one who may see it and holds no authority for what they asked.
 */
export const STANDING_PROBLEMS = Object.freeze({
  noAuthorityOnResource: problem(
    'noAuthorityOnResource',
    403,
    'No authority on this resource',
    'This operation on the resource is for its owners and platform administrators alone.',
  ),
  resourceNotFound: problem(
    'resourceNotFound',
    404,
    'Resource not found',
    'No resource you may see has the externalId named.',
  ),
});
