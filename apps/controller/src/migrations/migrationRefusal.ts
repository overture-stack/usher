import type { RefusedOption } from './types.js';

/** What the message of every refusal a migration run gives opens with. */
export const MIGRATIONS_REFUSE_TO_RUN = 'the schema migrations refuse to run';

/**
 * A migration run's refusal, before it writes anything, laid on one of its options: the option, and
 * the rule its value broke, worded to follow the option's name and never quoting the value, so a
 * caller that read the option from a variable can name the variable instead.
 */
export class MigrationRefusal extends Error {
  override readonly name = 'MigrationRefusal';

  /** The option at fault. */
  readonly option: RefusedOption;

  /** The rule its value broke, worded to follow its name. */
  readonly rule: string;

  /**
   * @param option the option at fault.
   * @param rule the rule its value broke, worded to follow its name.
   */
  constructor(option: RefusedOption, rule: string) {
    super(`${MIGRATIONS_REFUSE_TO_RUN}: ${option} ${rule}`);
    this.option = option;
    this.rule = rule;
  }
}
