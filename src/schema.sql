-- SIH 2026 RBCET Team Register
-- A team is a row; a student is a row that either sits on a team or waits in
-- the pool. Pool membership is team_id IS NULL, so there is one home for every
-- student and no way to be in two places at once. Seat 0 is the team leader.

CREATE TABLE IF NOT EXISTS teams (
  id          SERIAL PRIMARY KEY,
  no          TEXT        NOT NULL,
  draft       BOOLEAN     NOT NULL DEFAULT FALSE,
  sort_key    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS students (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  year        SMALLINT    CHECK (year BETWEEN 1 AND 4),
  girl        BOOLEAN     NOT NULL DEFAULT FALSE,
  branch      TEXT        NOT NULL DEFAULT '',
  team_id     INTEGER     REFERENCES teams(id) ON DELETE SET NULL,
  seat        INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A student on a team always has a seat; one in the pool never does.
  CONSTRAINT seat_matches_team CHECK ((team_id IS NULL) = (seat IS NULL))
);

CREATE INDEX IF NOT EXISTS students_team_idx ON students (team_id, seat);

-- Single row, enforced by the primary key. Holds the editable rule numbers.
CREATE TABLE IF NOT EXISTS rules (
  id          BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),
  data        JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every change to the register, so a disputed move can be traced back.
CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGSERIAL   PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  action  TEXT        NOT NULL,
  detail  JSONB       NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
