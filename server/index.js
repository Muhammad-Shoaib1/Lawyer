const path = require("path");
const dotenv = require("dotenv");

// Load backend environment variables from server/.env
dotenv.config({ path: path.join(__dirname, ".env") });

const app = require("./app");
const { connectToMongo } = require("./utils/mongo");

const port = process.env.PORT || 5000;

async function start() {
  await connectToMongo();
  app.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error("[server] failed to start:", err);
  process.exit(1);
});

