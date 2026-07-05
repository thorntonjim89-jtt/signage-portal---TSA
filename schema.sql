-- Signage portal schema.
-- Run this once against your Netlify DB (or local Postgres) before starting the app.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('client', 'team', 'supplier')),
  company_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotes (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  specs JSONB,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'pricing', 'priced', 'accepted', 'declined', 'converted')),
  internal_cost NUMERIC(12, 2),
  internal_markup_percent NUMERIC(6, 2),
  client_price NUMERIC(12, 2),
  priced_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_requests (
  id SERIAL PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'submitted', 'declined')),
  message TEXT,
  cost_price NUMERIC(12, 2),
  notes TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  quote_id INTEGER NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  current_stage INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_stages (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_number INTEGER NOT NULL CHECK (stage_number BETWEEN 1 AND 7),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (project_id, stage_number)
);

CREATE TABLE IF NOT EXISTS photos (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  blob_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qna_messages (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed a demo "team" account. Team/staff accounts are never created through
-- public self-registration (see auth-register.js), so at least one has to be
-- seeded here to be able to log in as team the first time.
-- Email: team@example.com   Password: TeamDemo123!
-- Change or remove this before any real deployment.
INSERT INTO users (email, password_hash, name, role)
VALUES ('team@example.com', '$2a$10$3W.q0zkQj3Un4TLNEerKRuz10zWLVf6Rrc599sZ2F0le84xR6sHWy', 'Demo Team Member', 'team')
ON CONFLICT (email) DO NOTHING;
