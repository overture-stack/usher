import { randomUUID } from 'node:crypto';

import type {
  CategoryName,
  ResourceIdentifier,
} from '@overture-stack/usher-types';

import type { Clock } from './clocks.js';

/**
 * A host's structured logger; Pino satisfies it. Anything a call throws is caught: the event it was
 * handed is dropped from the audit trail, and the drop is reported nowhere.
 */
export interface BridgeLogger {
  error(object: object, message: string): void;
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
}

/**
 * The bridge's mode, derived from the revocation channel's checks and the anonymous payload:
 *
 * - `cold` from start until an anonymous payload has been accepted and a check recorded, and again
 *   once the grace period has lapsed with no anonymous payload held;
 * - `normal` while the latest recorded check started within the grace period;
 * - `uncertain` once the grace period has lapsed while an anonymous payload is held.
 */
export type BridgeMode = 'cold' | 'normal' | 'uncertain';

/** Where inside the bridge an unexpected failure happened. */
export const INTERNAL_ERROR_STAGES = [
  'attach',
  'extract',
  'refreshAnonymous',
  'resolve',
] as const;

/** Each rule named by a refusal to start, as a fixed code rather than a configured value. */
export const START_REFUSAL_REASONS = [
  'audienceEmpty',
  'audienceInUse',
  'clockInvalid',
  'controllerUrlInsecure',
  'controllerUrlInvalid',
  'eventSourceEmpty',
  'failureHoldOutOfBounds',
  'intervalsOutOfOrder',
  'issuerEmpty',
  'keyUnusable',
  'loggerInvalid',
  'notRegistered',
  'numberOutOfRange',
  'payloadVersionsInvalid',
  'payloadVersionUnreadable',
  'refusalToleranceInvalid',
  'startDefect',
] as const;

/** Why the mode changed. */
export const MODE_CHANGE_REASONS = [
  'anonymousPayloadAccepted',
  'anonymousPayloadMissing',
  'checkConfirmed',
  'gracePeriodLapsed',
  'probableAudienceMismatch',
  'probableKeyMismatch',
] as const;

/** Where reading an Usher token failed, as a fixed reason code. */
export const TOKEN_REJECTION_REASONS = [
  'algorithmNotAllowed',
  'audienceRejected',
  'claimRejected',
  'claimsNotObject',
  'decryptionFailed',
  'expired',
  'headerKeyId',
  'headerMember',
  'headerType',
  'headerUnreadable',
  'headerUnsupported',
  'payloadMalformed',
  'payloadVersionUnlisted',
  'subjectMismatch',
  'tokenMalformed',
  'tokenTooLarge',
  'unexpected',
] as const;

const BRIDGE_MODES = ['cold', 'normal', 'uncertain'] as const;
const CHANNEL_FAILURE_CAUSES = [
  'defect',
  'network',
  'status',
  'timeout',
] as const;
const EXCHANGE_FAILURE_CAUSES = [
  'assertionRefused',
  'network',
  'overloaded',
  'status',
  'timeout',
] as const;
const MALFORMED_CREDENTIAL_REASONS = ['multiple', 'query', 'scheme'] as const;
const NOTICE_KINDS = [
  'baseline',
  'category',
  'global',
  'principal',
  'servedResources',
] as const;
const OVERTAKEN_OUTCOMES = [
  'abandoned',
  'exchangedAgain',
  'servedOpenTier',
] as const;
const REFUSAL_ORIGINS = ['cachedRefusal', 'controller', 'localExpiry'] as const;
const UNENFORCED_ENTRIES = ['fieldPartition'] as const;
const MALFORMED_CHANNEL_REASONS = [
  'answerUnreadable',
  'cursorRepeated',
  'echoMismatch',
  'idMismatch',
  'noticeUnreadable',
  'parserOverflow',
  'streamMissing',
  'versionsRefused',
  'versionUnlisted',
] as const;
const PUSH_RECONNECT_REASONS = ['idleTimeout'] as const;

type OneOf<Values extends readonly string[]> = Values[number];

/** The fields carried by each event, keyed by the event's name. */
export interface BridgeEventData {
  'bridge.internalError': { stage: OneOf<typeof INTERNAL_ERROR_STAGES> };
  'bridge.startRefusal': { reason: OneOf<typeof START_REFUSAL_REASONS> };
  'catalogue.filterLimit': {
    catalogue: string;

    /** The configured limit, never a count of the principal's grants or categories. */
    filterClauseLimit: number;
  };
  'catalogue.renderingMismatch': { catalogue: string };

