import { VerificationResult, VerificationStatus } from './utils/types';

/**
 * Service for scoring email verification results
 */
export class ScoreService {
  /**
   * Calculate verification score and status
   * @param email - The email address being verified
   * @param syntaxValid - Whether the email syntax is valid
   * @param isDisposable - Whether the domain is disposable
   * @param dnsValid - Whether the domain has valid DNS records
   * @param isCatchAll - Whether the domain accepts catch-all emails
   * @param smtpValid - Whether the SMTP verification succeeded
   * @param smtpResponseCode - The SMTP response code (if available)
   * @returns Verification result with score and status
   */
  calculateScore(
    email: string,
    syntaxValid: boolean,
    isDisposable: boolean,
    dnsValid: boolean,
    isCatchAll: boolean | null,
    smtpValid: boolean,
    smtpResponseCode?: number
  ): VerificationResult {
    // Start with current timestamp for the checked_at field
    const now = Date.now();
    
    // If syntax is invalid, immediate failure
    if (!syntaxValid) {
      return {
        email,
        status: VerificationStatus.UNDELIVERABLE,
        score: 0,
        reason: 'Invalid email syntax',
        checkedAt: now,
        ttl: this.calculateTtl(0)
      };
    }
    
    // If DNS lookup failed, immediate failure
    if (!dnsValid) {
      return {
        email,
        status: VerificationStatus.UNDELIVERABLE,
        score: 0,
        reason: 'Domain has no valid mail server',
        checkedAt: now,
        ttl: this.calculateTtl(0)
      };
    }
    
    // Base score calculation
    let score = 0;
    let reason = '';
    
    // Disposable email penalty
    if (isDisposable) {
      score += 20;
      reason = 'Disposable email domain';
    } else {
      score += 50;
    }
    
    // Catch-all domain penalty
    if (isCatchAll === true) {
      score += 20;
      reason = reason ? `${reason}, catch-all domain` : 'Catch-all domain';
    } else if (isCatchAll === false) {
      score += 30;
    }
    
    // SMTP verification is the biggest factor
    if (smtpValid) {
      score += 50;
    } else if (smtpResponseCode) {
      // Different types of failures have different impacts
      if (smtpResponseCode >= 500) {
        // Hard failure (5xx)
        score += 0;
        reason = reason ? `${reason}, mailbox does not exist` : 'Mailbox does not exist';
      } else if (smtpResponseCode >= 400) {
        // Temporary failure (4xx)
        score += 10;
        reason = reason ? `${reason}, temporary failure` : 'Temporary mailbox failure';
      }
    }
    
    // Calculate final status based on score
    let status: VerificationStatus;
    
    if (score === 100) {
      status = VerificationStatus.DELIVERABLE;
    } else if (score >= 70 && isCatchAll) {
      status = VerificationStatus.RISKY;
    } else if (score < 70 || smtpResponseCode === undefined) {
      status = VerificationStatus.UNKNOWN;
    } else if (smtpResponseCode >= 500) {
      status = VerificationStatus.UNDELIVERABLE;
    } else {
      status = VerificationStatus.UNKNOWN;
    }
    
    return {
      email,
      status,
      score,
      reason: reason || undefined,
      checkedAt: now,
      ttl: this.calculateTtl(score)
    };
  }
  
  /**
   * Calculate TTL (time-to-live) for caching based on score
   * Higher scores get longer TTL
   * @param score - The verification score
   * @returns TTL value in milliseconds
   */
  private calculateTtl(score: number): number {
    // Base TTL: 1 hour
    const baseMs = 60 * 60 * 1000;
    
    if (score >= 90) {
      // High confidence: cache for 24 hours
      return baseMs * 24;
    } else if (score >= 70) {
      // Medium confidence: cache for 12 hours
      return baseMs * 12;
    } else if (score >= 50) {
      // Lower confidence: cache for 6 hours
      return baseMs * 6;
    } else {
      // Low confidence: cache for 1 hour
      return baseMs;
    }
  }
} 