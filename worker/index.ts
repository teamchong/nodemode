// nodemode worker entry
//
// Routes:
//   /workspace/{id}/{action}  → Workspace DO
//   /api/workspaces/*         → REST API
//   /*                        → landing page

import type { Env } from "../src/env";
import { Workspace } from "../src/workspace";
import { ThreadDO } from "../src/thread-do";
import { createHandler } from "../src/handler";

export { Workspace, ThreadDO };
export type { Env };

const handler = createHandler();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handler(request, env);
  },
};
