import { Workspace, ThreadDO, createHandler } from "nodemode";
import type { Env } from "nodemode";

export { Workspace, ThreadDO };

const handler = createHandler();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handler(request, env);
  },
};
