import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { verifyTwitchJwt } from "./twitch-auth.js";

const BASE64_SECRET = Buffer.from("test-extension-secret-bytes").toString("base64");
const secretBytes = Buffer.from(BASE64_SECRET, "base64");

function signToken(claims: Record<string, unknown>, options: jwt.SignOptions = {}): string {
  return jwt.sign(claims, secretBytes, { algorithm: "HS256", expiresIn: "1h", ...options });
}

const validClaims = {
  channel_id: "123456789",
  role: "viewer",
  opaque_user_id: "U1234",
  user_id: "987654321",
};

describe("verifyTwitchJwt", () => {
  it("accepts a validly signed token and returns its claims", () => {
    const token = signToken(validClaims);
    const result = verifyTwitchJwt(token, BASE64_SECRET);
    expect("claims" in result).toBe(true);
    if ("claims" in result) {
      expect(result.claims.channel_id).toBe("123456789");
      expect(result.claims.role).toBe("viewer");
      expect(result.claims.opaque_user_id).toBe("U1234");
      expect(result.claims.user_id).toBe("987654321");
    }
  });

  it("accepts a token with no user_id (unidentified viewer)", () => {
    const { user_id, ...rest } = validClaims;
    const token = signToken(rest);
    const result = verifyTwitchJwt(token, BASE64_SECRET);
    expect("claims" in result).toBe(true);
    if ("claims" in result) expect(result.claims.user_id).toBeUndefined();
  });

  it("rejects a token signed with a different secret", () => {
    const wrongSecretBytes = Buffer.from(Buffer.from("a-completely-different-secret").toString("base64"), "base64");
    const token = jwt.sign(validClaims, wrongSecretBytes, { algorithm: "HS256", expiresIn: "1h" });
    const result = verifyTwitchJwt(token, BASE64_SECRET);
    expect("error" in result).toBe(true);
  });

  it("rejects an expired token", () => {
    const token = signToken(validClaims, { expiresIn: "-1h" });
    const result = verifyTwitchJwt(token, BASE64_SECRET);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.toLowerCase()).toContain("expired");
  });

  it("rejects a malformed token string", () => {
    const result = verifyTwitchJwt("not.a.jwt", BASE64_SECRET);
    expect("error" in result).toBe(true);
  });

  it("rejects a token missing required claims", () => {
    const token = signToken({ role: "viewer" }); // no channel_id/opaque_user_id
    const result = verifyTwitchJwt(token, BASE64_SECRET);
    expect("error" in result).toBe(true);
  });

  it("rejects a token signed with an algorithm other than HS256 (algorithm-confusion hardening)", () => {
    // jsonwebtoken refuses to even sign HS256-shaped claims with "none"
    // unless explicitly allowed — construct the token manually to prove
    // verifyTwitchJwt's pinned `algorithms: ["HS256"]` still rejects it.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(validClaims)).toString("base64url");
    const forgedToken = `${header}.${payload}.`;
    const result = verifyTwitchJwt(forgedToken, BASE64_SECRET);
    expect("error" in result).toBe(true);
  });
});