  /**
   * Logged once for each record key registered with an empty resource list, which denies every
   * request to the key.
   */
  'catalogue.resourceListMissing': { catalogue: string };
  'category.unenforced': {
    category: CategoryName;
    entry: OneOf<typeof UNENFORCED_ENTRIES>;
    payloadVersion: number;
    reason: 'notImplemented';
    resourceId: ResourceIdentifier;
    userId: string | null;
  };
  'category.unknown': {
    catalogue: string;
    category: CategoryName;

    /** The resource a resource category is defined under; absent for a global one. */
    resourceId?: ResourceIdentifier;
  };
  'category.unmapped': {
    catalogue: string;
    category: CategoryName;

    /**
     * The resource withheld, for a resource category; absent for a global one, which denies the
     * whole catalogue.
     */
    resourceId?: ResourceIdentifier;
  };
  'credential.malformed': {
    reason: OneOf<typeof MALFORMED_CREDENTIAL_REASONS>;
  };
  'credential.refusal': { origin: OneOf<typeof REFUSAL_ORIGINS> };
  'notice.applied': {
    entriesDropped: number;
    kind: OneOf<typeof NOTICE_KINDS>;
  };
  'revocationChannel.failure': {
    cause: OneOf<typeof CHANNEL_FAILURE_CAUSES>;

    /** How many failures of this cause were counted in the interval, or, at a stop, so far. */
    count: number;
  };
  'revocationChannel.malformed': {
    reason: OneOf<typeof MALFORMED_CHANNEL_REASONS>;
  };
  'revocationChannel.modeChange': {
    fromMode: BridgeMode;
    reason: OneOf<typeof MODE_CHANGE_REASONS>;
    toMode: BridgeMode;
  };
  'revocationChannel.pushReconnect': {
    reason: OneOf<typeof PUSH_RECONNECT_REASONS>;
  };
  'revocationChannel.reset': Record<string, never>;
  'token.exchangeFailure':
    | { cause: Exclude<OneOf<typeof EXCHANGE_FAILURE_CAUSES>, 'overloaded'> }
    | { cause: 'overloaded'; count: number };
  'token.overtaken': { outcome: OneOf<typeof OVERTAKEN_OUTCOMES> };
  'token.rejection': { reason: OneOf<typeof TOKEN_REJECTION_REASONS> };
}

/** The name of an event, whose CloudEvents `type` is `bio.overture.<name>`. */
export type BridgeEventName = keyof BridgeEventData;

/** What one field of an event may hold: a whole number of at least zero, one of a closed set, or a string. */
export type FieldKind =
  | { kind: 'count' }
  | { kind: 'oneOf'; values: readonly string[] }
  | { kind: 'text'; nullable: boolean };

/** How serious an event is, which decides its logging level. */
export type Severity = 'critical' | 'error' | 'info' | 'warning';

/**
 * A severity chosen per emission by whether the event carries one field, judged on the fields
 * copied into the log: `withField` when it carries the field, `withoutField` when it does not.
 */
export interface SeverityByField {
  field: string;
  withField: Severity;
  withoutField: Severity;
}

/**
 * A severity chosen per emission by the value of one field, judged on the fields copied into the
 * log: `byValue` names the severity for each value, and `otherwise` applies when the field is not
 * copied or holds a value not named in `byValue`.
 */
export interface SeverityByValue {
  byValue: Readonly<Record<string, Severity>>;
  field: string;
  otherwise: Severity;
}

/** One event's entry in {@link EVENT_CATALOGUE}. */
export interface EventDefinition {
  actorType: 'anonymous' | 'system';
  fields: Readonly<Record<string, FieldKind>>;

  /**
   * One severity for every emission, or one chosen per emission by whether a field is carried or by
   * the value it holds.
   */
  severity: Severity | SeverityByField | SeverityByValue;
}

const count: FieldKind = { kind: 'count' };
const text: FieldKind = { kind: 'text', nullable: false };
const oneOf = (values: readonly string[]): FieldKind => ({
  kind: 'oneOf',
  values,
});

/** The definition of every event, and the allowlist of the fields each may log. */
export const EVENT_CATALOGUE: Readonly<
  Record<BridgeEventName, EventDefinition>
