import Cerebras from "@cerebras/cerebras_cloud_sdk";
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { OpenRouter } from "@openrouter/sdk";
import Groq from "groq-sdk"; 
import { convertContentsToMessages } from './review.js';


function parseProviderList(value) {
  return (value || "")
    .split(",")
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
}

function providerMatches(provider, entry) {
  return provider.name.toLowerCase() === entry || (provider.type || "").toLowerCase() === entry;
}

export function filterProviders(providers, { enabled, disabled } = {}) {
  const allowList = parseProviderList(enabled !== undefined ? enabled : process.env.BOXY_ENABLED_PROVIDERS);
  const denyList = parseProviderList(disabled !== undefined ? disabled : process.env.BOXY_DISABLED_PROVIDERS);

  return providers.filter(provider => {
    if (allowList.length > 0 && !allowList.some(entry => providerMatches(provider, entry))) {
      return false;
    }
    return !denyList.some(entry => providerMatches(provider, entry));
  });
}

export function throwIfEmptyModelResponse(text, providerName) {
  if (!text || !text.trim()) {
    throw new Error(`${providerName} returned an empty response`);
  }
}
function escapeHtml(text) {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
export function sanitizeModelCommentText(text, elapsedSeconds, explicitReasoning = null) {
  const sourceText = text || "";
  const thinkTagRegex = /<think>([\s\S]*?)<\/think>/gi;
  const danglingThinkRegex = /<think>([\s\S]*)$/gi;
  let hadReasoning = Boolean(explicitReasoning);
  let extractedReasoning = explicitReasoning || "";

  let cleanedText = sourceText.replace(thinkTagRegex, (match, thoughts) => {
    hadReasoning = true;
    extractedReasoning += `${thoughts.trim()}\n\n`;
    return "";
  });

  cleanedText = cleanedText.replace(danglingThinkRegex, (match, thoughts) => {
    hadReasoning = true;
    extractedReasoning += `${thoughts.trim()}\n\n`;
    return "";
  });

  cleanedText = cleanedText.trim();

  if (!hadReasoning) {
    return cleanedText;
  }

  const reasoningBlock = escapeHtml(extractedReasoning.trim() || "No reasoning.");
  const details = `<details><summary>Thought for ${elapsedSeconds} seconds</summary>\n\n<pre>${reasoningBlock}</pre>\n\n</details>`;

  return cleanedText ? `${details}\n\n${cleanedText}` : details;
}
export function stripReasoningArtifacts(text) {
  return (text || "")
    .replace(/<think>([\s\S]*?)<\/think>/gi, "")
    .replace(/<think>([\s\S]*)$/gi, "")
    .trim();
}
export function formatGoogleCommentText(parts, elapsedSeconds) {
  const thoughtTexts = [];
  const answerTexts = [];

  for (const part of parts || []) {
    if (!part || !part.text) {
      continue;
    }

    if (part.thought) {
      thoughtTexts.push(part.text.trim());
    } else {
      answerTexts.push(part.text);
    }
  }

  const answerText = answerTexts.join("").trim();
  if (thoughtTexts.length === 0) {
    return answerText;
  }

  const reasoningBlock = escapeHtml(thoughtTexts.join("\n\n") || "No reasoning.");
  const details = `<details><summary>Thought for ${elapsedSeconds} seconds</summary>\n\n<pre>${reasoningBlock}</pre>\n\n</details>`;

  return answerText ? `${details}\n\n${answerText}` : details;
}
export function appendModelIdentification(text, model) {
  const body = (text || "").trim();
  if (!body || !model) {
    return body;
  }

  return `${body}\n\n---\n*Current model identification: ${model}*`;
}
export async function callAIWithFallback({ contents, tools, appLog, needsBigBrain = false }) {
  // needs big brain is optional param for when stronk models for thinking reviews or smth

  const providers = [
    { name: "novita-macaron-v1-venti", type: "novita", model: "mindai/macaron-v1-venti" },
    { name: "novita-macaron-v1-tall", type: "novita", model: "mindai/macaron-v1-tall" },
    { name: "novita-deepseek-v3.1", type: "novita", model: "deepseek/deepseek-v3.1" },
    { name: "novita-glm-4.5", type: "novita", model: "zai-org/glm-4.5" },
    { name: "novita-llama-3.3-70b", type: "novita", model: "meta-llama/llama-3.3-70b-instruct" },
    { name: "gemini-3.5-flash-lite", type: "google", model: "gemini-3.5-flash-lite", useBackup: false },
    { name: "gemini-3.1-flash-lite", type: "google", model: "gemini-3.1-flash-lite", useBackup: false },
    { name: "gemini-3.5-flash", type: "google", model: "gemini-3.5-flash", useBackup: false },
    { name: "gemma-4-26b-a4b-it", type: "google", model: "gemma-4-26b-a4b-it", useBackup: false },
    { name: "gemma-4-31b-it", type: "google", model: "gemma-4-31b-it", useBackup: false },
    { name: "gemini-3.1-flash-lite-backup", type: "google", model: "gemini-3.1-flash-lite", useBackup: true },
    { name: "gemini-3.5-flash-backup", type: "google", model: "gemini-3.5-flash", useBackup: true },
    { name: "gemma-4-26b-a4b-it-backup", type: "google", model: "gemma-4-26b-a4b-it", useBackup: true },
    { name: "gemma-4-31b-it-backup", type: "google", model: "gemma-4-31b-it", useBackup: true },
    { name: "mistral-large", type: "mistral", model: "mistral-large-latest", useBackup: false },
    { name: "pollinations-ultra-fast-gemma", type: "pollinations", model: "tomdacatto/gemma-4-31b-fast" },
    { name: "pollinations-agnes-1.5-flash", type: "pollinations", model: "Catniti/agnes-1.5-flash" },
    { name: "pollinations-minimax-m3-31b", type: "pollinations", model: "sharktide/inferenceport-ai-minimax-m3" },
    { name: "pollinations-gemma-4-31b-it", type: "pollinations", model: "Bakhshi7889/gemma-4-31b-it" },
    { name: "pollinations-qwen-3.6-27b", type: "pollinations", model: "sharktide/inferenceport-ai-qwen-3.6-27b" },
    { name: "pollinations-kimi-k2.7-code", type: "pollinations", model: "sharktide/inferenceport-ai-kimi-k2.7-code" },    
    { name: "pollinations-kimi-2.5", type: "pollinations", model: "sharktide/inferenceport-ai-kimi-k2.5" },
    { name: "pollinations-step-flash-3.5", type: "pollinations", model: "Spit-fires/step-3.5-flash-free" },
    { name: "command-a-plus-05-2026", type: "cohere", model: "command-a-plus-05-2026", useBackup: false },
    { name: "groq-llama-3.3-70b-versatile", type: "groq", model: "llama-3.3-70b-versatile", useBackup: false },
    { name: "groq-llama-3.1-8b-instant", type: "groq", model: "llama-3.1-8b-instant", useBackup: false },
    { name: "openrouter-nemotron-3-super", type: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" },
    { name: "openrouter-qwen-coder", type: "openrouter", model: "qwen/qwen3-coder:free" },
    { name: "openrouter-gemma-4-31b-a4b-it", type: "openrouter", model: "google/gemma-4-31b-it:free" },
    { name: "pollinations-gemma-slightly-more-expensive", type: "pollinations", model: "MarcosFRG/gemma-4-31b" },
    { name: "cerebras-gemma-4-31b", type: "cerebras", model: "gemma-4-31b" },
    { name: "pollinations-kimi-k3", type: "pollinations", model: "vendouple/kimi-k3" },
    { name: "hyperbolic-llama-3.3-70b", type: "hyperbolic", model: "meta-llama/Llama-3.3-70B-Instruct" },
    //{ name: "siliconflow-qwen-2.5-72b", type: "siliconflow", model: "Qwen/Qwen2.5-72B-Instruct" }
  ];

  const bigBrainProviders = [
    { name: "gemini-3.5-flash-lite", type: "google", model: "gemini-3.5-flash-lite", useBackup: false },
    { name: "gemini-3.5-flash-lite-backup", type: "google", model: "gemini-3.5-flash-lite", useBackup: true },
    { name: "gemini-3.1-flash-lite", type: "google", model: "gemini-3.5-flash-lite", useBackup: false },
    { name: "mistral-large", type: "mistral", model: "mistral-large-latest", useBackup: false },
    { name: "gemma-4-31b-it", type: "google", model: "gemma-4-31b-it", useBackup: false },
    { name: "command-a-plus-05-2026", type: "cohere", model: "command-a-plus-05-2026", useBackup: false },
    { name: "gemini-3.6-flash", type: "google", model: "gemini-3.6-flash", useBackup: false },
    { name: "gemini-3.5-flash-lite-backup", type: "google", model: "gemini-3.5-flash-lite", useBackup: true },
    { name: "gemma-4-31b-it-backup", type: "google", model: "gemma-4-31b-it", useBackup: true },
    { name: "gemini-3.6-flash-backup", type: "google", model: "gemini-3.6-flash", useBackup: true }

  ];
  
  const allProviders = needsBigBrain ? bigBrainProviders : providers;
  const providersToUse = filterProviders(allProviders);

  const skippedCount = allProviders.length - providersToUse.length;
  if (skippedCount > 0 && appLog) {
    appLog.info(`Skipping ${skippedCount} provider(s) disabled by BOXY_ENABLED_PROVIDERS/BOXY_DISABLED_PROVIDERS`);
  }

  if (providersToUse.length === 0) {
    throw new Error("No AI providers are enabled. Check BOXY_ENABLED_PROVIDERS / BOXY_DISABLED_PROVIDERS.");
  }

  let lastError = null;

  for (const provider of providersToUse) {
    // log provider and model regardless of failure so i can know what stupid model the script is calling
 
    const startTime = Date.now();
    try {
      appLog && appLog.info(`Currently trying: ${provider.name} with model: ${provider.model}`);
      if (provider.type === "google") {
        if (provider.useBackup ? !process.env.GEMINI_BACKUP_KEY : !process.env.GEMINI_API_KEY) {
          continue;
        }

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const aiBackup = new GoogleGenAI({ apiKey: process.env.GEMINI_BACKUP_KEY });

        const client = provider.useBackup && aiBackup ? aiBackup : ai;

        let toolList = tools && tools.length > 0 
          ? [{ functionDeclarations: tools }] 
          : [];

        if (!provider.model.startsWith("gemini-3")) {
          toolList.push({ codeExecution: {} });
          toolList.push({ googleSearch: {} });
        }

        if (toolList.length === 0) {
          toolList = undefined;
        }
        let thinkingLvl = "minimal";

        if (needsBigBrain || provider.model.startsWith("gemma")) {
          thinkingLvl = "high";
        }
        const config = {
          tools: toolList,
          toolConfig: {
            includeServerSideToolInvocations: true
          },
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: thinkingLvl
          },
          safetySettings: [
            {
              category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
              threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_HARASSMENT,
              threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
              threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
              threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
              threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
            },
          ],
        };

        // EXCEPTION FOR GOOGLE: Normalize history and ensure thought_signature exists on every tool call in history
        const normalizedContents = (contents || []).map(content => {
          if (content && content.role === "model" && Array.isArray(content.parts)) {
            const parts = content.parts.map(part => {
              if (part && part.functionCall) {
                const sig = part.functionCall.thoughtSignature || part.functionCall.thought_signature || part.thoughtSignature || "";
                return {
                  ...part,
                  functionCall: {
                    ...part.functionCall,
                    thoughtSignature: sig,
                    thought_signature: sig
                  }
                };
              }
              return part;
            });
            return { ...content, parts };
          }
          return content;
        });

        const response = await client.models.generateContent({
          model: provider.model,
          contents: normalizedContents,
          config: config
        });

        const parts = response.candidates?.[0]?.content?.parts || [];

        // Ensure real Gemini 3 thinking signatures are preserved on the returned parts and function calls
        for (const part of parts) {
          if (part && part.functionCall) {
            const sig = part.functionCall.thoughtSignature || part.functionCall.thought_signature || part.thoughtSignature;
            if (sig) {
              part.functionCall.thought_signature = sig;
              part.functionCall.thoughtSignature = sig;
            }
          }
        }

        const functionCalls = parts
          .filter(part => part && part.functionCall)
          .map(part => part.functionCall);

        if (functionCalls.length === 0 && response.functionCalls) {
          functionCalls.push(...response.functionCalls);
        }

        let answerText = "";
        for (const part of parts) {
          if (part.text && !part.thought) {
            answerText += part.text;
          }
        }

        let extraText = "";
        for (const part of parts) {
          if (part.executableCode && part.executableCode.code) {
            extraText += `\n\n**Code Execution:**\n\`\`\`python\n${part.executableCode.code}\n\`\`\`\n`;
          }
          if (part.codeExecutionResult && part.codeExecutionResult.output) {
            extraText += `**Output:**\n\`\`\`\n${part.codeExecutionResult.output}\n\`\`\`\n`;
          }
          if (part.inlineData && part.inlineData.data && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('image/')) {
            try {
              const buffer = Buffer.from(part.inlineData.data, 'base64');
              const blob = new Blob([buffer], { type: part.inlineData.mimeType });
              const formData = new FormData();
              formData.append('api_key', process.env.IMGHIPPO_API_KEY);
              formData.append('file', blob, 'graph.png');

              const uploadRes = await fetch('https://api.imghippo.com/v1/upload', {
                method: 'POST',
                body: formData
              });
              const uploadJson = await uploadRes.json();

              if (uploadJson.success) {
                extraText += `\n![Generated Graph](${uploadJson.data.url})\n`;
              } else if (appLog) {
                appLog.warn(`ImgHippo upload failed: ${JSON.stringify(uploadJson)}`);
              }
            } catch (e) {
              if (appLog) appLog.warn(`Failed to upload graph to ImgHippo: ${e.message}`);
            }
          }
        }

        if (extraText) {
          answerText += extraText;
        }

        if (functionCalls.length === 0 && !answerText.trim()) {
          throwIfEmptyModelResponse(answerText, `Google provider ${provider.name}`);
        }

        const elapsedSeconds = getElapsedSeconds(startTime);
        const formattedText = appendModelIdentification(formatGoogleCommentText(parts, elapsedSeconds), provider.model);

        return {
          functionCalls,
          candidates: response.candidates || [
            {
              content: {
                role: "model",
                parts: parts.length > 0 ? parts : [{ text: answerText }]
              }
            }
          ],
          text: formattedText
        };
      }
      if (provider.type === "cerebras") {
        if (!process.env.CEREBRAS_API_KEY) {
          continue;
        }

        const aiCerebras = new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });

        const messages = convertContentsToMessages(contents);

        const response = await aiCerebras.chat.completions.create({
          model: provider.model,
          messages
        });

        const message = response.choices?.[0]?.message;

        if (!message) {
          throw new Error("Empty choice content received from Cerebras");
        }

        const text = message.content || "";
        throwIfEmptyModelResponse(text, `Cerebras provider ${provider.name}`);
        const elapsedSeconds = getElapsedSeconds(startTime);
        const formattedText = appendModelIdentification(sanitizeModelCommentText(text, elapsedSeconds), provider.model);

        const contextText = stripReasoningArtifacts(text);

        return {
          functionCalls: [],
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: contextText }]
              }
            }
          ],
          text: formattedText
        };
      } 
      if (provider.type === "groq") {
        if (!process.env.GROQ_API_KEY) {
          continue;
        }

        const aiGroq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const messages = convertContentsToMessages(contents);

        let toolsParam = undefined;
        let toolChoiceParam = undefined;

        if (tools && tools.length > 0) {
          toolsParam = tools.map(t => {
            const props = {};
            for (const [k, v] of Object.entries(t.parameters?.properties || {})) {
              props[k] = { ...v };
              if (typeof props[k].type === 'string') {
                props[k].type = props[k].type.toLowerCase();
              }
              if (props[k].items && typeof props[k].items.type === 'string') {
                props[k].items = { ...props[k].items, type: props[k].items.type.toLowerCase() };
              }
            }
            return {
              type: "function",
              function: {
                name: t.name,
                description: t.description || "",
                parameters: {
                  type: "object",
                  properties: props,
                  required: t.parameters?.required || []
                }
              }
            };
          });
          toolChoiceParam = "auto";
        }

        const response = await aiGroq.chat.completions.create({
          model: provider.model,
          messages: messages,
          ...(toolsParam && { tools: toolsParam, tool_choice: toolChoiceParam })
        });

        const choice = response.choices?.[0];
        const message = choice?.message;

        if (!message) {
          throw new Error("Empty choice content received from Groq");
        }

        const text = message.content || "";
        const functionCalls = [];
        const parts = [];

        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const tc of message.tool_calls) {
            if (tc.type === "function") {
              let parsedArgs = {};
              try {
                parsedArgs = typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch (e) {
                parsedArgs = tc.function.arguments;
              }
              const fc = {
                name: tc.function.name,
                args: parsedArgs,
                id: tc.id
              };
              functionCalls.push(fc);
              parts.push({ functionCall: fc });
            }
          }
        } else {
          parts.push({ text });
        }

        if (functionCalls.length === 0) {
          throwIfEmptyModelResponse(text, `Groq provider ${provider.name}`);
        }

        const elapsedSeconds = getElapsedSeconds(startTime);
        const formattedText = appendModelIdentification(sanitizeModelCommentText(text, elapsedSeconds), provider.model);
        const contextParts = parts.map(part => (
          part.text ? { ...part, text: stripReasoningArtifacts(part.text) } : part
        ));

        return {
          functionCalls,
          candidates: [
            {
              content: {
                role: "model",
                parts: contextParts
              },
              finishReason: choice.finish_reason === "stop" ? "STOP" : (choice.finish_reason === "tool_calls" ? "STOP" : choice.finish_reason)
            }
          ],
          text: formattedText
        };
      }

      if (provider.type === "cohere") {
        if (!process.env.COHERE_API_KEY) {
          continue;
        }

        // wait 2 seconds because stupid cohere key has more rate limits if more tools stuff idk
        await new Promise(resolve => setTimeout(resolve, 2000));

        const messages = convertContentsToMessages(contents);
        const body = {
          model: provider.model,
          messages: messages
        };

        // Format tools the OpenAI way utilizing the endpoint's strict compatibility
        if (tools && tools.length > 0) {
          body.tools = tools.map(t => {
            const props = {};
            for (const [k, v] of Object.entries(t.parameters?.properties || {})) {
              props[k] = { ...v };
              if (typeof props[k].type === 'string') {
                props[k].type = props[k].type.toLowerCase();
              }
              if (props[k].items && typeof props[k].items.type === 'string') {
                props[k].items = { ...props[k].items, type: props[k].items.type.toLowerCase() };
              }
            }
            return {
              type: "function",
              function: {
                name: t.name,
                description: t.description || "",
                parameters: {
                  type: "object",
                  properties: props,
                  required: t.parameters?.required || []
                }
              }
            };
          });
          body.tool_choice = "auto";
        }

        const headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.COHERE_API_KEY}`
        };

        const res = await fetch("https://api.cohere.ai/compatibility/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          throw new Error(`Cohere Status ${res.status}: ${await res.text()}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        const message = choice?.message;

        if (!message) {
          throw new Error("Empty choice content received from Cohere API");
        }

        const text = message.content || "";
        const functionCalls = [];
        const parts = [];

        // Parse tool calls successfully
        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const tc of message.tool_calls) {
            if (tc.type === "function") {
              let parsedArgs = {};
              try {
                parsedArgs = typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch (e) {
                parsedArgs = tc.function.arguments;
              }
              const fc = {
                name: tc.function.name,
                args: parsedArgs,
                id: tc.id
              };
              functionCalls.push(fc);
              parts.push({ functionCall: fc });
            }
          }
        } else {
          parts.push({ text });
        }

        if (functionCalls.length === 0) {
          throwIfEmptyModelResponse(text, `Cohere provider ${provider.name}`);
        }

        const elapsedSeconds = getElapsedSeconds(startTime);
        const formattedText = sanitizeModelCommentText(text, elapsedSeconds);
        const contextParts = parts.map(part => (
          part.text ? { ...part, text: stripReasoningArtifacts(part.text) } : part
        ));
        const textWithHeader = appendModelIdentification(`${formattedText}\n\n*<sub>Used ${provider.name}</sub>*`, provider.model);

        return {
          functionCalls,
          candidates: [
            {
              content: {
                role: "model",
                parts: contextParts
              },
              finishReason: choice.finish_reason === "stop" ? "STOP" : (choice.finish_reason === "tool_calls" ? "STOP" : choice.finish_reason)
            }
          ],
          text: textWithHeader
        };
      }

      if (provider.type === "mistral") {
        if (!process.env.MISTRAL_API_KEY) {
          continue;
        }

        const messages = convertContentsToMessages(contents);
        const body = {
          model: provider.model,
          messages: messages
        };

        if (tools && tools.length > 0) {
          body.tools = tools.map(t => {
            const props = {};
            for (const [k, v] of Object.entries(t.parameters?.properties || {})) {
              props[k] = { ...v };
              if (typeof props[k].type === 'string') {
                props[k].type = props[k].type.toLowerCase();
              }
              if (props[k].items && typeof props[k].items.type === 'string') {
                props[k].items = { ...props[k].items, type: props[k].items.type.toLowerCase() };
              }
            }
            return {
              type: "function",
              function: {
                name: t.name,
                description: t.description || "",
                parameters: {
                  type: "object",
                  properties: props,
                  required: t.parameters?.required || []
                }
              }
            };
          });
          body.tool_choice = "auto";
        }

        const headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`
        };

        const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          throw new Error(`Mistral Status ${res.status}: ${await res.text()}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        const message = choice?.message;

        if (!message) {
          throw new Error("Empty choice content received from Mistral API");
        }

        const text = message.content || "";
        const functionCalls = [];
        const parts = [];

        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const tc of message.tool_calls) {
            if (tc.type === "function") {
              let parsedArgs = {};
              try {
                parsedArgs = typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch (e) {
                parsedArgs = tc.function.arguments;
              }
              const fc = {
                name: tc.function.name,
                args: parsedArgs,
                id: tc.id
              };
              functionCalls.push(fc);
              parts.push({ functionCall: fc });
            }
          }
        } else {
          parts.push({ text });
        }

        if (functionCalls.length === 0) {
          throwIfEmptyModelResponse(text, `Mistral provider ${provider.name}`);
        }

        const elapsedSeconds = getElapsedSeconds(startTime);
        const formattedText = appendModelIdentification(sanitizeModelCommentText(text, elapsedSeconds), provider.model);
        const contextParts = parts.map(part => (
          part.text ? { ...part, text: stripReasoningArtifacts(part.text) } : part
        ));

        return {
          functionCalls,
          candidates: [
            {
              content: {
                role: "model",
                parts: contextParts
              },
              finishReason: choice.finish_reason === "stop" ? "STOP" : (choice.finish_reason === "tool_calls" ? "STOP" : choice.finish_reason)
            }
          ],
          text: formattedText
        };
      }

      
      if (provider.type === "openrouter") {
        if (!process.env.OPENROUTER_API_KEY) {
          continue;
        }

        const aiBackupBackup = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
        const messages = convertContentsToMessages(contents);

        let toolsParam = undefined;
        let toolChoiceParam = undefined;

        if (tools && tools.length > 0) {
          toolsParam = tools.map(t => {
            const props = {};
            for (const [k, v] of Object.entries(t.parameters?.properties || {})) {
              props[k] = { ...v };
              if (typeof props[k].type === 'string') {
                props[k].type = props[k].type.toLowerCase();
              }
              if (props[k].items && typeof props[k].items.type === 'string') {
                props[k].items = { ...props[k].items, type: props[k].items.type.toLowerCase() };
              }
            }
            return {
              type: "function",
              function: {
                name: t.name,
                description: t.description || "",
                parameters: {
                  type: "object",
                  properties: props,
                  required: t.parameters?.required || []
                }
              }
            };
          });
          toolChoiceParam = "auto";
        }

        const response = await aiBackupBackup.chat.send({
          chatRequest: {
            model: provider.model,
            messages: messages,
            ...(toolsParam && { tools: toolsParam, tool_choice: toolChoiceParam })
          }
        });

        const choice = response.choices?.[0];
        const message = choice?.message;

        if (!message) {
          throw new Error("Empty choice content received from OpenRouter");
        }

        const text = message.content || "";
        const functionCalls = [];
        const parts = [];

        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const tc of message.tool_calls) {
            if (tc.type === "function") {
              let parsedArgs = {};
              try {
                parsedArgs = typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch (e) {
                parsedArgs = tc.function.arguments;
              }
              const fc = {
                name: tc.function.name,
                args: parsedArgs,
                id: tc.id
              };
              functionCalls.push(fc);
              parts.push({ functionCall: fc });
            }
          }
        } else {
          parts.push({ text });
        }

        if (functionCalls.length === 0) {
          throwIfEmptyModelResponse(text, `OpenRouter provider ${provider.name}`);
        }

        const elapsedSeconds = getElapsedSeconds(startTime);
        const formattedText = appendModelIdentification(sanitizeModelCommentText(text, elapsedSeconds), provider.model);
        const contextParts = parts.map(part => (
          part.text ? { ...part, text: stripReasoningArtifacts(part.text) } : part
        ));

        return {
          functionCalls,
          candidates: [
            {
              content: {
                role: "model",
                parts: contextParts
              },
              finishReason: choice.finish_reason === "stop" ? "STOP" : (choice.finish_reason === "tool_calls" ? "STOP" : choice.finish_reason)
            }
          ],
          text: formattedText
        };
      }

      if (provider.type === "hyperbolic") {
        if (!process.env.HYPERBOLIC_API_KEY) {
          continue;
        }

        const messages = convertContentsToMessages(contents);
        const body = {
          model: provider.model,
          messages: messages
        };

        if (tools && tools.length > 0) {
          body.tools = tools.map(t => {
            const props = {};
            for (const [k, v] of Object.entries(t.parameters?.properties || {})) {
              props[k] = { ...v };
              if (typeof props[k].type === 'string') {
                props[k].type = props[k].type.toLowerCase();
              }
              if (props[k].items && typeof props[k].items.type === 'string') {
                props[k].items = { ...props[k].items, type: props[k].items.type.toLowerCase() };
              }
            }
            return {
              type: "function",
              function: {
                name: t.name,
                description: t.description || "",
                parameters: {
                  type: "object",
                  properties: props,
                  required: t.parameters?.required || []
                }
              }
            };
          });
          body.tool_choice = "any";
        }

        const headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.HYPERBOLIC_API_KEY}`
        };

        const res = await fetch("https://api.hyperbolic.xyz/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          throw new Error(`Hyperbolic Status ${res.status}: ${await res.text()}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        const message = choice?.message;

        if (!message) {
          throw new Error("Empty choice content received from Hyperbolic");
        }

        const text = message.content || "";
        const functionCalls = [];
        const parts = [];

        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const tc of message.tool_calls) {
            if (tc.type === "function") {
              let parsedArgs = {};
              try {
                parsedArgs = typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch (e) {
                parsedArgs = tc.function.arguments;
              }
              const fc = {
                name: tc.function.name,
                args: parsedArgs,
                id: tc.id
              };
              functionCalls.push(fc);
              parts.push({ functionCall: fc });
            }
          }
        } else {
          parts.push({ text });
        }

        if (functionCalls.length === 0) {
          throwIfEmptyModelResponse(text, `Hyperbolic provider ${provider.name}`);
        }

        const elapsedSeconds = getElapsedSeconds(startTime);
        const formattedText = appendModelIdentification(sanitizeModelCommentText(text, elapsedSeconds), provider.model);
        const contextParts = parts.map(part => (
          part.text ? { ...part, text: stripReasoningArtifacts(part.text) } : part
        ));

        return {
          functionCalls,
          candidates: [
            {
              content: {
                role: "model",
                parts: contextParts
              },
              finishReason: choice.finish_reason === "stop" ? "STOP" : (choice.finish_reason === "tool_calls" ? "STOP" : choice.finish_reason)
            }
          ],
          text: formattedText
        };
      }

      if (provider.type === "siliconflow") {
        if (!process.env.SILICONFLOW_API_KEY) {
          continue;
        }

        const messages = convertContentsToMessages(contents);
        const body = {
          model: provider.model,
          messages: messages
        };

        if (tools && tools.length > 0) {
          body.tools = tools.map(t => {
            const props = {};
            for (const [k, v] of Object.entries(t.parameters?.properties || {})) {
              props[k] = { ...v };
              if (typeof props[k].type === 'string') {
                props[k].type = props[k].type.toLowerCase();
              }
              if (props[k].items && typeof props[k].items.type === 'string') {
                props[k].items = { ...props[k].items, type: props[k].items.type.toLowerCase() };
              }
            }
            return {
              type: "function",
              function: {
                name: t.name,
                description: t.description || "",
                parameters: {
                  type: "object",
                  properties: props,
                  required: t.parameters?.required || []
                }
              }
            };
          });
          body.tool_choice = "auto";
        }

        const headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.SILICONFLOW_API_KEY}`
        };

        const res = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          throw new Error(`SiliconFlow Status ${res.status}: ${await res.text()}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        const message = choice?.message;

        if (!message) {
          throw new Error("Empty choice content received from SiliconFlow");
        }

        const text = message.content || "";
        const functionCalls = [];
        const parts = [];

        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const tc of message.tool_calls) {
            if (tc.type === "function") {
              let parsedArgs = {};
              try {
                parsedArgs = typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch (e) {
                parsedArgs = tc.function.arguments;
              }
              const fc = {
                name: tc.function.name,
                args: parsedArgs,
                id: tc.id
              };
              functionCalls.push(fc);
              parts.push({ functionCall: fc });
            }
          }
        } else {
          parts.push({ text });
        }

        if (functionCalls.length === 0) {
          throwIfEmptyModelResponse(text, `SiliconFlow provider ${provider.name}`);
        }

        const elapsedSeconds = getElapsedSeconds(startTime);
        const formattedText = appendModelIdentification(sanitizeModelCommentText(text, elapsedSeconds), provider.model);
        const contextParts = parts.map(part => (
          part.text ? { ...part, text: stripReasoningArtifacts(part.text) } : part
        ));

        return {
          functionCalls,
          candidates: [
            {
              content: {
                role: "model",
                parts: contextParts
              },
              finishReason: choice.finish_reason === "stop" ? "STOP" : (choice.finish_reason === "tool_calls" ? "STOP" : choice.finish_reason)
            }
          ],
          text: formattedText
        };
      }

      if (provider.type === "novita") {
        if (!process.env.NOVITA_API_KEY) {
          continue;
        }

        const messages = convertContentsToMessages(contents);
        const body = {
          model: provider.model,
          messages: messages,
          max_tokens: provider.maxTokens || 8192,
          separate_reasoning: true
        };

        if (tools && tools.length > 0) {
          body.tools = tools.map(t => {
            const props = {};
            for (const [k, v] of Object.entries(t.parameters?.properties || {})) {
              props[k] = { ...v };
              if (typeof props[k].type === 'string') {
                props[k].type = props[k].type.toLowerCase();
              }
              if (props[k].items && typeof props[k].items.type === 'string') {
                props[k].items = { ...props[k].items, type: props[k].items.type.toLowerCase() };
              }
            }
            return {
              type: "function",
              function: {
                name: t.name,
                description: t.description || "",
                parameters: {
                  type: "object",
                  properties: props,
                  required: t.parameters?.required || []
                }
              }
            };
          });
          body.tool_choice = "auto";
        }

        const headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.NOVITA_API_KEY}`
        };

        const res = await fetch("https://api.novita.ai/openai/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          throw new Error(`Novita Status ${res.status}: ${await res.text()}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        const message = choice?.message;

        if (!message) {
          throw new Error("Empty choice content received from Novita");
        }

        const text = message.content || "";
        const reasoning = message.reasoning_content || null;
        const functionCalls = [];
        const parts = [];

        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const tc of message.tool_calls) {
            if (tc.type === "function") {
              let parsedArgs = {};
              try {
                parsedArgs = typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch (e) {
                parsedArgs = tc.function.arguments;
              }
              const fc = {
                name: tc.function.name,
                args: parsedArgs,
                id: tc.id
              };
              functionCalls.push(fc);
              parts.push({ functionCall: fc });
            }
          }
        } else {
          parts.push({ text });
        }

        if (functionCalls.length === 0) {
          throwIfEmptyModelResponse(text, `Novita provider ${provider.name}`);
        }

        const elapsedSeconds = getElapsedSeconds(startTime);
        const formattedText = appendModelIdentification(sanitizeModelCommentText(text, elapsedSeconds, reasoning), provider.model);
        const contextParts = parts.map(part => (
          part.text ? { ...part, text: stripReasoningArtifacts(part.text) } : part
        ));

        return {
          functionCalls,
          candidates: [
            {
              content: {
                role: "model",
                parts: contextParts
              },
              finishReason: choice.finish_reason === "stop" ? "STOP" : (choice.finish_reason === "tool_calls" ? "STOP" : choice.finish_reason)
            }
          ],
          text: formattedText
        };
      }

      if (provider.type === "pollinations") {
        if (!process.env.POLLINATIONS_API_KEY) {
          continue;
        }
        
        const messages = convertContentsToMessages(contents);
        const body = {
          model: provider.model,
          messages: messages
        };

        if (tools && tools.length > 0) {
          body.tools = tools.map(t => {
            const props = {};
            for (const [k, v] of Object.entries(t.parameters?.properties || {})) {
              props[k] = { ...v };
              if (typeof props[k].type === 'string') {
                props[k].type = props[k].type.toLowerCase();
              }
              if (props[k].items && typeof props[k].items.type === 'string') {
                props[k].items = { ...props[k].items, type: props[k].items.type.toLowerCase() };
              }
            }
            return {
              type: "function",
              function: {
                name: t.name,
                description: t.description || "",
                parameters: {
                  type: "object",
                  properties: props,
                  required: t.parameters?.required || []
                }
              }
            };
          });
          body.tool_choice = "auto";
        }

        const headers = {
          "Content-Type": "application/json"
        };
        const pollKey = process.env.POLLINATIONS_API_KEY || "any";
        headers["Authorization"] = `Bearer ${pollKey}`;

        const res = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          throw new Error(`Pollinations Status ${res.status}: ${await res.text()}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        const message = choice?.message;

        if (!message) {
          throw new Error("Empty choice content received");
        }

        const text = message.content || "";
        const functionCalls = [];
        const parts = [];

        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const tc of message.tool_calls) {
            if (tc.type === "function") {
              let parsedArgs = {};
              try {
                parsedArgs = typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch (e) {
                parsedArgs = tc.function.arguments;
              }
              const fc = {
                name: tc.function.name,
                args: parsedArgs,
                id: tc.id
              };
              functionCalls.push(fc);
              parts.push({ functionCall: fc });
            }
          }
        } else {
          parts.push({ text });
        }

        if (functionCalls.length === 0) {
          throwIfEmptyModelResponse(text, `Pollinations provider ${provider.name}`);
        }

        const elapsedSeconds = getElapsedSeconds(startTime);
        const formattedText = sanitizeModelCommentText(text, elapsedSeconds);
        const contextParts = parts.map(part => (
          part.text ? { ...part, text: stripReasoningArtifacts(part.text) } : part
        ));
        const textWithHeader = appendModelIdentification(`${formattedText}\n\n*<sub>Used ${provider.name}</sub>*`, provider.model);

        return {
          functionCalls,
          candidates: [
            {
              content: {
                role: "model",
                parts: contextParts
              },
              finishReason: choice.finish_reason === "stop" ? "STOP" : (choice.finish_reason === "tool_calls" ? "STOP" : choice.finish_reason)
            }
          ],
          text: textWithHeader
        };
      }
    } catch (err) {
      if (appLog) {
        appLog.warn(`Provider ${provider.name} failed. Error: ${err.message}`);
      }
      lastError = err;

      if (err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED")) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  throw new Error(`All AI providers failed. Last error: ${lastError ? lastError.message : "Unknown! You probably didn't provide any API keys."}`);
}
export function getElapsedSeconds(startTime) {
  return ((Date.now() - startTime) / 1000).toFixed(1);
}
