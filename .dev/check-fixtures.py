#!/usr/bin/env python3
"""Validate the conformance fixtures against the PermissionsPayload contract and the expectations format.

    python3 .dev/check-fixtures.py [PRINCIPALS.json [EXPECTATIONS.json]]

`expectations.json` is read from the directory holding `principals.json` unless it is named.

The contract is `PermissionsPayload` in `.dev/design/security-workflow.md`. A TypeScript type
cannot check a JSON file: importing one infers a union of object literals, so an entry with an
empty `permissions` map widens its siblings' keys to `undefined` and the whole array stops
assigning, which reports a defect in the importer rather than in the data. Structural rules stated
by the type also need checking at runtime, since nothing enforces a type on parsed JSON.

Two rules here are not in the type and cannot be. Action lists are non-empty, which the type says
through `NonEmpty` but only for literals. And no member may be named `categoryVersions`: the
versions live with the cached payload, and a fixture carrying one would teach an adapter to expect
a member never emitted by the controller.

A third is a rule of the vocabulary rather than of the type: `read` is a capability group, named
where roles are written and expanded into its members there, so it never appears as an action.

The category members carry three rules the type cannot state. `globalCategories` lists distinct
concrete global categories, never `global.unmarked`, and each list in `resourceCategories` distinct
resource categories, never `resource.unmarked`. `resourceCategories` names exactly the resources
named by `permissions`. And every category held on a resource is `global.unmarked`, listed in
`globalCategories`, or listed under that resource in `resourceCategories`.

`servedResources` carries two more. It lists distinct resource identifiers, and among them every
resource named by `permissions` or `resourceCategories`, since it is every resource served by the
audience, held or not.

This checker is stricter than the contract in one place, deliberately. It fails an entity key it
does not know, because a fixture is authored and an unknown key there is a typo. The contract
tolerates an unknown key at the entity level, and `usher-types` follows the contract.

The rest hold for the controller and the validator alike. The root holds the payload's members and
nothing else. A category name has one name after its scope, with no further separator, and field
categories are named the same way. A resource identifier is not empty, is not `__proto__`, and
holds no marker read specially by Arranger, and `sub` is a non-empty string or null. `iss` and
`aud` are non-empty strings. Timestamps are integers, never booleans, from zero up to the largest
safe integer, and `generatedAt` is not later than `iat`.

`expectations.json` holds to its own format, version 1. Every case names a `principals.json` entry
by `principalId`, and none of those is marked not implementable, since a case holds expectations
only once it can be checked. A case's key is a map of kind open or record, a record key names its
resource field, and every record carries a value at that field, an outcome of served, withheld or
denied, and a reason. A denial refuses the whole catalogue, so a case's records are all denied or
none is. Members are checked strictly here too. Whether a key holds to the registration format
and whether an outcome is right need usher-types, so the bridge's test reading this file decides
both.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable

Fail = Callable[[str], None]

ENTITY_ACTIONS = {
    "artifact": {"count", "view", "export", "create", "update", "delete"},
    "field": {"count", "view", "export", "update"},
    "record": {"count", "view", "export", "create", "update", "delete"},
    "revision": {"view", "export"},
}

# Named where roles are written and expanded into their members there, so a payload never carries
# one. An adapter that tests for `read` tests for something never emitted by the controller.
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
    "globalCategories",
    "resourceCategories",
    "servedResources",
)
SCOPES = ("global.", "resource.")
MAX_SAFE_INTEGER = 2**53 - 1
FORBIDDEN = ("categoryVersions",)
SPECIAL_VALUE_MARKERS = ("*", "__missing__", "set_id:")

EXPECTATIONS_FORMAT_VERSION = 1
EXPECTATIONS_MEMBERS = ("about", "cases", "formatVersion")
EXPECTATIONS_REQUIRED = ("cases", "formatVersion")
CASE_MEMBERS = ("keyRegistration", "principalId", "records")
RECORD_MEMBERS = ("fields", "outcome", "reason")
KEY_KINDS = ("open", "record")
OUTCOMES = ("denied", "served", "withheld")


def is_integer(value: object) -> bool:
    """True for a JSON integer. Python counts a boolean as an integer, and JSON does not."""
    return isinstance(value, int) and not isinstance(value, bool)


def check_actions(where: str, entity: str, actions: object, fail: Fail) -> None:
    if not isinstance(actions, list):
        return fail(f"{where}: {entity} must be a list of actions")
    if not actions:
        return fail(f"{where}: {entity} has an empty action list, which means what absence means")
    if len(set(map(json.dumps, actions))) != len(actions):
        fail(f"{where}: {entity} repeats an action")
    for action in actions:
        if not isinstance(action, str):
            fail(f"{where}: {entity} lists an action that is not a string")
        elif action in CAPABILITY_GROUPS:
            fail(f"{where}: {entity}.{action} is a capability group, expanded before issuance")
        elif action not in ENTITY_ACTIONS[entity]:
            fail(f"{where}: {entity}.{action} is not in that entity's vocabulary")


def check_payload(entry_id: object, payload: dict, fail: Fail) -> None:
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

    check_category_members(
        entry_id,
        permissions,
        payload.get("globalCategories"),
        payload.get("resourceCategories"),
        fail,
    )
    check_served_resources(
        entry_id,
        permissions,
        payload.get("resourceCategories"),
        payload.get("servedResources"),
        fail,
    )


def check_name(where: str, name: str, fail: Fail) -> None:
    if name == "":
        fail(f"{where}: a resource identifier is empty")
    elif name == "__proto__":
        fail(f"{where}: __proto__ is not a usable identifier")
    elif any(marker in name for marker in SPECIAL_VALUE_MARKERS):
        fail(f"{where}: a resource identifier holds a marker read specially by Arranger")


def check_category(where: str, category: object, fail: Fail) -> None:
    if not isinstance(category, str):
        return fail(f"{where}: a category name must be a string")
    scope = next((prefix for prefix in SCOPES if category.startswith(prefix)), None)
    if scope is None:
        fail(f"{where}: {category} is not a scoped category name")
    elif category[len(scope):] in ("", "__proto__"):
        fail(f"{where}: {category} has no usable name after its scope")
    elif "." in category[len(scope):]:
        fail(f"{where}: {category} holds a separator after its scope")


def check_category_list(
    where: str, categories: object, scope: str, reserved: str, fail: Fail
) -> None:
    """A list of distinct category names of one scope, never the scope's reserved name."""
    if not isinstance(categories, list):
        return fail(f"{where}: must be a list of category names")
    if len(set(map(json.dumps, categories))) != len(categories):
        fail(f"{where}: repeats a category")
    for category in categories:
        check_category(where, category, fail)
        if isinstance(category, str) and not category.startswith(scope):
            fail(f"{where}: {category} is not a {scope} category")
        elif category == reserved:
            fail(f"{where}: {reserved} is reserved, and is never listed")


