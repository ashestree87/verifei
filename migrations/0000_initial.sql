-- Create the email verification results table
CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  score INTEGER NOT NULL,
  reason TEXT,
  checked_at INTEGER NOT NULL,
  ttl INTEGER NOT NULL,
  job_id TEXT,
  domain TEXT GENERATED ALWAYS AS (substr(email, instr(email, '@') + 1)) VIRTUAL,
  UNIQUE(email)
);

-- Create indices for quick lookups
CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email);
CREATE INDEX IF NOT EXISTS idx_email_verifications_job_id ON email_verifications(job_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_domain ON email_verifications(domain);
CREATE INDEX IF NOT EXISTS idx_email_verifications_checked_at ON email_verifications(checked_at);

-- Create the jobs table to track verification jobs
CREATE TABLE IF NOT EXISTS verification_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  total_emails INTEGER NOT NULL,
  processed_emails INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  file_name TEXT,
  file_size INTEGER
);

-- Table for GDPR delete requests
CREATE TABLE IF NOT EXISTS deletion_requests (
  email TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL
); 