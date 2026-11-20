// The global setup loads this module under Node's own type stripping, without tsx: it keeps to
// erasable syntax and imports no sibling's values (type imports are erased, so they are allowed).

import type { KeycloakRealmOptions } from './containers.js';

/** One container a run started: the image it runs and the URL that reaches it. */
export interface RunningContainer {
	image: string;
	url: string;
}

/**
 * The run's shared Keycloak as the test files find it: the origin its relay listens on, the admin
 * password the test files use to reach its admin API, the realm it holds with every client secret and
 * person password, and the subjects the global setup learned before it removed the accounts it removes.
 */
export interface RunningKeycloak {
	adminPassword: string;
	image: string;

	/** The subject of each account the global setup learned, by username, before any removal. */
	subjects: Readonly<Record<string, string>>;

	/** The relay's origin, `http://127.0.0.1:<port>`, where the realm's issuer is served. */
	origin: string;

	realm: KeycloakRealmOptions;
}

/**
 * The containers a run's global setup started, as the test files find them. PostgreSQL's URL is its
 * superuser's, for the test support that creates roles and databases; a test connects under a role
 * `database.ts` hands it.
 */
export interface RunningContainers {
	keycloak: RunningKeycloak;
	postgresql: RunningContainer;
	valkey: RunningContainer;
}

const VARIABLES = {
	keycloakAdminPassword: 'USHER_TEST_KEYCLOAK_ADMIN_PASSWORD',
	keycloakImage: 'USHER_TEST_KEYCLOAK_IMAGE',
	keycloakOrigin: 'USHER_TEST_KEYCLOAK_ORIGIN',
	keycloakRealm: 'USHER_TEST_KEYCLOAK_REALM',
	keycloakSubjects: 'USHER_TEST_KEYCLOAK_SUBJECTS',
	postgresqlImage: 'USHER_TEST_POSTGRESQL_IMAGE',
	postgresqlUrl: 'USHER_TEST_POSTGRESQL_URL',
	valkeyImage: 'USHER_TEST_VALKEY_IMAGE',
	valkeyUrl: 'USHER_TEST_VALKEY_URL',
} as const;

/**
 * The environment variables that hand the containers to the test files. The global setup sets them
 * before any test file starts, and each test file inherits them; a wrapper script starting the
 * containers could set the same ones instead.
 *
 * @param containers the containers the run started.
 */
export const environmentForContainers = ({
	keycloak,
	postgresql,
	valkey,
}: RunningContainers): Readonly<Record<string, string>> => ({
	[VARIABLES.keycloakAdminPassword]: keycloak.adminPassword,
	[VARIABLES.keycloakImage]: keycloak.image,
	[VARIABLES.keycloakOrigin]: keycloak.origin,
	[VARIABLES.keycloakRealm]: JSON.stringify(keycloak.realm),
	[VARIABLES.keycloakSubjects]: JSON.stringify(keycloak.subjects),
	[VARIABLES.postgresqlImage]: postgresql.image,
	[VARIABLES.postgresqlUrl]: postgresql.url,
	[VARIABLES.valkeyImage]: valkey.image,
	[VARIABLES.valkeyUrl]: valkey.url,
});

/**
 * The containers the run started, read from the environment the global setup published.
 *
 * @param environment the environment to read; the process's own by default.
 * @throws {Error} when the run started none, as when a test file runs without the global setup.
 */
export const runningContainers = (
	environment: Readonly<Record<string, string | undefined>> = process.env,
): RunningContainers => {
	const postgresqlImage = environment[VARIABLES.postgresqlImage];
	const postgresqlUrl = environment[VARIABLES.postgresqlUrl];
	const valkeyImage = environment[VARIABLES.valkeyImage];
	const valkeyUrl = environment[VARIABLES.valkeyUrl];
	const keycloakAdminPassword = environment[VARIABLES.keycloakAdminPassword];
	const keycloakImage = environment[VARIABLES.keycloakImage];
	const keycloakOrigin = environment[VARIABLES.keycloakOrigin];
	const keycloakRealm = environment[VARIABLES.keycloakRealm];
	const keycloakSubjects = environment[VARIABLES.keycloakSubjects];
	if (
		postgresqlImage !== undefined &&
		postgresqlUrl !== undefined &&
		valkeyImage !== undefined &&
		valkeyUrl !== undefined &&
		keycloakAdminPassword !== undefined &&
		keycloakImage !== undefined &&
		keycloakOrigin !== undefined &&
		keycloakRealm !== undefined &&
		keycloakSubjects !== undefined
	) {
		return {
			keycloak: {
				adminPassword: keycloakAdminPassword,
				image: keycloakImage,
				origin: keycloakOrigin,
				realm: JSON.parse(keycloakRealm) as KeycloakRealmOptions,
				subjects: JSON.parse(keycloakSubjects) as Readonly<Record<string, string>>,
			},
			postgresql: { image: postgresqlImage, url: postgresqlUrl },
			valkey: { image: valkeyImage, url: valkeyUrl },
		};
	}
	throw new Error(
		'the test containers are not running: run the suite with pnpm test, whose global setup starts them',
	);
};
