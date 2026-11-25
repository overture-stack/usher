-- Whoever may read a category's records may make sets from them by default, since sets are how a reader
-- later shares access: the seeded roles that read, viewer, editor and curator, carry artifact.create.
-- A store a start has seeded holds those roles without it, and a start seeds only the roles a store
-- lacks, so this adds it to each of the three the store holds. A store no start has seeded holds no
-- role, and its first start seeds them with it. No other role changes, submitter included, since it
-- reads nothing.
--
-- Each permission added is recorded in change_records as the system actor, declared for this
-- migration's transaction.

SELECT set_config('usher.actor_type', 'system', true);

INSERT INTO role_permissions (role_id, capability_id)
SELECT role.id, capability.id
  FROM roles role
  JOIN capabilities capability ON capability.entity = 'artifact' AND capability.action = 'create'
 WHERE role.name IN ('curator', 'editor', 'viewer')
ON CONFLICT (role_id, capability_id) DO NOTHING;
