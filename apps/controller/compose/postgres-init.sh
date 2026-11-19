#!/usr/bin/env bash
# Creates Usher's two database roles and its database, once, when PostgreSQL's entrypoint initializes
# an empty data directory. The schema migration role owns the database, so the schema it creates and
# everything in it are its own. The runtime role, used by the controller to connect, is a separate
# login role: neither the schema migration role, nor a member of it, nor a superuser, as checked by
# the schema migration command before it runs. Each password comes from the environment as a psql
# variable, quoted by psql as a literal.
set -eo pipefail

: "${SCHEMA_MIGRATION_ROLE_PASSWORD:?is unset}"
: "${RUNTIME_ROLE_PASSWORD:?is unset}"

psql --no-psqlrc --set=ON_ERROR_STOP=1 \
  --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}" \
  --set=schema_migration_password="${SCHEMA_MIGRATION_ROLE_PASSWORD}" \
  --set=runtime_password="${RUNTIME_ROLE_PASSWORD}" <<'SQL'
-- A failing statement is logged with its text, here holding a password.
SET log_min_error_statement = 'panic';
CREATE ROLE usher_migration LOGIN PASSWORD :'schema_migration_password';
CREATE ROLE usher_controller LOGIN PASSWORD :'runtime_password';
CREATE DATABASE usher OWNER usher_migration;
SQL
