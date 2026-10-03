// Prints a plan's computed schedule: npm run schedule <plan>
import { PLANS } from "../plans/index.ts";
import { buildSchedule, validatePlan } from "../src/plan.ts";

const name = process.argv[2] ?? "";
const plan = Object.hasOwn(PLANS, name) ? PLANS[name] : undefined;

if (!plan) {
    console.error(
        `Usage: npm run schedule <plan>  (plans: ${Object.keys(PLANS).join(", ")})`,
    );
    process.exitCode = 1;
} else {
    const errors = validatePlan(plan);
    if (errors.length > 0) {
        console.error(`Plan "${name}" is invalid:\n- ${errors.join("\n- ")}`);
        process.exitCode = 1;
    } else {
        for (const s of buildSchedule(plan)) {
            console.log(
                `#${String(s.n).padEnd(3)} ${s.date}  ${s.book.short.padEnd(4)} ${s.range}`,
            );
        }
    }
}
