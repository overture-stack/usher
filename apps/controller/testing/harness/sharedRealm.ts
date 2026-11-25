import { randomBytes } from 'node:crypto';

import type { KeycloakClient, KeycloakPerson, KeycloakRealmOptions, SharedKeycloakPlan } from './containers.js';

// The global setup loads this module under Node's own type stripping, without tsx: it keeps to
// erasable syntax and imports no sibling's values (type imports are erased, so they are allowed).
// It holds the data of the one realm a run's shared Keycloak imports, which every suite sharing it
// reads, and the data of the realms the suites that cannot share it start for themselves.

/** The one realm a run's shared Keycloak holds, which every suite sharing it reads by this name. */
export const SHARED_REALM = 'overture';

/** The realm role of the listing suites' platform administrator. */
export const PLATFORM_ADMIN_ROLE = 'usher-platform-admin';

const freshPassword = (): string => randomBytes(24).toString('base64url');

/**
 * Each listing cast member's username, which is also their address. The administrator, Bo and the account
 * holding nothing are address people (`admin.one@`, `sub.bo@`, `abo@`); the rest are added to them. Fay's
 * account is removed once the run has learned her subject, so the seed holds a grant whose holder the
 * directory no longer knows.
 */
export const CAST = Object.freeze({
	administrator: 'admin.one@example.org',
	ana: 'ana@example.org',
	bo: 'sub.bo@example.org',
	cy: 'cy@example.org',
	dee: 'dee@example.org',
	eve: 'eve@example.org',
	fay: 'fay@example.org',
	gil: 'gil@example.org',
	hal: 'hal@example.org',
	holdsNothing: 'abo@example.org',
	outsider: 'outsider@example.org',
	quinn: 'quinn@example.org',
} as const);

const person = (username: string, email: string, details: Partial<KeycloakPerson> = {}): KeycloakPerson => ({
	email,
	password: freshPassword(),
	username,
	...details,
});

/**
 * The address realm's own people, at example.org: Bo verified (`sub.bo@`), his near misses (`bo.smith@`,
 * `abo@`), non-ASCII text (`zoë@`), plus-addressing (`bo+ims@`), an unverified address (`una@`), a disabled
 * account (`disabled@`), two accounts sharing `dup@`, an administrator (`admin.one@`) holding the first-user
 * role, an owner (`owner.ana@`) and an outsider (`outsider.cy@`) for the grants suites, and two accounts a
 * test disables (`paused@`) or deletes (`leaving@`) while it runs. Usernames are the addresses, the two
 * sharing one apart.
 */
const addressPeople = (firstUserRole: string): readonly KeycloakPerson[] => [
	person('sub.bo@example.org', 'sub.bo@example.org', { firstName: 'Bo', lastName: 'Example' }),
	person('bo.smith@example.org', 'bo.smith@example.org'),
	person('abo@example.org', 'abo@example.org'),
	person('zoë@example.org', 'zoë@example.org'),
	person('bo+ims@example.org', 'bo+ims@example.org'),
	person('una@example.org', 'una@example.org', { emailVerified: false }),
	person('disabled@example.org', 'disabled@example.org', { enabled: false }),
	person('dup.one', 'dup@example.org'),
	person('dup.two', 'dup@example.org'),
	person('admin.one@example.org', 'admin.one@example.org', { realmRoles: [firstUserRole] }),
	person('owner.ana@example.org', 'owner.ana@example.org', { firstName: 'Ana', lastName: 'Example' }),
	person('outsider.cy@example.org', 'outsider.cy@example.org', { firstName: 'Cy', lastName: 'Example' }),
	person('leaving@example.org', 'leaving@example.org', { firstName: 'Lee', lastName: 'Example' }),
	person('paused@example.org', 'paused@example.org', { firstName: 'Pat', lastName: 'Example' }),
];

/** The address realm's clients: the management client issuing tokens, and the Controller's directory. */
const addressClients = (managementAudience: string, managementClient: string): readonly KeycloakClient[] => [
	{ audiences: [managementAudience], clientId: managementClient },
	{
		audiences: [],
		clientId: 'usher-directory',
		directoryRoles: ['query-users', 'view-users'],
		secret: freshPassword(),
	},
];

/**
 * The realm for the suites resolving addresses (the grant tests and the listing tests), at its own
 * realm name: realm `overture` with the address people only, the management client and the
 * directory client. It is the part of the shared realm {@link sharedRealmOptions} holds that those
 * suites read, so a Keycloak started for them alone holds the same accounts.
 *
 * @param options the first-user role, the management API's audience and client, each the harness's by default.
 */
