import { it,expect } from "vitest";
import { OidcProvider } from "../src/auth/oidc-provider.js";
const config={issuer:"https://issuer.test",clientId:"game",tokenEndpoint:"https://issuer.test/token",jwksUri:"https://issuer.test/jwks"};
const input={code:"authorization-code",verifier:"pkce-verifier",nonce:"nonce",redirectUri:"https://game.test/callback"};
it("does not accept a successful token response without a signed ID token",async()=>{
 const provider=new OidcProvider(config,async(_url,options)=>{
  expect(options?.redirect).toBe("error");
  expect(String(options?.body)).toContain("code_verifier=pkce-verifier");
  return new Response(JSON.stringify({access_token:"ignored"}),{status:200});
 });
 await expect(provider.exchange(input)).rejects.toThrow("OIDC_IDENTITY_INVALID");
});
it("does not expose provider error details and rejects insecure configured endpoints",async()=>{
 await expect(new OidcProvider(config,async()=>new Response("private provider error",{status:401})).exchange(input)).rejects.toThrow("OIDC_PROVIDER_UNAVAILABLE");
 expect(()=>new OidcProvider({...config,jwksUri:"http://issuer.test/jwks"})).toThrow("OIDC_HTTPS_REQUIRED");
});
