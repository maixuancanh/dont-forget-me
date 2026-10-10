import {config as loadEnvironment} from "dotenv";
// Resolve the game's private configuration independently of the launcher cwd.
loadEnvironment({path:new URL('../.env',import.meta.url)});
import { z } from "zod";
export const schema = z.object({
  PORT: z.coerce.number().default(8798),
  HOST: z.string().default("127.0.0.1"),
  APP_MODE: z.enum(["development", "production"]).default("development"),
  MEMORY_MODE: z.enum(["local", "mainnet"]).default("local"),
  SESSION_SECRET: z.string().min(32),
  DATA_FILE: z.string().default("./data/state.json"),
  ALLOWED_ORIGIN: z.string().url().optional(),
  DATABASE_URL: z.string().optional(),
  AUTH_JWKS_URL: z.string().optional(),
  AUTH_ISSUER: z.string().optional(),
  AUTH_AUDIENCE: z.string().optional(),
  OIDC_AUTHORIZATION_ENDPOINT: z.string().url().optional(),
  OIDC_TOKEN_ENDPOINT: z.string().url().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  MEMWAL_PRIVATE_KEY: z.string().optional(),
  MEMWAL_ACCOUNT_ID: z.string().optional(),
  MEMWAL_SERVER_URL: z.string().default("https://relayer.memory.walrus.xyz"),
  // Private committee credentials, if the deployed Seal committee requires them.
  SEAL_SERVER_CONFIGS: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
});
export type Config = z.infer<typeof schema>;
export function config(env = process.env) {
  // Editable .env templates intentionally leave optional provider fields blank.
  const values={...env};
  for(const key of ['DATABASE_URL','ALLOWED_ORIGIN','AUTH_JWKS_URL','AUTH_ISSUER','AUTH_AUDIENCE','OIDC_AUTHORIZATION_ENDPOINT','OIDC_TOKEN_ENDPOINT','OIDC_REDIRECT_URI','OIDC_CLIENT_SECRET','LLM_BASE_URL','LLM_API_KEY','LLM_MODEL'])if(values[key]==='')delete values[key];
  const c = schema.parse(values);
  if(c.APP_MODE==="production")for(const field of [c.ALLOWED_ORIGIN,c.AUTH_ISSUER,c.AUTH_JWKS_URL,c.OIDC_AUTHORIZATION_ENDPOINT,c.OIDC_TOKEN_ENDPOINT,c.OIDC_REDIRECT_URI])if(field&&new URL(field).protocol!=="https:")throw new Error("Production authentication requires HTTPS");
  if (
    c.APP_MODE === "production" &&
    (!c.DATABASE_URL ||
      !c.AUTH_JWKS_URL ||
      !c.AUTH_ISSUER ||
      !c.AUTH_AUDIENCE ||
      !c.OIDC_AUTHORIZATION_ENDPOINT || !c.OIDC_TOKEN_ENDPOINT || !c.OIDC_REDIRECT_URI || !c.ALLOWED_ORIGIN ||
      c.MEMORY_MODE !== "mainnet" ||
      !c.LLM_API_KEY ||
      !c.LLM_BASE_URL ||
      !c.LLM_MODEL)
  )
    throw new Error(
      "Production requires verified auth, PostgreSQL, Mainnet memory and LLM configuration",
    );
  if (
    c.MEMORY_MODE === "mainnet" &&
    (!c.MEMWAL_PRIVATE_KEY || !c.MEMWAL_ACCOUNT_ID)
  )
    throw new Error("Mainnet account credentials missing");
  return c;
}
