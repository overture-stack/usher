/**
 * The key a column's text holds in every letter case, as each unique index comparing names in any letter case
 * writes it: lowered under ICU's root collation, so a letter beyond ASCII folds alike under any database default.
 *
 * @param column the column, or a parameter cast to text, whose key is meant.
 */
export const letterCaseKey = (column: string): string => `lower(${column} COLLATE "und-x-icu")`;
