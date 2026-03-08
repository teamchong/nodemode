import { Workspace, createHandler } from "nodemode";
import type { Env } from "nodemode";

export { Workspace };

const handler = createHandler();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handler(request, env);
  },
};
