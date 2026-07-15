-- Signage portal schema.
-- Run this once against your Netlify DB (or local Postgres) before starting the app.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('client', 'team', 'supplier')),
  company_name TEXT,
  -- Client/supplier self-registrations start 'pending' and can't log in
  -- until a team member approves them (see auth-register.js/auth-login.js).
  -- Team accounts are inserted directly and default to 'approved'.
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
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
  -- The supplier who actually fabricated this job, if any (picked by team at
  -- conversion time from whoever priced the originating quote). Null means
  -- it was produced in-house. This is what gives a supplier ongoing access
  -- to a project after the quoting phase, e.g. to report a defect.
  supplier_id INTEGER REFERENCES users(id),
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

-- File bytes live directly in Postgres (not Netlify Blobs) so uploads don't
-- depend on Netlify's blob storage being provisioned for the site.
CREATE TABLE IF NOT EXISTS photos (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  file_data BYTEA NOT NULL,
  content_type TEXT NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quote_attachments (
  id SERIAL PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  file_data BYTEA NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Team-uploaded design reference material (mockups, renders, PDFs) shown
-- under the Design & Proofing stage, for the client to review alongside
-- their approval — distinct from the client's own quote-request attachments.
CREATE TABLE IF NOT EXISTS design_packs (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  file_data BYTEA NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- General-purpose project document library (specs, contracts, trackers, RFI
-- logs, etc.) — not tied to any one stage. Both team and client can upload,
-- unlike design_packs which is team-only.
CREATE TABLE IF NOT EXISTS project_documents (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  file_data BYTEA NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A message belongs to exactly one of a project or a quote, so clients can
-- ask questions before their request has even been priced, not just after
-- it becomes a project.
CREATE TABLE IF NOT EXISTS qna_messages (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT qna_messages_one_parent CHECK (
    (project_id IS NOT NULL AND quote_id IS NULL) OR
    (project_id IS NULL AND quote_id IS NOT NULL)
  )
);

-- A single shared punch list per project: a client and a supplier are often
-- reporting the same physical defect, and siloing them into two disconnected
-- rows meant resolving one side left the other stuck open forever. Team,
-- the project's client, and the project's assigned supplier all see every
-- issue on the project (see project-issues.js). `source` still records who
-- originally reported it, purely as context.
CREATE TABLE IF NOT EXISTS project_issues (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('client', 'supplier', 'team')),
  reported_by INTEGER NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'wont_fix')),
  file_data BYTEA,
  content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- An audit trail of responses to an issue — a status change plus an
-- optional note and proof-of-fix photo — instead of a single overwritable
-- status field with no record of what was actually done.
CREATE TABLE IF NOT EXISTS project_issue_responses (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES project_issues(id) ON DELETE CASCADE,
  responder_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved', 'wont_fix')),
  description TEXT,
  file_data BYTEA,
  content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upcoming milestones for a project (e.g. "ceiling signage L23-L28 install"
-- scheduled for a given date) — the 7-stage timeline is deliberately coarse
-- and has no room for this level of detail. Team manages these; client and
-- team both see them (see scheduled-work.js).
CREATE TABLE IF NOT EXISTS scheduled_work (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  scheduled_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'complete')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Temporary holding area for large-file uploads. The browser splits a big
-- file into pieces small enough to fit in a single Netlify Function request
-- and uploads them here one at a time (upload-chunk.js); once they're all in,
-- upload-finalize.js assembles them into the real photos/quote_attachments/
-- project_issues row and deletes the chunk rows. Nothing here is meant to
-- persist beyond that assembly step.
CREATE TABLE IF NOT EXISTS upload_chunks (
  id SERIAL PRIMARY KEY,
  upload_id TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  chunk_index INTEGER NOT NULL,
  chunk_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (upload_id, chunk_index)
);

-- Team/staff accounts are never created through public self-registration
-- (see auth-register.js), so at least one has to be inserted manually to log
-- in as team the first time. Run something like the following once, with a
-- real email and a bcrypt hash of a real password (see README):
--
-- INSERT INTO users (email, password_hash, name, role)
-- VALUES ('you@example.com', '<bcrypt hash>', 'Your Name', 'team');
