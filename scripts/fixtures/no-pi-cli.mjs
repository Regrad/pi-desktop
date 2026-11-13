import { registerHooks } from "node:module";

// Runtime proof: an SDK smoke test must fail if it imports an executable CLI
// entry. The public SDK also exports inert CLI functions; importing those
// definitions is allowed, executing a standalone entry is not.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (/\/pi-coding-agent\/dist\/(?:bundle\/)?(?:cli|rpc-entry)\.js$/.test(result.url)) {
      throw new Error(`Desktop must not load a Pi executable entry: ${result.url}`);
    }
    return result;
  },
});