> = {
  'bridge.internalError': {
    actorType: 'system',
    fields: { stage: oneOf(INTERNAL_ERROR_STAGES) },
    severity: 'critical',
  },
  'bridge.startRefusal': {
    actorType: 'system',
    fields: { reason: oneOf(START_REFUSAL_REASONS) },
    severity: 'critical',
  },
  'catalogue.filterLimit': {
    actorType: 'system',
    fields: { catalogue: text, filterClauseLimit: count },
    severity: 'error',
  },
  'catalogue.renderingMismatch': {
    actorType: 'system',
    fields: { catalogue: text },
    severity: 'critical',
  },
  'catalogue.resourceListMissing': {
    actorType: 'system',
    fields: { catalogue: text },
    severity: 'critical',
  },
  'category.unenforced': {
    actorType: 'system',
    fields: {
      category: text,
      entry: oneOf(UNENFORCED_ENTRIES),
      payloadVersion: count,
      reason: oneOf(['notImplemented']),
      resourceId: text,
      userId: { kind: 'text', nullable: true },
    },
    severity: 'warning',
  },
  'category.unknown': {
    actorType: 'system',
    fields: { catalogue: text, category: text, resourceId: text },
    severity: 'warning',
  },
  'category.unmapped': {
    actorType: 'system',
    fields: { catalogue: text, category: text, resourceId: text },
    severity: {
      field: 'resourceId',
      withField: 'error',
      withoutField: 'critical',
    },
  },
  'credential.malformed': {
    actorType: 'anonymous',
    fields: { reason: oneOf(MALFORMED_CREDENTIAL_REASONS) },
    severity: 'info',
  },
  'credential.refusal': {
    actorType: 'anonymous',
    fields: { origin: oneOf(REFUSAL_ORIGINS) },
    severity: 'info',
  },
  'notice.applied': {
    actorType: 'system',
    fields: { entriesDropped: count, kind: oneOf(NOTICE_KINDS) },
    severity: 'info',
  },
  'revocationChannel.failure': {
    actorType: 'system',
    fields: { cause: oneOf(CHANNEL_FAILURE_CAUSES), count },
    severity: 'warning',
  },
  'revocationChannel.malformed': {
    actorType: 'system',
    fields: { reason: oneOf(MALFORMED_CHANNEL_REASONS) },
    severity: 'warning',
  },
  'revocationChannel.modeChange': {
    actorType: 'system',
    fields: {
      fromMode: oneOf(BRIDGE_MODES),
      reason: oneOf(MODE_CHANGE_REASONS),
      toMode: oneOf(BRIDGE_MODES),
    },
    severity: {
      byValue: { cold: 'critical', normal: 'info', uncertain: 'critical' },
      field: 'toMode',
      otherwise: 'critical',
    },
  },
  'revocationChannel.pushReconnect': {
    actorType: 'system',
    fields: { reason: oneOf(PUSH_RECONNECT_REASONS) },
    severity: 'info',
  },
  'revocationChannel.reset': {
    actorType: 'system',
    fields: {},
    severity: 'warning',
  },
  'token.exchangeFailure': {
    actorType: 'system',
    fields: { cause: oneOf(EXCHANGE_FAILURE_CAUSES), count },
    severity: 'warning',
  },
  'token.overtaken': {
    actorType: 'system',
    fields: { outcome: oneOf(OVERTAKEN_OUTCOMES) },
    severity: 'info',
  },
  'token.rejection': {
    actorType: 'system',
    fields: { reason: oneOf(TOKEN_REJECTION_REASONS) },
    severity: 'warning',
  },
};

const DEFINITIONS: ReadonlyMap<string, EventDefinition> = new Map(
  Object.entries(EVENT_CATALOGUE),
);

const LEVELS = {
  critical: 'error',
  error: 'error',
  info: 'info',
  warning: 'warn',
} as const satisfies Readonly<Record<Severity, keyof BridgeLogger>>;

/** Logs events through the host's {@link BridgeLogger}. */
export interface EventLog {
  /** Logs one event, carrying only the fields allowed by its definition, each of an allowed kind. */
  emit<Name extends BridgeEventName>(
    name: Name,
    data: BridgeEventData[Name],
  ): void;
}

/** A member's value when it is an own data property, never running an accessor. */
const ownDataValue = (record: unknown, member: string): unknown => {
  if (typeof record === 'object' && record !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(record, member);
    return descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : undefined;
  }
  return undefined;
};

const severityOf = (
  severity: Severity | SeverityByField | SeverityByValue,
  copied: ReadonlyMap<string, unknown>,
): Severity => {
  if (typeof severity === 'string') {
    return severity;
  }
  if ('byValue' in severity) {
    const value = copied.get(severity.field);
    return typeof value === 'string' && Object.hasOwn(severity.byValue, value)
      ? (severity.byValue[value] ?? severity.otherwise)
      : severity.otherwise;
  }
  return copied.has(severity.field)
    ? severity.withField
    : severity.withoutField;
};

const accepts = (field: FieldKind, value: unknown): boolean => {
  switch (field.kind) {
    case 'count':
      return (
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      );
    case 'oneOf':
      return typeof value === 'string' && field.values.includes(value);
    case 'text':
      return typeof value === 'string' || (field.nullable && value === null);
  }
};

