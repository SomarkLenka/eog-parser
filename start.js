const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || '/data/.openclaw';
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || '/data/workspace';
const GATEWAY_PORT = 18789;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || require('crypto').randomBytes(24).toString('hex');

// Ensure directories exist
[STATE_DIR, WORKSPACE_DIR, `${WORKSPACE_DIR}/skills/eog-parser`].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

// Create OpenClaw config if it doesn't exist
const configPath = path.join(STATE_DIR, 'openclaw.json');
if (!fs.existsSync(configPath)) {
  const config = {
    auth: {
      profiles: {
        "anthropic:default": {
          provider: "anthropic",
          mode: "api_key"
        }
      }
    },
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-20250514" },
        workspace: WORKSPACE_DIR,
        compaction: { mode: "safeguard" }
      }
    },
    gateway: {
      port: GATEWAY_PORT,
      bind: "loopback",
      auth: {
        mode: "token",
        token: GATEWAY_TOKEN
      }
    },
    skills: {
      load: {
        extraDirs: [`${WORKSPACE_DIR}/skills`],
        watch: true
      }
    },
    channels: {},
    tools: {
      web: { search: { enabled: false }, fetch: { enabled: true } }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('Created OpenClaw config');
}

// Copy eog-parser skill to workspace
const skillSrc = path.join(__dirname, 'skills', 'eog-parser');
const skillDst = path.join(WORKSPACE_DIR, 'skills', 'eog-parser');
if (fs.existsSync(skillSrc)) {
  fs.cpSync(skillSrc, skillDst, { recursive: true });
  console.log('Copied eog-parser skill');
}

// Export token for server
process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_TOKEN;
process.env.GATEWAY_PORT = GATEWAY_PORT;

console.log('Starting OpenClaw Gateway...');

// Start OpenClaw gateway
const gateway = spawn('openclaw', ['gateway'], {
  env: { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR },
  stdio: ['ignore', 'pipe', 'pipe']
});

gateway.stdout.on('data', (data) => console.log(`[gateway] ${data.toString().trim()}`));
gateway.stderr.on('data', (data) => console.error(`[gateway] ${data.toString().trim()}`));

gateway.on('error', (err) => {
  console.error('Failed to start gateway:', err);
  process.exit(1);
});

// Wait for gateway to be ready, then start Express server
setTimeout(() => {
  console.log('Starting Express server...');
  require('./server.js');
}, 5000);

// Handle shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  gateway.kill('SIGTERM');
  process.exit(0);
});
