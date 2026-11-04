import {
  SQON_COMBINATION_OPS,
  SQON_FIELD_OPS,
  SQON_MAX_DEPTH,
  SqonSchema,
  type SqonNode,
} from '@overture-stack/sqon';

import type { NonEmpty } from './payload.js';
import {
  hasOnlyMembers,
  isNonEmptyString,
  isPlainRecord,
  listEntries,
  ownMember,
} from './plainData.js';
import {
  brokenRules,
  checkSnapshot,
  ROOT_POSITION,
  type ValidationProblem,
} from './problems.js';
import { parseRecordNarrowing } from './renderedNarrowing.js';
import {
  canonicalOperatorOf,
  isBound,
  isLiteralValue,
  SPECIAL_VALUE_MARKERS,
} from './sqonPrimitives.js';

/**
 * The bridge's decision for one key registered by the adapter, one of three kinds in order of
 * increasing reach:
 * - `deny`: the data layer is not queried for the key, and `reason` says why;
 * - `narrow`: the data layer is queried under `sqon`, which never holds an empty group, an
 *   exclusion or a pivot;
 * - `allow`: the key is open by configuration.
 *
 * The reasons for a `deny`:
 * - `filter-limit`: the principal's grants are more than can be expressed by this catalogue's
 *   filter, not a rule broken by the principal;
 * - `no-grants`: the principal holds no grants, a case that is always a `deny`, never a narrowing;
 * - `rendering-mismatch`: a fault of the bridge itself, whose rendered filter says something other
 *   than the payload it was rendered from;
 * - `unknown-resource`: a fault in the operator's configuration, not the principal's: a key
 *   registering no resources;
 * - `unmapped-category`: a fault in the operator's configuration, not the principal's: a catalogue
 *   whose category mapping neither defines a global category defined by Usher nor declares it
 *   absent.
 */
export type Enforcement =
  | {
      kind: 'deny';
      reason:
        | 'filter-limit'
        | 'no-grants'
        | 'rendering-mismatch'
        | 'unknown-resource'
        | 'unmapped-category';
    }
  | { kind: 'narrow'; sqon: SqonNode }
  | { kind: 'allow' };

/**
 * The result of {@link validateEnforcement}: a copy of the enforcement result's own data, typed,
 * when it holds to the contract, and otherwise every problem found, each value-free.
 */
export type EnforcementValidationResult =
  | { enforcement: Enforcement; success: true }
  | { problems: NonEmpty<ValidationProblem>; success: false };

/**
 * The wording of every rule held by {@link validateEnforcement}, keyed by a stable name, to match
 * against each problem's `rule`.
 */
export const ENFORCEMENT_RULES = {
  allNotEmpty: 'an all clause lists at least one value',
  armMembers:
    'an enforcement result carries only the members defined for its kind',
  clauseMembers: 'a clause carries only fieldName and value',
  combinationContentIsList: "a combination's content is a list of SQON nodes",
  combinationNotEmpty:
    'a combination holds at least one entry, since an empty one matches every document',
  denyReason:
    'a deny carries its reason: filter-limit, no-grants, rendering-mismatch, unknown-resource or unmapped-category',
  depth: 'a filter nests no deeper than SQON allows',
  entryIsNode: 'every entry of a filter is a SQON node',
  exclusion:
    'a filter holds no exclusion: excluding a value is written as a not around an in',
  inNotEmpty:
    'an in clause lists at least one value: matching nothing is a deny, never a narrowing',
  isMap: 'an enforcement result is a map',
  kind: 'kind is deny, narrow or allow',
  literalValues:
    'a clause lists literal values, never one read specially by Arranger: a * pattern, a set_id: reference or __missing__',
  namesField: 'a clause names its field as a non-empty fieldName',
  nodeMembers: 'a filter node carries only op and content',
  notPlacement:
    'a not sits in an and beside an in clause, so it narrows only the records admitted by that clause',
  operator: 'a filter uses only operators defined by SQON',
  pattern: 'a filter matches values as listed, never by a wildcard pattern',
  pivot: 'a filter carries no pivot',
  rangeBound:
    'a range holds only usable bounds, each a finite number or a non-empty string, and a between holds two',
  validSqon: 'a narrowing holds a valid SQON',
} as const;

