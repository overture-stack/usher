import { StartRefusal } from '../failures/index.js';
import { ENVIRONMENT_VARIABLES, REPLACED_VARIABLES } from './environmentVariables.js';
import type { Clock, ConfigurationEnvironment, ControllerConfiguration, FieldWithVariable } from './types.js';
import {
	CONTROLLER_ROLE_DESCRIPTION,
	read,
	readAddresses,
	readDatabaseUrl,
	readInteger,
	readKey,
	readList,
	readSecureUrl,
	readSwitch,
	readText,
	readVerifiedConnection,
	type Reading,
	refused,
	then,
	type Variable,
} from './variableReaders.js';

// The greatest delay a Node timer keeps; a longer one fires at once.
const LONGEST_TIMER_MILLISECONDS = 2_147_483_647;

const SYSTEM_CLOCK: Clock = Object.freeze({ now: () => Date.now() });

const valueOf = <Value>(reading: Reading<Value>): Value => {
	if (reading.kind === 'read') {
		return reading.value;
	}
	throw new StartRefusal([reading.problem]);
};

// The rule a directory with only some of its four variables set breaks.
const PARTIAL_DIRECTORY_RULE =
	'is unset or empty while another directory variable is set: a directory needs all four, or none for no directory';

/**
 * Reads the Controller's configuration from an environment, every variable checked before any is
 * used: a refusal lists every rule broken, each naming the variable at fault and never its value.
 * The keys are 32 bytes as 43 base64url characters in canonical form, any whitespace around them
 * left out; the database's password is read from its own variable, as given, and a database URL
 * carrying one is refused, as is one naming no database role, one naming a file the driver cannot
 * read, and one whose connection leaves the host without verifying the server while that is not
 * allowed. The directory's four variables are set together or not at all, a start setting only some
 * of them refused, naming each one missing; the secret is read as given, and the URL is held to
 * https, or http to a loopback host. The clock is the system's and the log stream the process's
 * standard output; neither is read from the environment.
 *
 * @param environment the environment variables, such as `process.env`.
 * @throws {StartRefusal} naming each variable at fault.
 */
