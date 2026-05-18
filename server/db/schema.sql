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

-- ─── SEED: default super admin (change password immediately after setup) ─────
-- password: superadmin123  (bcrypt hash below)
INSERT INTO super_admins (name, email, password_hash)
VALUES (
  'Platform Admin',
  'admin@schoolpay.local',
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'  -- "password"
) ON CONFLICT (email) DO NOTHING;
