const providerPresets = {
  gpt: {
    label: "GPT",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    envKeys: ["OPENAI_API_KEY", "VITE_OPENAI_API_KEY"]
  },
  gemini: {
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    envKeys: ["GEMINI_API_KEY", "VITE_GEMINI_API_KEY"]
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    envKeys: ["DEEPSEEK_API_KEY", "VITE_DEEPSEEK_API_KEY"]
  },
  qwen: {
    label: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    envKeys: ["DASHSCOPE_API_KEY", "QWEN_API_KEY", "VITE_DASHSCOPE_API_KEY", "VITE_QWEN_API_KEY"]
  }
};

function providerApiKey(provider, settings) {
  const preset = providerPresets[provider];
  if (!preset) return "";

  const savedValue = settings?.apiKeys?.[provider]?.trim();
  if (savedValue) return savedValue;

  for (const key of preset.envKeys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function completionText(payload) {
  const choices = payload?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

async function runCloudAssistant(request, settings = {}) {
  const preset = providerPresets[request.provider];
  if (!preset) throw new Error("\u672a\u77e5\u4e91\u7aef\u6a21\u578b\u3002");

  const apiKey = providerApiKey(request.provider, settings);
  if (!apiKey) throw new Error(`${preset.label} \u6a21\u578b\u4e0d\u53ef\u7528\uff1a\u8bf7\u5148\u5728\u8bbe\u7f6e\u4e2d\u586b\u5199 API key\u3002`);

  const system =
    request.mode === "translate"
      ? `You translate academic writing into clear ${request.targetLanguage === "zh" ? "Simplified Chinese" : request.targetLanguage}. Keep technical terms accurate and preserve equations, citations, and variable names.`
      : "You help read academic papers. Answer based only on the selected passage. If the passage is insufficient, say what is missing.";
  const user =
    request.mode === "translate"
      ? request.text
      : `Selected passage from page ${request.page}:\n${request.text}\n\nQuestion:\n${request.question?.trim() ?? ""}`;

  const response = await fetch(`${preset.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: preset.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `\u4e91\u7aef\u8bf7\u6c42\u5931\u8d25\uff1a${response.status}`);
  }

  const text = completionText(await response.json());
  if (!text) throw new Error("\u4e91\u7aef\u8fd4\u56de\u4e3a\u7a7a\u3002");
  return text;
}

module.exports = {
  runCloudAssistant
};
