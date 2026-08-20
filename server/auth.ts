import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config";
import { AppError } from "./errors";

declare global {
  namespace Express {
    interface Request {
      accessIdentity?: JWTPayload;
    }
  }
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function teamIssuer(config: AppConfig): string {
  const domain = config.cloudflareTeamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}`;
}

async function verifyAccessJwt(request: Request, config: AppConfig, audience: string): Promise<JWTPayload> {
  const rawHeader = request.header("Cf-Access-Jwt-Assertion");
  if (!rawHeader) throw new AppError("需要先登录", 401, "UNAUTHORIZED");
  const issuer = teamIssuer(config);
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }
  try {
    const verified = await jwtVerify(rawHeader, jwks, {
      issuer,
      audience
    });
    return verified.payload;
  } catch {
    throw new AppError("登录状态无效或已过期", 401, "UNAUTHORIZED");
  }
}

export function createUserAuth(config: AppConfig) {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      if (config.authMode === "disabled") {
        request.accessIdentity = { email: config.allowedEmail || "local@money.invalid", sub: "local-development" };
        next();
        return;
      }
      const identity = await verifyAccessJwt(request, config, config.cloudflareAudience);
      const email = typeof identity.email === "string" ? identity.email.toLowerCase() : "";
      if (!email || email !== config.allowedEmail) {
        throw new AppError("这个账号没有访问账本的权限", 403, "FORBIDDEN");
      }
      request.accessIdentity = identity;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function tokensEqual(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createMcpAuth(config: AppConfig) {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      const authorization = request.header("Authorization") ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (config.authMode === "disabled" && !config.mcpApiToken) {
        request.accessIdentity = { sub: "local-mcp" };
        next();
        return;
      }
      if (!tokensEqual(token, config.mcpApiToken)) {
        throw new AppError("MCP 应用令牌无效", 401, "MCP_UNAUTHORIZED");
      }
      if (config.authMode === "cloudflare") {
        request.accessIdentity = await verifyAccessJwt(request, config, config.cloudflareMcpAudience);
      } else {
        request.accessIdentity = { sub: "local-mcp" };
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
