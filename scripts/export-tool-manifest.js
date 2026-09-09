import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { codeTools } from '../src/code/schema.js';

const destination = process.argv[2];
if (!destination) throw new Error('Supply the manifest output path. Run this in the unprivileged candidate build.');
const tools = Object.entries(codeTools).map(([name, tool]) => ({ name, title: tool.title, description: tool.description,
  write: !!tool.write, destructive: !!tool.destructive,
  inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-7', unrepresentable: 'any' }) }));
writeFileSync(destination, JSON.stringify({ version: 1, apiVersion: '0.5.0', tools }, null, 2) + '\n');
