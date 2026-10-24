-- SchoolPay Multi-Tenant Schema
-- Run once against your PostgreSQL database: psql -U postgres -d schoolpay -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── SCHOOLS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schools (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(255) NOT NULL,
  slug                VARCHAR(100) UNIQUE NOT NULL,        -- URL identifier e.g. "greenfield-primary"
  type                VARCHAR(20)  NOT NULL CHECK (type IN ('primary','secondary','university')),
  logo_url            TEXT,
  bank_name           VARCHAR(255),
  bank_account        VARCHAR(50),
  bank_account_name   VARCHAR(255),
  paystack_public_key TEXT,
  paystack_secret_key TEXT,                               -- stored, never sent to client
  from_email          VARCHAR(255),                       -- sender address for receipts
  smtp_host           VARCHAR(255),
  smtp_port           INTEGER DEFAULT 587,
  smtp_user           VARCHAR(255),
  smtp_pass           TEXT,
  active              BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── SUPER ADMINS (platform owner only) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS super_admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── USERS (school staff: admin, bursar, accountant) ────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  role          VARCHAR(20) NOT NULL CHECK (role IN ('school_admin','bursar','accountant')),
  password_hash TEXT NOT NULL,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(school_id, email)
);

-- ─── PAYMENT TYPES (fee definitions per school) ──────────────────────────────
CREATE TABLE IF NOT EXISTS payment_types (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  term          VARCHAR(100),                             -- e.g. "First Term", "Semester 1"
  academic_year VARCHAR(20),                             -- e.g. "2025/2026"
  is_mandatory  BOOLEAN DEFAULT true,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PAYMENTS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payment_type_id  UUID REFERENCES payment_types(id),
  student_id       VARCHAR(100) NOT NULL,
  student_name     VARCHAR(255) NOT NULL,
  student_email    VARCHAR(255) NOT NULL,
  student_class    VARCHAR(100),
  reference        VARCHAR(120) UNIQUE NOT NULL,
  amount           NUMERIC(12,2) NOT NULL,
  method           VARCHAR(20) NOT NULL CHECK (method IN ('paystack','bank')),
  status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','failed','refunded')),
  paystack_ref     VARCHAR(255),
  confirmed_at     TIMESTAMPTZ,
  confirmed_by     UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_school     ON payments(school_id);
CREATE INDEX IF NOT EXISTS idx_payments_student    ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_reference  ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_status     ON payments(status);

-- ─── BANK DOCUMENTS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payment_id     UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  file_path      TEXT NOT NULL,
  file_name      VARCHAR(255) NOT NULL,
  file_size      INTEGER,
  mime_type      VARCHAR(100),
  uploaded_at    TIMESTAMPTZ DEFAULT NOW(),
  review_status  VARCHAR(20) DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  reviewed_by    UUID REFERENCES users(id),
  review_note    TEXT,
  reviewed_at    TIMESTAMPTZ
);

-- ─── RECEIPTS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receipts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payment_id     UUID NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
  receipt_number VARCHAR(100) UNIQUE NOT NULL,
  issued_at      TIMESTAMPTZ DEFAULT NOW(),
  voided         BOOLEAN DEFAULT false,
  voided_at      TIMESTAMPTZ,
  voided_by      UUID REFERENCES users(id)
);

-- ─── COMPLAINTS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS complaints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payment_id    UUID REFERENCES payments(id),             -- optional, looked up by reference
  reference     VARCHAR(120),
  student_id    VARCHAR(100) NOT NULL,
  student_name  VARCHAR(255) NOT NULL,
  student_email VARCHAR(255) NOT NULL,
  subject       VARCHAR(255) NOT NULL,
  body          TEXT NOT NULL,
  status        VARCHAR(20) DEFAULT 'open'
                  CHECK (status IN ('open','in_review','resolved','rejected')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_complaints_school ON complaints(school_id);

-- ─── COMPLAINT REPLIES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS complaint_replies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id   UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  responder_id   UUID REFERENCES users(id),               -- NULL = student reply
  responder_name VARCHAR(255) NOT NULL,
  is_admin       BOOLEAN DEFAULT false,
  message        TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- The first platform admin is created at startup from SEED_ADMIN_EMAIL and
-- SEED_ADMIN_PASSWORD (see ensureSuperAdmin in server/index.js), so no
-- password ever lives in this file.

-- ─── FEE CATEGORIES + MULTI-FEE PAYMENTS ─────────────────────────────────────
-- Added after launch, so every statement is idempotent and safe to re-run on a
-- database that already holds live payments.

-- Categories are a plain label on the fee type rather than a table of their
-- own: a school types "Levies" on three fees and they group. category_slug is
-- the URL form, kept in the row so the per-category payment link can be
-- resolved with an index rather than by slugifying every row on every request.
ALTER TABLE payment_types ADD COLUMN IF NOT EXISTS category      VARCHAR(80);
ALTER TABLE payment_types ADD COLUMN IF NOT EXISTS category_slug VARCHAR(80);
CREATE INDEX IF NOT EXISTS idx_payment_types_category
  ON payment_types(school_id, category_slug);

-- One row per fee inside a payment. A single-fee payment still sets
-- payments.payment_type_id, so every existing query keeps working; a multi-fee
-- payment leaves it null and lives entirely in this table.
--
-- Name, term and year are snapshotted at payment time on purpose: a receipt has
-- to keep saying what was actually bought even after the school renames or
-- reprices the fee.
CREATE TABLE IF NOT EXISTS payment_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  payment_type_id UUID REFERENCES payment_types(id),
  name            VARCHAR(255) NOT NULL,
  term            VARCHAR(100),
  academic_year   VARCHAR(20),
  amount          NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_items_payment ON payment_items(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_items_type    ON payment_items(payment_type_id);
