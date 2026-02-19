const express = require('express');
const multer = require('multer');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const GATEWAY_URL = `ws://127.0.0.1:${process.env.GATEWAY_PORT || 18789}`;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';

// Ensure directories exist
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

// Rate limiting (simple in-memory)
const rateLimits = new Map();
const RATE_LIMIT = 100; // requests per hour
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_WINDOW;
  }
  
  if (record.count >= RATE_LIMIT) {
    return false;
  }
  
  record.count++;
  rateLimits.set(ip, record);
  return true;
}

// Configure multer
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files allowed'));
    }
  }
});

// API key validation (optional)
function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const requiredKey = process.env.API_KEY;
  
  if (requiredKey && apiKey !== requiredKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Parse PDF endpoint
app.post('/api/parse', validateApiKey, (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
  }
  next();
}, upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  const pdfPath = req.file.path;
  const baseName = path.basename(pdfPath, '.pdf');
  const outputCsvPath = path.join(OUTPUT_DIR, `${baseName}_parsed.csv`);
  
  console.log(`Processing: ${pdfPath}`);

  try {
    const result = await processWithOpenClaw(pdfPath, outputCsvPath);
    
    if (fs.existsSync(outputCsvPath)) {
      res.json({
        success: true,
        message: 'PDF parsed successfully',
        downloadUrl: `/api/download/${path.basename(outputCsvPath)}`
      });
    } else {
      res.json({
        success: true,
        message: result.message,
        note: 'CSV may not have been generated - check response for details'
      });
    }
  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    // Cleanup PDF after processing
    setTimeout(() => {
      fs.unlink(pdfPath, () => {});
    }, 60000);
  }
});

// Download CSV endpoint
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename.endsWith('.csv') || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  const csvPath = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.download(csvPath, filename, (err) => {
    if (!err) {
      // Cleanup after download
      setTimeout(() => fs.unlink(csvPath, () => {}), 300000); // 5 min
    }
  });
});

// Process with OpenClaw Gateway
function processWithOpenClaw(pdfPath, outputCsvPath) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL);
    let responseData = '';
    let connected = false;
    
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timeout waiting for OpenClaw response (5 minutes)'));
    }, 300000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'connect',
        params: { auth: { token: GATEWAY_TOKEN } }
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'connected') {
          connected = true;
          const message = `EOG_parse

Process this EOG Resources revenue check PDF: ${pdfPath}

Save the parsed CSV output to: ${outputCsvPath}

Use pdftoppm to convert pages to PNG, then use vision to extract each page's data.`;
          
          ws.send(JSON.stringify({
            type: 'chat.send',
            params: {
              sessionKey: 'agent:main:main',
              message: message,
              idempotencyKey: `parse-${Date.now()}`
            }
          }));
        }
        
        if (msg.type === 'chat') {
          if (msg.payload?.content) {
            responseData += msg.payload.content;
          }
          if (msg.payload?.done) {
            clearTimeout(timeout);
            ws.close();
            resolve({ success: true, message: responseData });
          }
        }

        if (msg.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.payload?.message || 'Gateway error'));
        }
      } catch (e) {
        console.error('Parse error:', e);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', () => {
      if (!connected) {
        clearTimeout(timeout);
        reject(new Error('Failed to connect to OpenClaw Gateway'));
      }
    });
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`EOG Parser API running on port ${PORT}`);
  console.log(`Gateway URL: ${GATEWAY_URL}`);
});
