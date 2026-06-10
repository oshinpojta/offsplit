import { createApp } from './app.js';
import type { Env } from './d1.js';

const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx: unknown) =>
    app.fetch(request, env, ctx as never),
};
