import { ControllerError } from './controllerError.js';
import type { StartProblem } from './types.js';

/**
 * Why the Controller, or its schema migration command, refuses to start. Each problem names the
 * environment variable or the stored setting at fault and the rule its value broke, never the value, so a
 * refusal is safe to print wherever the start's output goes, whatever the value holds.
 */
export class StartRefusal extends ControllerError {
	override readonly name = 'StartRefusal';

	/** The environment variables at fault, in the order their problems were found. */
	readonly variables: readonly string[];

	/** The stored settings at fault, in the order their problems were found. */
	readonly settings: readonly string[];

	/**
	 * @param problems each rule broken, with the variable or the setting at fault; at least one.
	 * @param opening what refuses, opening the message: the Controller's start by default.
	 */
	constructor(problems: readonly StartProblem[], opening = 'the controller refuses to start') {
		super(
			`${opening}: ${problems.map((problem) => ('setting' in problem ? `the setting ${problem.setting} ${problem.rule}` : `${problem.variable} ${problem.rule}`)).join('; ')}`,
		);
		this.variables = problems.flatMap((problem) => ('variable' in problem ? [problem.variable] : []));
		this.settings = problems.flatMap((problem) => ('setting' in problem ? [problem.setting] : []));
	}
}
