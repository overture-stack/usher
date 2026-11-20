import { eventInstant, type JsonValue } from '../eventLog/index.js';
import type { Reader, StoredResource } from './types.js';

/**
 * A resource as an answer shows it: a registration's, a read's, and each entry of a listing alike.
 * A platform administrator's answer and a counted owner's carry `grantSummary`, and `registeredBy`,
 * the registering administrator's subject or `null` where none is recorded; anyone else's carries
 * neither. An entry of a platform administrator's listing carries `grants` too.
 *
 * @param resource the resource as the store holds it.
 * @param reader who it is answered to.
 * @param grants its grants as a listing entry shows them; none for any other answer.
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
		grantSummary,
		registeredAt,
		registeredBy,
		retired,
		suppressed,
		updatedAt,
	}: StoredResource,
	reader: Reader,
	grants?: readonly JsonValue[],
): JsonValue => ({
	accessLevel,
	applications,
	categories,
	description,
	displayName,
	externalId,
	fields,
	...(grants === undefined ? {} : { grants }),
	...(reader === 'signedIn' ? {} : { grantSummary }),
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
