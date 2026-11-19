import { eventInstant, type JsonValue } from '../eventLog/index.js';
import type { Reader, StoredResource } from './types.js';

/**
 * A resource as an answer shows it: a registration's, a read's, and each entry of a listing alike.
 * A platform administrator's answer and a counted owner's carry `grantSummary`, holding no count,
 * and `registeredBy`, the registering administrator's subject or `null` where none is recorded;
 * anyone else's carries neither.
 *
 * @param resource the resource as the store holds it.
 * @param reader who it is answered to.
 */
export const resourceView = (
	{
		accessLevel,
		applications,
		categories,
		description,
		displayName,
		externalId,
		fields,
		registeredAt,
		registeredBy,
		retired,
		suppressed,
		updatedAt,
	}: StoredResource,
	reader: Reader,
): JsonValue => ({
	accessLevel,
	applications,
	categories,
	description,
	displayName,
	externalId,
	fields,
	...(reader === 'signedIn' ? {} : { grantSummary: {} }),
	registeredAt: eventInstant(registeredAt.getTime()),
	...(reader === 'signedIn'
		? {}
		: {
				registeredBy: registeredBy === null ? null : { subject: registeredBy },
			}),
	retired,
	suppressed,
	updatedAt: eventInstant(updatedAt.getTime()),
});
