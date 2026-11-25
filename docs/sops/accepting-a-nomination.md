# Accepting a nomination

Someone has nominated you as an administrator of Usher: the first user, for the first
administrator, or any administrator after that. Accepting makes you one.

1. **Sign in** with your account in the realm Usher trusts, at the API documentation page,
   `/api-docs`, or with any client of the Management API.
2. **Find the nomination** with `GET /admin/me/nominations`. It lists the nominations naming you,
   each with its `id` and state. Answer the one that is `pending`.
3. **Accept** with `POST /admin/nominations/{nominationId}/decisions`, sending
   `{ "decision": "accept" }`. To refuse instead, send `{ "decision": "decline" }`.
4. **Confirm** with `GET /admin/administrators`, which now lists you.

A nomination takes one answer: one already decided, replaced by a later nomination or withdrawn is
refused `409`, so ask whoever nominated you for a new one. Your acceptance is recorded in the audit
log as `admin.nominationDecision`, at `critical`.
