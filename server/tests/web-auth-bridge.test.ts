import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

it("keeps delayed browser login A bound to A after logout and login B", async () => {
  const source = await readFile(new URL("../../game/scripts/Memory/MemoryGame.gd", import.meta.url), "utf8");
  const line = source.split(/\r?\n/).find(value => value.includes("/v1/auth/csrf") && value.includes("JavaScriptBridge.eval"));
  expect(line).toBeDefined();
  // Execute the actual embedded bridge; JSON decoding matches its GDScript string escapes.
  const script = JSON.parse(line!.slice(line!.indexOf("(") + 1, line!.lastIndexOf(")")));
  const pending: Array<(value: unknown) => void> = [];
  const calls: Array<{ generation: number; data: any }> = [];
  let generation = 1;
  const callback = (requested: number) => (text: string) => {
    if (requested === generation) calls.push({ generation: requested, data: JSON.parse(text) });
  };
  const window = { dfmAuthCallback: callback(1) };
  const fetch = () => new Promise(resolve => pending.push(resolve));
  const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
  runInNewContext(script, { window, fetch, JSON, Error });
  generation++; // Logout invalidates A.
  generation++; // B starts and replaces the global callback.
  window.dfmAuthCallback = callback(3);
  runInNewContext(script, { window, fetch, JSON, Error });
  pending[1]({ ok: true, json: async () => ({ csrfToken: "csrf-B" }) });
  await settle();
  pending[2]({ ok: true, json: async () => ({ accessToken: "token-B", userId: "user-B" }) });
  await settle();
  expect(calls).toEqual([{ generation: 3, data: { accessToken: "token-B", userId: "user-B" } }]);
  pending[0]({ ok: true, json: async () => ({ csrfToken: "csrf-A" }) });
  await settle();
  pending[3]({ ok: true, json: async () => ({ accessToken: "token-A", userId: "user-A" }) });
  await settle();
  expect(calls).toEqual([{ generation: 3, data: { accessToken: "token-B", userId: "user-B" } }]);
});
