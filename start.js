const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || '/data/.openclaw';
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || '/data/workspace';

console.log('='.repeat(60));
console.log('EOG Parser - Starting up');
console.log('='.repeat(60));
console.log(`[startup] STATE_DIR: ${STATE_DIR}`);
console.log(`[startup] WORKSPACE_DIR: ${WORKSPACE_DIR}`);
console.log(`[startup] NODE_ENV: ${process.env.NODE_ENV}`);

// Debug: List all env vars that contain "API" or "KEY" or "ANTHROPIC"
console.log('[startup] Environment variables containing API/KEY/ANTHROPIC:');
Object.keys(process.env).forEach(key => {
  if (key.includes('API') || key.includes('KEY') || key.includes('ANTHROPIC') || key.includes('OPENAI')) {
    const val = process.env[key];
    const masked = val ? `${val.substring(0, 8)}...${val.substring(val.length - 4)}` : 'NOT SET';
    console.log(`[startup]   ${key} = ${masked}`);
  }
});

console.log(`[startup] ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}`);
if (process.env.ANTHROPIC_API_KEY) {
  console.log(`[startup] ANTHROPIC_API_KEY starts with: ${process.env.ANTHROPIC_API_KEY.substring(0, 10)}...`);
}

// Check if openclaw is available
console.log('[startup] Checking for openclaw command...');
try {
  const version = execSync('openclaw --version', { encoding: 'utf-8', timeout: 10000 }).trim();
  console.log(`[startup] OpenClaw version: ${version}`);
} catch (err) {
  console.error('[startup] ERROR: openclaw command not found!');
  console.error('[startup] Error details:', err.message);
  process.exit(1);
}

// Ensure directories exist
console.log('[startup] Creating directories...');
[STATE_DIR, WORKSPACE_DIR, `${WORKSPACE_DIR}/skills/eog-parser`].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[startup] Created: ${dir}`);
});

// Create OpenClaw config (delete old one first to avoid stale config on volume)
const configPath = path.join(STATE_DIR, 'openclaw.json');
console.log(`[startup] Config path: ${configPath}`);
if (fs.existsSync(configPath)) {
  fs.unlinkSync(configPath);
  console.log('[startup] Deleted existing config');
}

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
  skills: {
    load: {
      extraDirs: [`${WORKSPACE_DIR}/skills`],
      watch: false
    }
  },
  tools: {
    web: { search: { enabled: false }, fetch: { enabled: true } }
  }
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('[startup] Created OpenClaw config');

// Run OpenClaw onboarding to properly configure API key authentication
if (process.env.ANTHROPIC_API_KEY) {
  console.log('[startup] Running OpenClaw onboarding with API key...');
  try {
    const onboardResult = execSync(
      `openclaw onboard --anthropic-api-key "${process.env.ANTHROPIC_API_KEY}"`,
      { encoding: 'utf-8', timeout: 30000, env: { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR } }
    );
    console.log('[startup] OpenClaw onboarding complete');
    if (onboardResult) console.log(`[startup] Onboard output: ${onboardResult.substring(0, 200)}`);
  } catch (err) {
    console.error('[startup] OpenClaw onboarding error:', err.message);
    // Try alternative: set up auth profile directly
    console.log('[startup] Attempting direct auth profile setup...');
    const authDir = path.join(STATE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authProfile = {
      "anthropic:default": {
        provider: "anthropic",
        mode: "api_key",
        apiKey: process.env.ANTHROPIC_API_KEY
      }
    };
    fs.writeFileSync(path.join(authDir, 'profiles.json'), JSON.stringify(authProfile, null, 2));
    console.log('[startup] Created auth profile directly');
  }
} else {
  console.error('[startup] ERROR: ANTHROPIC_API_KEY not set!');
}

// Copy eog-parser skill to workspace
const skillSrc = path.join(__dirname, 'skills', 'eog-parser');
const skillDst = path.join(WORKSPACE_DIR, 'skills', 'eog-parser');
if (fs.existsSync(skillSrc)) {
  fs.cpSync(skillSrc, skillDst, { recursive: true });
  console.log('[startup] Copied eog-parser skill to workspace');
} else {
  console.log('[startup] WARNING: eog-parser skill source not found');
}

// Start Express server directly (no gateway needed)
console.log('[startup] Starting Express server...');
require('./server.js');
