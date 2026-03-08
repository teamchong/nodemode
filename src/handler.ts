// createHandler — reusable fetch handler for nodemode
//
// Extracts workspace routing into a factory function
// that can be used from any Cloudflare Worker entry point.
//
// Usage:
//   import { Workspace, createHandler } from "nodemode";
//   export { Workspace };
//   export default { fetch: createHandler() };

import type { Env } from "./env";

const WORKSPACE_ROUTE = /^\/workspace\/([^/]+)\/(.+)$/;
const API_ROUTE = /^\/api\/workspaces(?:\/([^/]+))?(?:\/(.*))?$/;

export interface HandlerOptions {
  fallback?: (request: Request, env: Env) => Response | Promise<Response>;
  cors?: boolean;
}

interface Fetchable {
  fetch(request: Request): Promise<Response>;
}

function getWorkspace(env: Env, id: string): Fetchable {
  const doId = env.WORKSPACE.idFromName(id);
  return env.WORKSPACE.get(doId) as unknown as Fetchable;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-action",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createHandler(options: HandlerOptions = {}) {
  const { fallback, cors = true } = options;

  return async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);

    // CORS preflight
    if (cors && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Workspace routes: /workspace/{id}/{action}
    const wsMatch = url.pathname.match(WORKSPACE_ROUTE);
    if (wsMatch) {
      const [, workspaceId, action] = wsMatch;
      const workspace = getWorkspace(env, workspaceId);
      const target = new URL(`/${action}`, request.url);
      target.search = url.search;
      const forwarded = new Request(target, request);
      const response = await workspace.fetch(forwarded);
      return cors ? withCors(response) : response;
    }

    // API routes: /api/workspaces/{id?}/{action?}
    const apiMatch = url.pathname.match(API_ROUTE);
    if (apiMatch) {
      const [, workspaceId, action] = apiMatch;

      // List workspaces via R2 prefix scan
      if (!workspaceId) {
        const listed = await env.FS_BUCKET.list({ delimiter: "/" });
        const workspaces = listed.delimitedPrefixes.map((prefix) =>
          prefix.replace(/\/$/, ""),
        );
        const response = new Response(JSON.stringify({ workspaces }), {
          headers: { "Content-Type": "application/json" },
        });
        return cors ? withCors(response) : response;
      }

      // Forward to workspace DO
      const workspace = getWorkspace(env, workspaceId);
      const forwarded = new Request(
        new URL(`/${action || ""}`, request.url),
        request,
      );
      const response = await workspace.fetch(forwarded);
      return cors ? withCors(response) : response;
    }

    // Fallback
    if (fallback) {
      return fallback(request, env);
    }

    return new Response("nodemode — Node.js runtime on Cloudflare Workers", {
      status: 200,
    });
  };
}
