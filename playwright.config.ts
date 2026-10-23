import { defineConfig, devices } from "@playwright/test";
const prefix = process.env.NEXT_PUBLIC_BASE_PATH ?? "/-shift-scheduler";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  retries: 1,
  use: {
    baseURL: "http://127.0.0.1:4173" + prefix + "/",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-iphone", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "node scripts/serve-preview.mjs",
    url: "http://127.0.0.1:4173" + prefix + "/",
    reuseExistingServer: false,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
