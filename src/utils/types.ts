export interface Env {
  VERIFEI: DurableObjectNamespace;
  DB: D1Database;
  EMAIL_BLOCKLIST: KVNamespace;
  VERIFICATION_QUEUE: Queue<VerificationJob>;
  SMTP_HELO_DOMAIN: string;
  PROBE_EMAIL: string;
  MAX_CONCURRENCY_PER_MX: string;
  SMTP_TIMEOUT_MS: string;
  GRAY_RETRY_AFTER_SEC: string;
  DISPOSABLE_LIST_URL?: string;
}

export interface VerificationJob {
  jobId: string;
  emails: string[];
  batchIndex: number;
  totalBatches: number;
}

export interface VerificationResult {
  email: string;
  status: VerificationStatus;
  score: number;
  reason?: string;
  checkedAt: number;
  ttl: number;
}

export enum VerificationStatus {
  DELIVERABLE = 'deliverable',
  RISKY = 'risky',
  UNKNOWN = 'unknown',
  UNDELIVERABLE = 'undeliverable',
  TIMEOUT = 'timeout'
}

export interface MXRecord {
  priority: number;
  exchange: string;
}

export interface DnsResult {
  hasMx: boolean;
  records: MXRecord[];
  hasA: boolean;
}

export interface SmtpResponse {
  code: number;
  message: string;
}

export interface SmtpResult {
  success: boolean;
  isCatchAll: boolean | null;
  response?: SmtpResponse;
  error?: string;
}

export interface DisposableDomain {
  domain: string;
  category: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  totalEmails: number;
  processedEmails: number;
  createdAt: number;
  completedAt?: number;
  fileName?: string;
  fileSize?: number;
}

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed'
} 