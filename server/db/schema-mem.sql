-- Simplified schema for pg-mem (in-memory dev mode)
-- Uses TEXT for UUIDs, REAL for money, TIMESTAMP for dates

CREATE TABLE IF NOT EXISTS schools (
  id                  TEXT PRIMARY KEY DEFAULT 'placeholder',
  name                TEXT NOT NULL,
  slug                TEXT UNIQUE NOT NULL,
  type                TEXT NOT NULL,
  logo_url            TEXT,
  bank_name           TEXT,
  bank_account        TEXT,
  bank_account_name   TEXT,
  paystack_public_key TEXT,
  paystack_secret_key TEXT,
  from_email          TEXT,
  smtp_host           TEXT,
  smtp_port           INTEGER DEFAULT 587,
  smtp_user           TEXT,
  smtp_pass           TEXT,
  active              BOOLEAN DEFAULT true,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS super_admins (
  id            TEXT PRIMARY KEY DEFAULT 'placeholder',
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT 'placeholder',
  school_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_types (
  id            TEXT PRIMARY KEY DEFAULT 'placeholder',
  school_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  amount        REAL NOT NULL DEFAULT 0,
  term          TEXT,
  academic_year TEXT,
  is_mandatory  BOOLEAN DEFAULT true,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id               TEXT PRIMARY KEY DEFAULT 'placeholder',
  school_id        TEXT NOT NULL,
  payment_type_id  TEXT,
  student_id       TEXT NOT NULL,
  student_name     TEXT NOT NULL,
  student_email    TEXT NOT NULL,
  student_class    TEXT,
  reference        TEXT UNIQUE NOT NULL,
  amount           REAL NOT NULL,
  method           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  paystack_ref     TEXT,
  confirmed_at     TIMESTAMP,
  confirmed_by     TEXT,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bank_documents (
  id             TEXT PRIMARY KEY DEFAULT 'placeholder',
  school_id      TEXT NOT NULL,
  payment_id     TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  file_size      INTEGER,
  mime_type      TEXT,
  uploaded_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  review_status  TEXT DEFAULT 'pending',
  reviewed_by    TEXT,
  review_note    TEXT,
  reviewed_at    TIMESTAMP
);

CREATE TABLE IF NOT EXISTS receipts (
  id             TEXT PRIMARY KEY DEFAULT 'placeholder',
  school_id      TEXT NOT NULL,
  payment_id     TEXT UNIQUE NOT NULL,
  receipt_number TEXT UNIQUE NOT NULL,
  issued_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  voided         BOOLEAN DEFAULT false,
  voided_at      TIMESTAMP,
  voided_by      TEXT
);

CREATE TABLE IF NOT EXISTS complaints (
  id            TEXT PRIMARY KEY DEFAULT 'placeholder',
  school_id     TEXT NOT NULL,
  payment_id    TEXT,
  reference     TEXT,
  student_id    TEXT NOT NULL,
  student_name  TEXT NOT NULL,
  student_email TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT DEFAULT 'open',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS complaint_replies (
  id             TEXT PRIMARY KEY DEFAULT 'placeholder',
  complaint_id   TEXT NOT NULL,
  responder_id   TEXT,
  responder_name TEXT NOT NULL,
  is_admin       BOOLEAN DEFAULT false,
  message        TEXT NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
