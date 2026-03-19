// @description send a test email to email@benipsen.com

export async function run() {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "upend <notifications@upend.site>",
      to: ["email@benipsen.com"],
      subject: "Hello from upend first notification",
      text: "hello from upend!",
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  console.log("email sent:", data.id);
}

run().then(() => process.exit(0));
