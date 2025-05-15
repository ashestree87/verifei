import { parseDomain, ParseResultType } from 'parse-domain';
import { DnsService } from './dns';
import { SmtpService } from './smtp';
import { ScoreService } from './score';
import { DnsResult, Env, VerificationResult, VerificationStatus } from './utils/types';

/**
 * Cache entry for domain verification results
 */
interface DomainCache {
  dnsResult: DnsResult;
  isCatchAll: boolean | null;
  bannerSeen: string | null;
  timestamp: number;
}

/**
 * Cache entry for email verification results
 */
interface EmailCache {
  result: VerificationResult;
  timestamp: number;
}

/**
 * Request body for email verification
 */
interface VerifyEmailRequest {
  email: string;
}

/**
 * Durable Object for email verification
 * One instance per domain to control concurrency and enable caching
 */
export class VerifeiDO {
  private state: DurableObjectState;
  private env: Env;
  private domainCache = new Map<string, DomainCache>();
  private emailCache = new Map<string, EmailCache>();
  private dnsService: DnsService;
  private smtpService: SmtpService;
  private scoreService: ScoreService;
  private activeTasks = 0;
  private readonly maxConcurrentTasks: number;
  private readonly cacheTimeMs = 60 * 60 * 1000; // 1 hour
  
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.dnsService = new DnsService();
    this.smtpService = new SmtpService(
      env.SMTP_HELO_DOMAIN,
      env.PROBE_EMAIL,
      parseInt(env.SMTP_TIMEOUT_MS, 10),
      parseInt(env.MAX_CONCURRENCY_PER_MX, 10)
    );
    this.scoreService = new ScoreService();
    this.maxConcurrentTasks = parseInt(env.MAX_CONCURRENCY_PER_MX, 10);
    
