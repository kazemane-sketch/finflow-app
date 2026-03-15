import { extractJson } from "./json-helpers.ts";

export interface LLMConfig {
  model: string;
  temperature: number;
  thinkingBudget?: number | null;
  thinkingEffort?: string | null;
  maxOutputTokens?: number;
  systemPrompt: string;
  webSearchEnabled?: boolean;
  responseSchema?: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  thinking?: string;
  structured?: any;
}

/**
 * Funzione unificata per chiamare Gemini, Claude o OpenAI dalle Edge Functions.
 */
export async function callLLM(
  prompt: string,
  config: LLMConfig,
  env: { geminiKey?: string; anthropicKey?: string; openaiKey?: string }
): Promise<LLMResponse> {
  const { model } = config;

  if (model.startsWith("gemini-")) {
    return callGemini(prompt, config, env.geminiKey);
  } else if (model.startsWith("claude-")) {
    return callAnthropic(prompt, config, env.anthropicKey);
  } else if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) {
    return callOpenAI(prompt, config, env.openaiKey);
  }

  throw new Error(`Modello non supportato: ${model}`);
}

async function callGemini(prompt: string, config: LLMConfig, key?: string): Promise<LLMResponse> {
  if (!key) throw new Error("GEMINI_API_KEY mancante");
  
  const budget = config.thinkingBudget || 0;
  // Alcuni modelli Gemini non supportano thinkingConfig esplicito
  const noThinkingModels = ["gemini-3.1-pro-preview"];
  const supportsThinking = !noThinkingModels.includes(config.model) && budget > 0;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${key}`;
  
  const payload: any = {
    systemInstruction: { parts: [{ text: config.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: config.maxOutputTokens || 8192,
      temperature: config.temperature,
    },
  };

  // Gemini doesn't support responseMimeType: application/json if tools are provided
  if (config.responseSchema && !payload.tools) {
    payload.generationConfig.responseMimeType = "application/json";
    payload.generationConfig.responseSchema = config.responseSchema;
  }

  if (supportsThinking) {
    payload.generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  
  let text = "";
  let thinking = "";
  
  for (const p of parts) {
    if (p.thought && p.text) thinking += p.text;
    else if (p.text) text += p.text;
  }

  let structured = null;
  try {
    structured = extractJson(text);
  } catch (e) {
    // try to extract from reasoning if model failed to format properly
  }

  return { text, thinking, structured };
}

async function callAnthropic(prompt: string, config: LLMConfig, key?: string): Promise<LLMResponse> {
  if (!key) throw new Error("ANTHROPIC_API_KEY mancante");

  const isExtendedThinking = config.thinkingBudget && config.thinkingBudget > 0;
  // Per Claude 3.5 Sonnet, il budget di thinking minimo è 1024 token
  const budget = config.thinkingBudget && config.thinkingBudget < 1024 ? 1024 : config.thinkingBudget;
  // Il thinking in Anthropic richiede temperature=1 forzata
  const temperature = isExtendedThinking ? 1 : config.temperature;

  const payload: any = {
    model: config.model.replace("claude-sonnet-4-6", "claude-3-5-sonnet-20241022").replace("claude-haiku-4-5", "claude-3-5-haiku-20241022"),
    system: config.systemPrompt,
    messages: [{ role: "user", content: prompt }],
    max_tokens: config.maxOutputTokens || 8192,
    temperature: temperature,
  };

  if (isExtendedThinking) {
    // Anthropic requires max_tokens to be larger than thinking budget
    if (payload.max_tokens <= budget!) {
      payload.max_tokens = budget! + 4096;
    }
    payload.thinking = { type: "enabled", budget_tokens: budget };
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      ...(isExtendedThinking ? { "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15" } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  
  let text = "";
  let thinking = "";

  for (const block of (data.content || [])) {
    if (block.type === "thinking") {
      thinking += block.thinking;
    } else if (block.type === "text") {
      text += block.text;
    }
  }

  let structured = null;
  try {
    structured = extractJson(text);
  } catch (e) {
    // ignore
  }

  return { text, thinking, structured };
}

async function callOpenAI(prompt: string, config: LLMConfig, key?: string): Promise<LLMResponse> {
  if (!key) throw new Error("OPENAI_API_KEY mancante");

  const isReasoningModel = config.model.startsWith("o1") || config.model.startsWith("o3") || config.model.startsWith("gpt-5");

  const payload: any = {
    model: config.model,
    instructions: config.systemPrompt,
    input: [
      { role: "user", content: prompt }
    ],
  };

  // Web search nativo
  if (config.webSearchEnabled) {
    payload.tools = [{ type: "web_search_preview" }];
  }

  if (isReasoningModel) {
    const effort = config.thinkingEffort && config.thinkingEffort !== "none"
      ? config.thinkingEffort
      : config.thinkingBudget && config.thinkingBudget > 10000 ? "high"
      : config.thinkingBudget && config.thinkingBudget > 2000 ? "medium"
      : config.thinkingBudget && config.thinkingBudget > 0 ? "low"
      : undefined;
    if (effort) payload.reasoning = { effort };
  } else {
    payload.temperature = config.temperature;
    payload.max_output_tokens = config.maxOutputTokens || 8192;
  }

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();

  let text = "";
  let thinking = "";
  for (const item of (data.output || [])) {
    if (item.type === "message" && item.content) {
      for (const part of item.content) {
        if (part.type === "output_text") text += part.text;
      }
    }
    if (item.type === "reasoning") {
      thinking += item.summary?.map((s: any) => s.text).join("\n") || "";
    }
  }

  let structured = null;
  try { structured = extractJson(text); } catch { /* ignore */ }
  return { text, thinking, structured };
}

/* ─── Multi-provider Function Calling (multi-turn tool loop) ─── */

export interface ToolDeclaration {
  name: string;
  description: string;
  /** Gemini format (type: "OBJECT") — auto-converted for OpenAI/Anthropic */
  parameters: Record<string, unknown>;
}

export interface LLMToolsConfig {
  model: string;
  temperature: number;
  thinkingBudget?: number | null;
  thinkingEffort?: string | null;
  maxOutputTokens: number;
  webSearchEnabled?: boolean;
  /** Gemini responseSchema — forces structured JSON output on the final response.
   *  Only used for Gemini models. Ignored for Claude/OpenAI. */
  responseSchema?: Record<string, unknown>;
}

// Keep old name as alias for backward compat
export type GeminiToolsConfig = LLMToolsConfig;

type ToolCallsResult = LLMResponse & { tool_calls_log: { name: string; args: Record<string, unknown> }[] };

/** Convert Gemini-style parameter schema (OBJECT/STRING/NUMBER/BOOLEAN/ARRAY) to JSON Schema (lowercase) */
function geminiSchemaToJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type" && typeof v === "string") {
      out.type = v.toLowerCase();
    } else if (k === "properties" && typeof v === "object" && v !== null) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = typeof pv === "object" && pv !== null
          ? geminiSchemaToJsonSchema(pv as Record<string, unknown>)
          : pv;
      }
      out.properties = props;
    } else if (k === "items" && typeof v === "object" && v !== null) {
      out.items = geminiSchemaToJsonSchema(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Unified function calling router — picks Gemini, OpenAI, or Anthropic based on model name.
 */
export async function callLLMWithTools(
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDeclaration[],
  toolHandler: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  config: LLMToolsConfig,
  env: { geminiKey?: string; anthropicKey?: string; openaiKey?: string },
  maxIterations = 10,
): Promise<ToolCallsResult> {
  const { model } = config;
  if (model.startsWith("gemini-")) {
    return callGeminiWithTools(systemPrompt, userPrompt, tools, toolHandler, config, env.geminiKey!, maxIterations);
  } else if (model.startsWith("claude-")) {
    return callAnthropicWithTools(systemPrompt, userPrompt, tools, toolHandler, config, env.anthropicKey!, maxIterations);
  } else if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("gpt-5")) {
    return callOpenAIWithTools(systemPrompt, userPrompt, tools, toolHandler, config, env.openaiKey!, maxIterations);
  }
  throw new Error(`callLLMWithTools: modello non supportato: ${model}`);
}

/** @deprecated Use callLLMWithTools instead — kept for backward compat */
export async function callGeminiWithTools(
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDeclaration[],
  toolHandler: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  config: LLMToolsConfig,
  geminiKey: string,
  maxIterations = 10,
): Promise<ToolCallsResult> {
  if (!geminiKey) throw new Error("GEMINI_API_KEY mancante");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${geminiKey}`;

  const geminiTools: any[] = [];
  
  if (tools && tools.length > 0) {
    geminiTools.push({
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    });
  }

  // Web search nativo rimosso per Gemini qui (è gestito tramite Tavily a livello edge function)
  
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [
    { role: "user", parts: [{ text: userPrompt }] },
  ];

  const toolCallsLog: { name: string; args: Record<string, unknown> }[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
    };
    // responseSchema forces structured JSON on the FINAL response (not tool calls)
    // IMPORTANT: Gemini API does not support `responseMimeType: "application/json"` when tools are provided.
    // So we can only use responseSchema if we are making a call WITHOUT tools, or we drop tools for the final call.
    // Since we pass tools on every iteration currently, we MUST NOT send responseMimeType if tools are present.
    // For now, we will just not send it if there are tools to avoid the 400 error.
    if (config.responseSchema && geminiTools.length === 0) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = config.responseSchema;
    }

    const payload: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: geminiTools,
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini API ${resp.status}: ${errText.slice(0, 500)}`);
    }

    const data = await resp.json();
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const functionCalls = parts.filter((p: any) => p.functionCall);

    if (functionCalls.length === 0) {
      let text = "";
      let thinking = "";
      for (const p of parts) {
        if (p.thought && p.text) thinking += p.text;
        else if (p.text) text += p.text;
      }

      let structured = null;
      try { structured = extractJson(text); } catch { /* ignore */ }

      if (!structured && config.responseSchema) {
        const finalContents = [
          ...contents,
          { role: "model", parts },
          {
            role: "user",
            parts: [{
              text:
                "Restituisci ORA solo il JSON finale conforme allo schema richiesto. " +
                "Nessun markdown, nessuna spiegazione, nessun testo extra.",
            }],
          },
        ];

        const finalPayload: Record<string, unknown> = {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: finalContents,
          generationConfig: {
            maxOutputTokens: config.maxOutputTokens,
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: config.responseSchema,
          },
        };

        const finalResp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(finalPayload),
        });

        if (finalResp.ok) {
          const finalData = await finalResp.json();
          const finalParts = finalData?.candidates?.[0]?.content?.parts || [];
          const finalText = finalParts
            .map((p: any) => (p?.text ? String(p.text) : ""))
            .join("");

          if (finalText) {
            text = finalText;
            try { structured = extractJson(finalText); } catch { /* ignore */ }
          }
        } else {
          const errText = await finalResp.text().catch(() => "");
          console.warn(`callGeminiWithTools final JSON pass failed: ${errText.slice(0, 300)}`);
        }
      }

      return { text, thinking, structured, tool_calls_log: toolCallsLog };
    }

    contents.push({ role: "model", parts });

    const functionResponseParts: Array<Record<string, unknown>> = [];
    for (const fc of functionCalls) {
      const { name, args } = fc.functionCall;
      toolCallsLog.push({ name, args: args || {} });
      console.log(`[callGeminiWithTools] Tool call: ${name}(${JSON.stringify(args || {}).slice(0, 200)})`);

      try {
        const result = await toolHandler(name, args || {});
        functionResponseParts.push({
          functionResponse: { name, response: { result } },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[callGeminiWithTools] Tool error ${name}: ${msg}`);
        functionResponseParts.push({
          functionResponse: { name, response: { error: msg } },
        });
      }
    }

    contents.push({ role: "user", parts: functionResponseParts });
  }

  throw new Error(`callGeminiWithTools: max iterations (${maxIterations}) reached without final response`);
}

