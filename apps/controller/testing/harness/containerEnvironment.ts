// The global setup loads this module under Node's own type stripping, without tsx: it keeps to
// erasable syntax and imports no sibling's values.

/** One container a run started: the image it runs and the URL that reaches it. */
export interface RunningContainer {
	image: string;
	url: string;
}

/**
 * The containers a run's global setup started, as the test files find them. PostgreSQL's URL is its
 * superuser's, for the test support that creates roles and databases; a test connects under a role
 * `database.ts` hands it.
 */
export interface RunningContainers {
	postgresql: RunningContainer;
	valkey: RunningContainer;
}

const VARIABLES = {
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
	postgresql,
	valkey,
}: RunningContainers): Readonly<Record<string, string>> => ({
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
	if (
		postgresqlImage !== undefined &&
		postgresqlUrl !== undefined &&
		valkeyImage !== undefined &&
		valkeyUrl !== undefined
	) {
		return {
			postgresql: { image: postgresqlImage, url: postgresqlUrl },
			valkey: { image: valkeyImage, url: valkeyUrl },
		};
	}
	throw new Error(
		'the test containers are not running: run the suite with pnpm test, whose global setup starts them',
	);
};
