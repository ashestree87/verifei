import { MXRecord, SmtpResponse, SmtpResult } from './utils/types';

/**
 * SMTP service for verifying email addresses via direct SMTP handshake
 */
export class SmtpService {
  private readonly heloHost: string;
  private readonly probeEmail: string;
  private readonly timeoutMs: number;
  private readonly maxAttemptsPerMx: number;
  
  /**
   * Creates an SMTP service instance
   * @param heloHost - The hostname to use in the HELO command
   * @param probeEmail - The email address to use as the MAIL FROM
   * @param timeoutMs - Connection timeout in milliseconds
   * @param maxAttemptsPerMx - Maximum number of concurrent connections per MX
   */
  constructor(
    heloHost: string,
    probeEmail: string,
    timeoutMs = 5000,
    maxAttemptsPerMx = 5
  ) {
    this.heloHost = heloHost;
    this.probeEmail = probeEmail;
    this.timeoutMs = timeoutMs;
    this.maxAttemptsPerMx = maxAttemptsPerMx;
  }
  
  /**
   * Verify an email address by connecting to the domain's mail server
   * @param email - The email address to verify
   * @param mxRecords - List of MX records for the domain
   * @returns Promise with SMTP verification result
   */
  async verify(email: string, mxRecords: MXRecord[]): Promise<SmtpResult> {
    if (!email.includes('@') || mxRecords.length === 0) {
      return {
        success: false,
        isCatchAll: null,
        error: 'Invalid email or no MX records'
      };
    }
    
    const domain = email.split('@')[1];
    
    // Try each MX record in order of priority
    for (const mx of mxRecords) {
      try {
        // Connect to the mail server
        const result = await this.connectAndVerify(mx.exchange, email);
        
        // If successful or got a definitive negative response, return the result
        if (result.success || (result.response && result.response.code >= 500)) {
          return result;
        }
        
        // If we got a temporary failure, try the next MX record
        continue;
      } catch (error) {
        console.error(`Error connecting to ${mx.exchange}:`, error);
        // Continue to the next MX record
      }
    }
    
    // If we've tried all MX records and none worked, return failure
    return {
      success: false,
      isCatchAll: null,
      error: `Failed to connect to any mail server for ${domain}`
    };
  }
  
  /**
   * Test if a domain has catch-all configuration by verifying a random address
   * @param domain - The domain to test
   * @param mxRecords - List of MX records for the domain
   * @returns Promise with boolean indicating if domain has catch-all
   */
  async testCatchAll(domain: string, mxRecords: MXRecord[]): Promise<boolean> {
    if (mxRecords.length === 0) {
      return false;
    }
    
    // Generate a random email that's unlikely to exist
    const randomUser = `probe-${Math.random().toString(36).substring(2, 10)}`;
    const randomEmail = `${randomUser}@${domain}`;
    
    // Try to verify the random email
    const result = await this.verify(randomEmail, mxRecords);
    
    // If verification succeeds, it's likely a catch-all domain
    return result.success;
  }
  
