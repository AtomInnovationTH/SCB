/**
 * daughterNames.js — single source of truth for the player-facing daughter name.
 *
 * Internal engine ids/types stay 'weaver-1' / 'spinner-2' (large / small arms),
 * but the crew only ever hears the size-based vocab: 'Large 1' / 'Small 2'. Both
 * the ArmUnit.displayName getter (which has the live arm object) and CommsSystem
 * (which only has an armId string from event payloads) route through this one
 * function so the same daughter can never be labelled two different ways.
 *
 * Non-daughter sources (HOUSTON, SYSTEM, ARM-1, NET POD, …) and any unrecognised
 * string pass through unchanged.
 *
 * @param {string} armId - e.g. 'weaver-1', 'spinner-2', 'menu-weaver-3'
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
