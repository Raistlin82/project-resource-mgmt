-- Postgres init script (runs once, only on a fresh data volume).
--
-- The 'postgres' service bootstraps the APP database from POSTGRES_DB. Keycloak
-- needs its OWN, separate database in the same Postgres instance, so we create
-- it here. This file is mounted into /docker-entrypoint-initdb.d, which the
-- official postgres image executes (alphabetically) on first init only.
--
-- Notes / caveats:
-- * CREATE DATABASE cannot run inside a transaction block and does not support
--   "IF NOT EXISTS" portably, so we guard it with a DO/dblink-free pattern:
--   gen a CREATE DATABASE statement only when the db is absent via \gexec.
-- * This script runs as the superuser defined by POSTGRES_USER, so the new
--   database is owned by that same user — which is exactly the role Keycloak
--   authenticates as (KC_DB_USERNAME=POSTGRES_USER in docker-compose).
-- * If you change the Keycloak DB name, keep KC_DB_URL in docker-compose.yml in
--   sync (jdbc:postgresql://postgres:5432/<this-name>).

SELECT 'CREATE DATABASE keycloak'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\gexec
