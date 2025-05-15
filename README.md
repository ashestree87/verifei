# Email Verifier

A Cloudflare-native tool to validate large email lists end-to-end. It provides a comprehensive email verification pipeline that can handle up to 50,000 emails per hour without hitting provider rate limits.

## Features

- Multi-stage verification pipeline
- Domain-based concurrency control with Durable Objects
- Disposable domain and catch-all detection
- Caching to reduce unnecessary rechecks
- GDPR compliance with data deletion endpoint
- CSV or JSON export of results
- Web API (REST) for integration with other tools

## Verification Pipeline

1. **Syntax & RFC compliance** check
2. **Disposable / role account** check against blocklists
3. **DNS lookups** for MX and A/AAAA records
4. **Catch-all domain** detection
5. **SMTP handshake** with STARTTLS support
6. **Scoring & verdict** for each email address
7. **Caching** of results to avoid hammering mail servers

## Quick Start

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- Cloudflare account with Workers, D1, KV, Durable Objects, and Queues access

### Setup

1. Clone the repository
2. Configure your `wrangler.toml` with your own values
3. Run the setup command:

```bash
npm install
npm run setup
```

This will:
- Create the required D1 database
- Create the KV namespace for blocklists
- Create the queue for email verification jobs

### Development

Run the development server:

```bash
npm run dev
```

### Deployment

Deploy to production:

```bash
npm run deploy
```

## Usage

### Verifying a Single Email

```bash
curl -X POST https://your-worker/verify \
  -H "Content-Type: application/json" \
  -d '{"email":"example@domain.com"}'
```

### Uploading a CSV File

```bash
curl -F "file=@emails.csv" https://your-worker/upload
```

The server will return a job ID that you can use to check the results.

### Getting Results

```bash
# Get JSON results
curl https://your-worker/results/YOUR_JOB_ID

# Get CSV results
curl https://your-worker/results/YOUR_JOB_ID?format=csv > verified_emails.csv
```

### GDPR Deletion Request

```bash
curl -X DELETE https://your-worker/gdpr/delete?email=example@domain.com
```

## Configuration

Set these environment variables in your `wrangler.toml` or via the Cloudflare Dashboard:

- `SMTP_HELO_DOMAIN` - Domain to use in SMTP HELO command
- `PROBE_EMAIL` - Email to use in MAIL FROM command
- `MAX_CONCURRENCY_PER_MX` - Maximum concurrent connections per mail server
- `SMTP_TIMEOUT_MS` - Timeout for SMTP connections in milliseconds
- `DISPOSABLE_LIST_URL` - URL to fetch disposable domains list (optional)
- `GRAY_RETRY_AFTER_SEC` - Time to wait before retrying greylisted emails

## Architecture

- **Cloudflare Workers**: API endpoints and job handling
- **Durable Objects**: Per-domain concurrency control and caching
- **KV Storage**: Disposable domain blocklists
- **D1 Database**: Stores verification results and job status
- **Queues**: Job processing for large email lists
- **Workers Sockets**: Direct SMTP connections for verification

## License

ISC License 