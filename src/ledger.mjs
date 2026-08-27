// Ledger interface, as the app uses it.
//   register(row)              -> { created: true, row } | { created: false, row: existing }
//   getById(id)                -> row | null
//   getByIdemKey(idemKey)      -> row | null
//   transition(row, patch, expectedStatus) -> row | null (null = condition failed)
//   ready()                    -> resolves if table reachable
// Every write is conditional. No unconditional Put/Update anywhere.
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export class ConditionFailed extends Error {}

export function createDynamoLedger({ region, table, client }) {
  const raw = client || new DynamoDBClient({ region });
  const doc = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  const isCond = (e) => e?.name === 'ConditionalCheckFailedException';

  return {
    async register(row) {
      try {
        await doc.send(new PutCommand({ TableName: table, Item: row, ConditionExpression: 'attribute_not_exists(idemKey)' }));
        return { created: true, row };
      } catch (e) {
        if (!isCond(e)) throw e;
        const existing = await this.getByIdemKey(row.idemKey);
        return { created: false, row: existing };
      }
    },
    async getByIdemKey(idemKey) {
      const r = await doc.send(new GetCommand({ TableName: table, Key: { idemKey } }));
      return r.Item || null;
    },
    async getById(id) {
      const r = await doc.send(new QueryCommand({
        TableName: table, IndexName: 'by-id', KeyConditionExpression: '#id = :id',
        ExpressionAttributeNames: { '#id': 'id' }, ExpressionAttributeValues: { ':id': id }, Limit: 1,
      }));
      return r.Items?.[0] || null;
    },
    async transition(row, patch, expectedStatus) {
      const names = { '#status': 'status' }, values = { ':expected': expectedStatus };
      const sets = [], removes = [];
      let i = 0;
      for (const [k, v] of Object.entries(patch)) {
        const nk = `#p${i}`, vk = `:v${i}`; i++;
        names[nk] = k;
        if (v === undefined) removes.push(nk); else { values[vk] = v; sets.push(`${nk} = ${vk}`); }
      }
      const expr = (sets.length ? `SET ${sets.join(', ')} ` : '') + (removes.length ? `REMOVE ${removes.join(', ')}` : '');
      try {
        const r = await doc.send(new UpdateCommand({
          TableName: table, Key: { idemKey: row.idemKey }, UpdateExpression: expr.trim(),
          ConditionExpression: '#status = :expected', ExpressionAttributeNames: names,
          ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW',
        }));
        return r.Attributes;
      } catch (e) {
        if (isCond(e)) return null;
        throw e;
      }
    },
    async ready() {
      await raw.send(new DescribeTableCommand({ TableName: table }), { abortSignal: AbortSignal.timeout(2000) });
    },
  };
}

// In-memory ledger with identical semantics. Used by tests and local dev.
export function createMemoryLedger() {
  const rows = new Map();
  return {
    _rows: rows,
    failNext: null, // set to an Error to make the next write throw
    async register(row) {
      if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
      if (rows.has(row.idemKey)) return { created: false, row: rows.get(row.idemKey) };
      rows.set(row.idemKey, { ...row });
      return { created: true, row };
    },
    async getByIdemKey(k) { return rows.get(k) || null; },
    async getById(id) { for (const r of rows.values()) if (r.id === id) return r; return null; },
    async transition(row, patch, expectedStatus) {
      if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
      const cur = rows.get(row.idemKey);
      if (!cur || cur.status !== expectedStatus) return null;
      const next = { ...cur };
      for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete next[k]; else next[k] = v; }
      rows.set(row.idemKey, next);
      return next;
    },
    async ready() { if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; } },
  };
}
