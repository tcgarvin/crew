import { serve } from "@hono/node-server";
import { app } from "./index";

const port = 3001;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@crew/server dev listening on http://localhost:${info.port}`);
});
