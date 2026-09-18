import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiConfig } from '../scripts/ai.mjs';

const root = mkdtempSync(join(tmpdir(), 'browse-ai-config-'));
const store = join(root, 'store'), project = join(root, 'project');
mkdirSync(store); mkdirSync(project);
const env = { BROWSE_HOME: store };
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`ok ${name}`); };
try {
  check('missing credentials fail clearly', () => assert.throws(() => aiConfig(env, project), /set TYPESAFE_API_KEY/));
  writeFileSync(join(store, 'typesafe.env'), 'UNRELATED=$(touch bad)\nTYPESAFE_API_KEY="user-key"\n', { mode: 0o600 });
  check('user credential works outside a project with dotenv', () => assert.equal(aiConfig(env, project).key, 'user-key'));
  check('dotenv is never executed', () => assert.equal(existsSync(join(project, 'bad')), false));
  writeFileSync(join(project, '.env'), 'UNRELATED=setting\n');
  check('project without a key uses user credential', () => assert.equal(aiConfig(env, project).key, 'user-key'));
  writeFileSync(join(project, '.env'), 'TYPESAFE_API_KEY=project-key\n');
  check('project key overrides user credential', () => assert.equal(aiConfig(env, project).key, 'project-key'));
  writeFileSync(join(project, 'explicit.env'), 'TYPESAFE_API_KEY=explicit-key\n');
  check('explicit file overrides both defaults', () => assert.equal(aiConfig({ ...env, TYPESAFE_ENV_FILE: 'explicit.env' }, project).key, 'explicit-key'));
  check('environment key overrides every file', () => assert.equal(aiConfig({ ...env, TYPESAFE_API_KEY: 'env-key', TYPESAFE_ENV_FILE: 'absent' }, project).key, 'env-key'));
  check('missing explicit file never uses another credential', () => assert.throws(() => aiConfig({ ...env, TYPESAFE_ENV_FILE: 'absent' }, project), /cannot read/));
  writeFileSync(join(project, 'empty.env'), 'UNRELATED=setting\n');
  check('explicit file without key never uses another credential', () => assert.throws(() => aiConfig({ ...env, TYPESAFE_ENV_FILE: 'empty.env' }, project), /set TYPESAFE_API_KEY/));
  rmSync(join(project, '.env')); mkdirSync(join(project, '.env'));
  check('unreadable default fails instead of silently switching accounts', () => assert.throws(() => aiConfig(env, project), /cannot read/));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`${checks}/${checks} passed`);
