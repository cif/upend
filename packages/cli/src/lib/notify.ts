// unified notification system — email (Resend) + Slack + webhooks
// usage: await notify({ email: "ben@example.com", subject: "done", body: "cleaned up 5 sessions" })
// usage: await notify({ slack: "#tasks", text: "session cleanup complete" })
// usage: await notify({ webhook: "https://...", payload: { message: "done", url: "https://..." } })
// usage: await notify({ email: "...", slack: "...", subject: "...", body: "..." }) // all at once

type NotifyOpts = {
  email?: string | string[];
  subject?: string;
  body?: string;
  slack?: string;     // channel name (needs SLACK_BOT_TOKEN) or webhook URL
  text?: string;      // slack message text (falls back to body)
  webhook?: string;   // any webhook URL
  payload?: any;      // custom webhook payload (default: { text })
};

export async function notify(opts: NotifyOpts) {
  const results: { channel: string; ok: boolean; error?: string }[] = [];

  if (opts.email) {
    const r = await sendEmail(opts);
    results.push(r);
  }

  if (opts.slack) {
    const r = await sendSlack(opts);
    results.push(r);
  }

  if (opts.webhook) {
    const r = await sendWebhook(opts);
    results.push(r);
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error("[notify] failures:", failed);
  }

  return results;
}

async function sendEmail(opts: NotifyOpts) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { channel: "email", ok: false, error: "RESEND_API_KEY not set" };

  const from = process.env.NOTIFY_FROM_EMAIL || "upend <notifications@upend.site>";
  const to = Array.isArray(opts.email) ? opts.email : [opts.email!];

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: opts.subject || "upend notification",
        text: opts.body || opts.text || "",
      }),
    });

    if (res.ok) {
      console.log(`[notify] email sent to ${to.join(", ")}`);
      return { channel: "email", ok: true };
    } else {
      const err = await res.text();
      return { channel: "email", ok: false, error: err };
    }
  } catch (err: any) {
    return { channel: "email", ok: false, error: err.message };
  }
}

async function sendSlack(opts: NotifyOpts) {
  const text = opts.text || opts.body || "";
  const channel = opts.slack!;

  // if it looks like a webhook URL, post directly
  if (channel.startsWith("https://")) {
    try {
      const res = await fetch(channel, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return { channel: "slack", ok: res.ok, error: res.ok ? undefined : await res.text() };
    } catch (err: any) {
      return { channel: "slack", ok: false, error: err.message };
    }
  }

  // otherwise use Slack API with bot token
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { channel: "slack", ok: false, error: "SLACK_BOT_TOKEN not set (or use a webhook URL)" };

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: channel.startsWith("#") ? channel : `#${channel}`,
        text,
      }),
    });

    const data = await res.json() as any;
    if (data.ok) {
      console.log(`[notify] slack message sent to ${channel}`);
      return { channel: "slack", ok: true };
    } else {
      return { channel: "slack", ok: false, error: data.error };
    }
  } catch (err: any) {
    return { channel: "slack", ok: false, error: err.message };
  }
}

async function sendWebhook(opts: NotifyOpts) {
  const url = opts.webhook!;
  const body = opts.payload || { text: opts.text || opts.body || "" };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(`[notify] webhook ${res.ok ? "sent" : "failed"}: ${url}`);
    return { channel: "webhook", ok: res.ok, error: res.ok ? undefined : await res.text() };
  } catch (err: any) {
    return { channel: "webhook", ok: false, error: err.message };
  }
}
