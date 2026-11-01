ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN administrator_id uuid REFERENCES users(id);
CREATE TABLE admin_demo_accounts (
 administrator_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('teacher','student','parent')),
 user_id uuid NOT NULL UNIQUE REFERENCES users(id),
 PRIMARY KEY(administrator_id,role)
);
CREATE TABLE admin_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), administrator_id uuid NOT NULL REFERENCES users(id),
 action text NOT NULL CHECK(action IN ('switch_teacher','switch_student','switch_parent','return_admin')),
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='klasskvest_app') THEN
  GRANT SELECT,INSERT ON admin_demo_accounts,admin_events TO klasskvest_app;
  GRANT INSERT(login,role,alias,password_hash) ON users TO klasskvest_app;
  GRANT INSERT ON guardian_links TO klasskvest_app;
 END IF;
END $$;

