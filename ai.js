import Cerebras from "@cerebras/cerebras_cloud_sdk";
import { GoogleGenAI } from "@google/genai";
import { OpenRouter } from "@openrouter/sdk";
import { convertContentsToMessages } from './review.js';

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
export const aiBackup = new GoogleGenAI({ apiKey: process.env.GEMINI_BACKUP_KEY });
export const aiCerebras = new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });
export const aiBackupBackup = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
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
export async function callAIWithFallback({ ai, contents, tools, appLog }) {
  const providers = [
    { name: "gemini-3.1-flash-lite", type: "google", model: "gemini-3.1-flash-lite", useBackup: false },
    { name: "gemini-3.5-flash", type: "google", model: "gemini-3.5-flash", useBackup: false },
    { name: "gemma-4-26b-a4b-it", type: "google", model: "gemma-4-26b-a4b-it", useBackup: false },
    { name: "gemma-4-31b-it", type: "google", model: "gemma-4-31b-it", useBackup: false },
    { name: "gemini-3.1-flash-lite-backup", type: "google", model: "gemini-3.1-flash-lite", useBackup: true },
    { name: "gemini-3.5-flash-backup", type: "google", model: "gemini-3.5-flash", useBackup: true },
    { name: "gemma-4-26b-a4b-it-backup", type: "google", model: "gemma-4-26b-a4b-it", useBackup: true },
    { name: "openrouter-nemotron-3-super", type: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" },
    { name: "openrouter-qwen-coder", type: "openrouter", model: "qwen/qwen3-coder:free" },
    { name: "openrouter-gemma-4-31b-a4b-it", type: "openrouter", model: "google/gemma-4-31b-it:free" },
    { name: "pollinations-qwen-coder", type: "pollinations", model: "qwen-coder" },
    { name: "cerebras-gemma-4-31b", type: "cerebras", model: "gemma-4-31b" },
  ];

  let lastError = null;

  for (const provider of providers) {
    // log provider and model regardless of failure so i can know what stupid model the script is calling
    appLog && appLog.info(`Currently trying: ${provider.name} with model: ${provider.model}`);
    const startTime = Date.now();
    try {
      appLog && appLog.info(`Currently trying: ${provider.name} with model: ${provider.model}`);
      if (provider.type === "google") {
        if (provider.useBackup && !process.env.GEMINI_BACKUP_KEY) {
          continue;
        }

        const client = provider.useBackup && aiBackup ? aiBackup : ai;

        const toolList = tools && tools.length > 0
          ? [{ functionDeclarations: tools }, { codeExecution: {} }, { googleSearch: {} }]
          : [{ codeExecution: {} }, { googleSearch: {} }];

        const config = {
          tools: toolList,
          toolConfig: {
            includeServerSideToolInvocations: true
          },
          thinkingConfig: {
            includeThoughts: true
          }
        };

        const response = await client.models.generateContent({
          model: provider.model,
          contents: contents,
          config: config
        });

        const functionCalls = response.functionCalls || [];
        const parts = response.candidates?.[0]?.content?.parts || [];

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
        const formattedText = formatGoogleCommentText(parts, elapsedSeconds);

        return {
          functionCalls,
          candidates: response.candidates || [
            {
              content: {
                role: "model",
                parts: parts.length > 0 ? parts : (functionCalls.length > 0 ? functionCalls.map(c => ({ functionCall: c })) : [{ text: answerText }])
              }
            }
          ],
          text: "formattedText"
        };
      }

      if (provider.type === "cerebras") {
        if (!process.env.CEREBRAS_API_KEY) {
          continue;
        }

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
        const formattedText = sanitizeModelCommentText(text, elapsedSeconds);

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

      if (provider.type === "openrouter") {
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
        const formattedText = sanitizeModelCommentText(text, elapsedSeconds);
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
        const textWithHeader = `*Used ${provider.name}*\n\n${formattedText}`;

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

  throw new Error(`All AI providers failed. Last error: ${lastError ? lastError.message : "unknown"}`);
}
export function getElapsedSeconds(startTime) {
  return ((Date.now() - startTime) / 1000).toFixed(1);
}

