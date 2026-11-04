import {
  type CategoryCondition,
  categoryConditionProblems,
  fieldNamesReadBy,
} from './categoryCondition.js';
import type { NonEmpty, ResourceIdentifier } from './payload.js';
import {
  hasOnlyMembers,
  isNonEmptyString,
  isPlainRecord,
  listEntries,
  ownMember,
  plainSnapshot,
} from './plainData.js';
import { READ_RULE, type ValidationProblem } from './problems.js';
import { isUsableResource } from './sqonPrimitives.js';

/** One exclusion of a rendered record narrowing. */
export interface ParsedExclusion {
  /** The category's condition, as held in the filter. */
  condition: CategoryCondition;

  /** The held resources whose records carrying the category are withheld. */
  lacking: NonEmpty<ResourceIdentifier>;
}

/** A resource's own category condition, as scoped to that resource in the unmarked clause. */
export interface ParsedScopedCondition {
  condition: CategoryCondition;
  resource: ResourceIdentifier;
}

/** The unmarked clause of a rendered record narrowing. */
export interface ParsedUnmarked {
  /** The condition of every global category tested in the clause, as held in the filter. */
  globalConditions: readonly CategoryCondition[];

  /** The held resources whose unmarked records are withheld. */
  lacking: NonEmpty<ResourceIdentifier>;

  /** Each lacking resource's own category conditions, beside the resource each belongs to. */
  scopedConditions: readonly ParsedScopedCondition[];
}

/**
 * What a rendered record narrowing says, as read by {@link parseRecordNarrowing}. Missing clauses
 * are dropped, since they follow from the conditions.
 */
export interface ParsedRecordNarrowing {
  /** The known resources not held, whose records are withheld; empty when the filter has none. */
  complement: readonly ResourceIdentifier[];

  exclusions: readonly ParsedExclusion[];

  held: NonEmpty<ResourceIdentifier>;

  resourceFieldName: string;

  /** Absent when every held resource holds its unmarked records. */
  unmarked?: ParsedUnmarked;
}

/**
 * The result of {@link parseRecordNarrowing}: what the filter says, when it is a rendered record
 * narrowing, and otherwise every problem found, each value-free.
 */
export type RecordNarrowingParseResult =
  | { narrowing: ParsedRecordNarrowing; success: true }
  | { problems: NonEmpty<ValidationProblem>; success: false };

/** The wording of every rule held by {@link parseRecordNarrowing}, keyed by a stable name. */
export const RENDERED_NARROWING_RULES = {
  complement:
    'the complement is an in on the resource field listing distinct usable literal identifiers, at least one, none of them held',
  conditions:
    'every authored condition holds to the grammar of a category condition',
  everyCategorized:
    "the test that each lacking resource carries one of its own categories is an and of at most one not around an in on the resource field and at least one or holding a resource's own test, together naming every lacking resource exactly once",
  exclusion:
    "an exclusion's or holds exactly one authored condition and one missing clause for each field read by that condition, and nothing else",
  heldTest:
    'the first member is an in on a non-empty resource field name listing the held resources, at least one, each a distinct usable literal identifier',
  lackingList:
    'a lacking list is an in on the resource field listing distinct held resources, at least one',
  memberKind:
    'every member after the held test is a not around the complement, an exclusion or the unmarked clause',
  memberOrder:
    'the complement comes before every exclusion and the unmarked clause after them, each at most once',
  missingClause:
    'a missing clause is an in on a field other than the resource field, listing __missing__ alone',
  resourceFieldUnread: 'no authored condition reads the resource field',
  root: 'a rendered narrowing is an and holding the held test first',
  scopedTest:
    "a resource's own test is an or of one not around an in naming that resource alone, at least one authored condition, and one missing clause for each field read by those conditions",
  structuralNode:
    'every node placed by the rendering carries only op and content, and every in placed by it carries only fieldName and value',
  unmarked:
    'the unmarked clause negates an or holding at least one member: authored global conditions, one missing clause for each field they read, and at most one test that each lacking resource carries one of its own categories',
} as const;