def check_category_members(
    entry_id: object,
    permissions: dict,
    global_categories: object,
    resource_categories: object,
    fail: Fail,
) -> None:
    check_category_list(
        f"{entry_id}/globalCategories", global_categories, "global.", "global.unmarked", fail
    )
    if not isinstance(resource_categories, dict):
        return fail(f"{entry_id}: resourceCategories must be a map")
    if set(resource_categories) != set(permissions):
        fail(f"{entry_id}: resourceCategories must name exactly the resources named by permissions")
    for resource, categories in resource_categories.items():
        check_category_list(
            f"{entry_id}/resourceCategories/{resource}",
            categories,
            "resource.",
            "resource.unmarked",
            fail,
        )
    listed_globals = global_categories if isinstance(global_categories, list) else []
    for resource, held in permissions.items():
        own = resource_categories.get(resource)
        listed = ["global.unmarked", *listed_globals, *(own if isinstance(own, list) else [])]
        for category in held if isinstance(held, dict) else ():
            if category not in listed:
                fail(f"{entry_id}/{resource}: {category} is held but listed in neither category member")


def check_served_resources(
    entry_id: object, permissions: dict, resource_categories: object, served: object, fail: Fail
) -> None:
    where = f"{entry_id}/servedResources"
    if not isinstance(served, list):
        return fail(f"{where}: must be a list of resource identifiers")
    if len(set(map(json.dumps, served))) != len(served):
        fail(f"{where}: repeats a resource")
    for resource in served:
        if isinstance(resource, str):
            check_name(where, resource, fail)
        else:
            fail(f"{where}: a resource identifier must be a string")
    named = {
        "permissions": permissions,
        "resourceCategories": resource_categories if isinstance(resource_categories, dict) else {},
    }
    for member, resources in named.items():
        for resource in resources:
            if resource not in served:
                fail(f"{where}: {resource} is named in {member} but not served")


def is_marked_not_implementable(entry: dict) -> bool:
    """An entry is implementable unless it carries an `implementable` member other than true."""
    return entry.get("implementable", True) is not True


def is_resource_value(value: object) -> bool:
    """A value at a resource field: one non-empty identifier, or a non-empty list of them."""
    values = value if isinstance(value, list) else [value]
    return bool(values) and all(isinstance(item, str) and item != "" for item in values)


def check_members(
    where: str, value: dict, members: tuple[str, ...], required: tuple[str, ...], fail: Fail
) -> None:
    for member in required:
        if member not in value:
            fail(f"{where}: required member {member} is missing")
    for member in value:
        if member not in members:
            fail(f"{where}: {member} is not a member here")


def check_expected_record(
    where: str, record: object, resource_field_name: str | None, fail: Fail
) -> None:
    if not isinstance(record, dict):
        return fail(f"{where}: a record is a map")
    check_members(where, record, RECORD_MEMBERS, RECORD_MEMBERS, fail)
    fields = record.get("fields")
    if not isinstance(fields, dict):
        fail(f"{where}: fields is a map from field names to values")
    elif resource_field_name is not None and not is_resource_value(fields.get(resource_field_name)):
        fail(f"{where}: carries no value at the key's resource field, {resource_field_name}")
    if record.get("outcome") not in OUTCOMES:
        fail(f"{where}: outcome is served, withheld or denied")
    if not (isinstance(record.get("reason"), str) and record["reason"] != ""):
        fail(f"{where}: reason is a non-empty string")


