/**
 * API-key storage for Image Studio.
 *
 * Keys are held by the Harness credential service, not by this plugin's settings
 * file: the plugin writes one ref per provider (the first entry of the adapter's
 * `keyRefs`) and reads through the whole chain, so a key the user already
 * configured for a DSH provider (e.g. `OPENAI_API_KEY`) is picked up
 * automatically. Values are resolved per operation, never cached.
 */

/**
 * @param {object} ctx host context (may expose `credentials`)
 * @param {(id: string) => object|undefined} getAdapter
 */
export function createCredentialStore(ctx, getAdapter) {
  const service = () => {
    try {
      return ctx.get?.('credentials', false) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /** Every credential ref this provider may answer from, most specific first. */
  function refsFor(providerId) {
    const adapter = getAdapter(providerId);
    const refs = Array.isArray(adapter?.keyRefs) ? adapter.keyRefs.filter((ref) => typeof ref === 'string' && ref) : [];
    return refs;
  }

  return {
    refsFor,

    /** Configured state + the ref that supplied it; never returns the value. */
    async describe(providerId) {
      const adapter = getAdapter(providerId);
      if (!adapter) return { configured: false, source: '', writable: false };
      if (adapter.id === 'mock') return { configured: true, source: 'offline', writable: false };
      const credentials = service();
      if (!credentials) return { configured: false, source: '', writable: false };
      for (const ref of refsFor(providerId)) {
        try {
          const info = await credentials.describe(ref);
          if (info?.configured === true) {
            return { configured: true, source: ref, writable: info.writable !== false };
          }
        } catch {
          // A ref the provider rejects is simply not a candidate.
        }
      }
      return { configured: false, source: '', writable: true };
    },

    /** Resolve the key for one operation. */
    async resolve(providerId) {
      const adapter = getAdapter(providerId);
      if (!adapter) return undefined;
      if (adapter.id === 'mock') return '';
      const credentials = service();
      if (!credentials) return undefined;
      for (const ref of refsFor(providerId)) {
        try {
          const resolved = await credentials.resolve(ref);
          if (resolved?.value) return resolved;
        } catch {
          // Try the next ref.
        }
      }
      return undefined;
    },

    /** Store the key in this plugin's own ref (the first one). */
    async save(providerId, apiKey) {
      const refs = refsFor(providerId);
      if (refs.length === 0) throw new Error(`provider "${providerId}" does not accept an API key`);
      const credentials = service();
      if (!credentials) throw new Error('the credential service is unavailable in this profile');
      await credentials.set(refs[0], apiKey);
      return refs[0];
    },

    /** Remove every ref this provider could answer from (own ref first). */
    async clear(providerId) {
      const credentials = service();
      if (!credentials) return;
      for (const ref of refsFor(providerId)) {
        try {
          await credentials.unset(ref);
        } catch {
          // Removing an absent ref is a no-op; a read-only ref is not ours to remove.
        }
      }
    },
  };
}
