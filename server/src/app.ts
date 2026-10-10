import Fastify from "fastify";
import pg from "pg";
import {registerRuntime,type RuntimeOptions} from "./routes/runtime.js";
import {PostgresRepository} from "./persistence/repository.js";
import { registerTurnRoutes, type DialogueAuthority } from "./routes/turns.js";
import { legacyCatalog, legacyKnowledge as knowledge } from "./story/canon.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.js";
import { Auth } from "./auth.js";
import { SessionService } from "./auth/session.js";
import { registerAuthRoutes,authCookies,validateCookieCsrf } from "./auth/routes.js";
import type { OidcExchange } from "./auth/oidc.js";
import type { Config } from "./config.js";
import type { CanonEvent, Run, State, RecordEntry } from "./model.js";
import {
  WalrusMemory,
  scope,
  payload,
  localWrite,
  type MemoryAdapter,
} from "./memory.js";
import {
  addRecord,
  known,
  share,
  compare,
  confront,
  decide,
  summary,
  usable,
} from "./rules.js";
import { answer } from "./chat.js";
export async function createApp(c: Config, adapter?: MemoryAdapter, oidcAdapter?: OidcExchange, dialogueAuthority?: DialogueAuthority, runtimeOptions?:RuntimeOptions) {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  // Browser clients send an unauthenticated preflight before Bearer-token requests.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && origin !== c.ALLOWED_ORIGIN)
      return reply.code(403).send({ error: "Game origin not allowed" });
    if (origin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-CSRF-Token");
      reply.header("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
  const store = new Store(c.DATA_FILE, c.DATABASE_URL);
  await store.init();
  const sessions = new SessionService(store);
  const auth = new Auth(c, sessions);
  registerAuthRoutes(app,c,store,sessions,oidcAdapter);
  const runtimePool=!runtimeOptions&&c.DATABASE_URL?new pg.Pool({connectionString:c.DATABASE_URL}):undefined;
  const runtimeConfig=runtimeOptions??(runtimePool?{repository:new PostgresRepository(runtimePool)}:undefined);
  const runtime=runtimeConfig?await registerRuntime(app,c,store,sessions,runtimeConfig):undefined;
  if(!runtime){registerTurnRoutes(app,c,store,sessions,dialogueAuthority);app.get('/v2/runtime',()=>({enabled:false,mode:c.APP_MODE,memoryMode:c.MEMORY_MODE}));}
  const memory =
    adapter ??
    (c.MEMORY_MODE === "mainnet"
      ? new WalrusMemory(
          c.MEMWAL_PRIVATE_KEY!,
          c.MEMWAL_ACCOUNT_ID!,
          c.MEMWAL_SERVER_URL,
        )
      : undefined);
  const catalog: CanonEvent[] = legacyCatalog;
  const events = catalog.filter((e) => e.sceneId !== "Ending");
  let flushing: Promise<void> | undefined;
  const flush = () =>
    (flushing ??= (async () => {
      let pending;
      do {
        pending = await store.transact((s) =>
          Object.values(s.runs).flatMap((run) =>
            run.records
              .filter(
                (r) =>
                  (r.status === "pending" || r.status === "failed") &&
                  (!r.retryAt || r.retryAt <= Date.now()),
              )
              .map((record) => ({
                user: run.userId,
                run: run.id,
                record: structuredClone(record),
              })),
          ),
        );
        for (const item of pending) {
          try {
            const ns = scope(item.user, item.run);
            const receipt = memory
              ? await memory.write(
                  payload(item.record),
                  ns,
                  item.record.id,
                  item.record.jobId,
                  async (jobId) => {
                    await store.transact((s) => {
                      const r = s.runs[item.run]?.records.find(
                        (r) => r.id === item.record.id,
                      );
                      if (r) r.jobId = jobId;
                    });
                  },
                )
              : { blobId: item.record.id };
            await store.transact((s) => {
              const r = s.runs[item.run]?.records.find(
                (r) => r.id === item.record.id,
              );
              if (!r) return;
              if (!memory) localWrite(s, payload(item.record), ns, r.id);
              r.status = memory ? "confirmed" : "local";
              r.blobId = receipt.blobId;
              r.jobId = receipt.jobId;
              delete r.error;
              delete r.retryAt;
            });
          } catch {
            await store.transact((s) => {
              const r = s.runs[item.run]?.records.find(
                (r) => r.id === item.record.id,
              );
              if (r) {
                r.status = "failed";
                r.attempts = (r.attempts ?? 0) + 1;
                r.retryAt =
                  Date.now() + Math.min(300000, 1000 * 2 ** r.attempts);
                r.error = "Storage unavailable; retry retains event identity";
              }
            });
          }
        }
      } while (pending.length);
    })().finally(() => {
      flushing = undefined;
    }));
  const kick = async () => {
    if (memory) void flush().catch(() => {});
    else await flush();
  };
  const timer = setInterval(() => {
    void flush().catch(() => {});
  }, 5000);
  timer.unref();
  const maybeReveal = (run: Run) => {
    const reveal = knowledge.supplementalReveals[0];
    const trust =
      (run.promise?.kept ? 1 : 0) +
      (run.records.some((r) => r.eventId === "trust:reassure_duy") ? 1 : 0);
    if (
      run.day >= reveal.requires.minimumDay &&
      trust >= reveal.requires.minimumTrust &&
      run.promise?.kept &&
      reveal.requires.witnessedEventIds.every((id: string) =>
        run.records.some((r) => r.eventId === id),
      )
    )
      addRecord(run, reveal.id, reveal.quote, "duy", reveal.clueTags);
  };
  const retrieved = async (run: Run, query: string, allowed: RecordEntry[]) => {
    const ns = scope(run.userId, run.id);
    const results = memory
      ? await memory.recall(query, ns)
      : await store.transact((s) => s.localMemories[ns] ?? []);
    const matched = allowed.filter((r) =>
      results.some((x) => x.blob_id === r.blobId && x.text === payload(r)),
    );
    if (matched.length)
      await store.transact((s) => {
        for (const record of s.runs[run.id]?.records ?? [])
          if (matched.some((r) => r.id === record.id))
            record.recalledAt = new Date().toISOString();
      });
    return matched;
  };
  app.setErrorHandler((err, _req, reply) =>
    reply.code((err as any).statusCode ?? (err instanceof Error&&err.message==='SESSION_INVALID'?401:(err as any).code==='GENERATION_UNAVAILABLE'?503:400)).send({
      error:
        err instanceof z.ZodError
          ? "Invalid request"
          : err instanceof Error
            ? err.message
            : "Request unavailable",
      mode: c.MEMORY_MODE,
      ...((err as any).reason==='PROVIDER_RATE_LIMITED'?{code:'PROVIDER_RATE_LIMITED',retryAfterSeconds:(err as any).retryAfterSeconds}:{}),
    }),
  );
  app.get("/health", () => ({
    ok: true,
    mode: c.MEMORY_MODE,
    production: c.APP_MODE === "production",
  }));
  app.post("/v1/session", async (req, reply) => {
    if (c.APP_MODE !== "development")
      return reply
        .code(404)
        .send({ error: "Use configured verified identity provider" });
    const { name, accessCode } = z
      .object({
        name: z.string().trim().min(1).max(60),
        accessCode: z.string().min(8).max(128),
      })
      .parse(req.body);
    const id = auth.identity(accessCode);
    const user = await store.transact((s) => (s.users[id] ??= { id, name }));
    if(runtime){const issued=await sessions.issueForUser(id);return {token:issued.accessToken,accessToken:issued.accessToken,refreshToken:issued.refreshToken,user,mode:c.MEMORY_MODE};}
    return { token: auth.sign(id), user, mode: c.MEMORY_MODE };
  });
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/v1/runs") && !req.url.startsWith("/v2/runs")) return;
    try {
      if (!req.headers.authorization && req.method !== "GET") validateCookieCsrf(req,c);
      (req as any).user = await auth.verify(
        (req.headers.authorization ?? "").replace(/^Bearer /, "") || authCookies(req).dfm_access || "",
      );
    } catch {
      return reply.code(401).send({ error: "Unauthenticated" });
    }
  });
  const owned = (s: State, id: string, user: string) => {
    const run = s.runs[id];
    if (!run || run.userId !== user)
      throw Object.assign(new Error("Run unavailable"), { statusCode: 404 });
    return run;
  };
  const view = (run: Run) => ({
    run,
    nextEvent: events[run.cursor]
      ? {
          sceneId: events[run.cursor]!.sceneId,
          stepIndex: events[run.cursor]!.stepIndex,
          day: events[run.cursor]!.day,
        }
      : { sceneId: "Ledger", stepIndex: 0, day: 6 },
    mode: c.MEMORY_MODE,
  });
  app.post("/v1/runs", async (req) =>
    store.transact((s) => {
      const run: Run = {
        id: randomUUID(),
        userId: (req as any).user,
        day: 1,
        cursor: 0,
        revision: 0,
        records: [],
        shares: [],
        turns: [],
      };
      s.runs[run.id] = run;
      return view(run);
    }),
  );
  app.get("/v1/runs/:id", async (req) =>
    store.transact((s) =>
      view(owned(s, (req.params as any).id, (req as any).user)),
    ),
  );
  app.post("/v1/runs/:id/events", async (req) => {
    const body = z
      .object({ sceneId: z.string(), stepIndex: z.number().int().min(0) })
      .parse(req.body);
    const result = await store.transact((s) => {
      const run = owned(s, (req.params as any).id, (req as any).user);
      const eventId = body.sceneId + ":" + body.stepIndex;
      const old = run.records.find((r) => r.eventId === eventId);
      if (old) return old;
      const expected = events[run.cursor];
      if (!expected || expected.id !== eventId)
        throw new Error(
          "Story checkpoint mismatch; resume the witnessed sequence",
        );
      run.day = expected.day;
      run.cursor++;
      const record = addRecord(
        run,
        eventId,
        expected.quote,
        expected.speaker,
        expected.clueTags,
        expected.category,
      );
      maybeReveal(run);
      return record;
    });
    await kick();
    return { record: result, mode: c.MEMORY_MODE };
  });
  app.get("/v1/runs/:id/journal", async (req) => {
    await kick();
    return store.transact((s) => ({
      records: owned(s, (req.params as any).id, (req as any).user).records.map(
        (r) => ({ ...r, inGameDay: r.day, claimStatus: r.status }),
      ),
      mode: c.MEMORY_MODE,
    }));
  });
  app.post("/v1/runs/:id/chat", async (req) => {
    const body = z
      .object({
        npcId: z.string(),
        message: z.string().trim().min(1).max(1500),
        clientTurnId: z.string().min(1).max(100),
      })
      .parse(req.body);
    await kick();
    const run = await store.transact((s) =>
      structuredClone(owned(s, (req.params as any).id, (req as any).user)),
    );
    const prior = run.turns.find((t) => t.id === body.clientTurnId);
    if (prior) return prior.response;
    if (!run.records.some((r) => r.speaker === body.npcId))
      throw new Error("This customer has not been encountered");
    const sources = await retrieved(
      run,
      body.message,
      known(run, body.npcId).filter((r) => r.type !== "conversation"),
    );
    const response = await answer(c, body.npcId, body.message, sources);
    const stored = await store.transact((s) => {
      const latest = owned(s, run.id, run.userId);
      if (!latest.turns.some((t) => t.id === body.clientTurnId)) {
        latest.turns.push({
          id: body.clientTurnId,
          response: { ...response, mode: c.MEMORY_MODE },
        });
        addRecord(
          latest,
          "chat:" + body.clientTurnId,
          "Player asked: " + body.message + "\nNPC replied: " + response.text,
          body.npcId,
          [],
          "conversation",
          response.sourceIds,
        );
      }
      return latest.turns.find((t) => t.id === body.clientTurnId)!.response;
    });
    await kick();
    return stored;
  });
  for (const action of ["share", "compare", "confront", "case", "promises"])
    app.post("/v1/runs/:id/" + action, async (req) => {
      await kick();
      const b = z
        .object({
          recordIds: z.array(z.string()).max(120).optional(),
          recordId: z.string().optional(),
          recipient: z.string().optional(),
          npcId: z.string().optional(),
          action: z.string().optional(),
        })
        .parse(req.body);
      const run = await store.transact((s) =>
        structuredClone(owned(s, (req.params as any).id, (req as any).user)),
      );
      const ids = b.recordIds ?? (b.recordId ? [b.recordId] : []);
      if (ids.length) {
        const rows = run.records.filter((r) => ids.includes(r.id) && usable(r));
        const recalled = (
          await Promise.all(rows.map((r) => retrieved(run, r.quote, [r])))
        ).flat();
        if (recalled.length !== new Set(ids).size)
          throw new Error(
            "Selected evidence is not retrievable; retry memory verification",
          );
      }
      const result = await store.transact((s) => {
        const r = owned(s, run.id, run.userId);
        if (action === "share")
          return share(r, b.recordId ?? "", b.recipient ?? "");
        if (action === "compare") return compare(r, b.recordIds ?? []);
        if (action === "confront") return confront(r, b.recordIds ?? []);
        if (action === "case") return decide(r, b.recordIds ?? []);
        if (
          b.npcId !== "duy" ||
          !["accept", "reassure"].includes(b.action ?? "") ||
          !r.records.some((x) => x.speaker === "duy")
        )
          throw new Error("Promise unavailable");
        if (b.action === "accept" && !r.promise) {
          r.promise = {
            id: "protect_duy_from_hanh",
            recipient: "hanh",
            kept: true,
          };
          const promise = addRecord(
            r,
            "promise:protect_duy_from_hanh",
            "You promised Duy not to disclose his identity to Hanh. Reporting to Phuc is permitted.",
            "player",
            [],
            "promise",
          );
          promise.recipients.push("duy");
        }
        if (b.action === "reassure") {
          if (!r.promise?.kept)
            throw new Error(
              "Accept and keep the promise before reassuring Duy",
            );
          const reassurance = addRecord(
            r,
            "trust:reassure_duy",
            "You reassured Duy that Phuc may hear his account while Hanh will not receive his identity.",
            "player",
            [],
            "relationship",
          );
          reassurance.recipients.push("duy");
        }
        maybeReveal(r);
        return { text: "Promise recorded. Reporting to Phuc is permitted." };
      });
      await kick();
      return { ...result, mode: c.MEMORY_MODE };
    });
  app.get("/v1/runs/:id/summary", async (req) =>
    store.transact((s) => ({
      ...summary(owned(s, (req.params as any).id, (req as any).user)),
      mode: c.MEMORY_MODE,
    })),
  );
  app.get("/v1/runs/:id/export", async (req) =>
    store.transact((s) => {
      const r = owned(s, (req.params as any).id, (req as any).user);
      return {
        schemaVersion: 1,
        runId: r.id,
        mode: c.MEMORY_MODE,
        records: r.records.map(
          ({
            id,
            eventId,
            day,
            speaker,
            quote,
            type,
            sourceIds,
            status,
            blobId,
            jobId,
            recalledAt,
            createdAt,
          }) => ({
            id,
            eventId,
            day,
            speaker,
            quote,
            type,
            sourceIds,
            status,
            blobId,
            jobId,
            recalledAt,
            createdAt,
          }),
        ),
        confirmedDistinctBlobs:
          c.MEMORY_MODE === "mainnet"
            ? new Set(
                r.records
                  .filter((x) => x.status === "confirmed" && x.blobId)
                  .map((x) => x.blobId),
              ).size
            : 0,
        retrievedDistinctBlobs:
          c.MEMORY_MODE === "mainnet"
            ? new Set(
                r.records
                  .filter(
                    (x) => x.status === "confirmed" && x.blobId && x.recalledAt,
                  )
                  .map((x) => x.blobId),
              ).size
            : 0,
        verifiedHuman: false,
      };
    }),
  );
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await flushing;
    if(memory instanceof WalrusMemory)memory.destroy();
    await store.close();
    await runtimePool?.end();
  });
  return { app, store, flush:runtime?.flush??flush, auth, sessions, runtime };
}
