import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { WalrusMemory } from "../src/memory.js";
const c = config();
if (c.MEMORY_MODE !== "mainnet")
  throw new Error(
    "Live verification requires MEMORY_MODE=mainnet and configured account/delegate",
  );
const id = randomUUID();
const namespace = "dfm:verification:" + id;
const text = JSON.stringify({
  schemaVersion: 1,
  eventId: id,
  quote:
    "The shopkeeper preserved the signed Friday payment before confronting the duplicate debt entry.",
  purpose: "Mainnet canary; not a player interaction",
});
const adapter = new WalrusMemory(
  c.MEMWAL_PRIVATE_KEY!,
  c.MEMWAL_ACCOUNT_ID!,
  c.MEMWAL_SERVER_URL,
);
const receipt = await adapter.write(text, namespace, id);
const results = await adapter.recall(
  "shopkeeper signed Friday payment duplicate debt",
  namespace,
);
const match = results.find(
  (r) => r.blob_id === receipt.blobId && r.text === text,
);
if (!match)
  throw new Error("Write completed but exact retrieval not evidenced");
await mkdir("reports", { recursive: true });
await writeFile(
  "reports/mainnet-canary.json",
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      network: "mainnet",
      namespace,
      ...receipt,
      retrievalVerified: true,
      countsAsPlayerMemory: false,
    },
    null,
    2,
  ),
);
console.log("MAINNET_CANARY_WRITE_RECALL_PASS (not player usage evidence)");
