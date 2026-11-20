import { runningContainers } from './containerEnvironment.js';
import { type KeycloakRealmOptions, connectSharedKeycloak, type SharedKeycloakRealm } from './containers.js';

/**
 * The run's shared Keycloak as a test process holds it: a handle with no `remove`, and the realm it
 * was started with, its clients' secrets and people's passwords included, for a test to sign people in
 * or to look one up in its `people`. Read from the environment the global setup wrote, so it starts
 * nothing; a test file run without the global setup throws, as {@link runningContainers} does.
 */
export const sharedKeycloak = (): { keycloak: SharedKeycloakRealm; options: KeycloakRealmOptions } => {
	const running = runningContainers().keycloak;
	return { keycloak: connectSharedKeycloak(running), options: running.realm };
};