type DenyReason = Extract<Enforcement, { kind: 'deny' }>['reason'];

const DENY_REASONS: ReadonlySet<string> = new Set(
  Object.keys({
    'filter-limit': true,
    'no-grants': true,
    'rendering-mismatch': true,
    'unknown-resource': true,
    'unmapped-category': true,
  } satisfies Readonly<Record<DenyReason, true>>),
);

/** Each arm's members, looked up through a `Map` so an inherited name is never a kind. */
const ARM_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    allow: new Set(['kind']),
    deny: new Set(['kind', 'reason']),
    narrow: new Set(['kind', 'sqon']),
  } satisfies Readonly<Record<Enforcement['kind'], ReadonlySet<string>>>),
);

const COMBINATION_OPERATORS: ReadonlySet<string> = new Set(
  SQON_COMBINATION_OPS,
);

const FIELD_OPERATORS: ReadonlySet<string> = new Set(SQON_FIELD_OPS);

const EXCLUSION_OPERATORS: ReadonlySet<string> = new Set([
  'not-in',
  'some-not-in',
]);

const PATTERN_OPERATORS: ReadonlySet<string> = new Set(['wildcard']);

const RANGE_OPERATORS: ReadonlySet<string> = new Set([
  'between',
  'gt',
  'gte',
  'lt',
  'lte',
]);

/** The operators whose values are searched by Arranger for {@link SPECIAL_VALUE_MARKERS}. */
const LISTING_OPERATORS: ReadonlySet<string> = new Set(['all', 'in']);

/** `pivot` is held by a rule of its own, so a filter carrying one is told why. */
const NODE_MEMBERS: ReadonlySet<string> = new Set(['content', 'op', 'pivot']);

const CLAUSE_MEMBERS: ReadonlySet<string> = new Set(['fieldName', 'value']);

const FILTER_POSITION = 'sqon';

const isInClause = (node: unknown): boolean =>
  isPlainRecord(node) && canonicalOperatorOf(ownMember(node, 'op')) === 'in';

// Every bound must be usable, since Arranger reads each bound it is given, a between's as the
// lowest and highest listed.
const isBoundedRange = (operator: string, value: unknown): boolean => {
  const bounds = listEntries(value);

  if (operator === 'between') {
    return bounds !== undefined && bounds.length === 2 && bounds.every(isBound);
  }
  return bounds ? bounds.length > 0 && bounds.every(isBound) : isBound(value);
};

const namesAField = (content: Readonly<Record<string, unknown>>): boolean =>
  isNonEmptyString(ownMember(content, 'fieldName'));

const clauseProblems = (
  operator: string,
  content: unknown,
  position: string,
): readonly ValidationProblem[] => {
  if (isPlainRecord(content)) {
    const value = ownMember(content, 'value');
    const values = listEntries(value) ?? [value];

    return brokenRules(position, [
      [namesAField(content), ENFORCEMENT_RULES.namesField],
      [
        hasOnlyMembers(content, CLAUSE_MEMBERS),
        ENFORCEMENT_RULES.clauseMembers,
      ],
      [!EXCLUSION_OPERATORS.has(operator), ENFORCEMENT_RULES.exclusion],
      [!PATTERN_OPERATORS.has(operator), ENFORCEMENT_RULES.pattern],
      [
        operator === 'in' ? values.length > 0 : true,
        ENFORCEMENT_RULES.inNotEmpty,
      ],
      [
        operator === 'all' ? values.length > 0 : true,
        ENFORCEMENT_RULES.allNotEmpty,
      ],
      [
        LISTING_OPERATORS.has(operator) ? values.every(isLiteralValue) : true,
        ENFORCEMENT_RULES.literalValues,
      ],
      [
        RANGE_OPERATORS.has(operator) ? isBoundedRange(operator, value) : true,
        ENFORCEMENT_RULES.rangeBound,
      ],
    ]);
  }

  return [{ position, rule: ENFORCEMENT_RULES.namesField }];
};

