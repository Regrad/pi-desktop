// A necessary-condition filter, NOT an alternative ast-grep interpreter.
// All real findings still come from the unchanged native matcher. Positive
// relations require their target somewhere in the complete syntax tree. Testing
// those cheap local predicates once avoids re-scanning a huge declaration for
// every property/literal when a required call, import or identifier is absent.
export function createAstPreflight(scopeRoot) {
  const documentRoot = scopeRoot.getRoot().root();
  const presence = new Map();
  const validKinds = new Map();

  function exists(local) {
    const key = JSON.stringify(local);
    if (!presence.has(key)) {
      try {
        presence.set(key, documentRoot.find({ rule: local }) !== null);
      } catch {
        presence.set(key, true);
      }
    }
    return presence.get(key);
  }

  function localPossible(rule) {
    if (typeof rule.kind !== "string") return true;
    const local = { kind: rule.kind };
    if (typeof rule.regex === "string") local.regex = rule.regex;
    // Unknown/invalid grammar predicates belong to the real matcher, which
    // owns rejection logging. Never turn an unsupported predicate into false.
    return exists(local);
  }

  function possible(rule, utils, visiting) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return true;
    if (visiting.has(rule)) return true;
    visiting.add(rule);
    try {
      if (!localPossible(rule)) return false;
      if (Array.isArray(rule.all) && !rule.all.every(part => possible(part, utils, visiting))) return false;
      if (Array.isArray(rule.any) && rule.any.length > 0 && !rule.any.some(part => possible(part, utils, visiting))) return false;
      if (typeof rule.matches === "string" && utils?.[rule.matches] &&
          !possible(utils[rule.matches], utils, visiting)) return false;
      for (const relation of ["follows", "precedes", "inside", "has"]) {
        if (rule[relation]) {
          if (!possible(rule[relation], utils, visiting)) return false;
        }
      }
      // Deliberately ignore not, pattern/metavariables, constraints, nthChild,
      // fields and stopBy. Hoisting these could change binding/negative semantics.
      return true;
    } finally {
      visiting.delete(rule);
    }
  }

  const preflight = config => possible(config.rule, config.utils, new Set());
  const candidatesByKind = new Map();
  const documentCandidates = new Map();
  const ranges = new Map();

  function rangeOf(node) {
    const id = node.id();
    if (!ranges.has(id)) ranges.set(id, node.range());
    return ranges.get(id);
  }

  function candidateKinds(rule, utils, visiting = new Set()) {
    if (!rule || typeof rule !== "object" || visiting.has(rule)) return null;
    visiting.add(rule);
    try {
      if (typeof rule.kind === "string") return [rule.kind];
      if (Array.isArray(rule.all)) {
        for (const part of rule.all) {
          const kinds = candidateKinds(part, utils, visiting);
          if (kinds) return kinds;
        }
      }
      if (Array.isArray(rule.any) && rule.any.length) {
        const branches = rule.any.map(part => candidateKinds(part, utils, visiting));
        if (branches.every(Boolean)) return [...new Set(branches.flat())];
      }
      if (typeof rule.matches === "string" && utils?.[rule.matches]) return candidateKinds(utils[rule.matches], utils, visiting);
      return null;
    } finally { visiting.delete(rule); }
  }

  function hasRelations(rule, utils, visiting = new Set()) {
    if (!rule || typeof rule !== "object" || visiting.has(rule)) return false;
    visiting.add(rule);
    try {
      if (rule.has || rule.inside || rule.follows || rule.precedes) return true;
      if ([...(rule.all || []), ...(rule.any || [])].some(part => hasRelations(part, utils, visiting))) return true;
      return typeof rule.matches === "string" && hasRelations(utils?.[rule.matches], utils, visiting);
    } finally { visiting.delete(rule); }
  }

  preflight.findAll = (config, limit = Infinity) => {
    if (!preflight(config) || limit <= 0) return [];
    const kinds = candidateKinds(config.rule, config.utils);
    // Simple rules retain the native fast path; no project-wide behavior change.
    if (!kinds || !hasRelations(config.rule, config.utils)) return scopeRoot.findAll(config).slice(0, limit);
    const key = JSON.stringify(kinds);
    if (!candidatesByKind.has(key)) {
      candidatesByKind.set(key, scopeRoot.findAll({ rule: kinds.length === 1 ? { kind: kinds[0] } : { any: kinds.map(kind => ({ kind })) } }));
    }
    const fitCache = new WeakMap();
    const chainCache = new WeakMap();
    const descendantCache = new WeakMap();
    const active = new WeakMap();
    const globalPossible = new WeakMap();

    function mapFor(cache, rule) {
      let map = cache.get(rule);
      if (!map) { map = new Map(); cache.set(rule, map); }
      return map;
    }

    function localFits(node, rule) {
      const local = {};
      if (typeof rule.kind === "string") {
        if (!validKinds.has(rule.kind)) {
          try { documentRoot.find({ rule: { kind: rule.kind } }); validKinds.set(rule.kind, true); }
          catch { validKinds.set(rule.kind, false); }
        }
        if (validKinds.get(rule.kind) && node.kind() !== rule.kind) return false;
        local.kind = rule.kind;
      }
      if (typeof rule.regex === "string") local.regex = rule.regex;
      // A directly captured variable must satisfy its own local constraints.
      // Do not import relational constraints or shared bindings into this filter.
      const name = typeof rule.pattern === "string" && /^\$([A-Z_][A-Z_0-9]*)$/.exec(rule.pattern)?.[1];
      const constraint = name && config.constraints?.[name];
      try {
        if ((local.regex !== undefined || (local.kind && !validKinds.get(local.kind))) && !node.matches({ rule: local })) return false;
        if (constraint && (constraint.kind || constraint.regex)) {
          const required = {};
          if (typeof constraint.kind === "string") required.kind = constraint.kind;
          if (typeof constraint.regex === "string") required.regex = constraint.regex;
          if (Object.keys(required).length && !node.matches({ rule: required })) return false;
        }
      } catch { return true; }
      return true;
    }

    // Cache suffixes of ancestor/sibling walks. The boundary is deliberately
    // broadened to end (including unnamed nodes); exact stopBy/field/binding
    // semantics are enforced only by node.matches(config) below.
    function along(node, rule, axis) {
      const byAxis = mapFor(chainCache, rule);
      let memo = byAxis.get(axis);
      if (!memo) { memo = new Map(); byAxis.set(axis, memo); }
      const visited = [];
      let current = node[axis]();
      let result = false;
      while (current) {
        const id = current.id();
        if (memo.has(id)) { result = memo.get(id); break; }
        visited.push(id);
        if (fits(current, rule)) { result = true; break; }
        current = current[axis]();
      }
      for (const id of visited) memo.set(id, result);
      return result;
    }

    function below(node, rule) {
      const memo = mapFor(descendantCache, rule);
      const nodeId = node.id();
      if (memo.has(nodeId)) return memo.get(nodeId);
      const kinds = candidateKinds(rule, config.utils);
      if (kinds) {
        const key = JSON.stringify(kinds);
        try {
          if (!documentCandidates.has(key)) {
            const matcher = kinds.length === 1 ? { kind: kinds[0] } : { any: kinds.map(kind => ({ kind })) };
            documentCandidates.set(key, documentRoot.findAll({ rule: matcher }).map(candidate => ({ node: candidate, range: rangeOf(candidate) })));
          }
        } catch { return true; }
        const bounds = rangeOf(node);
        const list = documentCandidates.get(key);
        let low = 0, high = list.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (list[middle].range.start.index < bounds.start.index) low = middle + 1;
          else high = middle;
        }
        let result = false;
        for (let index = low; index < list.length && list[index].range.start.index <= bounds.end.index; index++) {
          const candidate = list[index];
          if (candidate.node.id() !== nodeId && candidate.range.end.index <= bounds.end.index && fits(candidate.node, rule)) {
            result = true;
            break;
          }
        }
        memo.set(nodeId, result);
        return result;
      }
      // Iterative DFS avoids introducing a JS recursion limit for deep trees.
      const frames = [{ node, children: node.children(), next: 0 }];
      while (frames.length) {
        const frame = frames[frames.length - 1];
        if (frame.next === frame.children.length) {
          memo.set(frame.node.id(), false);
          frames.pop();
          continue;
        }
        const child = frame.children[frame.next++];
        const id = child.id();
        if (fits(child, rule) || memo.get(id) === true) {
          for (const ancestor of frames) memo.set(ancestor.node.id(), true);
          return true;
        }
        if (!memo.has(id)) frames.push({ node: child, children: child.children(), next: 0 });
      }
      return false;
    }

    function fits(node, rule) {
      if (!rule || typeof rule !== "object") return true;
      const memo = mapFor(fitCache, rule);
      const id = node.id();
      if (memo.has(id)) return memo.get(id);
      if (!globalPossible.has(rule)) globalPossible.set(rule, possible(rule, config.utils, new Set()));
      if (!globalPossible.get(rule)) { memo.set(id, false); return false; }
      const evaluating = mapFor(active, rule);
      if (evaluating.has(id)) return true;
      evaluating.set(id, true);
      let result = true;
      try {
        result = localFits(node, rule) &&
          (!Array.isArray(rule.all) || rule.all.every(part => fits(node, part))) &&
          (!Array.isArray(rule.any) || rule.any.length === 0 || rule.any.some(part => fits(node, part))) &&
          (!rule.matches || !config.utils?.[rule.matches] || fits(node, config.utils[rule.matches])) &&
          (!rule.follows || along(node, rule.follows, "prev")) &&
          (!rule.precedes || along(node, rule.precedes, "next")) &&
          (!rule.inside || along(node, rule.inside, "parent")) &&
          (!rule.has || below(node, rule.has));
      } finally { evaluating.delete(id); }
      memo.set(id, result);
      return result;
    }

    const result = [];
    for (const node of candidatesByKind.get(key)) {
      // The original native matcher still decides EVERY reported finding,
      // including constraints, metavariable equality, utilities and negatives.
      if (fits(node, config.rule) && node.matches(config)) {
        result.push(node);
        if (result.length >= limit) break;
      }
    }
    return result;
  };
  return preflight;
}
