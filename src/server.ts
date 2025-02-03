import { bot, notifyAdmins } from "./bot.ts";
import { webhookCallback } from "./deps.deno.ts";

const handleUpdate = webhookCallback(bot, "std/http");
let isFirstUpdate = true;

Deno.serve(async (req) => {
  if (req.method === "POST") {
    const url = new URL(req.url);
    if (url.pathname.slice(1) === bot.token) {
      try {
        console.log("Received webhook update");
        const response = await handleUpdate(req);
        // Only notify on first successful webhook
        if (isFirstUpdate) {
          await notifyAdmins().catch(console.error);
          isFirstUpdate = false;
        }
        console.log("Webhook update processed");
        return response;
      } catch (err) {
        console.error("Error processing webhook:", err);
        return new Response("Error", { status: 500 });
      }
    }
  }
  return new Response("Pinterest to Telegram Bot is operational");
}); 