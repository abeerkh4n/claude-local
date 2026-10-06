/**
 * Using the judge inside a normal test suite. Live tests are skipped unless
 * CLAUDE_CLI_LIVE=1, so `npm test` stays fast and offline.
 *
 *   npm run test:live
 */
import { describe, expect, it } from "vitest";
import { judge } from "../src/index.js";

const live = process.env.CLAUDE_CLI_LIVE === "1";

// Replace with a call to your own code, e.g. the reply your bot builds.
function closedDayReply(): string {
  return "Sorry, we're closed on Mondays. Could Tuesday at 7pm work instead?";
}

describe.skipIf(!live)("booking replies (live: uses your Claude subscription)", () => {
  it("does not offer a table on a day the restaurant is closed", async () => {
    const verdict = await judge({
      model: "sonnet",
      context: "Open Tuesday to Sunday, 5pm to 10pm. Closed Mondays.",
      input: "Guest: Can I book for Monday at 7?",
      output: closedDayReply(),
      criteria: ["Does not offer or confirm a Monday booking", "Suggests a day the restaurant is open"],
    });
    expect(verdict.passed, verdict.summary).toBe(true);
  }, 180_000);
});