/* ─── OpenAI Function Calling ─── */

async function callOpenAIWithTools(
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDeclaration[],
  toolHandler: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  config: LLMToolsConfig,
  openaiKey: string,
  maxIterations = 10,
): Promise<ToolCallsResult> {
  if (!openaiKey) throw new Error("OPENAI_API_KEY mancante");

  const isReasoningModel = config.model.startsWith("o1") || config.model.startsWith("o3") || config.model.startsWith("gpt-5");

  // Build tools: custom functions + optional native web search
  const oaiTools: any[] = tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: geminiSchemaToJsonSchema(t.parameters),
    strict: false,
  }));

  if (config.webSearchEnabled) {
    oaiTools.push({ type: "web_search_preview" });
  }

  const toolCallsLog: { name: string; args: Record<string, unknown> }[] = [];
  let previousResponseId: string | null = null;
  let currentInput: any = [
    { role: "user", content: userPrompt },
  ];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const payload: any = {
      model: config.model,
      instructions: systemPrompt,
      input: currentInput,
      tools: oaiTools,
    };

    if (previousResponseId) {
      payload.previous_response_id = previousResponseId;
    }

    if (isReasoningModel) {
      const effort = config.thinkingEffort && config.thinkingEffort !== "none"
        ? config.thinkingEffort
        : config.thinkingBudget && config.thinkingBudget > 10000 ? "high"
        : config.thinkingBudget && config.thinkingBudget > 2000 ? "medium"
        : config.thinkingBudget && config.thinkingBudget > 0 ? "low"
        : undefined;
      if (effort) payload.reasoning = { effort };
    } else {
      payload.temperature = config.temperature;
      payload.max_output_tokens = config.maxOutputTokens || 8192;
    }

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI API ${resp.status}: ${errText.slice(0, 500)}`);
    }

    const data = await resp.json();
    previousResponseId = data.id;

    const outputItems = data.output || [];
    const functionCalls = outputItems.filter((item: any) => item.type === "function_call");
    const webSearchCalls = outputItems.filter((item: any) => item.type === "web_search_call");

    // Log web searches
    for (const ws of webSearchCalls) {
      toolCallsLog.push({ name: "web_search", args: { status: ws.status } });
    }

    // No custom function calls -> extract final text
    if (functionCalls.length === 0) {
      let text = "";
      let thinking = "";
      for (const item of outputItems) {
        if (item.type === "message" && item.content) {
          for (const part of item.content) {
            if (part.type === "output_text") text += part.text;
          }
        }
        if (item.type === "reasoning") {
          thinking += item.summary?.map((s: any) => s.text).join("\n") || "";
        }
      }
      let structured = null;
      try { structured = extractJson(text); } catch { /* ignore */ }
      return { text, thinking, structured, tool_calls_log: toolCallsLog };
    }

    // Execute custom function calls
    currentInput = [];
    for (const fc of functionCalls) {
      const fnName = fc.name;
      let fnArgs: Record<string, unknown> = {};
      try { fnArgs = JSON.parse(fc.arguments || "{}"); } catch { /* ignore */ }
      toolCallsLog.push({ name: fnName, args: fnArgs });
      console.log(`[callOpenAIWithTools] Tool call: ${fnName}(${JSON.stringify(fnArgs).slice(0, 200)})`);

      let resultContent: string;
      try {
        const result = await toolHandler(fnName, fnArgs);
        resultContent = JSON.stringify(result);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[callOpenAIWithTools] Tool error ${fnName}: ${errMsg}`);
        resultContent = JSON.stringify({ error: errMsg });
      }

      currentInput.push({
        type: "function_call_output",
        call_id: fc.call_id,
        output: resultContent,
      });
    }
  }

  throw new Error(`callOpenAIWithTools: max iterations (${maxIterations}) reached without final response`);
}

