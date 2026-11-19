/**
 * One rule a start broke: the environment variable whose value broke it, or the stored setting whose value
 * did. Neither form carries the value.
 */
export type StartProblem =
	| {
			/** What is wrong, worded to follow the setting's name, and never quoting its value. */
			rule: string;

			/** The stored setting at fault. */
			setting: string;
	  }
	| {
			/** What is wrong, worded to follow the variable's name, and never quoting its value. */
			rule: string;

			/** The environment variable at fault. */
			variable: string;
	  };
