/** What reading JSON text strictly gave: its value, or the rule the text broke. */
export type JsonReading =
  { kind: 'read'; value: unknown } | { kind: 'refused'; rule: string };
