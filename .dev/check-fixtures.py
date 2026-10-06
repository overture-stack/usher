#!/usr/bin/env python3
"""Validate the conformance fixtures against the PermissionsPayload contract.

    python3 .dev/check-fixtures.py [PRINCIPALS.json]

The contract is `PermissionsPayload` in `.dev/design/security-workflow.md`. A TypeScript type
cannot check a JSON file: importing one infers a union of object literals, so an entry with an
empty `permissions` map widens its siblings' keys to `undefined` and the whole array stops
assigning, which reports a defect in the importer rather than in the data. Structural rules the
type states also need checking at runtime, since nothing enforces a type on parsed JSON.

Two rules here are not in the type and cannot be. Action lists are non-empty, which the type says
through `NonEmpty` but only for literals. And no member may be named `categoryVersions`: the
versions live with the cached payload, and a fixture carrying one would teach an adapter to expect
a member the controller does not emit.

A third is a rule of the vocabulary rather than of the type: `read` is a capability group, named
where roles are written and expanded into its members there, so it never appears as an action.

`offeredCategories` carries two rules the type cannot state: it names exactly the resources
`permissions` names, and every category held on a resource is one that resource offers.

This checker is stricter than the contract in one place, deliberately. It fails an entity key it
does not know, because a fixture is authored and an unknown key there is a typo. The contract
tolerates an unknown key at the entity level, and `usher-types` follows the contract.

The rest hold for the controller and the validator alike. The root holds the payload's members and
nothing else. A category name has one name after its scope, with no further separator, and field
categories are named the same way. A resource identifier is not empty, neither is `__proto__`, and
`sub` is a non-empty string or null. `iss` and `aud` are non-empty strings. Timestamps are
integers, never booleans, from zero up to the largest safe integer, and `generatedAt` is not later
than `iat`.
"""

import json
import sys

ENTITY_ACTIONS = {
    "record": {"count", "view", "export", "create", "update", "delete"},
    "field": {"count", "view", "export", "update"},
    "revision": {"view", "export"},
    "artifact": {"count", "view", "export", "create", "update", "delete"},
}

# Named where roles are written and expanded into their members there, so a payload never carries
# one. An adapter that tests for `read` tests for something the controller does not emit.
CAPABILITY_GROUPS = {"read"}

REQUIRED = (
    "payloadVersion",
    "sub",
    "iss",
    "aud",
    "iat",
    "exp",
    "generatedAt",
    "permissions",
    "offeredCategories",
)
SCOPES = ("global.", "resource.")
MAX_SAFE_INTEGER = 2**53 - 1


def is_integer(value):
    """True for a JSON integer. Python counts a boolean as an integer, and JSON does not."""
    return isinstance(value, int) and not isinstance(value, bool)
FORBIDDEN = ("categoryVersions",)


def check_actions(where, entity, actions, fail):
    if not isinstance(actions, list):
        return fail(f"{where}: {entity} must be a list of actions")
    if not actions:
        return fail(f"{where}: {entity} has an empty action list, which means what absence means")
    if len(set(actions)) != len(actions):
        fail(f"{where}: {entity} repeats an action")
    for action in actions:
        if action in CAPABILITY_GROUPS:
            fail(f"{where}: {entity}.{action} is a capability group, expanded before issuance")
        elif action not in ENTITY_ACTIONS[entity]:
            fail(f"{where}: {entity}.{action} is not in that entity's vocabulary")


