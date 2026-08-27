// Loads registration-states.json. Intake may only perform transitions listed with owner "intake".
import { readFileSync } from 'node:fs';
const spec = JSON.parse(readFileSync(new URL('../contracts/registration-states.json', import.meta.url), 'utf8'));

export const STATES = spec.states;
export const INITIAL = spec.initial;
export const TERMINAL = new Set(spec.terminal);
export const intakeTransitions = spec.transitions.filter((t) => t.owner === 'intake');

export function intakeMay(from, to) {
  return intakeTransitions.some((t) => t.from === from && t.to === to);
}
