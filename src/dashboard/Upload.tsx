import React, { useState } from 'react';

interface UploadProps {
  baseUrl: string;
}

export function Upload({ baseUrl }: UploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ jobId: string; totalEmails: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      setError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Please select a file to upload');
      return;
    }

    setIsUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      setUploadResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setIsUploading(false);
    }
  };

  const handleReset = () => {
    setFile(null);
    setUploadResult(null);
    setError(null);
  };

  return (
    <div className="upload-container">
      <h2>Email Verification</h2>
      <p>Upload a CSV file with email addresses to verify.</p>

      {!uploadResult ? (
        <form onSubmit={handleSubmit}>
          <div className="file-input">
            <label htmlFor="file-upload">
              {file ? file.name : 'Choose a CSV file'}
            </label>
            <input 
              id="file-upload" 
              type="file" 
              accept=".csv" 
              onChange={handleFileChange} 
              disabled={isUploading} 
            />
          </div>

          {error && <div className="error">{error}</div>}

          <button type="submit" disabled={!file || isUploading}>
            {isUploading ? 'Uploading...' : 'Upload and Verify'}
          </button>
        </form>
      ) : (
        <div className="result">
          <h3>Upload Successful!</h3>
          <p>Your file with {uploadResult.totalEmails} email(s) has been uploaded.</p>
          <p>Job ID: <strong>{uploadResult.jobId}</strong></p>
          <p>You can check the verification results using this ID.</p>
          
          <div className="result-links">
            <a 
              href={`${baseUrl}/results/${uploadResult.jobId}`} 
              target="_blank" 
              rel="noopener noreferrer"
            >
              View Results (JSON)
            </a>
            <a 
              href={`${baseUrl}/results/${uploadResult.jobId}?format=csv`} 
              target="_blank" 
              rel="noopener noreferrer"
            >
              Download Results (CSV)
            </a>
          </div>
          
          <button onClick={handleReset}>Upload Another File</button>
        </div>
      )}

      <style jsx>{`
        .upload-container {
          max-width: 600px;
          margin: 0 auto;
          padding: 2rem;
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        
        h2 {
          margin-top: 0;
          color: #333;
        }
        
        .file-input {
          margin: 1.5rem 0;
        }
        
        .file-input label {
          display: block;
          padding: 10px 15px;
          background: #f0f0f0;
          border: 1px solid #ddd;
          border-radius: 4px;
          cursor: pointer;
          text-align: center;
        }
        
        .file-input input {
          display: none;
        }
        
        button {
          background: #4a90e2;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 16px;
          width: 100%;
        }
        
        button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        
        .error {
          color: #e74c3c;
          margin-bottom: 1rem;
        }
        
        .result {
          text-align: center;
        }
        
        .result-links {
          display: flex;
          justify-content: space-between;
          margin: 1.5rem 0;
        }
        
        .result-links a {
          display: inline-block;
          padding: 8px 16px;
          background: #f8f9fa;
          border: 1px solid #ddd;
          border-radius: 4px;
          text-decoration: none;
          color: #4a90e2;
        }
      `}</style>
    </div>
  );
} 