def check_payload(entry_id, payload, fail):
    for member in REQUIRED:
        if member not in payload:
            fail(f"{entry_id}: required member {member} is missing")
    for member in payload:
        if member in FORBIDDEN:
            fail(f"{entry_id}: {member} must not travel in the payload")
        elif member not in REQUIRED:
            fail(f"{entry_id}: {member} is not a member of the payload")

    if not (is_integer(payload.get("payloadVersion")) and payload["payloadVersion"] == 1):
        fail(f"{entry_id}: payloadVersion must be 1")
    sub = payload.get("sub")
    if not (sub is None or (isinstance(sub, str) and sub != "")):
        fail(f"{entry_id}: sub must be a non-empty string or null, never absent")
    for claim in ("iss", "aud"):
        if not (isinstance(payload.get(claim), str) and payload[claim] != ""):
            fail(f"{entry_id}: {claim} must be a non-empty string")
    stamps = {stamp: payload.get(stamp) for stamp in ("iat", "exp", "generatedAt")}
    for stamp, value in stamps.items():
        if not (is_integer(value) and 0 <= value <= MAX_SAFE_INTEGER):
            fail(f"{entry_id}: {stamp} must be an integer from zero to the largest safe integer")
    if is_integer(stamps["iat"]) and is_integer(stamps["exp"]):
        if payload["exp"] <= payload["iat"]:
            fail(f"{entry_id}: exp must be later than iat")
    if is_integer(stamps["iat"]) and is_integer(stamps["generatedAt"]):
        if payload["generatedAt"] > payload["iat"]:
            fail(f"{entry_id}: generatedAt must not be later than iat")

    permissions = payload.get("permissions")
    if not isinstance(permissions, dict):
        return fail(f"{entry_id}: permissions must be a map")

    for resource, categories in permissions.items():
        check_name(f"{entry_id}/{resource}", resource, fail)
        for category in categories if isinstance(categories, dict) else ():
            check_category(f"{entry_id}/{resource}", category, fail)
        if not isinstance(categories, dict) or not categories:
            fail(f"{entry_id}/{resource}: a named resource carries at least one category")
            continue
        for category, entities in categories.items():
            where = f"{entry_id}/{resource}/{category}"
            if not isinstance(entities, dict) or not entities:
                fail(f"{where}: a named category reaches at least one entity")
                continue
            for entity, value in entities.items():
                if entity not in ENTITY_ACTIONS:
                    fail(f"{where}: {entity} is not a data-plane entity")
                elif entity == "field":
                    if not isinstance(value, dict) or not value:
                        fail(f"{where}: field maps to its own categories, and a present field key names at least one")
                        continue
                    for field_category, actions in value.items():
                        check_category(f"{where}/field", field_category, fail)
                        check_actions(f"{where}/field/{field_category}", "field", actions, fail)
                else:
                    check_actions(where, entity, value, fail)

    check_offered(entry_id, permissions, payload.get("offeredCategories"), fail)


def check_name(where, name, fail):
    if name == "":
        fail(f"{where}: a resource identifier is empty")
    elif name == "__proto__":
        fail(f"{where}: __proto__ is not a usable identifier")


def check_category(where, category, fail):
    if not isinstance(category, str):
        return fail(f"{where}: a category name must be a string")
    scope = next((prefix for prefix in SCOPES if category.startswith(prefix)), None)
    if scope is None:
        fail(f"{where}: {category} is not a scoped category name")
    elif category[len(scope):] in ("", "__proto__"):
        fail(f"{where}: {category} has no usable name after its scope")
    elif "." in category[len(scope):]:
        fail(f"{where}: {category} holds a separator after its scope")


def check_offered(entry_id, permissions, offered, fail):
    if not isinstance(offered, dict):
        return fail(f"{entry_id}: offeredCategories must be a map")
    if set(offered) != set(permissions):
        fail(f"{entry_id}: offeredCategories must name exactly the resources permissions names")
    for resource, categories in offered.items():
        where = f"{entry_id}/offeredCategories/{resource}"
        if not isinstance(categories, list) or not categories:
            fail(f"{where}: a named resource offers at least one category")
            continue
        if len(set(categories)) != len(categories):
            fail(f"{where}: repeats a category")
        for category in categories:
            check_category(where, category, fail)
        held = permissions.get(resource)
        if isinstance(held, dict):
            for category in held:
                if category not in categories:
                    fail(f"{where}: {category} is held but not offered")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else ".dev/design/conformance/principals.json"
    with open(path) as handle:
        document = json.load(handle)

    failures = []
    fail = failures.append

    entries = document.get("principals")
    if not isinstance(entries, list) or not entries:
        fail("principals must be a non-empty list")
        entries = []

    seen = set()
    for entry in entries:
        entry_id = entry.get("id", "<no id>")
        if entry_id in seen:
            fail(f"{entry_id}: duplicate id, and expectations key on it")
        seen.add(entry_id)
        if "case" not in entry:
            fail(f"{entry_id}: no case number, so nothing traces it to token-calculation.md")
        if "payload" not in entry:
            fail(f"{entry_id}: no payload")
            continue
        check_payload(entry_id, entry["payload"], fail)

    for failure in failures:
        print(f"  {failure}")

    print(
        f"\nChecked {len(entries)} fixtures against the PermissionsPayload contract. "
        + (f"{len(failures)} FAILED." if failures else "All pass.")
        + "\nThis checks shape and vocabulary. Whether a payload is the right answer for its case\n"
        + "is a question only the case table answers, and no validator can."
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
