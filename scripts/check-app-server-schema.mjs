import { validateAppServerSchema } from '../dist/src/appserver/AppServerSchemaCompatibility.js';

const command = process.env.CODEX_COMMAND || 'codex';
const version = await validateAppServerSchema(command, process.env.EXPECTED_CODEX_VERSION);
console.log(`App-server schema ${version} is compatible with link_bot.`);
