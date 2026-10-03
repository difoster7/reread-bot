import type { Plan } from "../src/plan.ts";
import mistborn from "./mistborn.ts";

/** Plans selectable via the PLAN var. Register new plans here. */
export const PLANS: Record<string, Plan> = { mistborn };
