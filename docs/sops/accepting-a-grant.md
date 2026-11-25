# Accepting a grant

A grant gives you access to a resource's records once you accept it. It confers only what you
accepted, so when its role later gains a capability, you take it on by answering the grant again.

1. **Sign in** with your account in the realm Usher trusts, at the API documentation page,
   `/api-docs`, or with any client of the Management API.
2. **Find your grants** with `GET /admin/me/grants`. Each lists in `capabilities` what its role lets
   you use now, and in `decision` your latest answer. Answer a grant whose `decision` is `null`, or
   whose `decision.capabilities` lacks a name `capabilities` now lists.
3. **Accept** with `POST /admin/grants/{grantId}/decisions`, sending `{ "decision": "accept" }` and,
   in `capabilities`, the `name` of each capability the listing showed, as strings. To refuse
   instead, send `"decline"` with the same list.
4. **Confirm** with `GET /admin/me/grants`: the grant's `decision.capabilities` now holds every name
   in its `capabilities`.

A list differing from what the role carries now is refused `422`, and the listed objects themselves
are refused `400`. Each answer is recorded in the audit log, and the latest one stands.
