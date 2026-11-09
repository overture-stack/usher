import { ControllerError } from '../controllerError.js';

/**
 * A unit of store work sent its `COMMIT`, and the store did not answer it within one more store
 * timeout, so whether the change took effect is unknown. The unit was abandoned, its connection
 * discarded. Its `code` names it on a log line; its message names no value.
 */
export class CommitUnconfirmed extends ControllerError {
  readonly code = 'commitUnconfirmed';

  override readonly name = 'CommitUnconfirmed';

  constructor() {
    super('the store did not confirm whether the commit took effect');
  }
}
