#!/usr/bin/env bash
# =============================================================================
# seed-remote.sh
# -----------------------------------------------------------------------------
# Assignment 2 variant of seed.sh -- seeds a REMOTE, TLS-required MySQL
# instance (Aiven) instead of the local Docker mysql-db service. Same schema
# and data shape as seed.sh; adds --ssl-ca / --ssl-mode for TLS.
#
# Usage:
#   MYSQL_HOST=... MYSQL_PORT=... MYSQL_USER=... MYSQL_PASSWORD=... \
#   MYSQL_DATABASE=capacity_lab MYSQL_SSL_CA=/path/to/ca.pem \
#   bash data-seed/seed-remote.sh
# =============================================================================
set -euo pipefail

MYSQL_HOST="${MYSQL_HOST:?MYSQL_HOST is required}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:?MYSQL_USER is required}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:?MYSQL_PASSWORD is required}"
MYSQL_DATABASE="${MYSQL_DATABASE:-capacity_lab}"
MYSQL_SSL_CA="${MYSQL_SSL_CA:?MYSQL_SSL_CA (path to CA cert) is required}"
ROW_COUNT="${ROW_COUNT:-100000}"

MYSQL=(mysql -h "${MYSQL_HOST}" -P "${MYSQL_PORT}" -u "${MYSQL_USER}" "-p${MYSQL_PASSWORD}" \
  --ssl-ca="${MYSQL_SSL_CA}" --ssl-mode=REQUIRED)

echo ">> Waiting for MySQL at ${MYSQL_HOST}:${MYSQL_PORT} ..."
until "${MYSQL[@]}" -e "SELECT 1" >/dev/null 2>&1; do
  echo "   ...still waiting"
  sleep 2
done
echo ">> MySQL is up."

echo ">> Creating schema and loading ${ROW_COUNT} patient rows (this may take a minute) ..."
"${MYSQL[@]}" <<SQL
CREATE DATABASE IF NOT EXISTS ${MYSQL_DATABASE};
USE ${MYSQL_DATABASE};

DROP TABLE IF EXISTS patients;
DROP TABLE IF EXISTS hospitals;

CREATE TABLE patients (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  first_name   VARCHAR(64)  NOT NULL,
  last_name    VARCHAR(64)  NOT NULL,
  email        VARCHAR(128) NOT NULL,
  diagnosis    VARCHAR(255) NOT NULL,
  notes        TEXT         NOT NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE INDEX idx_patients_last_name ON patients (last_name);

CREATE TABLE hospitals (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(128) NOT NULL,
  available_beds INT          NOT NULL DEFAULT 1000
) ENGINE=InnoDB;

INSERT INTO hospitals (name, available_beds) VALUES
  ('General Hospital',        1000000),
  ('St. Mary Medical Center', 1000000),
  ('Lakeside Clinic',         1000000),
  ('Mountain View Hospital',  1000000),
  ('Riverside Health',        1000000);

SET SESSION cte_max_recursion_depth = ${ROW_COUNT};
INSERT INTO patients (first_name, last_name, email, diagnosis, notes)
WITH RECURSIVE seq (n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < ${ROW_COUNT}
)
SELECT
  ELT(1 + (n % 8), 'Alice','Bob','Carol','David','Eve','Frank','Grace','Heidi'),
  ELT(1 + (n % 10), 'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez'),
  CONCAT('patient', n, '@example.com'),
  ELT(1 + (n % 5), 'Hypertension','Diabetes','Asthma','Fracture','Migraine'),
  REPEAT(CONCAT('Clinical note for patient ', n, '. '), 6)
FROM seq;

SELECT CONCAT('patients rows: ', COUNT(*)) AS seeded FROM patients;
SELECT CONCAT('hospitals rows: ', COUNT(*)) AS seeded FROM hospitals;
SQL

echo ">> Seed complete."
