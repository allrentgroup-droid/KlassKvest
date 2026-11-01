-- Created by Docker's init script, separate from the migration owner.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='klasskvest_app') THEN
  GRANT USAGE ON SCHEMA public TO klasskvest_app;
  GRANT SELECT ON schema_migrations,users,classes,memberships,guardian_links,tasks,answers,coin_ledger,polls,votes TO klasskvest_app;
  GRANT SELECT,INSERT,DELETE ON sessions TO klasskvest_app;
  GRANT SELECT,INSERT,UPDATE,DELETE ON login_limits TO klasskvest_app;
  GRANT INSERT ON classes,memberships,tasks,answers,coin_ledger,polls TO klasskvest_app;
  GRANT SELECT,INSERT,UPDATE ON votes TO klasskvest_app;
 END IF;
END $$;
