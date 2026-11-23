import type { DiagramArea } from './diagram.js';

/**
 * The parts of the Controller's schema, each drawn as one diagram, in the order they are drawn. A
 * table belongs to exactly one, so a migration adding a table adds it here too, or the diagrams
 * refuse to generate.
 */
export const SCHEMA_AREAS: readonly DiagramArea[] = Object.freeze([
	{ tables: ['users', 'user_identities'], title: 'Principals' },
	{
		tables: ['administrators', 'nominations', 'nomination_declines', 'nomination_revocations'],
		title: 'Administrators',
	},
	{ tables: ['groups', 'group_users'], title: 'Groups' },
	{
		tables: ['resources', 'resource_fields', 'resource_field_values', 'categories', 'resource_categories'],
		title: 'Resources and categories',
	},
	{
		tables: ['applications', 'application_keys', 'application_resources', 'key_fingerprints'],
		title: 'Applications',
	},
	{
		tables: ['capabilities', 'roles', 'role_permissions'],
		title: 'Capabilities, roles and permissions',
	},
	{
		tables: ['grants', 'grant_decisions', 'grant_requests', 'grant_operations', 'invitations'],
		title: 'Grants and invitations',
	},
	{
		tables: ['principal_revocations', 'global_revocations', 'sid_sign_outs', 'subject_sign_outs', 'exchanged_sids'],
		title: 'Revocations and sign-outs',
	},
	{
		tables: ['notices', 'notice_stream', 'notice_retention', 'notification_outbox', 'used_channel_assertions'],
		title: 'The notice stream',
	},
	{
		tables: ['audit_log', 'change_records'],
		title: 'Audit and change records',
	},
	{
		tables: ['settings', 'settings_generation', 'settings_seed', 'identity_provider_configuration'],
		title: 'Settings',
	},
	{
		tables: ['policy_generation', 'schema_migrations'],
		title: 'Policy and schema state',
	},
]);
