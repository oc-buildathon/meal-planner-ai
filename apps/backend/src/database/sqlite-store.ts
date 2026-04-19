import {
  BaseStore,
  type Operation,
  type OperationResults,
  type Item,
  type GetOperation,
  type PutOperation,
  type SearchOperation,
  type ListNamespacesOperation,
  type MatchCondition,
} from "@langchain/langgraph";
import type { Database } from "bun:sqlite";

/**
 * `SearchItem` isn't re-exported by the installed @langchain/langgraph;
 * it is simply an `Item` with an optional numeric score. Re-declare
 * locally to avoid importing the private `@langchain/langgraph-checkpoint`
 * package directly.
 */
type SearchItem = Item & { score?: number };

/**
 * Namespace separator used internally.
 *
 * The separator must be a character guaranteed not to appear inside a
 * namespace segment. We use 0x1F (Unit Separator) — an ASCII control
 * character with no legitimate use in path segments.
 */
const NS_SEP = "\u001F";

function encodeNamespace(ns: string[]): string {
  return ns.join(NS_SEP);
}

function decodeNamespace(s: string): string[] {
  return s.length === 0 ? [] : s.split(NS_SEP);
}

/**
 * SqliteStore — persistent BaseStore implementation backed by the same
 * SQLite file used for users + message log.
 *
 * What this enables:
 *   - Per-user memory namespaces (`["mealprep-agent", "user", <id>]`)
 *     survive process restarts.
 *   - `/taste/profile.md`, `/diet/active-plan.md`, etc. that the deep
 *     agent writes via its `edit_file` tool are persisted as rows in
 *     `agent_store`.
 *
 * What this does NOT implement:
 *   - Vector / semantic search (the `query` search option). Everything
 *     the deep-agent does today is direct get/put by path, so that's
 *     fine. Can be added later with a separate embeddings column.
 */
export class SqliteStore extends BaseStore {
  constructor(private readonly db: Database) {
    super();
  }

  async batch<Op extends Operation[]>(
    operations: Op,
  ): Promise<OperationResults<Op>> {
    const results: unknown[] = new Array(operations.length);

    // Group puts into a single transaction for consistency + speed.
    const putOps: Array<[number, PutOperation]> = [];

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i] as Operation;