def check_expectation_case(where: str, case: object, principals_by_id: dict, fail: Fail) -> None:
    if not isinstance(case, dict):
        return fail(f"{where}: a case is a map")
    check_members(where, case, CASE_MEMBERS, CASE_MEMBERS, fail)

    principal_id = case.get("principalId")
    principal = principals_by_id.get(principal_id) if isinstance(principal_id, str) else None
    if principal is None:
        fail(f"{where}: principalId names no entry in principals.json")
    elif is_marked_not_implementable(principal):
        fail(f"{where}: {principal_id} is marked not implementable, so it holds no expectations")

    key = case.get("keyRegistration")
    is_record_key = isinstance(key, dict) and key.get("kind") == "record"
    named_field = key.get("resourceFieldName") if is_record_key else None
    resource_field_name = named_field if isinstance(named_field, str) and named_field != "" else None
    if not (isinstance(key, dict) and key.get("kind") in KEY_KINDS):
        fail(f"{where}: keyRegistration is a map of kind open or record")
    elif is_record_key and resource_field_name is None:
        fail(f"{where}: a record key names its resource field")

    records = case.get("records")
    if not isinstance(records, list) or not records:
        return fail(f"{where}: records is a non-empty list")
    for index, record in enumerate(records):
        check_expected_record(f"{where}/records/{index}", record, resource_field_name, fail)
    denials = [isinstance(record, dict) and record.get("outcome") == "denied" for record in records]
    if any(denials) and not all(denials):
        fail(f"{where}: a denial refuses the whole catalogue, so every record is denied or none is")


def check_expectations(document: object, principals_by_id: dict, fail: Fail) -> list:
    """Checks the expectations document, returning its cases so the summary can count them."""
    if not isinstance(document, dict):
        fail("expectations: the document is a map")
        return []
    check_members("expectations", document, EXPECTATIONS_MEMBERS, EXPECTATIONS_REQUIRED, fail)
    version = document.get("formatVersion")
    if not (is_integer(version) and version == EXPECTATIONS_FORMAT_VERSION):
        fail(f"expectations: formatVersion must be {EXPECTATIONS_FORMAT_VERSION}")
    cases = document.get("cases")
    if not isinstance(cases, list) or not cases:
        fail("expectations: cases must be a non-empty list")
        return []
    for index, case in enumerate(cases):
        principal_id = case.get("principalId") if isinstance(case, dict) else None
        label = principal_id if isinstance(principal_id, str) else f"cases/{index}"
        check_expectation_case(f"expectations/{label}", case, principals_by_id, fail)
    return cases


def checked_cases(expectations_path: str, principals_by_id: dict, fail: Fail) -> list:
    """Checks the expectations document at `expectations_path`, returning its cases."""
    if os.path.exists(expectations_path):
        with open(expectations_path) as handle:
            return check_expectations(json.load(handle), principals_by_id, fail)
    fail(f"expectations: {expectations_path} does not exist")
    return []


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else ".dev/design/conformance/principals.json"
    expectations_path = (
        sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(path), "expectations.json")
    )
    with open(path) as handle:
        document = json.load(handle)

    failures: list[str] = []
    fail = failures.append

    principals = document.get("principals")
    has_principals = isinstance(principals, list) and len(principals) > 0
    if not has_principals:
        fail("principals must be a non-empty list")
    entries = principals if has_principals else []

    ids = [entry.get("id", "<no id>") for entry in entries]
    for index, (entry, entry_id) in enumerate(zip(entries, ids)):
        if entry_id in ids[:index]:
            fail(f"{entry_id}: duplicate id, and expectations key on it")
        if "case" not in entry:
            fail(f"{entry_id}: no case number, so nothing traces it to token-calculation.md")
        if "payload" in entry:
            check_payload(entry_id, entry["payload"], fail)
        else:
            fail(f"{entry_id}: no payload")

    principals_by_id = {entry.get("id"): entry for entry in entries}
    cases = checked_cases(expectations_path, principals_by_id, fail)
    records = sum(
        len(case["records"])
        for case in cases
        if isinstance(case, dict) and isinstance(case.get("records"), list)
    )

    for failure in failures:
        print(f"  {failure}")

    print(
        f"\nChecked {len(entries)} fixtures against the PermissionsPayload contract, and "
        + f"{len(cases)} expectation {'case' if len(cases) == 1 else 'cases'} holding {records} "
        + f"{'record' if records == 1 else 'records'} against the expectations format. "
        + (f"{len(failures)} FAILED." if failures else "All pass.")
        + "\nThis checks shape and vocabulary. Whether a payload is the right answer for its case\n"
        + "is a question answered only by the case table, never by a validator. Whether an outcome\n"
        + "is right is for the bridge's test reading expectations.json to say."
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
