// Every checklist line is a CHECK = a statement that must be TRUE.
//   "USB port"                                   -> the USB port must really be there
//   "USB cable :: plugged into a USB port"       -> the cable must be visibly inserted (state check)
//   "Screen :: no cracks or broken areas"        -> must be visibly free of damage
import { cleanText } from './common.js';

// A line starting with "!" is a CRITICAL safety check, e.g. "! Guardrails :: fitted on all open sides".
export function parseCheck(s) {
  let txt = String(s ?? '').trim();
  const critical = txt.startsWith('!');
  if (critical) txt = txt.slice(1);
  const [name, ...rest] = txt.split('::');
  return { name: cleanText(name, 80), rule: cleanText(rest.join('::'), 200), critical };
}

// Turns a checklist line into the exact statement the AI must verify.
export function statement(s) {
  const { name, rule } = parseCheck(s);
  return rule
    ? `${name}: ${rule}`
    : `"${name}" is physically there on the item and clearly visible (an empty place or socket where it should be does NOT count).`;
}

export const STRICT_RULES = `How to judge each check:
- Each check is a STATEMENT that must be TRUE. Judge the WHOLE statement, not just whether an object exists.
- State words (connected, plugged in, inserted, attached, fitted, closed, locked, tightened, switched on, lit, turned on):
  TRUE only if you can SEE that state. Example: "USB cable plugged into laptop" is TRUE only if you see the cable's plug
  physically inside the laptop's USB port. An empty port = FALSE. A cable lying near the laptop but not inserted = FALSE.
  If the port area is hidden, cropped, blurry or too far to tell = UNCLEAR.
- A socket, port, slot or mounting point being visible does NOT mean something is connected or fitted in it.
- Negative checks ("no cracks", "not damaged", "without leaks"): TRUE only if the area is clearly visible and the problem is absent.
- If the area is not in the photo, blocked, blurry, too dark or too far: UNCLEAR. Never guess.
- Never assume something because this kind of item normally has it.
- Write "evidence" FIRST: one short sentence describing exactly what you see at that spot. Then give the verdict.
- confidence (0 to 1) = how sure you are of the verdict. Use below 0.7 when the detail is small or partly hidden.`;

// Extra domain knowledge for special modules, added to every AI prompt of that module.
const MODULE_HINTS = {
  scaffold: `SCAFFOLDING INSPECTION – terms and rules:
- Standards = vertical tubes/uprights. Ledgers = horizontal tubes along the length. Transoms = short horizontal tubes across
  the width under the boards. Base plate = flat steel plate under each standard. Sole board = timber plank under base plates.
  Ties = tubes/anchors fixing the scaffold to the building. Bracing = diagonal tubes. Couplers = clamps joining tubes.
  Guardrail = top rail about 950 mm - 1 m above the platform. Mid rail = intermediate rail between guardrail and toe board.
  Toe board = upright plank (about 150 mm) along the platform edge. Platform = boards / steel decks forming the working floor.
- Judge only the part of the scaffold you can see, and say in the evidence which part you looked at.
- Bricks, blocks, loose packing, soft or uneven soil under base plates = FALSE for the sole board / firm ground check.
- Any visible gap, missing, broken or overhanging-unsupported board = FALSE for the platform check.
- An open side of a working platform without a guardrail / mid rail / toe board = FALSE for that check.
- Bent, cracked, crushed or heavily corroded tubes = FALSE for the tube condition check.
- A tube end without coupler, or a coupler hanging loose = FALSE for the couplers check.
- Missing ties on a tall scaffold against a building = FALSE for the ties check if the wall side is visible.
- People working without safety gear are NOT part of the checklist; mention them only under defects.`,
};
export function moduleHints(module) {
  return MODULE_HINTS[module] ? '\n' + MODULE_HINTS[module] : '';
}

export const VERDICT_TO_STATUS = { true: 'present', false: 'missing', unclear: 'unclear' };