const FILTER_POSITION = 'sqon';

const MISSING_MARKER = '__missing__';

const NODE_MEMBERS: ReadonlySet<string> = new Set(['content', 'op']);

const CLAUSE_MEMBERS: ReadonlySet<string> = new Set(['fieldName', 'value']);

/**
 * A part of the form, read, or the rules it breaks: at least one, so no refusal goes unreported.
 */
type Parsed<Value> =
  { rules: NonEmpty<string>; success: false } | { success: true; value: Value };

/** What every member after the held test is read against. */
interface Context {
  fieldName: string;
  held: ReadonlySet<unknown>;
}

/** The held test, read; `listed` keeps the held resources in the order given. */
interface HeldTest extends Context {
  listed: NonEmpty<ResourceIdentifier>;
}

/** An `in`, as placed by the rendering. */
interface InTest {
  fieldName: unknown;

  /**
   * Whether the node carries only `op` and `content`, and its content only `fieldName` and
   * `value`.
   */
  structural: boolean;

  values: readonly unknown[] | undefined;
}

/** Authored conditions read together: those holding to the grammar, and the fields they read. */
interface CheckedConditions {
  /** Whether every candidate holds to the grammar. */
  allAuthored: boolean;

  conditions: readonly CategoryCondition[];
  fieldNames: readonly string[];
  rules: readonly string[];
}

type MemberKind = 'complement' | 'exclusion' | 'unmarked';

type ParsedMember =
  | { complement: readonly ResourceIdentifier[]; kind: 'complement' }
  | { exclusion: ParsedExclusion; kind: 'exclusion' }
  | { kind: 'unmarked'; unmarked: ParsedUnmarked };

/** The rank of each kind, in the order required of members. */
const KIND_RANKS: Readonly<Record<MemberKind, number>> = {
  complement: 0,
  exclusion: 1,
  unmarked: 2,
};

/**
 * A refusal for `rules`, or for `fallback` when they are empty, which no input reaches: a value
 * failing to be read without a rule to name is refused all the same.
 */
const refusedWith = (
  rules: readonly string[],
  fallback: string,
): Parsed<never> => {
  const [first, ...others] = rules;

  return {
    rules: first === undefined ? [fallback] : [first, ...others],
    success: false,
  };
};

const rulesOf = (parsed: Parsed<unknown>): readonly string[] =>
  parsed.success ? [] : parsed.rules;

const brokenOf = (
  rules: readonly (readonly [holds: boolean, rule: string])[],
): readonly string[] =>
  rules.filter(([holds]) => !holds).map(([, rule]) => rule);

const hasNoRepeats = (values: readonly unknown[]): boolean =>
  new Set(values).size === values.length;

const nonEmptyOf = <Value>(
  values: readonly Value[],
): NonEmpty<Value> | undefined => {
  const [first, ...others] = values;

  return first === undefined ? undefined : [first, ...others];
};

const isNodeOf = (
  node: unknown,
  op: string,
): node is Readonly<Record<string, unknown>> =>
  isPlainRecord(node) && ownMember(node, 'op') === op;

const entriesOf = (
  node: unknown,
  op: string,
): readonly unknown[] | undefined =>
  isNodeOf(node, op) ? listEntries(ownMember(node, 'content')) : undefined;

const hasNodeMembers = (node: unknown): boolean =>
  isPlainRecord(node) && hasOnlyMembers(node, NODE_MEMBERS);

const inTestOf = (node: unknown): InTest | undefined => {
  const content = isNodeOf(node, 'in') ? ownMember(node, 'content') : undefined;

  return isPlainRecord(content)
    ? {
        fieldName: ownMember(content, 'fieldName'),
        structural:
          hasNodeMembers(node) && hasOnlyMembers(content, CLAUSE_MEMBERS),
        values: listEntries(ownMember(content, 'value')),
      }
    : undefined;
};

const isMissingClause = (node: unknown): boolean => {
  const [only, ...others] = inTestOf(node)?.values ?? [];

  return only === MISSING_MARKER && others.length === 0;
};

