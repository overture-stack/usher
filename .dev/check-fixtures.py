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
"""

import json
import sys

ENTITY_ACTIONS = {
    "record": {"aggregate", "read", "export", "create", "update", "delete"},
    "field": {"aggregate", "read", "export", "update"},
    "revision": {"read", "export"},
    "artifact": {"create", "read", "update", "delete", "export"},
}

REQUIRED = ("payloadVersion", "sub", "iss", "aud", "iat", "exp", "generatedAt", "permissions")
FORBIDDEN = ("categoryVersions",)


def check_actions(where, entity, actions, fail):
    if not isinstance(actions, list):
        return fail(f"{where}: {entity} must be a list of actions")
    if not actions:
        return fail(f"{where}: {entity} has an empty action list, which means what absence means")
    if len(set(actions)) != len(actions):
        fail(f"{where}: {entity} repeats an action")
    for action in actions:
        if action not in ENTITY_ACTIONS[entity]:
            fail(f"{where}: {entity}.{action} is not in that entity's vocabulary")


def check_payload(entry_id, payload, fail):
    for member in REQUIRED:
        if member not in payload:
            fail(f"{entry_id}: required member {member} is missing")
    for member in FORBIDDEN:
        if member in payload:
            fail(f"{entry_id}: {member} must not travel in the payload")

    if payload.get("payloadVersion") != 1:
        fail(f"{entry_id}: payloadVersion must be 1")
    if not (payload.get("sub") is None or isinstance(payload.get("sub"), str)):
        fail(f"{entry_id}: sub must be a string or null, never absent")
    for stamp in ("iat", "exp", "generatedAt"):
        if not isinstance(payload.get(stamp), int):
            fail(f"{entry_id}: {stamp} must be an integer")
    if isinstance(payload.get("iat"), int) and isinstance(payload.get("exp"), int):
        if payload["exp"] <= payload["iat"]:
            fail(f"{entry_id}: exp must be later than iat")

    permissions = payload.get("permissions")
    if not isinstance(permissions, dict):
        return fail(f"{entry_id}: permissions must be a map")

    for resource, categories in permissions.items():
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
                        check_actions(f"{where}/field/{field_category}", "field", actions, fail)
                else:
                    check_actions(where, entity, value, fail)


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
