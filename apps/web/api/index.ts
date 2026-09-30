import { app } from "@crew/server";
import { handle } from "hono/vercel";

// Runtime is pinned to nodejs22.x by the root vercel.json `functions` entry.
export default handle(app);