const missingFieldName = (node: unknown): unknown => inTestOf(node)?.fieldName;

/** Whether `node` is a `not` around an `in` on the resource field, as a scoping test is. */
const testsResourceField = (node: unknown, fieldName: string): boolean =>
  (entriesOf(node, 'not') ?? []).some(
    (entry) => inTestOf(entry)?.fieldName === fieldName,
  );

/**
 * Whether a member of the unmarked clause's `or` is the test that each lacking resource carries one
 * of its own categories, told from an authored condition by the scoping tests it holds, since no
 * authored condition reads the resource field.
 */
const isCategorizedTest = (node: unknown, fieldName: string): boolean =>
  (entriesOf(node, 'and') ?? []).some(
    (entry) =>
      testsResourceField(entry, fieldName) ||
      (entriesOf(entry, 'or') ?? []).some((member) =>
        testsResourceField(member, fieldName),
      ),
  );

/** Whether `listed` holds each of `required` exactly once and nothing else. */
const coversExactly = (
  listed: readonly unknown[],
  required: readonly unknown[],
): boolean => {
  const listedSet: ReadonlySet<unknown> = new Set(listed);

  return (
    hasNoRepeats(listed) &&
    listedSet.size === new Set(required).size &&
    required.every((value) => listedSet.has(value))
  );
};

const isDistinctResourceList = (
  values: readonly unknown[] | undefined,
): values is readonly string[] =>
  values !== undefined &&
  values.length > 0 &&
  values.every(isUsableResource) &&
  hasNoRepeats(values);

/** Whether a condition holds to the authored grammar, which makes it a SQON node. */
const isAuthoredCondition = (
  condition: unknown,
): condition is CategoryCondition =>
  categoryConditionProblems(condition, 'condition').length === 0;

const checkConditions = (
  candidates: readonly unknown[],
  { fieldName }: Context,
): CheckedConditions => {
  const conditions = candidates.filter(isAuthoredCondition);
  const fieldNames = conditions.flatMap(fieldNamesReadBy);
  const allAuthored = conditions.length === candidates.length;

  return {
    allAuthored,
    conditions,
    fieldNames,
    rules: brokenOf([
      [allAuthored, RENDERED_NARROWING_RULES.conditions],
      [
        !fieldNames.includes(fieldName),
        RENDERED_NARROWING_RULES.resourceFieldUnread,
      ],
    ]),
  };
};

/**
 * Whether the missing clauses cover exactly the fields read by the conditions, judged only once
 * every condition holds to the grammar, since the fields of any other are unknown.
 */
const coversConditions = (
  missingClauses: readonly unknown[],
  checked: CheckedConditions,
): boolean =>
  checked.allAuthored
    ? coversExactly(missingClauses.map(missingFieldName), checked.fieldNames)
    : true;

const missingClauseRules = (
  missingClauses: readonly unknown[],
  { fieldName }: Context,
): readonly string[] =>
  brokenOf([
    [
      missingClauses.every((clause) => inTestOf(clause)?.structural === true),
      RENDERED_NARROWING_RULES.structuralNode,
    ],
    [
      missingClauses.every((clause) => {
        const clauseField = missingFieldName(clause);

        return isNonEmptyString(clauseField) && clauseField !== fieldName;
      }),
      RENDERED_NARROWING_RULES.missingClause,
    ],
  ]);

const parseHeldTest = (node: unknown): Parsed<HeldTest> => {
  const test = inTestOf(node);
  const fieldName = test?.fieldName;
  const values = test?.values;
  const listed = isDistinctResourceList(values)
    ? nonEmptyOf(values)
    : undefined;
  const rules = brokenOf([
    [
      test === undefined || test.structural,
      RENDERED_NARROWING_RULES.structuralNode,
    ],
    [
      isNonEmptyString(fieldName) && listed !== undefined,
      RENDERED_NARROWING_RULES.heldTest,
    ],
  ]);

  return rules.length === 0 && isNonEmptyString(fieldName) && listed
    ? { success: true, value: { fieldName, held: new Set(listed), listed } }
    : refusedWith(rules, RENDERED_NARROWING_RULES.heldTest);
};