export const addressKeycloakRealm = ({
	firstUserRole = 'usher-first-user',
	managementAudience = 'usher-management-test',
	managementClient = 'usher-ui-test',
}: {
	firstUserRole?: string;
	managementAudience?: string;
	managementClient?: string;
} = {}): KeycloakRealmOptions => ({
	clients: addressClients(managementAudience, managementClient),
	duplicateEmailsAllowed: true,
	people: addressPeople(firstUserRole),
	realm: SHARED_REALM,
	realmRoles: [firstUserRole],
});

// The listing cast beyond the address people, each with the names it is shown by (the contract's
// `NamedPrincipal`). Quinn never signs in, since Keycloak may refuse a person with no names a
// direct access grant.
const LISTING_ADDITIONS: readonly {
	firstName: string | null;
	lastName: string | null;
	name: keyof typeof CAST;
	realmRoles?: readonly string[];
}[] = Object.freeze([
	{ firstName: 'Ana', lastName: 'Example', name: 'ana' },
	{ firstName: 'Cy', lastName: 'Example', name: 'cy' },
	{ firstName: 'Dee', lastName: 'Example', name: 'dee' },
	{ firstName: 'Eve', lastName: 'Example', name: 'eve' },
	{ firstName: 'Fay', lastName: 'Example', name: 'fay' },
	{ firstName: 'Gil', lastName: 'Example', name: 'gil' },
	{ firstName: 'Hal', lastName: 'Example', name: 'hal' },
	{ firstName: 'Olu', lastName: 'Example', name: 'outsider' },
	{ firstName: null, lastName: null, name: 'quinn', realmRoles: [PLATFORM_ADMIN_ROLE] },
]);

/**
 * The people the egoImport suites add: Ana at `ana.a@example.org`, and two accounts holding
 * `twin@example.org`, which the realm allows.
 */
const EGO_IMPORT_ADDITIONS: readonly KeycloakPerson[] = Object.freeze([
	person('ana.a@example.org', 'ana.a@example.org'),
	person('twin.one', 'twin@example.org'),
	person('twin.two', 'twin@example.org'),
]);

/**
 * The one realm a run's shared Keycloak imports: the address realm, the listing cast, the egoImport
 * accounts and the registrar's, with the clients of each: the management client, the directory client,
 * and `lyric-svc`, a confidential client with a service account, whose tokens name the management API.
 * Duplicate addresses are allowed, so sign-in is by username.
 *
 * @param options the first-user role and the management API's audience and client, each the harness's by default.
 */
export const sharedRealmOptions = ({
	firstUserRole = 'usher-first-user',
	managementAudience = 'usher-management-test',
	managementClient = 'usher-ui-test',
}: {
	firstUserRole?: string;
	managementAudience?: string;
	managementClient?: string;
} = {}): KeycloakRealmOptions => {
	const address = addressKeycloakRealm({ firstUserRole, managementAudience, managementClient });
	return {
		clients: [
			...address.clients,
			{ audiences: [managementAudience], clientId: 'lyric-svc', secret: freshPassword() },
		],
		duplicateEmailsAllowed: true,
		people: [
			...address.people,
			...LISTING_ADDITIONS.map(({ firstName, lastName, name, realmRoles }) =>
				person(CAST[name], CAST[name], {
					firstName,
					lastName,
					...(realmRoles === undefined ? {} : { realmRoles }),
				}),
			),
			...EGO_IMPORT_ADDITIONS,
			// The registrar suites register applications as the realm's administrator, and a person holding none.
			person('registrar@example.org', 'registrar@example.org', { realmRoles: [firstUserRole] }),
			person('bystander@example.org', 'bystander@example.org'),
		],
		realm: SHARED_REALM,
		realmRoles: [firstUserRole, PLATFORM_ADMIN_ROLE],
	};
};

/**
 * What the run's global setup starts the shared Keycloak with: the shared realm, the subjects of every
 * listing cast member learned, and Fay's account removed once they are, since the seed holds a grant
 * whose holder the directory no longer knows.
 */
export const sharedRealmPlan = (): SharedKeycloakPlan => ({
	learned: Object.values(CAST),
	options: sharedRealmOptions(),
	removed: [CAST.fay],
});