export const readConfiguration = (environment: ConfigurationEnvironment): ControllerConfiguration => {
	const variable = (field: FieldWithVariable): Variable => ({
		name: ENVIRONMENT_VARIABLES[field],
		value: environment[ENVIRONMENT_VARIABLES[field]],
	});
	const managementClients = readList(variable('managementClients'));
	const databaseAllowUnverifiedConnection = readSwitch(variable('databaseAllowUnverifiedConnection'), false);
	// A directory takes all four of its variables or none: a start setting only some of them is refused,
	// naming each left unset or empty and never a value. Every one read empty, none is set: no directory.
	const directoryRaw = {
		directoryClientId: readText(variable('directoryClientId'), { emptyAllowed: true, fallback: '' }),
		directoryClientSecret: readText(variable('directoryClientSecret'), { emptyAllowed: true, fallback: '' }),
		directoryRealm: readText(variable('directoryRealm'), { emptyAllowed: true, fallback: '' }),
		directoryUrl: readText(variable('directoryUrl'), { emptyAllowed: true, fallback: '' }),
	};
	const directoryIsSet = Object.values(directoryRaw).some(
		(reading) => reading.kind === 'read' && reading.value !== '',
	);
	const directoryUrl = then(directoryRaw.directoryUrl, (url): Reading<string> =>
		url !== ''
			? readSecureUrl(variable('directoryUrl'))
			: directoryIsSet
				? refused(variable('directoryUrl'), PARTIAL_DIRECTORY_RULE)
				: read(url),
	);
	const directorySetting = (
		field: 'directoryClientId' | 'directoryClientSecret' | 'directoryRealm',
	): Reading<string> =>
		then(directoryRaw[field], (value): Reading<string> =>
			value === '' && directoryIsSet ? refused(variable(field), PARTIAL_DIRECTORY_RULE) : read(value),
		);
	const readings = {
		// The page's tokens are management tokens, so its client is one of the management clients, as listed.
		apiDocsClient: then(
			readText(variable('apiDocsClient'), { emptyAllowed: true, fallback: '' }),
			(client): Reading<string> =>
				client !== '' && managementClients.kind === 'read' && !managementClients.value.includes(client)
					? refused(
							variable('apiDocsClient'),
							`is not one of the clients in ${ENVIRONMENT_VARIABLES.managementClients}`,
						)
					: read(client),
		),
		backChannelLogoutAudiences: readList(variable('backChannelLogoutAudiences')),
		cursorKey: readKey(variable('cursorKey')),
		databaseAllowUnverifiedConnection,
		databaseControlConnections: readInteger(variable('databaseControlConnections'), { fallback: 5, minimum: 1 }),
		databaseExchangeConnections: readInteger(variable('databaseExchangeConnections'), { fallback: 10, minimum: 1 }),
		databasePassword: readText(variable('databasePassword')),
		databaseSchema: readText(variable('databaseSchema')),
		// An opt-out that cannot be read allows nothing, beside its own refusal.
		databaseUrl: then(
			readDatabaseUrl(variable('databaseUrl'), {
				passwordVariable: ENVIRONMENT_VARIABLES.databasePassword,
				roleDescription: CONTROLLER_ROLE_DESCRIPTION,
			}),
			(url) =>
				readVerifiedConnection(
					variable('databaseUrl'),
					url,
					databaseAllowUnverifiedConnection.kind === 'read' && databaseAllowUnverifiedConnection.value,
				),
		),
		directoryClientId: directorySetting('directoryClientId'),
		directoryClientSecret: directorySetting('directoryClientSecret'),
		directoryRealm: directorySetting('directoryRealm'),
		directoryUrl,
		host: readText(variable('host')),
		identityProviderIssuer: readSecureUrl(variable('identityProviderIssuer')),
		instanceName: readText(variable('instanceName')),
		keyEncryptionKey: readKey(variable('keyEncryptionKey')),
		managementAudience: readText(variable('managementAudience')),
		managementClients,
		port: readInteger(variable('port'), { maximum: 65_535, minimum: 0 }),
		serviceAccountRole: readText(variable('serviceAccountRole'), {
			fallback: 'usher-service-account',
		}),
		storeTimeoutMilliseconds: readInteger(variable('storeTimeoutMilliseconds'), {
			fallback: 5000,
			maximum: LONGEST_TIMER_MILLISECONDS,
			minimum: 1,
		}),
		trustedProxies: readAddresses(variable('trustedProxies')),
	} satisfies Record<FieldWithVariable, Reading<unknown>>;
	const replaced = Object.entries(REPLACED_VARIABLES).flatMap(([name, replacement]) =>
		environment[name] === undefined ? [] : [{ rule: `is replaced by ${replacement}: unset it`, variable: name }],
	);
	const problems = [
		...replaced,
		...Object.values(readings).flatMap((reading) => (reading.kind === 'refused' ? [reading.problem] : [])),
	];
	if (problems.length === 0) {
		return {
			apiDocsClient: valueOf(readings.apiDocsClient),
			backChannelLogoutAudiences: valueOf(readings.backChannelLogoutAudiences),
			clock: SYSTEM_CLOCK,
			cursorKey: valueOf(readings.cursorKey),
			databaseAllowUnverifiedConnection: valueOf(readings.databaseAllowUnverifiedConnection),
			databaseControlConnections: valueOf(readings.databaseControlConnections),
			databaseExchangeConnections: valueOf(readings.databaseExchangeConnections),
			databasePassword: valueOf(readings.databasePassword),
			databaseSchema: valueOf(readings.databaseSchema),
			databaseUrl: valueOf(readings.databaseUrl),
			directoryClientId: valueOf(readings.directoryClientId),
			directoryClientSecret: valueOf(readings.directoryClientSecret),
			directoryRealm: valueOf(readings.directoryRealm),
			directoryUrl: valueOf(readings.directoryUrl),
			host: valueOf(readings.host),
			identityProviderIssuer: valueOf(readings.identityProviderIssuer),
			instanceName: valueOf(readings.instanceName),
			keyEncryptionKey: valueOf(readings.keyEncryptionKey),
			logStream: process.stdout,
			managementAudience: valueOf(readings.managementAudience),
			managementClients: valueOf(readings.managementClients),
			port: valueOf(readings.port),
			serviceAccountRole: valueOf(readings.serviceAccountRole),
			storeTimeoutMilliseconds: valueOf(readings.storeTimeoutMilliseconds),
			trustedProxies: valueOf(readings.trustedProxies),
		};
	}
	throw new StartRefusal(problems);
};
