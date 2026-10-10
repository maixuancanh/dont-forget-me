import { it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
const root = new URL("../../", import.meta.url);
it("production character speech uses semantic beats rather than canned sentences", () => {
 const files = readdirSync(new URL("game/story/interaction/prod/", root)).filter(f => f.endsWith(".json"));
 expect(files).toHaveLength(25);
 for (const file of files) {
  const scene = JSON.parse(readFileSync(new URL(`game/story/interaction/prod/${file}`, root), "utf8"));
  for (const step of scene.interactions) {
   expect(["say", "choice"]).not.toContain(step.type);
   expect(step).not.toHaveProperty("sentence");
   if (step.type === "dialogue_beat") expect(step.beat_id).toMatch(/^v2\./);
  }
 }
});
it("private canon is absent from the client resource root", () => {
 expect(existsSync(new URL("game/story/canon/events.json", root))).toBe(false);
});
