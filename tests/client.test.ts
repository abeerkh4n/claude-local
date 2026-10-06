import { describe, expect, it } from "vitest";
import { createClaude, createLimiter, type ClientOptions } from "../src/client.js";
import { fakeCli, SIGNED_IN, type FakeReply } from "./helpers.js";

function client(replies: FakeReply[], options: ClientOptions = {}) {
  const fake = fakeCli(replies);
  return { claude: createClaude({ spawnImpl: fake.impl, statusImpl: () => SIGNED_IN, ...options }), spawns: fake.spawns };
}

describe("createClaude", () => {
  it("ask() returns the reply; each call is its own process", async () => {
    const { claude, spawns } = client(["one", "two"]);
    expect(await claude.ask("a")).toBe("one");
    expect(await claude.ask("b")).toBe("two");
    expect(spawns).toHaveLength(2);
  });

  it("checks the login once, before the first call", async () => {
    let checks = 0;
    const fake = fakeCli(["hi"]);
    const claude = createClaude({ spawnImpl: fake.impl, statusImpl: () => (checks++, SIGNED_IN) });
    await Promise.all([claude.ask("a"), claude.ask("b"), claude.ask("c")]);
    expect(checks).toBe(1);
  });

  it("refuses to call when the CLI is signed in with an API login", async () => {
    const { claude, spawns } = client(["hi"], { statusImpl: () => ({ installed: true, loggedIn: true, authMethod: "console" }) });
    await expect(claude.ask("a")).rejects.toThrow(/not a Claude subscription/);
    expect(spawns).toHaveLength(0);
  });

  it("applies client defaults; a call option wins unless it is undefined", async () => {
    const { claude, spawns } = client(["hi"], { model: "haiku", system: "S" });
    await claude.ask("p", { model: undefined });
    await claude.ask("p", { model: "opus" });
    const model = (i: number) => spawns[i]!.args[spawns[i]!.args.indexOf("--model") + 1];
    expect([model(0), model(1)]).toEqual(["haiku", "opus"]);
    expect(spawns[1]!.args).toContain("S");
  });

  it("json() sends the schema and returns the parsed data", async () => {
    const { claude, spawns } = client([{ text: "", data: { intent: "book" } }]);
    expect(await claude.json("p", { type: "object" })).toEqual({ intent: "book" });
    expect(spawns[0]!.args).toContain("--json-schema");
  });

  it("stream() yields the text as it is written, and result has the whole reply", async () => {
    const { claude } = client([{ deltas: ["Dear ", "team,", " hello."] }]);
    const stream = claude.stream("Write a note");
    const pieces: string[] = [];
    for await (const text of stream) pieces.push(text);
    expect(pieces).toEqual(["Dear ", "team,", " hello."]);
    expect((await stream.result).text).toBe("Dear team, hello.");
  });

  it("a failed stream throws from the loop", async () => {
    const { claude } = client([{ error: "usage limit reached" }]);
    const loop = async () => {
      for await (const _ of claude.stream("x")) void _;
    };
    await expect(loop()).rejects.toThrow(/usage limit reached/);
  });

  it("sends files with the prompt", async () => {
    const { claude, spawns } = client(["A red square."]);
    await claude.ask("What is this?", { files: [{ data: new Uint8Array([1]), mediaType: "image/png" }] });
    expect(spawns[0]!.messages[0]!.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } },
      { type: "text", text: "What is this?" },
    ]);
  });

  it("retries a crash once; never a CLI error; never after text has been streamed", async () => {
    const crash = client([{ crash: true }, "ok"]);
    expect(await crash.claude.ask("p")).toBe("ok");
    expect(crash.spawns).toHaveLength(2);
    expect(crash.claude.stats()).toMatchObject({ calls: 1, retries: 1, failures: 0 });

    const limit = client([{ error: "usage limit reached" }, "ok"], { retries: 3 });
    await expect(limit.claude.ask("p")).rejects.toThrow(/usage limit/);
    expect(limit.spawns).toHaveLength(1);

    const midStream = client([{ deltas: ["Hal"], crash: true }, "Hello"]);
    await expect(midStream.claude.stream("p").result).rejects.toThrow(/exited/);
    expect(midStream.spawns).toHaveLength(1);
  });

  it("adds up calls, would-be API cost, average time and the latest usage window", async () => {
    const { claude } = client([{ text: "a", cost: 0.25 }, { text: "b", cost: 0.5, rateLimit: "allowed_warning" }]);
    await claude.ask("1");
    await claude.ask("2");
    expect(claude.stats()).toMatchObject({ calls: 2, failures: 0, retries: 0, apiCostUsd: 0.75 });
    expect(claude.stats().rateLimit?.status).toBe("allowed_warning");
  });
});

describe("chat", () => {
  it("one process for the whole conversation, with the history kept", async () => {
    const { claude, spawns } = client(["Nice to meet you, Zara.", "Your name is Zara."]);
    const chat = claude.chat({ system: "Be brief." });
    expect(await chat.send("I'm Zara.")).toBe("Nice to meet you, Zara.");
    expect(await chat.send("What's my name?")).toBe("Your name is Zara.");
    await chat.close();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.args).toContain("Be brief.");
    expect(chat.turns).toEqual([
      { role: "user", content: "I'm Zara." },
      { role: "assistant", content: "Nice to meet you, Zara." },
      { role: "user", content: "What's my name?" },
      { role: "assistant", content: "Your name is Zara." },
    ]);
    expect(claude.stats().calls).toBe(2);
  });

  it("messages sent without waiting are queued, one turn each, in order", async () => {
    const { claude, spawns } = client(["first", "second", "third"]);
    const chat = claude.chat();
    const replies = await Promise.all([chat.send("1"), chat.send("2"), chat.send("3")]);
    await chat.close();
    expect(replies).toEqual(["first", "second", "third"]);
    expect(spawns[0]!.messages.map((m) => m.content)).toEqual(["1", "2", "3"]);
  });

  it("streams a turn, and a closed chat says so", async () => {
    const { claude } = client([{ deltas: ["Sure", "."] }]);
    const chat = claude.chat();
    const pieces: string[] = [];
    for await (const text of chat.stream("Can you help?")) pieces.push(text);
    expect(pieces).toEqual(["Sure", "."]);
    await chat.close();
    await expect(chat.send("more")).rejects.toThrow(/closed/);
  });
});

describe("createLimiter", () => {
  it("never runs more than the limit at once, and runs everything", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = async (n: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limit(() => task(n))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("keeps going after a task fails", async () => {
    const limit = createLimiter(1);
    const failed = limit(() => Promise.reject(new Error("boom")));
    const next = limit(() => Promise.resolve("ok"));
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});
