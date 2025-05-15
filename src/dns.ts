import { DnsResult, MXRecord } from './utils/types';

interface DnsResponse {
  Status: number;
  Answer?: {
    name: string;
    type: number;
    TTL: number;
    data: string;
  }[];
}

/**
 * DNS utility class for performing MX and A record lookups
 * using Cloudflare's DNS over HTTPS API
 */
export class DnsService {
  private readonly dnsApiBase = 'https://cloudflare-dns.com/dns-query';
  private readonly timeoutMs: number;
  
  /**
   * Create a new DNS service instance
   * @param timeoutMs - Timeout for DNS queries in milliseconds
   */
  constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
  }
  
  /**
   * Fetch with timeout
   * @param url - URL to fetch
   * @param options - Fetch options
   * @returns Promise with the fetch response
   */
  private async fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const signal = controller.signal;
    
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    
    try {
      const response = await fetch(url, { ...options, signal });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      
      // Check if it's an abortion error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.timeoutMs}ms`);
      }
      
      throw error;
    }
  }
  
  /**
   * Perform DNS lookups for a domain
   * @param domain - The domain to lookup
   * @returns Promise with DNS lookup results
   */
  async lookup(domain: string): Promise<DnsResult> {
    try {
      const [mxRecords, hasA] = await Promise.all([
        this.lookupMX(domain),
        this.hasARecord(domain)
      ]);
      
      return {
        hasMx: mxRecords.length > 0,
        records: mxRecords,
        hasA
      };
    } catch (error) {
      console.error(`DNS lookup error for ${domain}:`, error);
      // Return empty result on error
      return {
        hasMx: false,
        records: [],
        hasA: false
      };
    }
  }
  
  /**
   * Check if domain has any MX records
   * @param domain - The domain to check
   * @returns Array of MX records sorted by priority
   */
  private async lookupMX(domain: string): Promise<MXRecord[]> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.dnsApiBase}?name=${encodeURIComponent(domain)}&type=MX`, 
        {
          headers: {
            'Accept': 'application/dns-json'
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`DNS query failed: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json() as DnsResponse;
      
      if (!data.Answer || !Array.isArray(data.Answer)) {
        return [];
      }
      
      // Extract MX records and sort by priority
      const mxRecords: MXRecord[] = data.Answer
        .map((record) => {
          // MX record data format: "<priority> <exchange>"
          const parts = record.data.split(' ');
          const priority = parseInt(parts[0], 10);
          // Remove trailing dot from exchange
          const exchange = parts.slice(1).join(' ').replace(/\.$/, '');
          
          return { priority, exchange };
        })
        .sort((a: MXRecord, b: MXRecord) => a.priority - b.priority);
      
      return mxRecords;
    } catch (error) {
      console.error('MX lookup error:', error);
      return [];
    }
  }
  
  /**
   * Check if domain has any A/AAAA records
   * @param domain - The domain to check
   * @returns Boolean indicating if A/AAAA records exist
   */
  private async hasARecord(domain: string): Promise<boolean> {
    try {
      // Check for A records
      const aResponse = await this.fetchWithTimeout(
        `${this.dnsApiBase}?name=${encodeURIComponent(domain)}&type=A`,
        {
          headers: {
            'Accept': 'application/dns-json'
          }
        }
      );
      
      if (!aResponse.ok) {
        return false;
      }
      
      const aData = await aResponse.json() as DnsResponse;
      
      // If we found A records, return true
      if (aData.Answer && Array.isArray(aData.Answer) && aData.Answer.length > 0) {
        return true;
      }
      
      // If no A records, check for AAAA records
      const aaaaResponse = await this.fetchWithTimeout(
        `${this.dnsApiBase}?name=${encodeURIComponent(domain)}&type=AAAA`,
        {
          headers: {
            'Accept': 'application/dns-json'
          }
        }
      );
      
      if (!aaaaResponse.ok) {
        return false;
      }
      
      const aaaaData = await aaaaResponse.json() as DnsResponse;
      
      return !!(aaaaData.Answer && Array.isArray(aaaaData.Answer) && aaaaData.Answer.length > 0);
    } catch (error) {
      console.error('A/AAAA lookup error:', error);
      return false;
    }
  }
} 