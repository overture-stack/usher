import { ControllerError } from '../failures/index.js';

/**
 * The store did not answer one unit of work within the store timeout, and the unit was abandoned. Its
 * `code` names it on a log line, as a store's own failure is named by its SQLSTATE or system error
 * code; its message names no value.
 */
export class StoreTimeout extends ControllerError {
  readonly code = 'storeTimeout';

  override readonly name = 'StoreTimeout';

  constructor() {
    super('the store did not answer within the store timeout');
  }
}