      if ("key" in op && "namespace" in op && !("value" in op)) {
        // GetOperation
        results[i] = this.getOne(op as GetOperation);
      } else if ("namespacePrefix" in op) {
        // SearchOperation
        results[i] = this.search_(op as SearchOperation);
      } else if ("matchConditions" in op) {
        // ListNamespacesOperation
        results[i] = this.listNamespaces_(op as ListNamespacesOperation);
      } else if ("value" in op) {
        // PutOperation — batched below
        putOps.push([i, op as PutOperation]);
        results[i] = undefined;
      }
    }

    if (putOps.length > 0) {
      const upsert = this.db.query(`
        INSERT INTO agent_store (namespace, key, value_json, created_at, updated_at)
        VALUES ($ns, $k, $v, datetime('now','subsec'), datetime('now','subsec'))
        ON CONFLICT(namespace, key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = datetime('now','subsec');
      `);
      const del = this.db.query(
        `DELETE FROM agent_store WHERE namespace = $ns AND key = $k;`,
      );

      const tx = this.db.transaction(() => {
        for (const [, op] of putOps) {
          const ns = encodeNamespace(op.namespace);
          if (op.value === null) {
            del.run({ $ns: ns, $k: op.key });
          } else {
            upsert.run({
              $ns: ns,
              $k: op.key,
              $v: JSON.stringify(op.value),
            });
          }
        }
      });
      tx();
    }

    return results as OperationResults<Op>;
  }

  // ------------------------------------------------------------------
  // Individual ops
  // ------------------------------------------------------------------

  private getOne(op: GetOperation): Item | null {
    const ns = encodeNamespace(op.namespace);
    const row = this.db
      .query<
        { value_json: string; created_at: string; updated_at: string },
        any
      >(
        `SELECT value_json, created_at, updated_at
         FROM agent_store
         WHERE namespace = $ns AND key = $k
         LIMIT 1`,
      )
      .get({ $ns: ns, $k: op.key });

    if (!row) return null;

    return {
      value: safeJsonParse(row.value_json),
      key: op.key,
      namespace: op.namespace,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private search_(op: SearchOperation): SearchItem[] {
    const prefix = encodeNamespace(op.namespacePrefix);
    const offset = op.offset ?? 0;
    const limit = op.limit ?? 10;

    // Pull all candidates under the prefix. Small dataset per user, so
    // in-memory filtering is fine. Namespace equals the prefix or begins
    // with `prefix + SEP`.
    const rows = this.db
      .query<
        {
          namespace: string;
          key: string;
          value_json: string;
          created_at: string;
          updated_at: string;
        },
        any
      >(
        prefix.length === 0
          ? `SELECT namespace, key, value_json, created_at, updated_at
             FROM agent_store
             ORDER BY namespace, key`
          : `SELECT namespace, key, value_json, created_at, updated_at
             FROM agent_store
             WHERE namespace = $ns OR namespace LIKE $nsLike
             ORDER BY namespace, key`,
      )
      .all({ $ns: prefix, $nsLike: prefix + NS_SEP + "%" });

    let items: Item[] = rows.map((r) => ({
      value: safeJsonParse(r.value_json),
      key: r.key,
      namespace: decodeNamespace(r.namespace),
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }));

    if (op.filter && Object.keys(op.filter).length > 0) {
      items = items.filter((it) => matchesFilter(it.value, op.filter!));
    }

    // No vector search — return without scores.
    const page = items.slice(offset, offset + limit);
    return page.map((it) => ({ ...it, score: undefined }));
  }

  private listNamespaces_(op: ListNamespacesOperation): string[][] {
    const rows = this.db
      .query<{ namespace: string }, []>(
        `SELECT DISTINCT namespace FROM agent_store`,
      )
      .all();

    let namespaces = rows.map((r) => decodeNamespace(r.namespace));

    if (op.matchConditions && op.matchConditions.length > 0) {
      namespaces = namespaces.filter((ns) =>
        op.matchConditions!.every((c: MatchCondition) => doesMatch(c, ns)),
      );
    }

    if (op.maxDepth !== undefined) {
      const uniq = new Set<string>();
      for (const ns of namespaces) {
        uniq.add(ns.slice(0, op.maxDepth).join(NS_SEP));
      }
      namespaces = Array.from(uniq).map(decodeNamespace);
    }

    namespaces.sort((a, b) =>
      a.join(NS_SEP).localeCompare(b.join(NS_SEP)),
    );

    const offset = op.offset ?? 0;
    const limit = op.limit ?? namespaces.length;
    return namespaces.slice(offset, offset + limit);
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function safeJsonParse(s: string): Record<string, any> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Implement the same operator-style filter semantics as InMemoryStore. */
function matchesFilter(
  value: Record<string, any>,
  filter: Record<string, any>,
): boolean {
  for (const [k, cond] of Object.entries(filter)) {
    const v = value[k];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, target] of Object.entries(cond)) {
        switch (op) {
          case "$eq":
            if (v !== target) return false;
            break;
          case "$ne":
            if (v === target) return false;
            break;
          case "$gt":
            if (!(v > (target as any))) return false;
            break;
          case "$gte":
            if (!(v >= (target as any))) return false;
            break;
          case "$lt":
            if (!(v < (target as any))) return false;
            break;
          case "$lte":
            if (!(v <= (target as any))) return false;
            break;
          default:
            // Unknown operator — be strict, don't match.
            return false;
        }
      }
    } else {
      if (v !== cond) return false;
    }
  }
  return true;
}

function doesMatch(m: MatchCondition, key: string[]): boolean {
  const { matchType, path } = m;
  if (matchType === "prefix") {
    if (path.length > key.length) return false;
    return path.every((p: string, i: number) => p === "*" || p === key[i]);
  }
  if (matchType === "suffix") {
    if (path.length > key.length) return false;
    return path.every(
      (p: string, i: number) =>
        p === "*" || p === key[key.length - path.length + i],
    );
  }
  return false;
}
