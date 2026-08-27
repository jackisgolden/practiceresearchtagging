// Structured JSON logs + CloudWatch EMF metrics, both to stdout. No SDK calls.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLog({ level = 'info', out = process.stdout } = {}) {
  const min = LEVELS[level] ?? 20;
  const emit = (lvl) => (o) => { if (LEVELS[lvl] >= min) out.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, ...o }) + '\n'); };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export function createMetrics({ env, namespace = 'ESS/UFM/Intake', out = process.stdout } = {}) {
  const emf = (name, value, unit, dims = {}) => {
    const d = { Environment: env, ...dims };
    out.write(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [Object.keys(d)], Metrics: [{ Name: name, Unit: unit }] }] },
      ...d, [name]: value,
    }) + '\n');
  };
  return {
    count: (name, dims) => emf(name, 1, 'Count', dims),
    ms: (name, value, dims) => emf(name, value, 'Milliseconds', dims),
  };
}

export const nullLog = { debug() {}, info() {}, warn() {}, error() {} };
export const nullMetrics = { count() {}, ms() {} };
