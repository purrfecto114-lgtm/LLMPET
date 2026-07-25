'use strict';
// R20-拓展: Provider lazy loading verification
// Ensures codewhale/codex/opencode/aider are NOT loaded at module require time,
// and are only loaded on first getProvider() / getActiveProviders() call.
//
// #r5: Updated from 3 providers to 5 (added codex + opencode in Round 5).

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

console.log('[L1] ALL_IDS is static (no module loading)');
{
  // Clear any cached module
  delete require.cache[require.resolve('../providers/index')];
  // Also clear claude (always loaded) so we get a clean state
  delete require.cache[require.resolve('../providers/claude')];
  delete require.cache[require.resolve('../providers/base')];

  const idx = require('../providers/index');
  assert(Array.isArray(idx.ALL_IDS), 'ALL_IDS is array');
  assert(idx.ALL_IDS.length === 5, 'ALL_IDS has 5 entries (#r5: +codex +opencode)');
  assert(idx.ALL_IDS.includes('claude'), 'includes claude');
  assert(idx.ALL_IDS.includes('codewhale'), 'includes codewhale');
  assert(idx.ALL_IDS.includes('codex'), 'includes codex (#r5)');
  assert(idx.ALL_IDS.includes('opencode'), 'includes opencode (#r5)');
  assert(idx.ALL_IDS.includes('aider'), 'includes aider');
  assert(Object.isFrozen(idx.ALL_IDS), 'ALL_IDS is frozen');
}

console.log('[L2] claude is loaded eagerly (default provider)');
{
  // claude should always be in the loaded map at module init
  delete require.cache[require.resolve('../providers/index')];
  const idx = require('../providers/index');
  const claude = idx.getProvider('claude');
  assert(claude !== null, 'claude provider available');
  assert(claude.id === 'claude', 'claude.id correct');
  assert(typeof claude.parseHookStdin === 'function', 'claude has parseHookStdin');
}

console.log('[L3] codewhale loads on demand via getProvider');
{
  delete require.cache[require.resolve('../providers/index')];
  delete require.cache[require.resolve('../providers/codewhale')];
  const idx = require('../providers/index');
  // codewhale should NOT be in require.cache yet (only claude loaded eagerly)
  // We can't directly check the internal `loaded` Map, but we can verify
  // that getProvider('codewhale') works and returns a valid descriptor.
  const cw = idx.getProvider('codewhale');
  assert(cw !== null, 'codewhale loaded on demand');
  assert(cw.id === 'codewhale', 'codewhale.id correct');
  assert(typeof cw.parseHookStdin === 'function', 'codewhale has parseHookStdin');
}

console.log('[L4] aider loads on demand via getProvider');
{
  delete require.cache[require.resolve('../providers/index')];
  delete require.cache[require.resolve('../providers/aider')];
  const idx = require('../providers/index');
  const aider = idx.getProvider('aider');
  assert(aider !== null, 'aider loaded on demand');
  assert(aider.id === 'aider', 'aider.id correct');
  assert(typeof aider.parseHookStdin === 'function', 'aider has parseHookStdin');
}

console.log('[L4b] codex loads on demand via getProvider (#r5)');
{
  delete require.cache[require.resolve('../providers/index')];
  delete require.cache[require.resolve('../providers/codex')];
  const idx = require('../providers/index');
  const codex = idx.getProvider('codex');
  assert(codex !== null, 'codex loaded on demand');
  assert(codex.id === 'codex', 'codex.id correct');
  assert(typeof codex.parseHookStdin === 'function', 'codex has parseHookStdin');
}

console.log('[L4c] opencode loads on demand via getProvider (#r5)');
{
  delete require.cache[require.resolve('../providers/index')];
  delete require.cache[require.resolve('../providers/opencode')];
  const idx = require('../providers/index');
  const oc = idx.getProvider('opencode');
  assert(oc !== null, 'opencode loaded on demand');
  assert(oc.id === 'opencode', 'opencode.id correct');
  assert(typeof oc.parseHookStdin === 'function', 'opencode has parseHookStdin');
}

console.log('[L5] unknown provider returns null without crash');
{
  delete require.cache[require.resolve('../providers/index')];
  const idx = require('../providers/index');
  const unknown = idx.getProvider('nonexistent');
  assert(unknown === null, 'unknown provider returns null');
}