/**
 * Creates the event log, whose `emit` hands each event to the logger once.
 *
 * - Each event is wrapped in the CloudEvents envelope, with `source` as given, `type` as
 *   `bio.overture.<name>`, `time` from the wall clock in UTC, and the severity.
 * - It is logged at the level mapped from its severity: `info`, `warn` for a warning, and `error` for
 *   an error or a critical event.
 * - Only the fields given to the event by the catalogue are copied, and only when each holds a value
 *   of its kind, so a cast that smuggles in a token, a payload or an error's message loses it.
 * - An event whose severity depends on a field takes it from the fields copied, so the severity
 *   logged always matches the fields logged.
 * - `actorId` is always null: no event has an identified actor.
 * - When the logger throws, that event alone is dropped and `emit` returns normally. The drop is
 *   reported nowhere, not even to the logger.
 */
export const createEventLog = ({
  logger,
  source,
  wallClock,
}: {
  logger: BridgeLogger;
  source: string;
  wallClock: Clock;
}): EventLog => ({
  emit: (name, data) => {
    const definition = DEFINITIONS.get(name);
    if (definition !== undefined) {
      const fields = Object.entries(definition.fields).flatMap(
        ([field, kind]) => {
          const value = ownDataValue(data, field);
          return accepts(kind, value) ? [[field, value] as const] : [];
        },
      );
      const type = `bio.overture.${name}`;
      const severity = severityOf(definition.severity, new Map(fields));
      const envelope = {
        data: {
          actorId: null,
          actorType: definition.actorType,
          ...Object.fromEntries(fields),
        },
        id: randomUUID(),
        severity,
        source,
        specversion: '1.0',
        time: new Date(wallClock.now()).toISOString(),
        type,
      };
      try {
        logger[LEVELS[severity]](envelope, type);
      } catch {
        // The logger is the only path a report of the drop could take, so the drop goes unreported.
      }
    }
  },
});

/** How long a tally counts before it reports, from the first occurrence recorded. */
export const TALLY_INTERVAL_MS = 60_000;

/** Counts occurrences by cause, so a flood of them becomes one event per cause per interval. */
export interface Tally<Cause extends string> {
  /** Counts one occurrence of `cause`; ignored once stopped. */
  record(cause: Cause): void;

  /** Logs every count held and cancels the interval, for good: a record after it is ignored. */
  stop(): void;
}

/**
 * Counts occurrences by cause. The first recorded while no timer is armed arms an unreferenced one,
 * which calls `report` once for each cause recorded since, with its count. Records after a stop are
 * ignored, so no timer outlives it.
 */
const createTally = <Cause extends string>(
  report: (cause: Cause, count: number) => void,
): Tally<Cause> => {
  const state: {
    counts: ReadonlyMap<Cause, number>;
    stopped: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
  } = { counts: new Map(), stopped: false, timer: undefined };

  const reportAll = (): void => {
    state.counts.forEach((count, cause) => report(cause, count));
    state.counts = new Map();
    state.timer = undefined;
  };

  return {
    record: (cause) => {
      if (state.stopped) {
        return;
      }
      state.counts = new Map(state.counts).set(
        cause,
        (state.counts.get(cause) ?? 0) + 1,
      );
      if (state.timer === undefined) {
        state.timer = setTimeout(reportAll, TALLY_INTERVAL_MS);
        state.timer.unref?.();
      }
    },
    stop: () => {
      state.stopped = true;
      clearTimeout(state.timer);
      reportAll();
    },
  };
};

/** Counts overloaded requests, so a flood of them becomes one event per interval. */
export interface OverloadTally {
  /** Counts one overloaded request; ignored once stopped. */
  record(): void;

  /** Logs any count held and cancels the interval, for good: a record after it is ignored. */
  stop(): void;
}

/**
 * Creates the tally of requests shed beyond the in-flight bound, whose one event per interval is a
 * `token.exchangeFailure` with cause `overloaded`, carrying the count.
 */
export const createOverloadTally = (events: EventLog): OverloadTally => {
  const tally = createTally<'overloaded'>((cause, count) =>
    events.emit('token.exchangeFailure', { cause, count }),
  );
  return { record: () => tally.record('overloaded'), stop: tally.stop };
};

/**
 * Creates the tally of the revocation channel's failed checks, whose one event per cause per
 * interval is a `revocationChannel.failure` carrying that cause's count.
 */
export const createChannelFailureTally = (
  events: EventLog,
): Tally<OneOf<typeof CHANNEL_FAILURE_CAUSES>> =>
  createTally((cause, count) =>
    events.emit('revocationChannel.failure', { cause, count }),
  );
