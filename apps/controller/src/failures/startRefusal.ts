import { ControllerError } from './controllerError.js';
import type { StartProblem } from './types.js';

/**
 * Why the controller, or its schema migration command, refuses to start. Each problem names the
 * environment variable at fault and the rule its value broke, never the value, so a refusal is safe
 * to print wherever the start's output goes, whatever the variable holds.
 */
export class StartRefusal extends ControllerError {
  override readonly name = 'StartRefusal';

  /** The environment variables at fault, in the order their problems were found. */
  readonly variables: readonly string[];

  /**
   * @param problems each rule broken, with the variable at fault; at least one.
   * @param opening what refuses, opening the message: the controller's start by default.
   */
  constructor(
    problems: readonly StartProblem[],
    opening = 'the controller refuses to start',
  ) {
    super(
      `${opening}: ${problems.map(({ rule, variable }) => `${variable} ${rule}`).join('; ')}`,
    );
    this.variables = problems.map(({ variable }) => variable);
  }
}
