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
    
    const timeout = parseInt(env.SMTP_TIMEOUT_MS, 10) || 5000;
    
    this.dnsService = new DnsService(timeout);
    this.smtpService = new SmtpService(
      env.SMTP_HELO_DOMAIN,
      env.PROBE_EMAIL,
      timeout,
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
    
    console.log(`DO fetch request to path: ${path}`);
    
    // Perform a cache cleanup on each request
    this.cleanCache();
    
    if (path === '/verify' && request.method === 'POST') {
      console.log('Processing /verify request in DO');
      
      let email: string;
      try {
        const data = await request.json() as VerifyEmailRequest;
        
        if (!data.email || typeof data.email !== 'string') {
          return new Response('Email parameter is required', { status: 400 });
        }
        
        email = data.email;
      } catch (error) {
        console.error('Error parsing request body:', error);
        return new Response('Invalid request body', { status: 400 });
      }
      
      try {
        // Check if we've reached the concurrency limit
        if (this.activeTasks >= this.maxConcurrentTasks) {
          console.log(`Too many concurrent verifications (${this.activeTasks}/${this.maxConcurrentTasks})`);
          return new Response('Too many concurrent verifications', { status: 429 });
        }
        
        console.log(`Starting verification for: ${email}`);
        
        // Create a verification timeout
        const verifyTimeoutPromise = new Promise<VerificationResult>((resolve) => {
          setTimeout(() => {
            console.log(`Internal timeout while verifying: ${email}`);
            resolve({
              email,
              status: VerificationStatus.TIMEOUT,
              score: 0,
              reason: 'Internal verification timeout',
              checkedAt: Date.now(),
              ttl: 15 * 60 * 1000 // 15 minutes
            });
          }, 10000); // 10 second timeout
        });
        
        // Verify the email with a timeout
        const resultPromise = this.verify(email);
        const result = await Promise.race([resultPromise, verifyTimeoutPromise]);
        
        console.log(`Completed verification for ${email} with status: ${result.status}`);
        
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error(`Verification error for ${email || 'unknown email'}:`, error);
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
      
      // Setup an abort controller for timeouts
      const controller = new AbortController();
      const signal = controller.signal;
      
      // Use a 25 second timeout to ensure we don't hit the worker limit
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 25000);
      
      try {
        // 1. Basic validation
        if (!this.isValidEmailSyntax(email)) {
          const result = this.scoreService.calculateScore(
            email,
            false, // syntax valid
            false, // is disposable
            false, // dns valid
            null,  // is catch-all
            false, // smtp valid
            undefined // smtp response code
          );
          
          return result;
        }
        
        // Extract the domain
        const domain = email.split('@')[1].toLowerCase();
        
        // 2. Check if email is already cached
        const cachedEmail = this.emailCache.get(email);
        if (cachedEmail) {
          return cachedEmail.result;
        }
        
        // 3. Check if domain is disposable - with abort signal
        let isDisposable = false;
        try {
          isDisposable = await this.isDisposableDomain(domain);
        } catch (error) {
          if (signal.aborted) {
            throw new Error('Operation timed out');
          }
          console.error(`Error checking if domain is disposable: ${error}`);
        }
        
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
          
          // Check if we've been aborted
          if (signal.aborted) {
            throw new Error('Operation timed out');
          }
          
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
          // Check if we've been aborted before making SMTP calls
          if (signal.aborted) {
            throw new Error('Operation timed out');
          }
          
          smtpResult = await this.smtpService.verify(email, dnsResult.records);
          
          // Check if we've been aborted
          if (signal.aborted) {
            throw new Error('Operation timed out');
          }
          
          // 6. Test catch-all if necessary and not already cached
          if (cachedDomain && cachedDomain.isCatchAll === null) {
            try {
              isCatchAll = await this.smtpService.testCatchAll(domain, dnsResult.records);
              
              // Check if we've been aborted
              if (signal.aborted) {
                throw new Error('Operation timed out');
              }
              
              // Update the domain cache with catch-all info
              this.domainCache.set(domain, {
                ...cachedDomain,
                isCatchAll,
                timestamp: Date.now()
              });
            } catch (catchAllError) {
              console.error(`Error testing catch-all for ${domain}:`, catchAllError);
              // Continue without catch-all info
            }
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
      } catch (error) {
        // If we have an abort error, return a specific result
        if (error instanceof Error && error.name === 'AbortError' || 
            (error instanceof Error && error.message === 'Operation timed out')) {
          console.error(`Verification timed out for ${email}`);
          
          // Return a timeout-specific result
          return {
            email,
            status: VerificationStatus.TIMEOUT,
            score: 0,
            reason: 'Verification timed out',
            checkedAt: Date.now(),
            ttl: 15 * 60 * 1000 // 15 minutes - shorter cache for timeouts
          };
        }
        
        // Re-throw other errors
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
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
      // Reduce timeout for KV operations to be very fast
      const kvTimeout = 2000; // 2 seconds
      
      // Check if domain is directly in the blocklist
      const isBlockedPromise = this.env.EMAIL_BLOCKLIST.get(`blocklist/disposable/${domain}`);
      const timeoutPromise = new Promise<null>((_, reject) => {
        setTimeout(() => reject(new Error('KV lookup timed out')), kvTimeout);
      });
      
      // Race the KV lookup against the timeout
      const isBlocked = await Promise.race([isBlockedPromise, timeoutPromise]) as string | null;
      
      if (isBlocked) {
        return true;
      }
      
      // Check if domain is a subdomain of a blocked domain
      const result = parseDomain(domain);
      
      if (result.type === ParseResultType.Listed) {
        const rootDomain = `${result.domain}.${result.topLevelDomains.join('.')}`;
        
        // Same timeout pattern for the root domain check
        const isRootBlockedPromise = this.env.EMAIL_BLOCKLIST.get(`blocklist/disposable/${rootDomain}`);
        const isRootBlocked = await Promise.race([isRootBlockedPromise, timeoutPromise]) as string | null;
        
        return !!isRootBlocked;
      }
      
      return false;
    } catch (error) {
      // Specific logging for timeout errors
      if (error instanceof Error && error.message === 'KV lookup timed out') {
        console.warn(`KV lookup timed out for domain: ${domain}`);
      } else {
        console.error('Error checking disposable domain:', error);
      }
      
      // Assume not disposable if check fails, but allow the verification to continue
      return false;
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