/**
 * Problems with one node of a narrowing's filter and everything under it, by the rules for filters
 * that restrict access. `besideIn` says whether the node sits in an `and` that also holds an `in`
 * clause. A `not` must sit there, so it narrows only the records admitted by that clause.
 */
const nodeProblems = (
  node: Readonly<Record<string, unknown>>,
  position: string,
  depth: number,
  besideIn: boolean,
): readonly ValidationProblem[] => {
  const operator = canonicalOperatorOf(ownMember(node, 'op'));
  const content = ownMember(node, 'content');
  const shapeProblems = brokenRules(position, [
    [hasOnlyMembers(node, NODE_MEMBERS), ENFORCEMENT_RULES.nodeMembers],
    [!Object.hasOwn(node, 'pivot'), ENFORCEMENT_RULES.pivot],
    [operator === 'not' ? besideIn : true, ENFORCEMENT_RULES.notPlacement],
  ]);

  if (operator !== undefined && COMBINATION_OPERATORS.has(operator)) {
    return [
      ...shapeProblems,
      ...combinationProblems(operator, content, position, depth),
    ];
  }

  if (operator !== undefined && FIELD_OPERATORS.has(operator)) {
    return [...shapeProblems, ...clauseProblems(operator, content, position)];
  }

  return [...shapeProblems, { position, rule: ENFORCEMENT_RULES.operator }];
};

/**
 * The depth limit is `SqonSchema`'s own, counted here in nodes rather than in JSON levels, so a
 * filter that passed it never reaches the limit here and recursion stays far inside the stack.
 */
const filterProblems = (
  node: unknown,
  position: string,
  depth: number,
  besideIn: boolean,
): readonly ValidationProblem[] => {
  const withinDepth = depth <= SQON_MAX_DEPTH;

  if (withinDepth && isPlainRecord(node)) {
    return nodeProblems(node, position, depth, besideIn);
  }

  return [
    {
      position,
      rule: withinDepth
        ? ENFORCEMENT_RULES.entryIsNode
        : ENFORCEMENT_RULES.depth,
    },
  ];
};

const combinationProblems = (
  operator: string,
  content: unknown,
  position: string,
  depth: number,
): readonly ValidationProblem[] => {
  const entries = listEntries(content);

  if (entries !== undefined && entries.length > 0) {
    const holdsIn = operator === 'and' && entries.some(isInClause);

    return entries.flatMap((entry, index) =>
      filterProblems(
        entry,
        `${position}.content[${index}]`,
        depth + 1,
        holdsIn,
      ),
    );
  }

  return [
    {
      position,
      rule: entries
        ? ENFORCEMENT_RULES.combinationNotEmpty
        : ENFORCEMENT_RULES.combinationContentIsList,
    },
  ];
};

// Exported so tests can reach refusals otherwise made first by `SqonSchema`, such as an entry that
// is not a node. The package root does not export it.
/**
 * The problems found in a narrowing's filter by the structural walk alone, without `SqonSchema`,
 * under the rules for filters that restrict access, positioned from `sqon`. It takes no snapshot:
 * `sqon` is read directly, so a getter in it runs and an error it throws is not caught.
 *
 * @internal
 */
export const walkProblems = (sqon: unknown): readonly ValidationProblem[] =>
  filterProblems(sqon, FILTER_POSITION, 0, false);