    // Instead of setting alarms, we'll use a simple periodic check on fetch
    // since DurableObjectState alarms are not available in the type definition
  }
  
  /**
   * Handle fetch requests to the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Perform a cache cleanup on each request
    this.cleanCache();
    
    if (path === '/verify' && request.method === 'POST') {
      const data = await request.json() as VerifyEmailRequest;
      
      if (!data.email || typeof data.email !== 'string') {
        return new Response('Email parameter is required', { status: 400 });
      }
      
      try {
        // Check if we've reached the concurrency limit
        if (this.activeTasks >= this.maxConcurrentTasks) {
          return new Response('Too many concurrent verifications', { status: 429 });
        }
        
        // Verify the email
        const result = await this.verify(data.email);
        
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Verification error:', error);
        return new Response(`Verification error: ${error instanceof Error ? error.message : String(error)}`, {
          status: 500
        });
      }
    }
    
    return new Response('Not found', { status: 404 });
  }
  
  /**
   * Clean up expired cache entries
   */
  private cleanCache(): void {
    const now = Date.now();
    
    // Clean domain cache (items older than cache TTL)
    for (const [domain, cache] of this.domainCache.entries()) {
      if (now - cache.timestamp > this.cacheTimeMs) {
        this.domainCache.delete(domain);
      }
    }
    
    // Clean email cache (items older than their TTL)
    for (const [email, cache] of this.emailCache.entries()) {
      if (now - cache.timestamp > cache.result.ttl) {
        this.emailCache.delete(email);
      }
    }
  }
  
  /**
   * Verify an email address
   * @param email - The email address to verify
   * @returns Promise with verification result
   */
  async verify(email: string): Promise<VerificationResult> {
    try {
      this.activeTasks++;
      
      // 1. Basic validation
      if (!this.isValidEmailSyntax(email)) {
        return this.scoreService.calculateScore(
          email,
          false, // syntax valid
          false, // is disposable
          false, // dns valid
          null,  // is catch-all
          false, // smtp valid
          undefined // smtp response code
        );
      }
      
      // Extract the domain
      const domain = email.split('@')[1].toLowerCase();
      
      // 2. Check if email is already cached
      const cachedEmail = this.emailCache.get(email);
      if (cachedEmail) {
        return cachedEmail.result;
      }
      
      // 3. Check if domain is disposable
      const isDisposable = await this.isDisposableDomain(domain);
      
      // 4. Perform or retrieve cached DNS check
      let dnsResult: DnsResult;
      let isCatchAll: boolean | null = null;
      
      const cachedDomain = this.domainCache.get(domain);
      if (cachedDomain) {
        dnsResult = cachedDomain.dnsResult;
        isCatchAll = cachedDomain.isCatchAll;
      } else {
        // Perform DNS lookup
        dnsResult = await this.dnsService.lookup(domain);
        
        // Cache the DNS result
        this.domainCache.set(domain, {
          dnsResult,
          isCatchAll: null, // We'll set this later if needed
          bannerSeen: null,
          timestamp: Date.now()
        });
      }
      
      // If no valid DNS records, return early
      const dnsValid = dnsResult.hasMx || dnsResult.hasA;
      if (!dnsValid) {
        const result = this.scoreService.calculateScore(
          email,
          true,  // syntax valid
          isDisposable,
          false, // dns valid
          null,  // is catch-all
          false, // smtp valid
          undefined // smtp response code
        );
        
        this.cacheEmailResult(email, result);
        return result;
      }
      
      // 5. Perform SMTP verification
      let smtpResult;
      
      // If we have MX records, use them for SMTP check
      if (dnsResult.hasMx && dnsResult.records.length > 0) {
        smtpResult = await this.smtpService.verify(email, dnsResult.records);
        
        // 6. Test catch-all if necessary and not already cached
        if (cachedDomain && cachedDomain.isCatchAll === null) {
          isCatchAll = await this.smtpService.testCatchAll(domain, dnsResult.records);
          
          // Update the domain cache with catch-all info
          this.domainCache.set(domain, {
            ...cachedDomain,
            isCatchAll,
            timestamp: Date.now()
          });
        }
      } else {
        // No MX records, but the domain is valid - fall back to external service
        // or mark as unknown
        smtpResult = {
          success: false,
          isCatchAll: null,
          error: 'Domain has no mail exchanger records'
        };
      }
      
      // 7. Score the result
      const result = this.scoreService.calculateScore(
        email,
        true,  // syntax valid
        isDisposable,
        dnsValid,
        isCatchAll,
        smtpResult.success,
        smtpResult.response?.code
      );
      
      // Cache the result
      this.cacheEmailResult(email, result);
      
      return result;
    } finally {
      this.activeTasks--;
    }
  }
  
  /**
   * Check if an email address has valid syntax
   * @param email - The email address to check
   * @returns Boolean indicating if syntax is valid
   */
  private isValidEmailSyntax(email: string): boolean {
    // RFC 5322 compliant email regex
    const regex = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    
    if (!regex.test(email)) {
      return false;
    }
    
    // Check domain part using parse-domain
    const domainPart = email.split('@')[1];
    const result = parseDomain(domainPart);
    
    if (result.type !== ParseResultType.Listed) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Check if a domain is disposable by consulting KV blocklist
   * @param domain - The domain to check
   * @returns Promise with boolean indicating if domain is disposable
   */
  private async isDisposableDomain(domain: string): Promise<boolean> {
    try {
      // Check if domain is directly in the blocklist
      const isBlocked = await this.env.EMAIL_BLOCKLIST.get(`blocklist/disposable/${domain}`);
      if (isBlocked) {
        return true;
      }
      
      // Check if domain is a subdomain of a blocked domain
      const result = parseDomain(domain);
      
      if (result.type === ParseResultType.Listed) {
        const rootDomain = `${result.domain}.${result.topLevelDomains.join('.')}`;
        const isRootBlocked = await this.env.EMAIL_BLOCKLIST.get(`blocklist/disposable/${rootDomain}`);
        return !!isRootBlocked;
      }
      
      return false;
    } catch (error) {
      console.error('Error checking disposable domain:', error);
      return false; // Assume not disposable if check fails
    }
  }
  
  /**
   * Cache an email verification result
   * @param email - The verified email address
   * @param result - The verification result
   */
  private cacheEmailResult(email: string, result: VerificationResult): void {
    this.emailCache.set(email, {
      result,
      timestamp: Date.now()
    });
  }
} 