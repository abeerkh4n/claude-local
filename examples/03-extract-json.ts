/**
 * Turn messy text into data your code can use: the reply is JSON that matches
 * your schema, already parsed.
 *
 *   npx tsx examples/03-extract-json.ts
 */
import { claude } from "../src/index.js";

const email = `Hi there — following up on my call yesterday. We'd love to do Sam's farewell
at yours on Fri the 24th, probably 14 of us but could creep to 16. Arriving around 7.
Two vegetarians and one coeliac. Is the back room free? Budget is roughly $85 a head.
Cheers, Morgan (0491 570 159)`;

interface Enquiry {
  name: string;
  phone: string | null;
  date: string;
  time: string;
  guests: { expected: number; maximum: number };
  dietary: string[];
  budgetPerHead: number | null;
  questions: string[];
}

const schema = {
  type: "object",
  properties: {
    name: { type: "string" },
    phone: { type: ["string", "null"] },
    date: { type: "string", description: "As written, e.g. 'Fri 24th'" },
    time: { type: "string" },
    guests: {
      type: "object",
      properties: { expected: { type: "integer" }, maximum: { type: "integer" } },
      required: ["expected", "maximum"],
    },
    dietary: { type: "array", items: { type: "string" } },
    budgetPerHead: { type: ["number", "null"] },
    questions: { type: "array", items: { type: "string" }, description: "Things they asked us" },
  },
  required: ["name", "phone", "date", "time", "guests", "dietary", "budgetPerHead", "questions"],
};

const enquiry = await claude.json<Enquiry>(`Extract the booking enquiry from this email:\n\n${email}`, schema, {
  model: "haiku",
});
console.log(enquiry);
