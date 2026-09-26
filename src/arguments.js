// Zod messages can contain arbitrary unknown property names. Return only schema
// field names and bounded, value-free issues, never submitted source or values.
export function parseArguments(schema, args) {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;
  const fields = new Set([...Object.keys(schema.shape || {}), 'action', 'path', 'expectedSha256', 'content', 'executable', 'oldText', 'newText', 'to']);
  const issues = parsed.error.issues.slice(0, 5).map(issue => {
    const field = issue.path.map(part => typeof part === 'number' && Number.isSafeInteger(part) ? part : fields.has(part) ? part : '<field>').join('.') || '<arguments>';
    const details = issue.code === 'too_small' ? { minimum: issue.minimum } : issue.code === 'too_big' ? { maximum: issue.maximum } : {};
    const message = issue.code === 'too_small' ? `Must be at least ${issue.minimum}.` : issue.code === 'too_big' ? `Must be at most ${issue.maximum}.`
      : issue.code === 'unrecognized_keys' ? 'Contains unsupported fields; use only the advertised arguments.'
        : issue.code === 'invalid_type' ? 'Missing or incorrect argument type.' : issue.code === 'invalid_value' ? 'Value is not one of the advertised options.'
          : issue.code === 'custom' && field === 'maxBytes' ? 'maxBytes and limit must match when both are supplied.'
            : issue.code === 'custom' ? 'Arguments conflict with the documented field constraints.' : 'Value does not match the advertised format.';
    return { field, code: issue.code, message, ...details };
  });
  throw Object.assign(new Error(`Invalid tool arguments: ${issues.map(issue => `${issue.field}: ${issue.message}`).join('; ').slice(0, 500)}`), { code: 'INVALID_ARGUMENT', issues });
}

