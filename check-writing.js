// Netlify Function: securely proxies requests to the Groq API (OpenAI-compatible).
// The API key lives only in Netlify's environment variables (server side),
// never in the browser.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "GROQ_API_KEY sozlanmagan. Netlify > Site settings > Environment variables bo'limiga qo'shing." })
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
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 1000,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: `Groq API xatosi: ${errText}` }) };
    }

    const data = await response.json();
    const textBlock = data.choices?.[0]?.message?.content || "";
    const cleaned = textBlock.replace(/```json|```/g, "").trim();
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
