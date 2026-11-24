import { AsyncLocalStorage } from 'node:async_hooks';

import { ControllerError } from '../failures/index.js';

/** The administrator a request was admitted as: the trusted issuer and the subject. */
export interface AdmittedIdentity {
	issuer: string;
	subject: string;
}

// The administrator the request being served was admitted as, carried to every change it runs, so each
// change can confirm, in its own transaction, that the administrator is still one.
const admittedAdministratorScope = new AsyncLocalStorage<AdmittedIdentity>();

/**
 * Thrown when the administrator a request was admitted as is not a live administrator at the
 * transaction of a change the request runs, so the change commits nothing. Admin status is read inside
 * each change's own transaction, so a change by a removed administrator never commits.
 */
export class AdministratorStatusWithdrawn extends ControllerError {
	override readonly name: string = 'AdministratorStatusWithdrawn';

	constructor() {
		super('the administrator the request was admitted as is no longer one');
	}
}

/**
 * Runs work for a request admitted as an administrator, so each change the work runs confirms, within
 * its own transaction, that the identity is still a live administrator.
 *
 * @param identity the administrator the request was admitted as.
 * @param work the request's work, run with the identity in scope.
 */
export const withAdministratorAuthority = <Result>(
	identity: AdmittedIdentity,
	work: () => Promise<Result>,
): Promise<Result> => admittedAdministratorScope.run(identity, work);

/**
 * The administrator the request being served was admitted as, or none for work run outside a request
 * admitted as an administrator.
 */
export const admittedAdministrator = (): AdmittedIdentity | undefined => admittedAdministratorScope.getStore();
