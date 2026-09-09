import { z } from 'zod';

const id = z.string().uuid(), key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
const release = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
export const releaseTools = {
  praxis_release_plan: { action: 'releasePlan', title: 'Prepare a Praxis application release', write: true,
    description: 'Prepare an exact synchronized Praxis source commit with the independent updater. Requires a completed project_sync operation for praxis and expected current release. Builds/tests run without live state or production authority. Returns a durable operation; inspect praxis_release_status until ready. Does not activate.',
    schema: z.object({ syncOperationId: id, expectedRelease: release, idempotencyKey: key }) },
  praxis_release_apply: { action: 'releaseApply', title: 'Activate a prepared Praxis release', write: true, destructive: true,
    description: 'Activate a ready, tested release plan through the independent updater. Requires its digest and expected current release. Active jobs defer activation. Failed health restores the previous application; protected controls remain separate. If a saved operation reports restoration_failed, an explicit retry with identical inputs/key resumes that same restoration after observing current state.',
    schema: z.object({ planId: id, planDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedRelease: release, idempotencyKey: key }) },
  praxis_release_status: { action: 'releaseStatus', title: 'Recover Praxis release status',
    description: 'Read active application release and optionally a durable release operation, including bounded saved preparation diagnostics. Works through the protected gateway when the coding application is unavailable. Never restarts or recreates work.',
    schema: z.object({ operationId: id.optional() }) },
  praxis_release_history: { action: 'releaseHistory', title: 'List Praxis release operations',
    description: 'Recover release preparation, activation and rollback receipts from the independently stored history. Follow the supplied cursor.',
    schema: z.object({ cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }) },
  praxis_release_rollback: { action: 'releaseRollback', title: 'Restore a previous Praxis application', write: true, destructive: true,
    description: 'Restore the previous known working application from an identified successful activation. Requires expected current release. Does not restore databases or reverse Git publication, external effects or protected configuration.',
    schema: z.object({ deploymentOperationId: id, expectedRelease: release, idempotencyKey: key }) }
};
