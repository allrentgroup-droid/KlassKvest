ALTER TABLE classes ADD COLUMN goal integer NOT NULL DEFAULT 30000 CHECK(goal BETWEEN 100 AND 1000000);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='klasskvest_app') THEN
  GRANT UPDATE(goal) ON classes TO klasskvest_app;
 END IF;
END $$;
