'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { portOpen } = require('../../database/devMongo');

const SERVICE_DIR = path.join(__dirname, '..', '..', '..', '..', 'diagnostic-service');
const DEFAULT_URL = 'http://127.0.0.1:8090';

/**
 * Development convenience: if the AI diagnostic service is installed next to
 * this app (diagnostic-service/.venv) and is not already running, start it as
 * a child process, so "npm run dev" brings up AI too. Production never spawns
 * processes: point DIAGNOSTIC_SERVICE_URL at the deployed service instead.
 *
 * May fill in config.DIAGNOSTIC_SERVICE_URL (dev only) when it was unset.
 */
async function ensureDiagnosticService(config, logger) {
  // The built-in provider (GROQ_API_KEY) needs no second process.
  if (config.isProduction || !config.AI_AUTOSTART || config.GROQ_API_KEY) return () => {};
  const python = path.join(SERVICE_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) return () => {};

  const url = new URL(config.DIAGNOSTIC_SERVICE_URL || DEFAULT_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return () => {};
  config.DIAGNOSTIC_SERVICE_URL ||= DEFAULT_URL;
  const port = Number(url.port || 80);
  if (await portOpen(port)) {
    logger.info({ url: config.DIAGNOSTIC_SERVICE_URL }, 'ai: diagnostic service already running');
    return () => {};
  }

  const child = spawn(python, ['-m', 'uvicorn', 'app.api.main:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: SERVICE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const relay = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) if (line.trim()) logger.debug({ service: 'diagnostic-service' }, line.trim());
  };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  child.on('exit', (code) => logger.warn({ code }, 'ai: diagnostic service exited'));
  logger.info({ url: config.DIAGNOSTIC_SERVICE_URL, pid: child.pid }, 'ai: started diagnostic service (dev)');
  return () => child.kill();
}

module.exports = { ensureDiagnosticService };
