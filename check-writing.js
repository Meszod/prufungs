// Netlify Function: securely proxies requests to the Anthropic API.
// The API key lives only in Netlify's environment variables (server side),
// never in the browser.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY sozlanmagan. Netlify > Site settings > Environment variables bo'limiga qo'shing." })
    };
  }

  let systemPrompt, userPrompt;
  try {
    const body = JSON.parse(event.body || "{}");
    systemPrompt = body.systemPrompt;
    userPrompt = body.userPrompt;
    if (!systemPrompt || !userPrompt) throw new Error("Missing prompt fields");
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Noto'g'ri so'rov formati" }) };
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: `Anthropic API xatosi: ${errText}` }) };
    }

    const data = await response.json();
    const textBlocks = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const cleaned = textBlocks.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Server xatosi" }) };
  }
};