/* ─── Anthropic Tool Use ─── */

async function callAnthropicWithTools(
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDeclaration[],
  toolHandler: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  config: LLMToolsConfig,
  anthropicKey: string,
  maxIterations = 10,
): Promise<ToolCallsResult> {
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY mancante");

  const anthropicTools: any[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: geminiSchemaToJsonSchema(t.parameters),
  }));

  if (config.webSearchEnabled) {
    anthropicTools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3,
    });
  }

  const modelId = config.model
    .replace("claude-sonnet-4-6", "claude-3-5-sonnet-20241022")
    .replace("claude-haiku-4-5", "claude-3-5-haiku-20241022");

  const messages: Array<{ role: string; content: unknown }> = [
    { role: "user", content: userPrompt },
  ];

  const toolCallsLog: { name: string; args: Record<string, unknown> }[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const payload: Record<string, unknown> = {
      model: modelId,
      system: systemPrompt,
      messages,
      tools: anthropicTools,
      max_tokens: config.maxOutputTokens || 8192,
      temperature: config.temperature,
    };

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2025-04-14",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 500)}`);
    }

    const data = await resp.json();
    const contentBlocks = data.content || [];

    const toolUseBlocks = contentBlocks.filter((b: any) => b.type === "tool_use");

    // If no custom function tool_use blocks...
    if (toolUseBlocks.length === 0) {
      // Check if there are web search blocks
      const hasWebSearch = contentBlocks.some((b: any) =>
        b.type === "web_search_tool_use" || b.type === "web_search_tool_result"
      );

      // If stop_reason indicates end, or no web search is active -> final response
      if (data.stop_reason === "end_turn" || !hasWebSearch) {
        let text = "";
        let thinking = "";
        for (const block of contentBlocks) {
          if (block.type === "thinking") thinking += block.thinking;
          else if (block.type === "text") text += block.text;
          // Log web search for debug
          else if (block.type === "web_search_tool_use") {
            toolCallsLog.push({ name: "web_search", args: { query: block.query || "" } });
          }
          // web_search_tool_result: Claude handles this internally, we ignore it
        }
        let structured = null;
        try { structured = extractJson(text); } catch { /* ignore */ }
        return { text, thinking, structured, tool_calls_log: toolCallsLog };
      }

      // If there's a web search but not finished, Claude is still processing.
      // Add blocks to history and continue loop.
      messages.push({ role: "assistant", content: contentBlocks });
      continue;
    }

    // Add assistant message to history
    messages.push({ role: "assistant", content: contentBlocks });

    // Execute tool calls and build tool_result blocks
    const toolResults: Array<Record<string, unknown>> = [];
    for (const tu of toolUseBlocks) {
      const fnName = tu.name;
      const fnArgs = tu.input || {};
      toolCallsLog.push({ name: fnName, args: fnArgs });
      console.log(`[callAnthropicWithTools] Tool call: ${fnName}(${JSON.stringify(fnArgs).slice(0, 200)})`);

      let resultContent: string;
      try {
        const result = await toolHandler(fnName, fnArgs);
        resultContent = JSON.stringify(result);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[callAnthropicWithTools] Tool error ${fnName}: ${errMsg}`);
        resultContent = JSON.stringify({ error: errMsg });
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: resultContent,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(`callAnthropicWithTools: max iterations (${maxIterations}) reached without final response`);
}
