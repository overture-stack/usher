/** One rule a start broke, and the environment variable whose value broke it. */
export interface StartProblem {
  /** What is wrong, worded to follow the variable's name, and never quoting its value. */
  rule: string;

  /** The environment variable at fault. */
  variable: string;
}