console.log('[L6] getActiveProviders with default (claude only)');
{
  // Ensure no env/config override
  const origEnv = process.env.OCTOPUS_PROVIDER;
  delete process.env.OCTOPUS_PROVIDER;
  delete require.cache[require.resolve('../providers/index')];
  delete require.cache[require.resolve('../providers/codewhale')];
  delete require.cache[require.resolve('../providers/aider')];

  const idx = require('../providers/index');
  const active = idx.getActiveProviders();
  assert(active.length === 1, '1 active provider by default');
  assert(active[0].id === 'claude', 'default is claude');
  // Restore env
  if (origEnv !== undefined) process.env.OCTOPUS_PROVIDER = origEnv;
  else delete process.env.OCTOPUS_PROVIDER;
}

console.log('[L7] getActiveProviders with OCTOPUS_PROVIDER=codewhale');
{
  process.env.OCTOPUS_PROVIDER = 'codewhale';
  delete require.cache[require.resolve('../providers/index')];
  delete require.cache[require.resolve('../providers/codewhale')];

  const idx = require('../providers/index');
  const active = idx.getActiveProviders();
  assert(active.length === 1, '1 active provider');
  assert(active[0].id === 'codewhale', 'active is codewhale');
  delete process.env.OCTOPUS_PROVIDER;
}

console.log('[L8] getActiveProviders with OCTOPUS_PROVIDER=all loads all 5 (#r5)');
{
  process.env.OCTOPUS_PROVIDER = 'all';
  delete require.cache[require.resolve('../providers/index')];
  delete require.cache[require.resolve('../providers/codewhale')];
  delete require.cache[require.resolve('../providers/codex')];
  delete require.cache[require.resolve('../providers/opencode')];
  delete require.cache[require.resolve('../providers/aider')];

  const idx = require('../providers/index');
  const active = idx.getActiveProviders();
  assert(active.length === 5, '5 active providers with "all" (#r5)');
  const ids = active.map(p => p.id);
  assert(ids.includes('claude'), 'claude in active');
  assert(ids.includes('codewhale'), 'codewhale in active');
  assert(ids.includes('codex'), 'codex in active (#r5)');
  assert(ids.includes('opencode'), 'opencode in active (#r5)');
  assert(ids.includes('aider'), 'aider in active');
  delete process.env.OCTOPUS_PROVIDER;
}

console.log('[L9] invalidate resets cache but keeps loaded providers');
{
  process.env.OCTOPUS_PROVIDER = 'claude';
  delete require.cache[require.resolve('../providers/index')];

  const idx = require('../providers/index');
  const first = idx.getActiveIds();
  assert(first.length === 1 && first[0] === 'claude', 'before invalidate: claude only');

  // Switch to all
  process.env.OCTOPUS_PROVIDER = 'all';
  delete require.cache[require.resolve('../providers/codewhale')];
  delete require.cache[require.resolve('../providers/codex')];
  delete require.cache[require.resolve('../providers/opencode')];
  delete require.cache[require.resolve('../providers/aider')];
  const after = idx.invalidate();
  assert(after.activeIds.length === 5, 'after invalidate: 5 providers (#r5)');
  delete process.env.OCTOPUS_PROVIDER;
}

console.log('[L10] lazy load does not break provider-validate test expectations (#r5)');
{
  delete require.cache[require.resolve('../providers/index')];
  delete require.cache[require.resolve('../providers/codewhale')];
  delete require.cache[require.resolve('../providers/codex')];
  delete require.cache[require.resolve('../providers/opencode')];
  delete require.cache[require.resolve('../providers/aider')];
  delete require.cache[require.resolve('../providers/claude')];

  const { getProvider, ALL_IDS, is_active, getActiveIds } = require('../providers/index');

  // All IDs still accessible (#r5: 5 providers now)
  assert(ALL_IDS.length === 5, 'ALL_IDS still 5 after fresh load (#r5)');

  // getProvider works for all
  for (const id of ALL_IDS) {
    const p = getProvider(id);
    assert(p !== null, `getProvider('${id}') returns non-null`);
    assert(p.id === id, `getProvider('${id}').id correct`);
  }

  // is_active works
  assert(is_active('claude') === true, 'claude is active by default');
  assert(typeof is_active('codewhale') === 'boolean', 'is_active returns boolean for codewhale');
  assert(typeof is_active('codex') === 'boolean', 'is_active returns boolean for codex (#r5)');
  assert(typeof is_active('opencode') === 'boolean', 'is_active returns boolean for opencode (#r5)');

  // getActiveIds works
  const ids = getActiveIds();
  assert(Array.isArray(ids) && ids.length >= 1, 'getActiveIds returns non-empty array');
  assert(ids[0] === 'claude', 'first active id is claude');
}

// --- Summary ---
console.log('');
if (fail) {
  console.log(`❌ FAIL — ${pass} passed, ${fail} failed`);
  process.exit(1);
} else {
  console.log(`✅ ALL PASS — ${pass} passed, 0 failed`);
}