const express = require('express');
const multer = require('multer');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || '/data/.openclaw';
const GATEWAY_PORT = 18789;

let gatewayProcess = null;
let gatewayToken = null;
let gatewayReady = false;

console.log('[server] Initializing Express server...');
console.log(`[server] PORT: ${PORT}`);
console.log(`[server] UPLOAD_DIR: ${UPLOAD_DIR}`);
console.log(`[server] OUTPUT_DIR: ${OUTPUT_DIR}`);
console.log(`[server] STATE_DIR: ${STATE_DIR}`);
console.log(`[server] GATEWAY_PORT: ${GATEWAY_PORT}`);
console.log(`[server] ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}`);

// Ensure directories exist
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[server] Ensured directory: ${dir}`);
});

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

// Start OpenClaw Gateway
function startGateway() {
  return new Promise((resolve, reject) => {
    console.log('[gateway] Starting OpenClaw gateway...');

    // Generate a random token for gateway auth
    gatewayToken = crypto.randomBytes(32).toString('hex');
    console.log(`[gateway] Generated auth token: ${gatewayToken.substring(0, 8)}...`);

    const args = [
      'gateway', 'run',
      '--bind', 'loopback',
      '--port', String(GATEWAY_PORT),
      '--auth', 'token'
    ];

    console.log(`[gateway] Command: openclaw ${args.join(' ')}`);

    gatewayProcess = spawn('openclaw', args, {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        NODE_OPTIONS: '--max-old-space-size=1024'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let startupOutput = '';
    let resolved = false;

    gatewayProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[gateway stdout] ${output}`);
      startupOutput += output;

      // Check if gateway is ready
      if (!resolved && (output.includes('listening') || output.includes('ready') || output.includes('started'))) {
        resolved = true;
        gatewayReady = true;
        console.log('[gateway] Gateway is ready!');
        resolve();
      }
    });

    gatewayProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`[gateway stderr] ${output}`);
      startupOutput += output;

      // Some tools output ready message to stderr
      if (!resolved && (output.includes('listening') || output.includes('ready') || output.includes('started'))) {
        resolved = true;
        gatewayReady = true;
        console.log('[gateway] Gateway is ready (stderr)!');
        resolve();
      }
    });

    gatewayProcess.on('error', (err) => {
      console.error(`[gateway] Process error: ${err.message}`);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    gatewayProcess.on('close', (code) => {
      console.log(`[gateway] Process exited with code ${code}`);
      gatewayReady = false;
      if (!resolved) {
        resolved = true;
        reject(new Error(`Gateway exited with code ${code}: ${startupOutput}`));
      }
    });

    // Timeout - assume ready after 5 seconds if no explicit ready message
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        gatewayReady = true;
        console.log('[gateway] Assuming gateway ready after timeout');
        resolve();
      }
    }, 5000);
  });
}

