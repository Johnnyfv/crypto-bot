// Parse command
const text = msg.text.trim().replace(/\u00A0/g, " ");
const lower = text.toLowerCase();

// Accept /c, /cc, /cbot (and with @CConvertibot)
const isCcmd = lower.startsWith("/c ");
const isCcCmd = lower.startsWith("/cc ");
const isCbotCmd = lower.startsWith("/cbot ");

if (!(isCcmd || isCcCmd || isCbotCmd || lower.startsWith("/c@") || lower.startsWith("/cc@") || lower.startsWith("/cbot@"))) {
  return new Response("ok"); // not our command
}

const parts = text.split(/\s+/);
const mention = (parts[0].split("@")[1] || "").toLowerCase();
if (mention && env.BOT_USERNAME && mention !== env.BOT_USERNAME.toLowerCase()) {
  return new Response("ok");
}