  /**
   * Connect to a mail server and perform SMTP handshake to verify an email
   * @param server - Mail server hostname
   * @param email - Email address to verify
   * @returns Promise with SMTP verification result
   */
  private async connectAndVerify(server: string, email: string): Promise<SmtpResult> {
    // Using Cloudflare Workers Sockets API
    let socket: any = null;
    let timeoutId: NodeJS.Timeout | null = null;
    
    try {
      socket = new (globalThis as any).Socket({
        hostname: server,
        port: 25,
        ssl: false, // Start with non-SSL, we'll try STARTTLS later
      });
      
      // Set a timeout
      timeoutId = setTimeout(() => {
        if (socket) {
          try {
            socket.close();
            socket = null;
          } catch (e) {
            // Ignore errors on close
          }
        }
      }, this.timeoutMs);
      
      // Connect to the server
      const connected = await socket.connect();
      if (!connected) {
        return {
          success: false,
          isCatchAll: null,
          error: `Failed to connect to ${server}`
        };
      }
      
      // Wait for the server's greeting
      const greeting = await this.readResponse(socket);
      if (!this.isPositiveResponse(greeting)) {
        return {
          success: false,
          isCatchAll: null,
          response: greeting
        };
      }
      
      // Send HELO
      await socket.write(`HELO ${this.heloHost}\r\n`);
      const heloResponse = await this.readResponse(socket);
      if (!this.isPositiveResponse(heloResponse)) {
        return {
          success: false,
          isCatchAll: null,
          response: heloResponse
        };
      }
      
      // Try STARTTLS if available (optional)
      await socket.write("STARTTLS\r\n");
      const tlsResponse = await this.readResponse(socket);
      
      // If STARTTLS is supported, upgrade the connection
      if (this.isPositiveResponse(tlsResponse)) {
        try {
          await socket.startTls();
          
          // Need to send HELO again after STARTTLS
          await socket.write(`HELO ${this.heloHost}\r\n`);
          await this.readResponse(socket); // Read but ignore the response
        } catch (error) {
          // If TLS fails, continue with plain connection
          console.warn('STARTTLS failed, continuing with plain connection');
        }
      }
      
      // Send MAIL FROM
      await socket.write(`MAIL FROM:<${this.probeEmail}>\r\n`);
      const mailFromResponse = await this.readResponse(socket);
      if (!this.isPositiveResponse(mailFromResponse)) {
        return {
          success: false,
          isCatchAll: null,
          response: mailFromResponse
        };
      }
      
      // Send RCPT TO (this is the actual test)
      await socket.write(`RCPT TO:<${email}>\r\n`);
      const rcptToResponse = await this.readResponse(socket);
      
      // Determine success based on the RCPT TO response
      return {
        success: this.isPositiveResponse(rcptToResponse),
        isCatchAll: null, // This is determined separately
        response: rcptToResponse
      };
    } catch (error) {
      return {
        success: false,
        isCatchAll: null,
        error: `SMTP error: ${error instanceof Error ? error.message : String(error)}`
      };
    } finally {
      // Always clean up
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      if (socket) {
        try {
          // Send QUIT command if possible
          await socket.write("QUIT\r\n").catch(() => {});
        } catch (e) {
          // Ignore errors on QUIT
        }
        
        try {
          socket.close();
        } catch (e) {
          // Ignore errors on close
        }
      }
    }
  }
  
  /**
   * Read and parse an SMTP response from a socket
   * @param socket - The connected socket
   * @returns Promise with parsed SMTP response
   */
  private async readResponse(socket: any): Promise<SmtpResponse> {
    // Add a timeout to prevent hanging forever
    const readPromise = socket.read();
    
    // Create a timeout promise that rejects after the timeout period
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Socket read timed out'));
      }, this.timeoutMs);
    });
    
    // Race the read promise against the timeout
    let buffer;
    try {
      buffer = await Promise.race([readPromise, timeoutPromise]);
    } catch (error) {
      return {
        code: 0,
        message: `Read timeout: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    
    const responseText = new TextDecoder().decode(buffer);
    
    // Parse the response code and message
    const match = responseText.match(/^(\d{3})([ -])(.*)/m);
    if (match) {
      return {
        code: parseInt(match[1], 10),
        message: match[3].trim()
      };
    }
    
    return {
      code: 0,
      message: responseText.trim()
    };
  }
  
  /**
   * Check if an SMTP response indicates success (2xx or 3xx)
   * @param response - The SMTP response to check
   * @returns Boolean indicating success
   */
  private isPositiveResponse(response: SmtpResponse): boolean {
    return response.code >= 200 && response.code < 400;
  }
  
  /**
   * Fallback method using external microservice if Workers Sockets is unavailable
   * This would call an external API that performs the SMTP check
   * @param email - The email to verify
   * @returns Promise with SMTP verification result
   */
  async verifyWithExternalService(email: string): Promise<SmtpResult> {
    try {
      // This would be replaced with the actual endpoint of your microservice
      const response = await fetch('https://your-smtp-service.example.com/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, probeEmail: this.probeEmail })
      });
      
      if (!response.ok) {
        throw new Error(`External service error: ${response.status}`);
      }
      
      return await response.json() as SmtpResult;
    } catch (error) {
      return {
        success: false,
        isCatchAll: null,
        error: `External service error: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
} 