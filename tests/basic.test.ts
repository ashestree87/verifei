import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScoreService } from '../src/score';
import { VerificationStatus } from '../src/utils/types';

describe('Email Verification Tests', () => {
  describe('ScoreService', () => {
    let scoreService: ScoreService;
    
    beforeEach(() => {
      scoreService = new ScoreService();
    });
    
    it('should mark email with invalid syntax as undeliverable', () => {
      const result = scoreService.calculateScore(
        'invalid-email',
        false, // syntax valid
        false, // is disposable
        false, // dns valid
        null,  // is catch-all
        false, // smtp valid
        undefined // smtp response code
      );
      
      expect(result.status).toBe(VerificationStatus.UNDELIVERABLE);
      expect(result.score).toBe(0);
      expect(result.reason).toContain('syntax');
    });
    
    it('should mark email with invalid DNS as undeliverable', () => {
      const result = scoreService.calculateScore(
        'test@non-existent-domain.com',
        true,  // syntax valid
        false, // is disposable
        false, // dns valid
        null,  // is catch-all
        false, // smtp valid
        undefined // smtp response code
      );
      
      expect(result.status).toBe(VerificationStatus.UNDELIVERABLE);
      expect(result.score).toBe(0);
      expect(result.reason).toContain('domain');
    });
    
    it('should give lower score to disposable emails', () => {
      const resultNormal = scoreService.calculateScore(
        'test@gmail.com',
        true,  // syntax valid
        false, // is disposable
        true,  // dns valid
        false, // is catch-all
        true,  // smtp valid
        250    // smtp response code
      );
      
      const resultDisposable = scoreService.calculateScore(
        'test@disposable.com',
        true,  // syntax valid
        true,  // is disposable
        true,  // dns valid
        false, // is catch-all
        true,  // smtp valid
        250    // smtp response code
      );
      
      expect(resultNormal.score).toBeGreaterThan(resultDisposable.score);
      expect(resultDisposable.reason).toContain('Disposable');
    });
    
    it('should mark successful email as deliverable', () => {
      const result = scoreService.calculateScore(
        'test@example.com',
        true,  // syntax valid
        false, // is disposable
        true,  // dns valid
        false, // is catch-all
        true,  // smtp valid
        250    // smtp response code
      );
      
      expect(result.status).toBe(VerificationStatus.DELIVERABLE);
      expect(result.score).toBe(100);
      expect(result.reason).toBeUndefined();
    });
    
    it('should mark catch-all domains as risky', () => {
      const result = scoreService.calculateScore(
        'test@catch-all-domain.com',
        true,   // syntax valid
        false,  // is disposable
        true,   // dns valid
        true,   // is catch-all
        true,   // smtp valid
        250     // smtp response code
      );
      
      expect(result.status).toBe(VerificationStatus.RISKY);
      expect(result.score).toBeLessThan(100);
      expect(result.reason).toContain('catch-all');
    });
  });
}); 