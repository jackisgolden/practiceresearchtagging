// Hand-written checks mirroring contracts/*.schema.json. Returns ALL errors.
import { readFileSync } from 'node:fs';
import { ULID_RE } from './ids.mjs';

const load = (n) => JSON.parse(readFileSync(new URL(`../contracts/${n}`, import.meta.url), 'utf8'));
const INTAKE = load('intake-event.schema.json');
const REG = load('registration.schema.json');
const AUDIT = load('audit.schema.json');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function check(schema, obj) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: ['body must be a JSON object'] };
  for (const k of schema.required || []) if (!(k in obj)) errors.push(`missing: ${k}`);
  for (const k of Object.keys(obj)) if (!(k in schema.properties)) errors.push(`unexpected: ${k}`);
  for (const [k, rule] of Object.entries(schema.properties)) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (rule.const !== undefined && v !== rule.const) errors.push(`${k}: must equal ${rule.const}`);
    if (rule.enum && !rule.enum.includes(v)) errors.push(`${k}: must be one of ${rule.enum.join('|')}`);
    if (rule.type === 'string') {
      if (typeof v !== 'string') { errors.push(`${k}: must be string`); continue; }
      if (rule.minLength !== undefined && v.length < rule.minLength) errors.push(`${k}: shorter than ${rule.minLength}`);
      if (rule.maxLength !== undefined && v.length > rule.maxLength) errors.push(`${k}: longer than ${rule.maxLength}`);
      if (rule.pattern && !new RegExp(rule.pattern).test(v)) errors.push(`${k}: does not match ${rule.pattern}`);
      if (rule.format === 'date-time' && !isDate(v)) errors.push(`${k}: invalid date-time`);
    } else if (rule.type === 'integer') {
      if (!Number.isInteger(v)) { errors.push(`${k}: must be integer`); continue; }
      if (rule.minimum !== undefined && v < rule.minimum) errors.push(`${k}: below ${rule.minimum}`);
    } else if (rule.type === 'object') {
      if (!isObj(v)) errors.push(`${k}: must be object`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export const validateIntakeEvent = (o) => check(INTAKE, o);
export const validateRegistration = (o) => {
  const r = check(REG, o);
  if (r.ok && !ULID_RE.test(o.id)) return { ok: false, errors: ['id: not a ULID'] };
  return r;
};
export const validateAudit = (o) => check(AUDIT, o);
export const validateReprocessBody = (o) => {
  if (!isObj(o)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors = Object.keys(o).filter((k) => k !== 'params').map((k) => `unexpected: ${k}`);
  if ('params' in o && !isObj(o.params)) errors.push('params: must be object');
  return errors.length ? { ok: false, errors } : { ok: true };
};