const parseLackingList = (
  node: unknown,
  { fieldName, held }: Context,
): Parsed<NonEmpty<ResourceIdentifier>> => {
  const test = inTestOf(node);
  const values = test?.values;
  const lacking =
    test?.fieldName === fieldName &&
    isDistinctResourceList(values) &&
    values.every((resource) => held.has(resource))
      ? nonEmptyOf(values)
      : undefined;
  const rules = brokenOf([
    [
      test === undefined || test.structural,
      RENDERED_NARROWING_RULES.structuralNode,
    ],
    [lacking !== undefined, RENDERED_NARROWING_RULES.lackingList],
  ]);

  return rules.length === 0 && lacking
    ? { success: true, value: lacking }
    : refusedWith(rules, RENDERED_NARROWING_RULES.lackingList);
};

const parseComplement = (
  node: unknown,
  { fieldName, held }: Context,
): Parsed<ParsedMember> => {
  const test = inTestOf(node);
  const values = test?.values;
  const complement =
    test?.fieldName === fieldName &&
    isDistinctResourceList(values) &&
    values.every((resource) => !held.has(resource))
      ? values
      : undefined;
  const rules = brokenOf([
    [test?.structural === true, RENDERED_NARROWING_RULES.structuralNode],
    [complement !== undefined, RENDERED_NARROWING_RULES.complement],
  ]);

  return rules.length === 0 && complement
    ? { success: true, value: { complement, kind: 'complement' } }
    : refusedWith(rules, RENDERED_NARROWING_RULES.complement);
};

const parseExclusion = (
  node: unknown,
  context: Context,
): Parsed<ParsedMember> => {
  const [lackingNode, orNode] = entriesOf(node, 'and') ?? [];
  const lacking = parseLackingList(lackingNode, context);
  const members = entriesOf(orNode, 'or') ?? [];
  const missingClauses = members.filter(isMissingClause);
  const candidates = members.filter((member) => !isMissingClause(member));
  const checked = checkConditions(candidates, context);
  const [condition, ...otherConditions] = checked.conditions;
  const rules = [
    ...brokenOf([
      [
        hasNodeMembers(node) && hasNodeMembers(orNode),
        RENDERED_NARROWING_RULES.structuralNode,
      ],
      [
        candidates.length === 1 && coversConditions(missingClauses, checked),
        RENDERED_NARROWING_RULES.exclusion,
      ],
    ]),
    ...rulesOf(lacking),
    ...missingClauseRules(missingClauses, context),
    ...checked.rules,
  ];

  return rules.length === 0 &&
    lacking.success &&
    condition !== undefined &&
    otherConditions.length === 0
    ? {
        success: true,
        value: {
          exclusion: { condition, lacking: lacking.value },
          kind: 'exclusion',
        },
      }
    : refusedWith(rules, RENDERED_NARROWING_RULES.exclusion);
};

/**
 * One lacking resource's own test: an `or` of a `not` around an `in` naming it, its conditions and
 * their missing clauses.
 */
const parseScopedTest = (
  node: unknown,
  context: Context,
): Parsed<{ resource: string; scoped: readonly ParsedScopedCondition[] }> => {
  const members = entriesOf(node, 'or') ?? [];
  const isScope = (member: unknown): boolean =>
    testsResourceField(member, context.fieldName);
  const [scope, ...otherScopes] = members.filter(isScope);
  const missingClauses = members.filter(isMissingClause);
  const candidates = members.filter(
    (member) => !isScope(member) && !isMissingClause(member),
  );
  const checked = checkConditions(candidates, context);
  const [scopeTest, ...otherTests] = entriesOf(scope, 'not') ?? [];
  const test = inTestOf(scopeTest);
  const [resource, ...otherResources] = test?.values ?? [];
  const rules = [
    ...brokenOf([
      [
        hasNodeMembers(node) &&
          hasNodeMembers(scope) &&
          test?.structural === true,
        RENDERED_NARROWING_RULES.structuralNode,
      ],
      [
        otherScopes.length === 0 &&
          otherTests.length === 0 &&
          isUsableResource(resource) &&
          otherResources.length === 0 &&
          candidates.length > 0 &&
          coversConditions(missingClauses, checked),
        RENDERED_NARROWING_RULES.scopedTest,
      ],
    ]),
    ...missingClauseRules(missingClauses, context),
    ...checked.rules,
  ];

  return rules.length === 0 && isUsableResource(resource)
    ? {
        success: true,
        value: {
          resource,
          scoped: checked.conditions.map((condition) => ({
            condition,
            resource,
          })),
        },
      }
    : refusedWith(rules, RENDERED_NARROWING_RULES.scopedTest);
};

