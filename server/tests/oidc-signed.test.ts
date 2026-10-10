import {it,expect} from "vitest";
import {generateKeyPair,exportJWK,SignJWT} from "jose";
import {OidcProvider} from "../src/auth/oidc-provider.js";
it("verifies signed JWT and rejects issuer, audience, nonce, expiry and wrong signatures",async()=>{
 const {privateKey,publicKey}=await generateKeyPair("RS256");const wrong=await generateKeyPair("RS256");const jwk=await exportJWK(publicKey);jwk.kid="test";
 const issue=(changes:any={},key=privateKey)=>new SignJWT({nonce:"nonce",name:"Player",...changes}).setProtectedHeader({alg:"RS256",kid:"test"}).setIssuer(changes.iss??"https://issuer.test").setAudience(changes.aud??"client").setSubject("person").setIssuedAt().setExpirationTime(changes.exp??"5m").sign(key);
 let jwt=await issue();const request:typeof fetch=async(url)=>new Response(JSON.stringify(String(url).endsWith("jwks")?{keys:[jwk]}:{id_token:jwt}),{status:200,headers:{"content-type":"application/json"}});
 const provider=new OidcProvider({issuer:"https://issuer.test",clientId:"client",tokenEndpoint:"https://issuer.test/token",jwksUri:"https://issuer.test/jwks"},request);
 const input={code:"code",verifier:"proof",nonce:"nonce",redirectUri:"https://game.test/callback"};expect((await provider.exchange(input)).subject).toBe("person");
 for(const change of [{iss:"https://evil.test"},{aud:"other"},{nonce:"other"},{exp:1},{azp:"other"}]){jwt=await issue(change);await expect(provider.exchange(input)).rejects.toThrow();}
 jwt=await issue({},wrong.privateKey);await expect(provider.exchange(input)).rejects.toThrow();
});
