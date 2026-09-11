import { createApp } from "./app";
import { env } from "./common/lib/env";
import { logger } from "./common/lib/logger";

const app = createApp();
app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "FLS Mitr API listening");
});
