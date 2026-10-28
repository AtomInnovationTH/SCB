/**
 * daughterDisplayName — single source of truth for the player-facing daughter name. Engine ids/types stay 'weaver-1' /
 * 'spinner-2' (large / small arms), but the crew only hears 'Large 1' / 'Small 2'. ArmUnit.displayName
 * (has the live arm object) and CommsSystem (only an armId string from event payloads) both route through it so a
 * daughter can't be labelled two ways. Non-daughter sources (HOUSTON, SYSTEM, ARM-1, LARGE NET, …) and unrecognised
 * strings pass through unchanged.
 * @param {string} armId e.g. 'weaver-1', 'spinner-2', 'menu-weaver-3'
 * @returns {string} 'Large 1' / 'Small 2', or the input unchanged
 */
export function daughterDisplayName(armId) {
  if (!armId || typeof armId !== 'string') return armId;
  const lower = armId.toLowerCase();
  const isWeaver = lower.includes('weaver');
  const isSpinner = lower.includes('spinner');
  if (!isWeaver && !isSpinner) return armId;
  const label = isWeaver ? 'Large' : 'Small';
  const m = armId.match(/(\d+)\s*$/);
  return m ? `${label} ${m[1]}` : label;
}
