'use strict';

/**
 * Creates a user from the command line (used to bootstrap the first admin).
 *
 *   npm run create-user -- --email you@example.com --name "You" --role admin
 *
 * The password is read from NEXLINK_NEW_USER_PASSWORD or prompted on stdin
 * (hidden), so it never appears in shell history or process listings.
 */
require('dotenv').config();
const readline = require('node:readline');
const { loadConfig } = require('../src/config/env');
const { connectDatabase, disconnectDatabase } = require('../src/database');
const { User, ROLES } = require('../src/database/models/identity');
const { hashPassword } = require('../src/modules/auth/passwords');
const { AuditEvent } = require('../src/database/models/audit');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const email = arg('email');
  const displayName = arg('name') || email;
  const role = arg('role') || 'admin';
  if (!email || !ROLES.includes(role)) {
    console.error(`usage: npm run create-user -- --email <email> [--name <name>] [--role ${ROLES.join('|')}]`);
    process.exit(2);
  }
  const password = process.env.NEXLINK_NEW_USER_PASSWORD || (await promptHidden('Password (min 12 chars): '));
  if (!password || password.length < 12) {
    console.error('Password must be at least 12 characters');
    process.exit(2);
  }
  const config = loadConfig();
  await connectDatabase(config.MONGODB_URI);
  if (await User.exists({ email: email.toLowerCase() })) {
    console.error(`User ${email} already exists`);
    process.exit(1);
  }
  const user = await User.create({ email, displayName, role, passwordHash: await hashPassword(password, config.PASSWORD_SCRYPT_N) });
  await AuditEvent.create({
    at: new Date(),
    actor: { type: 'system', id: 'cli', label: 'create-user script' },
    operation: 'user.create',
    target: { type: 'user', id: String(user._id), label: email },
    decision: 'allow',
    outcome: 'success',
    metadata: { role },
  });
  console.log(`Created ${role} ${email} (${user._id})`);
  await disconnectDatabase();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
