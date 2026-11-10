/**
 * The longest `sub` a refusal's `refusedSubject` names, in characters: OpenID Connect's longest. A
 * longer one is left out, never cut short, since a shortened identifier could name someone else. One
 * rule of the audit trail for every refusal naming a subject, as `audit-events.md` states it under "A
 * refused token names its subject only when the controller verified its signature".
 */
export const REFUSED_SUBJECT_MAXIMUM_LENGTH = 255;
