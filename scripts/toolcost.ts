/**
 * Deterministic fixed-cost reporter: the per-turn token tax of the tool
 * definitions (name + description + every inputSchema `.describe()` + param
 * names + annotations) that ship to the model EVERY turn, whether or not a tool
 * fires. No model involved — this number is exact and reproducible, the only
 * honest "tokens saved" metric. Run: `npm run toolcost`.
 *
 * Reports per-group totals so you can see what `EFFICIENT_TOKEN_GROUPS=core`
 * (or any bundle subset) actually saves.
 */
import type { ZodTypeAny } from "zod";

import { plugins } from "../src/index.js";

interface ToolCost {
  group: string;
  name: string;
  chars: number;
}

function describeLen(field: unknown): number {
  // A Zod field exposes its `.describe()` text on `.description`.
  const d = (field as { description?: unknown })?.description;
  return typeof d === "string" ? d.length : 0;
}

/** Faithful proxy for a tool definition's serialized size (chars). */
function toolChars(name: string, description: string, inputSchema: Record<string, ZodTypeAny>, annotations: unknown): number {
  let n = name.length + description.length;
  for (const [key, field] of Object.entries(inputSchema)) {
    n += key.length + describeLen(field);
  }
  n += annotations ? JSON.stringify(annotations).length : 0;
  return n;
}

function main(): void {
  const costs: ToolCost[] = [];
  for (const p of plugins) {
    const group = p.group ?? "core";
    for (const t of p.tools) {
      costs.push({
        group,
        name: t.name,
        chars: toolChars(t.name, t.description, t.inputSchema as Record<string, ZodTypeAny>, t.annotations),
      });
    }
  }
  costs.sort((a, b) => b.chars - a.chars);

  const byGroup = new Map<string, { tools: number; chars: number }>();
  for (const c of costs) {
    const g = byGroup.get(c.group) ?? { tools: 0, chars: 0 };
    g.tools += 1;
    g.chars += c.chars;
    byGroup.set(c.group, g);
  }

  const tok = (chars: number): number => Math.ceil(chars / 4);
  const total = costs.reduce((a, c) => a + c.chars, 0);

  console.log(`Per-turn tool-definition cost (${costs.length} tools)\n`);
  console.log("By group:");
  for (const [g, v] of [...byGroup.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
    console.log(`  ${g.padEnd(8)} ${String(v.tools).padStart(2)} tool(s)  ${String(v.chars).padStart(6)} chars  ~${tok(v.chars)} tok`);
  }
  console.log(`  ${"TOTAL".padEnd(8)} ${String(costs.length).padStart(2)} tool(s)  ${String(total).padStart(6)} chars  ~${tok(total)} tok`);

  const core = costs.filter((c) => c.group === "core").reduce((a, c) => a + c.chars, 0);
  console.log(`\nEFFICIENT_TOKEN_GROUPS=core would ship ~${tok(core)} tok (saves ~${tok(total - core)} tok/turn vs all).`);

  console.log("\nTop 12 most expensive tools:");
  for (const c of costs.slice(0, 12)) {
    console.log(`  ${String(c.chars).padStart(4)} chars  ${c.name}  [${c.group}]`);
  }
}

main();
