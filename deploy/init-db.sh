#!/bin/sh
set -eu
app_password="$(cat /run/secrets/db_app_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$app_password" <<'SQL'
CREATE ROLE klasskvest_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
SELECT format('ALTER ROLE klasskvest_app PASSWORD %L', :'app_password') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE klasskvest FROM PUBLIC;
GRANT CONNECT ON DATABASE klasskvest TO klasskvest_app;
SQL