/**
 * Problems with a narrowing's filter. `SqonSchema` runs first and on its own, never composed into a
 * schema of this package, since `@overture-stack/sqon` depends on zod directly and its copy can
 * differ from any other; its issues are never passed on, since they can quote the filter. A filter
 * it accepts passes when the walk accepts it, or when `parseRecordNarrowing` reads it as a rendered
 * record narrowing, whose missing clauses and authored conditions would be refused by the walk; a
 * filter refused by both is reported with the walk's problems.
 */
const sqonProblems = (sqon: unknown): readonly ValidationProblem[] => {
  if (SqonSchema.safeParse(sqon).success) {
    const problems = walkProblems(sqon);

    return problems.length === 0 || parseRecordNarrowing(sqon).success
      ? []
      : problems;
  }

  return [{ position: FILTER_POSITION, rule: ENFORCEMENT_RULES.validSqon }];
};

const reasonProblems = (reason: unknown): readonly ValidationProblem[] =>
  brokenRules('reason', [
    [
      typeof reason === 'string' && DENY_REASONS.has(reason),
      ENFORCEMENT_RULES.denyReason,
    ],
  ]);

/**
 * The problems with an enforcement result under the rules of {@link validateEnforcement},
 * positioned from the result itself. Unlike that validator, it takes no snapshot: `value` is read
 * directly, so a getter in it runs and an error it throws is not caught. No problem quotes the
 * result, even when `SqonSchema` refuses its filter.
 */
export const enforcementProblems = (
  value: unknown,
): readonly ValidationProblem[] => {
  if (isPlainRecord(value)) {
    const kind = ownMember(value, 'kind');
    const members =
      typeof kind === 'string' ? ARM_MEMBERS.get(kind) : undefined;

    if (members) {
      return [
        ...brokenRules(ROOT_POSITION, [
          [hasOnlyMembers(value, members), ENFORCEMENT_RULES.armMembers],
        ]),
        ...(kind === 'deny' ? reasonProblems(ownMember(value, 'reason')) : []),
        ...(kind === 'narrow' ? sqonProblems(ownMember(value, 'sqon')) : []),
      ];
    }

    return [{ position: 'kind', rule: ENFORCEMENT_RULES.kind }];
  }

  return [{ position: ROOT_POSITION, rule: ENFORCEMENT_RULES.isMap }];
};

/**
 * Validates one enforcement result, never throwing, whatever `value` is. A `deny` carries only
 * `kind` and one of the reasons of {@link Enforcement}, a `narrow` only `kind` and `sqon`, and an
 * `allow` only `kind`. A narrowing's filter must pass `SqonSchema`, and then, at any depth:
 * - every combination holds at least one entry, and every entry is a SQON node carrying only `op`
 *   and `content`, never a `pivot`;
 * - every clause names its field by a non-empty `fieldName` and carries only `fieldName` and
 *   `value`;
 * - no clause is an exclusion of any kind or a wildcard pattern;
 * - every `in` or `all` lists at least one value, each a literal holding no marker read specially
 *   by Arranger;
 * - every range holds only usable bounds, each a finite number or a non-empty string, and every
 *   `between` holds two;
 * - every `not` sits in an `and` beside an `in` clause.
 *
 * Operators are read through `SQON_OP_ALIASES` first, so `!=` is an exclusion like `not-in` and `=`
 * is an `in`. A filter refused by those rules is accepted all the same when `parseRecordNarrowing`
 * reads it as a rendered record narrowing, and is otherwise refused with their problems.
 *
 * @param value an enforcement result, untrusted.
 * @returns a copy of the result's own data, typed, which is exactly what was checked, or every
 *   problem found, none naming content of the result.
 */
export const validateEnforcement = (
  value: unknown,
): EnforcementValidationResult => {
  const {
    problems: [firstProblem, ...otherProblems],
    snapshot,
  } = checkSnapshot(value, enforcementProblems);

  return firstProblem
    ? { problems: [firstProblem, ...otherProblems], success: false }
    : { enforcement: snapshot as Enforcement, success: true };
};
