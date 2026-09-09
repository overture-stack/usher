# Researcher experience design

Three UX decisions must be made before researcher-facing documentation can be written.

## Access request workflow

When a researcher needs access to categorized data, how do they initiate the request? Options: a self-service form in the management UI reviewed by a Custodian or Admin; an external DAC integration via REMS or GA4GH Passport; or an out-of-band process (institutional or email). The in-product request flow is not yet designed. Prerequisite to the researcher journey documentation, and related to the DACO-style approval workflows in Future scope (DACO is about ethics-review-gated access specifically; this covers the general grant request path).

## Denied access user experience

When a member has no category grant for a given category, records tagged with that category are excluded from their results. The user-facing manifestation is a plugin design decision: an empty result set, a reduced count, an informative message, or no indication at all. Existence denial is a hard invariant (OWASP A01); revealing that records exist but are inaccessible violates it, but revealing nothing may confuse researchers who expect records they know exist.

## Category grant expiry and renewal

Category grants carry an `expires_at`. No mechanism is designed for notifying researchers before their grant expires or for guiding them through renewal. Distinct from custodian notification (which covers tightening changes applied by an admin or owner): this covers the researcher's own expiry and renewal cycle.
