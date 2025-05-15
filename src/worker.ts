import { Router } from 'itty-router';
import { CsvSplitter } from './utils/csvSplitter';
import { Env, JobStatus, VerificationJob, VerificationResult } from './utils/types';
import { VerifeiDO } from './verifierDO';

// Re-export the Durable Object class for Cloudflare
export { VerifeiDO };

// Interface for JSON input to verify a single email
interface VerifyEmailRequest {
  email: string;
}

// Interface for job results from the database
interface JobResult {
  id: string;
  status: JobStatus;
  total_emails: number;
  processed_emails: number;
  created_at: number;
  completed_at?: number;
  file_name?: string;
  file_size?: number;
}

/**
 * Main Worker for handling email verification requests
 */
export default {
  /**
   * Handle HTTP requests
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    // Create a promise that times out after 50 seconds (Cloudflare's max is 60s)
    const timeoutPromise = new Promise<Response>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Request timed out'));
      }, 50000);
    });
    
    try {
      // Set up the router
      const router = Router();
      
      // Handle OPTIONS request for CORS
      router.options('*', () => new Response(null, { headers: corsHeaders }));
      
      // Health check endpoint
      router.get('/health', () => {
        return new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      });
      
      // Upload endpoint for CSV/JSON files
      router.post('/upload', async (request) => {
        try {
          // Check if it's a multipart/form-data request
          const contentType = request.headers.get('Content-Type') || '';
          
          if (!contentType.includes('multipart/form-data')) {
            return new Response('Expected multipart/form-data', { 
              status: 400,
              headers: corsHeaders
            });
          }
          
          // Parse the form data
          const formData = await request.formData();
          const file = formData.get('file') as any;
          
          if (!file || typeof file.text !== 'function') {
            return new Response('File is required', { 
              status: 400,
              headers: corsHeaders
            });
          }
          
          // Process the file
          const fileContent = await file.text();
          const emails = CsvSplitter.parseEmails(fileContent);
          
          if (emails.length === 0) {
            return new Response('No valid email addresses found in file', { 
              status: 400,
              headers: corsHeaders
            });
          }
          
          // Create a job ID
          const jobId = crypto.randomUUID();
          
          // Store job info in the database
          const fileName = file.name || 'unknown';
          const fileSize = file.size || 0;
          
          await env.DB.prepare(`
            INSERT INTO verification_jobs (id, status, total_emails, processed_emails, created_at, file_name, file_size)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(jobId, JobStatus.PENDING, emails.length, 0, Date.now(), fileName, fileSize).run();
          
          // Split emails into chunks and queue them
          const chunks = CsvSplitter.chunkEmails(emails, 100);
          
          for (let i = 0; i < chunks.length; i++) {
            const job: VerificationJob = {
              jobId,
              emails: chunks[i],
              batchIndex: i,
              totalBatches: chunks.length
            };
            
            // Send the chunk to the queue
            await env.VERIFICATION_QUEUE.send(job);
          }
          
          // Update job status to processing
          await env.DB.prepare(`
            UPDATE verification_jobs SET status = ? WHERE id = ?
          `).bind(JobStatus.PROCESSING, jobId).run();
          
          return new Response(JSON.stringify({ jobId, totalEmails: emails.length }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (error) {
          console.error('Upload error:', error);
          return new Response(`Upload error: ${error instanceof Error ? error.message : String(error)}`, { 
            status: 500,
            headers: corsHeaders
          });
        }
      });
      
      // Verify a single email
      router.post('/verify', async (request) => {
        try {
          const data = await request.json() as VerifyEmailRequest;
          
          if (!data || !data.email || typeof data.email !== 'string') {
            return new Response('Email parameter is required', { 
              status: 400,
              headers: corsHeaders
            });
          }
          
          const email = data.email.trim();
          const domain = email.split('@')[1];
          
          if (!domain) {
            return new Response('Invalid email format', { 
              status: 400,
              headers: corsHeaders
            });
          }
          
          // Create an ID for the Durable Object based on the domain
          const doId = env.VERIFEI.idFromName(domain);
          
          // Get the Durable Object stub
          const doStub = env.VERIFEI.get(doId);
          
          // Create a controller for the fetch request
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
          
          try {
            // Forward the request to the Durable Object
            const response = await doStub.fetch(new Request('http://internal/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email }),
              signal: controller.signal
            }));
            
            clearTimeout(timeoutId);
            
            // Add CORS headers to the response
            const responseInit = {
              status: response.status,
              statusText: response.statusText,
              headers: { ...Object.fromEntries(response.headers.entries()), ...corsHeaders }
            };
            
            return new Response(await response.text(), responseInit);
          } catch (error) {
            clearTimeout(timeoutId);
            if (error instanceof Error && error.name === 'AbortError') {
              return new Response(`Verification timed out for ${email}`, { 
                status: 504, // Gateway Timeout
                headers: corsHeaders 
              });
            }
            throw error; // Re-throw for the outer catch
          }
        } catch (error) {
          console.error('Verification error:', error);
          return new Response(`Verification error: ${error instanceof Error ? error.message : String(error)}`, { 
            status: 500,
            headers: corsHeaders
          });
        }
      });
      
      // Get results for a job
      router.get('/results/:jobId', async (request, { jobId }) => {
        try {
          if (!jobId) {
            return new Response('Job ID is required', { 
              status: 400,
              headers: corsHeaders
            });
          }
          
          // Get job info
          const jobResult = await env.DB.prepare(`
            SELECT * FROM verification_jobs WHERE id = ?
          `).bind(jobId).first<JobResult>();
          
          if (!jobResult) {
            return new Response('Job not found', { 
              status: 404,
              headers: corsHeaders
            });
          }
          
          // Get the format (csv or json)
          const url = new URL(request.url);
          const format = url.searchParams.get('format') || 'json';
          
          // Get pagination parameters
          const page = parseInt(url.searchParams.get('page') || '1', 10);
          const pageSize = parseInt(url.searchParams.get('pageSize') || '100', 10);
          const offset = (page - 1) * pageSize;
          
          // Get the results from the database
          const resultsQuery = await env.DB.prepare(`
            SELECT * FROM email_verifications 
            WHERE job_id = ? 
            ORDER BY email
            LIMIT ? OFFSET ?
          `).bind(jobId, pageSize, offset).all<VerificationResult>();
          
          const results = resultsQuery.results;
          
          // Get total count for pagination
          const countResult = await env.DB.prepare(`
            SELECT COUNT(*) as count FROM email_verifications WHERE job_id = ?
          `).bind(jobId).first<{ count: number }>();
          
          const totalResults = countResult ? countResult.count : 0;
          const totalPages = Math.ceil(totalResults / pageSize);
          
          // Format the response
          if (format.toLowerCase() === 'csv') {
            const csv = CsvSplitter.resultsToCSV(results);
            
            return new Response(csv, {
              headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="verification-results-${jobId}.csv"`,
                ...corsHeaders
              }
            });
          } else {
            return new Response(JSON.stringify({
              job: jobResult,
              results,
              pagination: {
                page,
                pageSize,
                totalResults,
                totalPages
              }
            }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
        } catch (error) {
          console.error('Results error:', error);
          return new Response(`Results error: ${error instanceof Error ? error.message : String(error)}`, { 
            status: 500,
            headers: corsHeaders
          });
        }
      });
      
      // GDPR deletion request
      router.delete('/gdpr/delete', async (request) => {
        try {
          const url = new URL(request.url);
          const email = url.searchParams.get('email');
          
          if (!email) {
            return new Response('Email parameter is required', { 
              status: 400,
              headers: corsHeaders
            });
          }
          
          // Record the deletion request
          await env.DB.prepare(`
            INSERT OR REPLACE INTO deletion_requests (email, requested_at)
            VALUES (?, ?)
          `).bind(email, Date.now()).run();
          
          // Delete the email from verification results
          await env.DB.prepare(`
            DELETE FROM email_verifications WHERE email = ?
          `).bind(email).run();
          
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (error) {
          console.error('GDPR deletion error:', error);
          return new Response(`GDPR deletion error: ${error instanceof Error ? error.message : String(error)}`, { 
            status: 500,
            headers: corsHeaders
          });
        }
      });
      
      // Handle API requests
      router.all('*', () => new Response('Not Found', { 
        status: 404,
        headers: corsHeaders
      }));
      
      // Race the router against the timeout
      const routerPromise = router.handle(request).catch((error: unknown) => {
        console.error('Router error:', error);
        return new Response(`Internal server error: ${error instanceof Error ? error.message : String(error)}`, {
          status: 500,
          headers: corsHeaders
        });
      });
      
      return await Promise.race([routerPromise, timeoutPromise]);
    } catch (error) {
      console.error('Global error in fetch handler:', error);
      return new Response(`Internal server error: ${error instanceof Error ? error.message : String(error)}`, {
        status: 500, 
        headers: corsHeaders
      });
    }
  },
  
  /**
   * Handle queue messages
   */
  async queue(batch: MessageBatch<VerificationJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      
      try {
        // Process each email in the batch
        for (const email of job.emails) {
          try {
            const domain = email.split('@')[1];
            
            if (!domain) {
              console.warn(`Invalid email format: ${email}`);
              continue;
            }
            
            // Get the Durable Object for this domain
            const doId = env.VERIFEI.idFromName(domain);
            const doStub = env.VERIFEI.get(doId);
            
            // Create a controller for the fetch request
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
            
            try {
              // Verify the email
              const response = await doStub.fetch(new Request('http://internal/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
                signal: controller.signal
              }));
              
              clearTimeout(timeoutId);
              
              if (!response.ok) {
                console.error(`Verification failed for ${email}: ${response.statusText}`);
                continue;
              }
              
              // Parse the result with timeout protection
              let result: VerificationResult;
              try {
                const text = await response.text();
                result = JSON.parse(text) as VerificationResult;
              } catch (parseError) {
                console.error(`Error parsing result for ${email}:`, parseError);
                continue;
              }
              
              // Store the result in the database
              await env.DB.prepare(`
                INSERT OR REPLACE INTO email_verifications 
                (email, status, score, reason, checked_at, ttl, job_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `).bind(
                result.email,
                result.status,
                result.score,
                result.reason || null,
                result.checkedAt,
                result.ttl,
                job.jobId
              ).run();
              
              // Update processed count
              await env.DB.prepare(`
                UPDATE verification_jobs
                SET processed_emails = processed_emails + 1
                WHERE id = ?
              `).bind(job.jobId).run();
            } catch (error) {
              clearTimeout(timeoutId);
              
              if (error instanceof Error && error.name === 'AbortError') {
                console.error(`Verification timed out for ${email}`);
              } else {
                console.error(`Error verifying email ${email}:`, error);
              }
            }
          } catch (error) {
            console.error(`Error processing email ${email}:`, error);
          }
        }
        
        // Check if this was the last batch
        if (job.batchIndex === job.totalBatches - 1) {
          // Check if all emails have been processed
          const jobResult = await env.DB.prepare(`
            SELECT * FROM verification_jobs WHERE id = ?
          `).bind(job.jobId).first<JobResult>();
          
          if (jobResult && jobResult.processed_emails >= jobResult.total_emails) {
            // Mark the job as completed
            await env.DB.prepare(`
              UPDATE verification_jobs
              SET status = ?, completed_at = ?
              WHERE id = ?
            `).bind(JobStatus.COMPLETED, Date.now(), job.jobId).run();
          }
        }
      } catch (error) {
        console.error(`Error processing batch for job ${job.jobId}:`, error);
        
        // Mark the job as failed if this was a critical error
        try {
          await env.DB.prepare(`
            UPDATE verification_jobs
            SET status = ?
            WHERE id = ?
          `).bind(JobStatus.FAILED, job.jobId).run();
        } catch (dbError) {
          console.error(`Failed to update job status to FAILED for ${job.jobId}:`, dbError);
        }
      }
    }
  },
  
  /**
   * Handle scheduled events (e.g., cron triggers)
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // For the daily sync of blocklists from external source to KV
    if (env.DISPOSABLE_LIST_URL) {
      try {
        // Create an abort controller for timeouts
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
        
        try {
          // Fetch the latest disposable domain list with timeout
          const response = await fetch(env.DISPOSABLE_LIST_URL, {
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch disposable domains: ${response.status}`);
          }
          
          const domains = await response.json() as { domain: string, category: string }[];
          
          // Update KV store (in batches to avoid hitting limits)
          const batchSize = 100;
          for (let i = 0; i < domains.length; i += batchSize) {
            const batch = domains.slice(i, i + batchSize);
            const promises = batch.map(({ domain, category }) => 
              env.EMAIL_BLOCKLIST.put(`blocklist/disposable/${domain}`, category)
            );
            
            // Use Promise.allSettled to continue even if some promises fail
            const results = await Promise.allSettled(promises);
            
            // Log any failures
            results.forEach((result, index) => {
              if (result.status === 'rejected') {
                console.error(`Failed to update KV for domain ${batch[index].domain}:`, result.reason);
              }
            });
          }
          
          console.log(`Updated disposable domain list with ${domains.length} domains`);
        } catch (error) {
          clearTimeout(timeoutId);
          
          if (error instanceof Error && error.name === 'AbortError') {
            console.error('Timeout while fetching disposable domains list');
          } else {
            console.error('Error updating disposable domains:', error);
          }
        }
      } catch (error) {
        console.error('Error in scheduled disposable domains update:', error);
      }
    }
    
    // Clean up old jobs and results (keep for 30 days)
    try {
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      
      // Get old jobs
      const oldJobs = await env.DB.prepare(`
        SELECT id FROM verification_jobs
        WHERE created_at < ?
      `).bind(thirtyDaysAgo).all<{ id: string }>();
      
      // Delete old verification results
      if (oldJobs.results.length > 0) {
        for (const job of oldJobs.results) {
          try {
            await env.DB.prepare(`
              DELETE FROM email_verifications
              WHERE job_id = ?
            `).bind(job.id).run();
          } catch (error) {
            console.error(`Failed to delete verification results for job ${job.id}:`, error);
          }
        }
        
        // Delete old jobs
        try {
          await env.DB.prepare(`
            DELETE FROM verification_jobs
            WHERE created_at < ?
          `).bind(thirtyDaysAgo).run();
        } catch (error) {
          console.error('Failed to delete old jobs:', error);
        }
      }
      
      // Also delete individual old verifications not associated with a job
      try {
        await env.DB.prepare(`
          DELETE FROM email_verifications
          WHERE job_id IS NULL AND checked_at < ?
        `).bind(thirtyDaysAgo).run();
      } catch (error) {
        console.error('Failed to delete old verifications not associated with jobs:', error);
      }
      
      console.log('Cleaned up old verification data');
    } catch (error) {
      console.error('Error cleaning up old data:', error);
    }
  }
}; 