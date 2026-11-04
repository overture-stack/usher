import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  NOTICE_RULES,
  POLL_ANSWER_RULES,
  validateNotice,
  validatePollAnswer,
} from './notice.js';
import {
  assertAccepted,
  assertCarriesNoInput,
  assertRefusedFor,
  LEAK_MARKER,
} from './testSupport.js';

const principal = {
  cursor: 'c-42',
  kind: 'principal',
  subjectTag: 'tag-ana',
  v: 1,
};
const category = {
  cursor: 'c-43',
  kind: 'category',
  resource: 'HEART_STUDY',
  v: 1,
};

/** Resources holding a marker Arranger reads specially, alone or inside a name. */
const MARKER_RESOURCES = [
  '*',
  'HEART_STUDY*',
  'set_id:HEART_STUDY',
  '__missing__',
  'HEART__missing__STUDY',
] as const;

const answerWith = (members: Record<string, unknown> = {}) => ({
  after: 'c-41',
  more: false,
  next: 'c-43',
  nonce: 'nonce-1',
  notices: [principal, category],
  v: 1,
  ...members,
});

suite('validateNotice', () => {
  for (const notice of [
    principal,
    category,
    { cursor: 'c-44', kind: 'baseline', v: 1 },
    { cursor: 'c-45', kind: 'global', v: 1 },
    { cursor: 'c-46', kind: 'servedResources', v: 1 },
  ]) {
    test(`accepts a ${notice.kind} notice`, () => {
      assertAccepted(validateNotice(notice));
    });
  }

  for (const [description, value, position, rule] of [
    ['a value that is not a map', 'notice', '(root)', NOTICE_RULES.isMap],
    ['another version', { ...principal, v: 2 }, 'v', NOTICE_RULES.version],
    [
      'an unknown kind',
      { ...principal, kind: 'refresh' },
      'kind',
      NOTICE_RULES.kind,
    ],
    [
      'a kind named like an inherited member',
      { ...principal, kind: 'constructor' },
      'kind',
      NOTICE_RULES.kind,
    ],
    [
      'an empty cursor',
      { ...principal, cursor: '' },
      'cursor',
      NOTICE_RULES.cursor,
    ],
    [
      'a principal notice without its tag',
      { cursor: 'c', kind: 'principal', v: 1 },
      'subjectTag',
      NOTICE_RULES.subjectTag,
    ],
    [
      'a category notice without its resource',
      { cursor: 'c', kind: 'category', v: 1 },
      'resource',
      NOTICE_RULES.resource,
    ],
    [
      'a category notice naming __proto__',
      JSON.parse(
        '{"cursor":"c","kind":"category","resource":"__proto__","v":1}',
      ),
      'resource',
      NOTICE_RULES.resource,
    ],
    [
      'a member its kind does not define',
      { ...category, subjectTag: 'tag-ana' },
      '(root)',
      NOTICE_RULES.members,
    ],
    [
      'a global notice naming a resource',
      { cursor: 'c', kind: 'global', resource: 'HEART_STUDY', v: 1 },
      '(root)',
      NOTICE_RULES.members,
    ],
    [
      'a servedResources notice naming a resource',
      { cursor: 'c', kind: 'servedResources', resource: 'HEART_STUDY', v: 1 },
      '(root)',
      NOTICE_RULES.members,
    ],
    [
      'a servedResources notice without its cursor',
      { kind: 'servedResources', v: 1 },
      'cursor',
      NOTICE_RULES.cursor,
    ],
    [
      'a servedResources notice of another version',
      { cursor: 'c', kind: 'servedResources', v: 2 },
      'v',
      NOTICE_RULES.version,
    ],
  ] as const) {
    test(`refuses ${description}`, () => {
      assertRefusedFor(validateNotice(value), position, rule);
    });
  }

  test('names every kind it accepts in its kind rule', () => {
    assert.equal(
      NOTICE_RULES.kind,
      'kind is principal, category, baseline, global or servedResources',
    );
  });

  for (const resource of MARKER_RESOURCES) {
    test(`refuses a category notice naming ${JSON.stringify(resource)}, since it holds a marker read specially by Arranger`, () => {
      const notice = { ...category, resource };

      const result = validateNotice(notice);

      assertRefusedFor(result, 'resource', NOTICE_RULES.resource);
    });
  }

  test('names no content of the notice in its problems', () => {
    const result = validateNotice({
      cursor: '',
      kind: 'principal',
      [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_value`,
      subjectTag: `${LEAK_MARKER}_tag`,
      v: 1,
    });

    assertCarriesNoInput(result);
  });

  test('refuses a resource holding a marker without naming it in its problems', () => {
    const result = validateNotice({
      ...category,
      resource: `set_id:${LEAK_MARKER}_resource*`,
    });

    assertRefusedFor(result, 'resource', NOTICE_RULES.resource);
    assertCarriesNoInput(result);
  });
});

suite('validatePollAnswer', () => {
  test('accepts an answer carrying notices', () => {
    assertAccepted(validatePollAnswer(answerWith()));
  });

  test('accepts an answer from head carrying none', () => {
    assertAccepted(
      validatePollAnswer(answerWith({ after: 'head', notices: [] })),
    );
  });

  for (const [description, value, position, rule] of [
    ['a value that is not a map', [], '(root)', POLL_ANSWER_RULES.isMap],
    ['another version', answerWith({ v: 2 }), 'v', POLL_ANSWER_RULES.version],
    [
      'an empty nonce',
      answerWith({ nonce: '' }),
      'nonce',
      POLL_ANSWER_RULES.nonce,
    ],
    [
      'a missing after',
      answerWith({ after: undefined }),
      'after',
      POLL_ANSWER_RULES.after,
    ],
    ['an empty next', answerWith({ next: '' }), 'next', POLL_ANSWER_RULES.next],
    [
      'more as a string',
      answerWith({ more: 'false' }),
      'more',
      POLL_ANSWER_RULES.more,
    ],
    [
      'notices that are not a list',
      answerWith({ notices: {} }),
      'notices',
      POLL_ANSWER_RULES.notices,
    ],
    [
      'a member beyond the six',
      answerWith({ head: 'c-50' }),
      '(root)',
      POLL_ANSWER_RULES.members,
    ],
    [
      'a notice that breaks its rules',
      answerWith({ notices: [{ ...principal, cursor: '' }] }),
      'notices[0].cursor',
      NOTICE_RULES.cursor,
    ],
    [
      'a later notice that breaks its rules, positioned by its index',
      answerWith({ notices: [principal, category, { ...principal, v: 2 }] }),
      'notices[2].v',
      NOTICE_RULES.version,
    ],
    [
      'a notice that is not a map, positioned by its index',
      answerWith({ notices: [principal, 'notice'] }),
      'notices[1]',
      NOTICE_RULES.isMap,
    ],
  ] as const) {
    test(`refuses ${description}`, () => {
      assertRefusedFor(validatePollAnswer(value), position, rule);
    });
  }

  test('names no content of the answer in its problems', () => {
    const result = validatePollAnswer(
      answerWith({
        nonce: '',
        notices: [
          {
            cursor: `${LEAK_MARKER}_cursor`,
            kind: `${LEAK_MARKER}_kind`,
            v: 1,
          },
        ],
      }),
    );

    assertCarriesNoInput(result);
  });
});
