/** One rule a start broke, and the environment variable whose value broke it. */
export interface StartProblem {
  /** What is wrong, worded to follow the variable's name, and never quoting its value. */
  rule: string;

  /** The environment variable at fault. */
  variable: string;
}

/**
 * Why the controller refuses to start. Each problem names the environment variable at fault and the
 * rule its value broke, never the value, so a refusal is safe to print wherever the start's output
 * goes, whatever the variable holds.
 */
export class StartRefusal extends Error {
  override readonly name = 'StartRefusal';

  /** The environment variables at fault, in the order their problems were found. */
  readonly variables: readonly string[];

  /**
   * @param problems each rule broken, with the variable at fault; at least one.
   */
  constructor(problems: readonly StartProblem[]) {
    super(
      `the controller refuses to start: ${problems.map(({ rule, variable }) => `${variable} ${rule}`).join('; ')}`,
    );
    this.variables = problems.map(({ variable }) => variable);
  }
}
