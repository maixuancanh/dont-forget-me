import { createHmac, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";
import type { SessionService } from "./auth/session.js";
export class Auth {
  private jwks;
  constructor(private c: Config, private sessions?: SessionService) {
    this.jwks = c.AUTH_JWKS_URL
      ? createRemoteJWKSet(new URL(c.AUTH_JWKS_URL))
      : undefined;
  }
  sign(user: string) {
    const body = Buffer.from(
      JSON.stringify({ sub: user, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url");
    return (
      body +
      "." +
      createHmac("sha256", this.c.SESSION_SECRET)
        .update(body)
        .digest("base64url")
    );
  }
  identity(code: string) {
    return createHmac("sha256", this.c.SESSION_SECRET)
      .update("identity:" + code)
      .digest("hex");
  }
  async verify(token: string) {
    if (/^[A-Za-z0-9_-]{43}$/.test(token) && this.sessions) return (await this.sessions.authenticate(token)).userId;
    if (this.c.APP_MODE === "production") {
      throw new Error("Unauthenticated");
    }
    const [body, sig] = token.split(".");
    if (!body || !sig) throw new Error("Unauthenticated");
    const expected = createHmac("sha256", this.c.SESSION_SECRET)
      .update(body)
      .digest();
    const actual = Buffer.from(sig, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("Unauthenticated");
    const value = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!value.sub || value.exp <= Date.now() / 1000)
      throw new Error("Unauthenticated");
    return String(value.sub);
  }
}
