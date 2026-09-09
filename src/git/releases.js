import { createHash } from 'node:crypto';
import { releaseTools } from '../release-schema.js';

export const releaseBrokerSchemas = Object.fromEntries(Object.values(releaseTools).map(tool => [tool.action, tool.schema.strict()]));
const actions = { releasePlan: 'plan', releaseApply: 'apply', releaseRollback: 'rollback', releaseStatus: 'status', releaseHistory: 'history' };
function operationId(owner, key) {
  const bytes = createHash('sha256').update(`praxis-release\0${owner}\0${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}

/** Runs in the independently installed broker, never candidate application code. */
export async function releaseCall(broker, action, { owner, ...args }) {
  if (!broker.releaseControl) throw Object.assign(new Error('Independent release control is not installed.'), { code: 'SELF_UPDATE_DISABLED' });
  let input = { action: actions[action], owner, ...args };
  if (args.idempotencyKey) input.operationId = operationId(owner, args.idempotencyKey);
  if (action === 'releasePlan') {
    const source = broker.row(owner, args.syncOperationId);
    if (source.kind !== 'sync' || source.project_id !== 'praxis' || source.status !== 'completed') {
      throw Object.assign(new Error('A completed Praxis project_sync operation is required.'), { code: 'SOURCE_NOT_READY' });
    }
    const result = JSON.parse(source.result_json);
    delete input.syncOperationId;
    input = { ...input, exportId: result.exportId, sourceCommit: result.commit, sourceDigest: result.revision };
  }
  return broker.releaseControl(input);
}
