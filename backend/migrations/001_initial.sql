CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 login text NOT NULL UNIQUE CHECK (login ~ '^[a-z0-9_-]{3,64}$'),
 password_hash text NOT NULL,
 role text NOT NULL CHECK (role IN ('teacher','student','parent')),
 alias text NOT NULL CHECK (length(alias) BETWEEN 1 AND 40),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE classes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
 class_id uuid NOT NULL REFERENCES classes(id), user_id uuid NOT NULL REFERENCES users(id),
 PRIMARY KEY(class_id,user_id)
);
CREATE TABLE guardian_links (
 parent_id uuid NOT NULL REFERENCES users(id), student_id uuid NOT NULL REFERENCES users(id),
 consent_at timestamptz NOT NULL DEFAULT now(), consent_reference text NOT NULL CHECK(length(consent_reference) BETWEEN 1 AND 100),
 PRIMARY KEY(parent_id,student_id), CHECK(parent_id <> student_id)
);
CREATE TABLE tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), class_id uuid NOT NULL REFERENCES classes(id),
 created_by uuid NOT NULL REFERENCES users(id), question text NOT NULL CHECK(length(question) BETWEEN 1 AND 2000),
 options jsonb NOT NULL CHECK(jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 6),
 correct_index integer NOT NULL CHECK(correct_index >= 0 AND correct_index < jsonb_array_length(options)),
 reward integer NOT NULL CHECK(reward BETWEEN 1 AND 1000), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,class_id)
);
CREATE TABLE answers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL, class_id uuid NOT NULL,
 student_id uuid NOT NULL REFERENCES users(id), selected_index integer NOT NULL CHECK(selected_index BETWEEN 0 AND 5),
 correct boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(task_id,class_id) REFERENCES tasks(id,class_id),
 UNIQUE(task_id,student_id), UNIQUE(id,class_id)
);
CREATE TABLE coin_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), class_id uuid NOT NULL REFERENCES classes(id),
 answer_id uuid NOT NULL UNIQUE, amount integer NOT NULL CHECK(amount BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(answer_id,class_id) REFERENCES answers(id,class_id)
);
CREATE INDEX coin_ledger_class ON coin_ledger(class_id);
CREATE TABLE polls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), class_id uuid NOT NULL REFERENCES classes(id),
 created_by uuid NOT NULL REFERENCES users(id), title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 audience text NOT NULL CHECK(audience IN ('student','parent')),
 options jsonb NOT NULL CHECK(jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 6),
 closes_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE votes (
 poll_id uuid NOT NULL REFERENCES polls(id), user_id uuid NOT NULL REFERENCES users(id),
 option_index integer NOT NULL CHECK(option_index BETWEEN 0 AND 5), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(poll_id,user_id)
);
CREATE INDEX tasks_class ON tasks(class_id);
CREATE INDEX polls_class ON polls(class_id);
CREATE INDEX memberships_user ON memberships(user_id);
CREATE INDEX guardian_student ON guardian_links(student_id);
CREATE TABLE login_limits (key text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL);