/**
 * The resources named by a `not` around an `in` on the resource field, or none for any other node.
 */
const unscopedResources = (
  node: unknown,
  { fieldName }: Context,
): readonly unknown[] | undefined => {
  const [only, ...others] = entriesOf(node, 'not') ?? [];
  const test = inTestOf(only);
  const values = test?.values;

  return others.length === 0 &&
    hasNodeMembers(node) &&
    test?.structural === true &&
    test.fieldName === fieldName &&
    values !== undefined &&
    values.length > 0
    ? values
    : undefined;
};

/**
 * The test that each lacking resource carries one of its own categories: at most one `not` around
 * an `in` naming the lacking resources defining none, and one scoped test for each other one,
 * together naming every lacking resource once.
 */
const parseCategorizedTest = (
  node: unknown,
  context: Context,
  lacking: readonly string[],
): Parsed<readonly ParsedScopedCondition[]> => {
  const members = entriesOf(node, 'and') ?? [];
  const uncategorizedTests = members.filter((member) =>
    isNodeOf(member, 'not'),
  );
  const scopedTests = members
    .filter((member) => isNodeOf(member, 'or'))
    .map((member) => parseScopedTest(member, context));
  const named = [
    ...uncategorizedTests.flatMap(
      (member) => unscopedResources(member, context) ?? [],
    ),
    ...scopedTests.flatMap((scoped) =>
      scoped.success ? [scoped.value.resource] : [],
    ),
  ];
  const rules = [
    ...brokenOf([
      [hasNodeMembers(node), RENDERED_NARROWING_RULES.structuralNode],
      [
        uncategorizedTests.length + scopedTests.length === members.length &&
          uncategorizedTests.length <= 1 &&
          uncategorizedTests.every(
            (member) => unscopedResources(member, context) !== undefined,
          ) &&
          scopedTests.length > 0 &&
          coversExactly(named, lacking),
        RENDERED_NARROWING_RULES.everyCategorized,
      ],
    ]),
    ...scopedTests.flatMap(rulesOf),
  ];

  return rules.length === 0
    ? {
        success: true,
        value: scopedTests.flatMap((scoped) =>
          scoped.success ? scoped.value.scoped : [],
        ),
      }
    : refusedWith(rules, RENDERED_NARROWING_RULES.everyCategorized);
};

const parseUnmarked = (
  node: unknown,
  context: Context,
): Parsed<ParsedMember> => {
  const [lackingNode, negation] = entriesOf(node, 'and') ?? [];
  const lacking = parseLackingList(lackingNode, context);
  const [orNode, ...othersNegated] = entriesOf(negation, 'not') ?? [];
  const members = entriesOf(orNode, 'or') ?? [];
  const isCategorized = (member: unknown): boolean =>
    isCategorizedTest(member, context.fieldName);
  const missingClauses = members.filter(isMissingClause);
  const checked = checkConditions(
    members.filter(
      (member) => !isCategorized(member) && !isMissingClause(member),
    ),
    context,
  );
  const [categorizedNode, ...otherCategorized] = members.filter(isCategorized);
  const categorized =
    categorizedNode === undefined
      ? undefined
      : parseCategorizedTest(
          categorizedNode,
          context,
          lacking.success ? lacking.value : [],
        );
  const rules = [
    ...brokenOf([
      [
        hasNodeMembers(node) &&
          hasNodeMembers(negation) &&
          hasNodeMembers(orNode),
        RENDERED_NARROWING_RULES.structuralNode,
      ],
      [
        othersNegated.length === 0 &&
          members.length > 0 &&
          otherCategorized.length === 0 &&
          coversConditions(missingClauses, checked),
        RENDERED_NARROWING_RULES.unmarked,
      ],
    ]),
    ...rulesOf(lacking),
    ...missingClauseRules(missingClauses, context),
    ...checked.rules,
    ...(categorized ? rulesOf(categorized) : []),
  ];

  return rules.length === 0 && lacking.success
    ? {
        success: true,
        value: {
          kind: 'unmarked',
          unmarked: {
            globalConditions: checked.conditions,
            lacking: lacking.value,
            scopedConditions: categorized?.success ? categorized.value : [],
          },
        },
      }
    : refusedWith(rules, RENDERED_NARROWING_RULES.unmarked);
};

