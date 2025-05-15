import Papa from 'papaparse';
import { VerificationResult } from './types';

/**
 * Utility class to parse and split CSV files into chunks
 */
export class CsvSplitter {
  /**
   * Parse a CSV file and extract email addresses
   * @param fileContent - The CSV file content as string
   * @param emailColumnIndex - Optional index of the email column (default: 0)
   * @returns Array of email addresses
   */
  static parseEmails(fileContent: string, emailColumnIndex = 0): string[] {
    const parseResult = Papa.parse(fileContent, { skipEmptyLines: true });
    
    if (!parseResult.data || !Array.isArray(parseResult.data)) {
      return [];
    }
    
    return parseResult.data
      .slice(1) // Skip header row
      .map((row: unknown) => {
        if (Array.isArray(row) && row.length > emailColumnIndex) {
          return row[emailColumnIndex].toString().trim();
        }
        return '';
      })
      .filter((email: string) => email && email.includes('@'));
  }
  
  /**
   * Split an array of emails into chunks of specified size
   * @param emails - Array of email addresses
   * @param chunkSize - Size of each chunk
   * @returns Array of email chunks
   */
  static chunkEmails(emails: string[], chunkSize = 100): string[][] {
    const chunks: string[][] = [];
    
    for (let i = 0; i < emails.length; i += chunkSize) {
      chunks.push(emails.slice(i, i + chunkSize));
    }
    
    return chunks;
  }
  
  /**
   * Convert verification results to CSV format
   * @param results - Array of verification results
   * @returns CSV string
   */
  static resultsToCSV(results: VerificationResult[]): string {
    const headers = ['email', 'status', 'score', 'reason', 'checked_at'];
    
    // Format the data for Papa.unparse
    const data = [
      headers,
      ...results.map(r => [
        r.email,
        r.status,
        r.score,
        r.reason || '',
        new Date(r.checkedAt).toISOString()
      ])
    ];
    
    return Papa.unparse(data);
  }
} 