// Process PDF via Gateway WebSocket
function processWithGateway(pdfPath, outputCsvPath) {
  return new Promise((resolve, reject) => {
    if (!gatewayReady) {
      return reject(new Error('Gateway not ready'));
    }

    const prompt = `Process this EOG Resources revenue check PDF: ${pdfPath}

Use pdftoppm to convert pages to PNG images, then use vision to extract the data from each page.

Extract all revenue/payment data into a CSV format with columns for:
- Owner/Payee name
- Property/Well name
- Product type
- Volume
- Price
- Gross value
- Deductions
- Net value

Save the parsed CSV output to: ${outputCsvPath}`;

    console.log('[gateway] Connecting to WebSocket...');
    console.log(`[gateway] Prompt: ${prompt.substring(0, 100)}...`);

    const wsUrl = `ws://127.0.0.1:${GATEWAY_PORT}`;
    console.log(`[gateway] WebSocket URL: ${wsUrl}`);

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Bearer ${gatewayToken}`
      }
    });

    let fullResponse = '';
    let messageReceived = false;

    const timeout = setTimeout(() => {
      console.log('[gateway] WebSocket timeout after 5 minutes');
      ws.close();
      if (!messageReceived) {
        reject(new Error('Gateway timeout'));
      }
    }, 300000); // 5 minute timeout

    ws.on('open', () => {
      console.log('[gateway] WebSocket connected');

      // Send the message to the agent
      const message = {
        type: 'message',
        agent: 'main',
        content: prompt
      };

      console.log('[gateway] Sending message to agent...');
      ws.send(JSON.stringify(message));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log(`[gateway] Received: ${JSON.stringify(msg).substring(0, 200)}...`);

        if (msg.type === 'content' || msg.type === 'text') {
          fullResponse += msg.content || msg.text || '';
        } else if (msg.type === 'done' || msg.type === 'complete' || msg.type === 'end') {
          messageReceived = true;
          clearTimeout(timeout);
          ws.close();
          resolve({ success: true, message: fullResponse });
        } else if (msg.type === 'error') {
          messageReceived = true;
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.error || msg.message || 'Gateway error'));
        }
      } catch (e) {
        // Plain text response
        fullResponse += data.toString();
      }
    });

    ws.on('error', (err) => {
      console.error(`[gateway] WebSocket error: ${err.message}`);
      clearTimeout(timeout);
      if (!messageReceived) {
        reject(err);
      }
    });

    ws.on('close', () => {
      console.log('[gateway] WebSocket closed');
      clearTimeout(timeout);
      if (!messageReceived && fullResponse) {
        resolve({ success: true, message: fullResponse });
      } else if (!messageReceived) {
        reject(new Error('WebSocket closed without response'));
      }
    });
  });
}

// Fallback: Process with CLI (shell wrapper approach)
function processWithCLI(pdfPath, outputCsvPath) {
  return new Promise((resolve, reject) => {
    const prompt = `Process this EOG Resources revenue check PDF: ${pdfPath}

Use pdftoppm to convert pages to PNG images, then use vision to extract the data from each page.

Extract all revenue/payment data into a CSV format with columns for:
- Owner/Payee name
- Property/Well name
- Product type
- Volume
- Price
- Gross value
- Deductions
- Net value

Save the parsed CSV output to: ${outputCsvPath}`;

    console.log('[cli] Starting CLI process (fallback)...');
    console.log(`[cli] Prompt: ${prompt.substring(0, 100)}...`);

    // Use shell wrapper to reliably capture output
    const timestamp = Date.now();
    const stdoutFile = `/tmp/oc_out_${timestamp}.txt`;
    const stderrFile = `/tmp/oc_err_${timestamp}.txt`;
    const exitFile = `/tmp/oc_exit_${timestamp}.txt`;

    // Escape prompt for shell (replace single quotes)
    const escapedPrompt = prompt.replace(/'/g, "'\\''");

    const shellCmd = `openclaw agent --local --agent main --message '${escapedPrompt}' > ${stdoutFile} 2> ${stderrFile}; echo $? > ${exitFile}`;

    console.log('[cli] Running via shell wrapper...');

    const proc = spawn('sh', ['-c', shellCmd], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        NODE_OPTIONS: '--max-old-space-size=1024',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        TERM: 'dumb'
      }
    });

    const timeout = setTimeout(() => {
      console.log('[cli] Timeout after 5 minutes, killing process');
      proc.kill('SIGTERM');
      reject(new Error('Timeout waiting for OpenClaw response (5 minutes)'));
    }, 300000);

    proc.on('close', () => {
      clearTimeout(timeout);

      let stdout = '';
      let stderr = '';
      let exitCode = 1;

      try {
        if (fs.existsSync(stdoutFile)) {
          stdout = fs.readFileSync(stdoutFile, 'utf-8');
          fs.unlinkSync(stdoutFile);
        }
        if (fs.existsSync(stderrFile)) {
          stderr = fs.readFileSync(stderrFile, 'utf-8');
          fs.unlinkSync(stderrFile);
        }
        if (fs.existsSync(exitFile)) {
          exitCode = parseInt(fs.readFileSync(exitFile, 'utf-8').trim()) || 1;
          fs.unlinkSync(exitFile);
        }
      } catch (e) {
        console.error('[cli] Error reading output files:', e.message);
      }

      console.log(`[cli] Exit code: ${exitCode}`);
      console.log(`[cli] stdout (${stdout.length} chars): ${stdout.substring(0, 1000)}`);
      console.log(`[cli] stderr (${stderr.length} chars): ${stderr.substring(0, 1000)}`);

      if (exitCode === 0) {
        resolve({ success: true, message: stdout });
      } else {
        reject(new Error(`OpenClaw exited with code ${exitCode}: ${stderr || stdout || 'No output'}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[cli] Process error: ${err.message}`);
      reject(err);
    });
  });
}

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  console.log('[server] Health check requested');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
    gatewayReady: gatewayReady
  });
});

// Gateway status
app.get('/api/gateway-status', (req, res) => {
  res.json({
    ready: gatewayReady,
    port: GATEWAY_PORT
  });
});

// Parse PDF endpoint
app.post('/api/parse', validateApiKey, (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  console.log(`[server] Parse request from ${ip}`);
  if (!checkRateLimit(ip)) {
    console.log(`[server] Rate limit exceeded for ${ip}`);
    return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
  }
  next();
}, upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    console.log('[server] No PDF file in request');
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  const pdfPath = req.file.path;
  const baseName = path.basename(pdfPath, '.pdf');
  const outputCsvPath = path.join(OUTPUT_DIR, `${baseName}_parsed.csv`);

  console.log(`[server] Processing PDF: ${pdfPath}`);
  console.log(`[server] Output will be: ${outputCsvPath}`);

  try {
    let result;

    // Try gateway first, fallback to CLI
    if (gatewayReady) {
      console.log('[server] Using gateway approach...');
      try {
        result = await processWithGateway(pdfPath, outputCsvPath);
      } catch (gatewayErr) {
        console.error('[server] Gateway failed, trying CLI fallback:', gatewayErr.message);
        result = await processWithCLI(pdfPath, outputCsvPath);
      }
    } else {
      console.log('[server] Gateway not ready, using CLI approach...');
      result = await processWithCLI(pdfPath, outputCsvPath);
    }

    console.log('[server] Processing complete');

    if (fs.existsSync(outputCsvPath)) {
      console.log('[server] CSV file created successfully');
      res.json({
        success: true,
        message: 'PDF parsed successfully',
        downloadUrl: `/api/download/${path.basename(outputCsvPath)}`
      });
    } else {
      console.log('[server] CSV file not found after processing');
      res.json({
        success: true,
        message: result.message,
        note: 'CSV may not have been generated - check response for details'
      });
    }
  } catch (error) {
    console.error('[server] Processing error:', error);
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
  console.log(`[server] Download requested: ${filename}`);

  if (!filename.endsWith('.csv') || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const csvPath = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(csvPath)) {
    console.log(`[server] File not found: ${csvPath}`);
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(csvPath, filename, (err) => {
    if (!err) {
      console.log(`[server] Download complete: ${filename}`);
      // Cleanup after download
      setTimeout(() => fs.unlink(csvPath, () => {}), 300000); // 5 min
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down...');
  if (gatewayProcess) {
    gatewayProcess.kill('SIGTERM');
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[server] SIGINT received, shutting down...');
  if (gatewayProcess) {
    gatewayProcess.kill('SIGTERM');
  }
  process.exit(0);
});

// Start server
async function main() {
  // Try to start the gateway
  try {
    await startGateway();
    console.log('[server] Gateway started successfully');
  } catch (err) {
    console.error('[server] Failed to start gateway:', err.message);
    console.log('[server] Will use CLI fallback for processing');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log(`[server] EOG Parser API running on port ${PORT}`);
    console.log(`[server] Health check: http://0.0.0.0:${PORT}/health`);
    console.log(`[server] Gateway ready: ${gatewayReady}`);
    console.log('='.repeat(60));
  });
}

main();