/**
 * The kind of a member after the held test, told by shape alone: a `not` around an `in` is the
 * complement, and a `not` around an `and` of two members is an exclusion when the second is an `or`
 * and the unmarked clause when it is a `not`.
 */
const kindOf = (member: unknown): MemberKind | undefined => {
  const [child, ...others] = entriesOf(member, 'not') ?? [];
  const pair = entriesOf(child, 'and') ?? [];
  const [, second] = pair;

  if (child === undefined || others.length > 0) {
    return undefined;
  }

  if (inTestOf(child)) {
    return 'complement';
  }

  if (pair.length === 2) {
    return isNodeOf(second, 'or')
      ? 'exclusion'
      : isNodeOf(second, 'not')
        ? 'unmarked'
        : undefined;
  }

  return undefined;
};

const MEMBER_PARSERS: Readonly<
  Record<MemberKind, (node: unknown, context: Context) => Parsed<ParsedMember>>
> = {
  complement: parseComplement,
  exclusion: parseExclusion,
  unmarked: parseUnmarked,
};

const parseMember = (
  member: unknown,
  kind: MemberKind | undefined,
  context: Context,
): Parsed<ParsedMember> => {
  if (kind) {
    const [child] = entriesOf(member, 'not') ?? [];
    const parsed = MEMBER_PARSERS[kind](child, context);

    return hasNodeMembers(member)
      ? parsed
      : refusedWith(
          [RENDERED_NARROWING_RULES.structuralNode, ...rulesOf(parsed)],
          RENDERED_NARROWING_RULES.structuralNode,
        );
  }

  return refusedWith([], RENDERED_NARROWING_RULES.memberKind);
};

/**
 * Whether a member of `kind` keeps the order of kinds, given the kinds of the members before it.
 */
const isInOrder = (
  kind: MemberKind | undefined,
  earlier: readonly (MemberKind | undefined)[],
): boolean =>
  kind === undefined ||
  earlier.every(
    (previous) =>
      previous === undefined ||
      KIND_RANKS[previous] < KIND_RANKS[kind] ||
      (previous === kind && kind === 'exclusion'),
  );

const memberPosition = (index: number): string =>
  `${FILTER_POSITION}.content[${index}]`;

const problemsFor = (
  position: string,
  rules: readonly string[],
): readonly ValidationProblem[] =>
  Array.from(new Set(rules), (rule) => ({ position, rule }));

const refusalOf = (
  problems: readonly ValidationProblem[],
): RecordNarrowingParseResult | undefined => {
  const [first, ...others] = problems;

  return first === undefined
    ? undefined
    : { problems: [first, ...others], success: false };
};

const assembled = (
  held: NonEmpty<ResourceIdentifier>,
  resourceFieldName: string,
  members: readonly ParsedMember[],
): ParsedRecordNarrowing => {
  const [unmarked] = members.flatMap((member) =>
    member.kind === 'unmarked' ? [member.unmarked] : [],
  );

  return {
    complement: members.flatMap((member) =>
      member.kind === 'complement' ? member.complement : [],
    ),
    exclusions: members.flatMap((member) =>
      member.kind === 'exclusion' ? [member.exclusion] : [],
    ),
    held,
    resourceFieldName,
    ...(unmarked ? { unmarked } : {}),
  };
};

const parsedMembers = (
  members: readonly unknown[],
  heldTest: HeldTest,
): RecordNarrowingParseResult => {
  const { fieldName, held, listed } = heldTest;
  const context: Context = { fieldName, held };
  const kinds = members.map(kindOf);
  const parsed = members.map((member, index) =>
    parseMember(member, kinds[index], context),
  );
  const refusal = refusalOf(
    parsed.flatMap((member, index) =>
      problemsFor(memberPosition(index + 1), [
        ...rulesOf(member),
        ...brokenOf([
          [
            isInOrder(kinds[index], kinds.slice(0, index)),
            RENDERED_NARROWING_RULES.memberOrder,
          ],
        ]),
      ]),
    ),
  );

  return (
    refusal ?? {
      narrowing: assembled(
        listed,
        fieldName,
        parsed.flatMap((member) => (member.success ? [member.value] : [])),
      ),
      success: true,
    }
  );
};

const parsedSnapshot = (sqon: unknown): RecordNarrowingParseResult => {
  const [heldNode, ...members] = entriesOf(sqon, 'and') ?? [];
  const rootRefusal = refusalOf(
    problemsFor(
      FILTER_POSITION,
      brokenOf([
        [heldNode !== undefined, RENDERED_NARROWING_RULES.root],
        [
          isPlainRecord(sqon) ? hasNodeMembers(sqon) : true,
          RENDERED_NARROWING_RULES.structuralNode,
        ],
      ]),
    ),
  );

  if (rootRefusal) {
    return rootRefusal;
  }

  const heldTest = parseHeldTest(heldNode);

  if (heldTest.success) {
    return parsedMembers(members, heldTest.value);
  }

  const [firstRule, ...otherRules] = heldTest.rules;
  const position = memberPosition(0);

  return {
    problems: [
      { position, rule: firstRule },
      ...otherRules.map((rule) => ({ position, rule })),
    ],
    success: false,
  };
};

/**
 * Reads a filter as a rendered record narrowing, the form rendered by `canonicalRecordNarrowing`,
 * and returns what it says. It accepts exactly that form: an `and` holding these members, in this
 * order of kinds, told apart by shape:
 *
 * - first, the held test: an `in` on the resource field listing the held resources;
 * - at most one complement: a `not` around an `in` on that field listing resources, none of them
 *   held;
 * - any number of exclusions, each a `not` around an `and` of a lacking list and an `or` of one
 *   authored condition and a missing clause for each field it reads;
 * - at most one unmarked clause, last: a `not` around an `and` of a lacking list and a `not` around
 *   an `or` of authored global conditions, a missing clause for each field they read, and at most
 *   one categorized test.
 *
 * Within that form:
 *
 * - a lacking list is an `in` on the resource field listing held resources;
 * - the categorized test, that each lacking resource carries one of its own categories, is an `and`
 *   of at most one `not` around an `in` naming the lacking resources defining none, and an `or` for
 *   each other lacking resource, of a `not` around an `in` naming it alone, its own conditions and
 *   their missing clauses, naming every lacking resource once between them;
 * - every authored condition holds to the grammar checked by `validateCategoryCondition`, and reads
 *   no resource field;
 * - a missing clause, an `in` listing `__missing__` alone on another field, is the only place
 *   admitting that marker;
 * - every node placed by the form carries only `op` and `content`, its operator spelled
 *   canonically.
 *
 * Order within lists and among exclusions is not checked. Never throws, whatever `sqon` is.
 *
 * @returns what the filter says, its authored conditions copied as given and its missing clauses
 *   dropped, or every problem found, positioned at the root or at the member of the root holding
 *   it, none naming content of the filter.
 */
export const parseRecordNarrowing = (
  sqon: unknown,
): RecordNarrowingParseResult => {
  try {
    return parsedSnapshot(plainSnapshot(sqon));
  } catch {
    return {
      problems: [{ position: FILTER_POSITION, rule: READ_RULE }],
      success: false,
    };
  }
};
