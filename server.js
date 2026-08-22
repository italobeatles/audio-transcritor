import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs-extra';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import wav from 'wav-decoder';
import { pipeline, env as transformersEnv } from '@xenova/transformers';
import OpenAI from 'openai';

ffmpeg.setFfmpegPath(ffmpegPath);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;
const publicDir = path.join(root, 'public');
const tempDir = path.join(root, 'temp');
const transformersCacheDir = path.join(root, '.cache', 'transformers');

transformersEnv.cacheDir = transformersCacheDir;
transformersEnv.useFSCache = true;

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(publicDir));

const LOCAL_TRANSCRIPTION_MODEL = process.env.LOCAL_TRANSCRIPTION_MODEL || 'Xenova/whisper-base';
const OPENAI_TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || 'gpt-4o-transcribe';
const OPENAI_SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'gpt-5-mini';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/auto';
const FOUNDRY_API_KEY = process.env.FOUNDRY_API_KEY || process.env.GITHUB_TOKEN;
const FOUNDRY_ENDPOINT = (process.env.FOUNDRY_ENDPOINT || process.env.GITHUB_BASE_URL || 'https://models.inference.ai.azure.com').replace(/\/+$/, '');
const FOUNDRY_MODEL = process.env.FOUNDRY_MODEL || process.env.GITHUB_MODEL || 'gpt-5-mini';
const HF_MODEL = process.env.HF_MODEL || 'zai-org/GLM-4.5';
const COHERE_MODEL = process.env.COHERE_MODEL || 'command-a-03-2025';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
let localTranscriberPromise;
let providerCache = [];
let providerCacheAt = 0;

function hasOpenAi() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.USE_OPENAI !== 'false');
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
}

async function ensureDir(dir) {
  await fs.ensureDir(dir);
}

async function ensureRuntimeDirs() {
  await ensureDir(tempDir);
  await ensureDir(transformersCacheDir);
}

async function convertToWav(inputFile) {
  const outputFile = path.join(tempDir, `${path.basename(inputFile, path.extname(inputFile))}-${Date.now()}.wav`);
  await ensureDir(tempDir);
  await new Promise((resolve, reject) => {
    ffmpeg(inputFile)
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('end', resolve)
      .on('error', reject)
      .save(outputFile);
  });
  return outputFile;
}

async function getLocalTranscriber() {
  if (!localTranscriberPromise) {
    localTranscriberPromise = pipeline('automatic-speech-recognition', LOCAL_TRANSCRIPTION_MODEL);
  }
  return localTranscriberPromise;
}

async function transcribeWithOpenAi(inputPath, onProgress) {
  onProgress?.({ percent: 15, step: 'Enviando audio para a transcricao remota...' });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const result = await client.audio.transcriptions.create({
    file: createReadStream(inputPath),
    model: OPENAI_TRANSCRIPTION_MODEL,
    language: 'pt',
    temperature: 0
  });
  onProgress?.({ percent: 90, step: 'Finalizando transcricao remota...' });
  return normalizeText(result?.text);
}

async function transcribeAudio(inputPath, onProgress) {
  if (hasOpenAi() && process.env.PREFER_REMOTE_TRANSCRIPTION !== 'false') {
    try {
      return await transcribeWithOpenAi(inputPath, onProgress);
    } catch (error) {
      console.error(`Transcricao remota falhou (${OPENAI_TRANSCRIPTION_MODEL}); usando fallback local: ${error.message}`);
      onProgress?.({ percent: 8, step: 'Transcricao remota indisponivel; usando processamento local...' });
    }
  }

  onProgress?.({ percent: 15, step: 'Convertendo Ã¡udio para WAV...' });
  onProgress?.({ percent: 15, step: 'Convertendo áudio para WAV...' });
  const wavPath = await convertToWav(inputPath);

  onProgress?.({ percent: 30, step: 'Decodificando áudio...' });
  const buffer = await fs.readFile(wavPath);
  const audioData = await wav.decode(buffer);

  onProgress?.({ percent: 45, step: 'Carregando modelo de transcrição...' });
  const transcriber = await getLocalTranscriber();

  onProgress?.({ percent: 60, step: 'Transcrevendo áudio...' });
  const result = await transcriber(audioData.channelData[0], {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: 'portuguese',
    task: 'transcribe'
  });

  onProgress?.({ percent: 90, step: 'Finalizando...' });
  return normalizeText(result?.text);
}

function buildCorrectionPrompt(rawText) {
  return `Corrija o texto abaixo, que foi gerado por transcrição automática de áudio. Remova palavras repetidas sem sentido, corrige erros óbvios de reconhecimento de fala e ruídos de captação. Preserve o significado original, o tom da fala e gírias ou intenções do falante. Não adicione informações novas.

Texto para corrigir:
${rawText}

Responda apenas com o texto corrigido, sem explicações ou comentários.`;
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function buildPrompt(transcript, userContext) {
  return `Você é um assistente brasileiro especializado em comunicação interpessoal. Sua tarefa é escrever UMA RESPOSTA PRONTA para WhatsApp, em primeira pessoa, como se fosse enviada pelo usuário.

Regras obrigatórias:
- Não faça resumo do áudio.
- Não dê instruções ao usuário sobre como responder.
- Escreva diretamente a mensagem que o usuário pode enviar.
- Use explicitamente as informações relevantes fornecidas pelo usuário para ajustar conteúdo, tom, limites e contexto.
- O tom deve parecer interessado, cuidadoso e maduro, sem promessa afetiva e sem ambiguidade romântica.
- Se fizer sentido, divida em múltiplas mensagens curtas de WhatsApp.
- Preserve clareza emocional: acolha, mostre que ouviu pontos específicos e feche com uma pergunta ou encaminhamento concreto.

Transcrição:
${transcript}

Informações relevantes fornecidas pelo usuário:
${userContext || 'Nenhum'}

Formato da saída:
Entregue somente o texto pronto para enviar. Não inclua títulos, análise, explicações, tópicos técnicos ou observações fora da mensagem.`;
}

function summariseLocally(transcript, userContext) {
  const cleaned = normalizeText(transcript);
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  const first = sentences.slice(0, 6).join(' ');
  return `Li com atenção o que você trouxe e quero responder com cuidado, sem ser superficial. Pelo que entendi, tem pontos importantes aí que merecem ser levados a sério: ${first || cleaned}

Também estou levando em conta este contexto: ${userContext || 'não há um contexto adicional além da própria transcrição'}.

Quero ser honesto e cuidadoso ao mesmo tempo. Eu valorizo essa troca e o que você está tentando comunicar, mas também não quero criar uma expectativa que eu não possa sustentar. Para mim, faz sentido continuar essa conversa com calma, tentando entender melhor o que é mais importante para você agora e o que você espera que eu compreenda de forma mais concreta.`;
}

async function callOpenAi(prompt) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: OPENAI_SUMMARY_MODEL,
    temperature: 0.3,
    messages: [
      { role: 'system', content: 'Você é um assistente brasileiro.' },
      { role: 'user', content: prompt }
    ]
  });
  return response.choices?.[0]?.message?.content?.trim() || '';
}

async function callProvider({ name, url, headers, body, extractor, errorHint, timeoutMs = 15000 }) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) {
    const quota = response.status === 429 || /quota|rate limit|insufficient/i.test(text);
    throw new Error(`${name} retornou ${response.status}: ${errorHint || text}`, { cause: quota ? 'quota' : 'error' });
  }
  return extractor(JSON.parse(text));
}

function getProviderAttempts(prompt) {
  const attempts = [];

  if (hasOpenAi()) {
    attempts.push({ name: 'OpenAI', fn: () => callOpenAi(prompt) });
  }

  if (process.env.GROQ_API_KEY) {
    attempts.push({
      name: 'Groq',
      fn: () => callProvider({
        name: 'Groq',
        url: `${process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (FOUNDRY_API_KEY) {
    attempts.push({
      name: 'Microsoft Foundry Models',
      fn: () => callProvider({
        name: 'Microsoft Foundry Models',
        url: `${FOUNDRY_ENDPOINT}/chat/completions`,
        headers: { Authorization: `Bearer ${FOUNDRY_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: FOUNDRY_MODEL, temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (process.env.OPENROUTER_API_KEY) {
    attempts.push({
      name: 'OpenRouter',
      fn: () => callProvider({
        name: 'OpenRouter',
        url: `${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/italolopes/freelas-agent', 'X-Title': 'Transcritor WhatsApp' },
        body: { model: OPENROUTER_MODEL, temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (process.env.NVIDIA_API_KEY) {
    attempts.push({
      name: 'NVIDIA NIM',
      fn: () => callProvider({
        name: 'NVIDIA NIM',
        url: `${process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: process.env.NVIDIA_MODEL || 'z-ai/glm-5.1', temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (process.env.HF_TOKEN) {
    attempts.push({
      name: 'Hugging Face',
      fn: () => callProvider({
        name: 'Hugging Face',
        url: `${process.env.HF_BASE_URL || 'https://router.huggingface.co/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: { model: HF_MODEL, temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (process.env.COHERE_API_KEY) {
    attempts.push({
      name: 'Cohere',
      fn: () => callProvider({
        name: 'Cohere',
        url: `${process.env.COHERE_BASE_URL || 'https://api.cohere.com'}/v2/chat`,
        headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: COHERE_MODEL, temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.message?.content?.[0]?.text?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (process.env.CEREBRAS_API_KEY) {
    attempts.push({
      name: 'Cerebras',
      fn: () => callProvider({
        name: 'Cerebras',
        url: `${process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: process.env.CEREBRAS_MODEL || 'zai-glm-4.7', temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (process.env.OPENCODE_API_KEY) {
    attempts.push({
      name: 'OpenCode',
      fn: () => callProvider({
        name: 'OpenCode',
        url: `${process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.OPENCODE_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: process.env.OPENCODE_MODEL || 'big-pickle', temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    attempts.push({
      name: 'Cloudflare Workers AI',
      fn: () => callProvider({
        name: 'Cloudflare Workers AI',
        url: `${process.env.CLOUDFLARE_BASE_URL || 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CLOUDFLARE_ACCOUNT_ID + '/ai/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: { model: process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (process.env.BYTEPLUS_API_KEY || process.env.ARK_API_KEY) {
    attempts.push({
      name: 'BytePlus/ModelArk',
      fn: () => callProvider({
        name: 'BytePlus/ModelArk',
        url: `${process.env.BYTEPLUS_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.BYTEPLUS_API_KEY || process.env.ARK_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: process.env.BYTEPLUS_MODEL || 'seed-1-8-251228', temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (process.env.GEMINI_API_KEY) {
    attempts.push({
      name: 'Gemini',
      fn: () => callProvider({
        name: 'Gemini',
        url: `${process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'}/models/${GEMINI_MODEL}:generateContent`,
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
        extractor: json => json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '',
        errorHint: 'sem resposta util'
      })
    });
  }

  if (process.env.OLLAMA_URL || process.env.OLLAMA_MODEL) {
    attempts.push({
      name: 'Ollama (local)',
      fn: async () => {
        const baseUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
        const model = process.env.OLLAMA_MODEL || 'qwen2.5-coder:0.5b';
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(15000)
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`Ollama retornou ${response.status}: ${text}`);
        return JSON.parse(text).choices?.[0]?.message?.content?.trim() || '';
      }
    });
  }

  return attempts;
}

async function tryProviders(attempts, onProgress) {
  const total = attempts.length;
  for (let i = 0; i < total; i++) {
    const { name, fn } = attempts[i];
    try {
      const pct = Math.round(((i + 1) / total) * 85);
      onProgress?.({ percent: pct, step: `Tentando ${name}...` });
      const result = await fn();
      if (result) return result;
    } catch (error) {
      // continue to next provider
    }
  }
  return null;
}

async function generateResponse({ transcript, userContext, prompt, onProgress }) {
  onProgress?.({ percent: 5, step: 'Preparando prompt...' });
  const attempts = getProviderAttempts(prompt);

  const result = await tryProviders(attempts, onProgress);
  if (result) {
    onProgress?.({ percent: 100, step: 'Resposta pronta!' });
    return result;
  }

  onProgress?.({ percent: 100, step: 'Usando fallback local...' });
  return summariseLocally(transcript || prompt, userContext);
}

async function correctTranscription(rawText, onProgress) {
  if (!rawText || !rawText.trim()) return '';

  onProgress?.({ percent: 5, step: 'Preparando correção...' });
  const prompt = buildCorrectionPrompt(rawText);
  const attempts = getProviderAttempts(prompt);

  const result = await tryProviders(attempts, onProgress);
  if (result) return normalizeText(result);

  return normalizeText(rawText);
}

function providerEnvSnapshot() {
  return [
    {
      providerName: 'Groq',
      modelName: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      keyPresent: Boolean(process.env.GROQ_API_KEY),
      enabled: Boolean(process.env.GROQ_API_KEY)
    },
    {
      providerName: 'Microsoft Foundry Models',
      modelName: FOUNDRY_MODEL,
      keyPresent: Boolean(FOUNDRY_API_KEY),
      enabled: Boolean(FOUNDRY_API_KEY)
    },
    {
      providerName: 'OpenRouter',
      modelName: OPENROUTER_MODEL,
      keyPresent: Boolean(process.env.OPENROUTER_API_KEY),
      enabled: Boolean(process.env.OPENROUTER_API_KEY)
    },
    {
      providerName: 'NVIDIA NIM',
      modelName: process.env.NVIDIA_MODEL || 'z-ai/glm-5.1',
      keyPresent: Boolean(process.env.NVIDIA_API_KEY),
      enabled: Boolean(process.env.NVIDIA_API_KEY)
    },
    {
      providerName: 'Hugging Face',
      modelName: HF_MODEL,
      keyPresent: Boolean(process.env.HF_TOKEN),
      enabled: Boolean(process.env.HF_TOKEN)
    },
    {
      providerName: 'Cohere',
      modelName: COHERE_MODEL,
      keyPresent: Boolean(process.env.COHERE_API_KEY),
      enabled: Boolean(process.env.COHERE_API_KEY)
    },
    {
      providerName: 'Cerebras',
      modelName: process.env.CEREBRAS_MODEL || 'zai-glm-4.7',
      keyPresent: Boolean(process.env.CEREBRAS_API_KEY),
      enabled: Boolean(process.env.CEREBRAS_API_KEY)
    },
    {
      providerName: 'OpenCode',
      modelName: process.env.OPENCODE_MODEL || 'big-pickle',
      keyPresent: Boolean(process.env.OPENCODE_API_KEY),
      enabled: Boolean(process.env.OPENCODE_API_KEY)
    },
    {
      providerName: 'Cloudflare Workers AI',
      modelName: process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      keyPresent: Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID),
      enabled: Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID)
    },
    {
      providerName: 'BytePlus/ModelArk',
      modelName: process.env.BYTEPLUS_MODEL || 'seed-1-8-251228',
      keyPresent: Boolean(process.env.BYTEPLUS_API_KEY || process.env.ARK_API_KEY),
      enabled: Boolean(process.env.BYTEPLUS_API_KEY || process.env.ARK_API_KEY)
    },
    {
      providerName: 'OpenAI',
      modelName: OPENAI_SUMMARY_MODEL,
      keyPresent: Boolean(process.env.OPENAI_API_KEY),
      enabled: process.env.USE_OPENAI !== 'false'
    },
    {
      providerName: 'Google Gemini',
      modelName: GEMINI_MODEL,
      keyPresent: Boolean(process.env.GEMINI_API_KEY),
      enabled: Boolean(process.env.GEMINI_API_KEY)
    },
    {
      providerName: 'Ollama (local)',
      modelName: process.env.OLLAMA_MODEL || 'qwen2.5-coder:0.5b',
      keyPresent: Boolean(process.env.OLLAMA_URL || process.env.OLLAMA_MODEL),
      enabled: Boolean(process.env.OLLAMA_URL || process.env.OLLAMA_MODEL),
      localFallback: true
    }
  ];
}

async function probeProvider(provider) {
  const prompt = 'Responda somente OK.';
  const { providerName, modelName, keyPresent } = provider;
  try {
    const testCall = async (cfg) => {
      const text = await callProvider(cfg);
      return text ? 'available' : 'unavailable';
    };

    if (providerName === 'OpenAI' && hasOpenAi()) {
      const text = await callOpenAi(prompt);
      return { ...provider, status: text ? 'available' : 'unavailable', lastError: '' };
    }

    if (providerName === 'Groq' && process.env.GROQ_API_KEY) {
      const status = await testCall({
        name: 'Groq',
        url: `${process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'Microsoft Foundry Models' && FOUNDRY_API_KEY) {
      const status = await testCall({
        name: 'Microsoft Foundry Models',
        url: `${FOUNDRY_ENDPOINT}/chat/completions`,
        headers: { Authorization: `Bearer ${FOUNDRY_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'OpenRouter' && process.env.OPENROUTER_API_KEY) {
      const status = await testCall({
        name: 'OpenRouter',
        url: `${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/italolopes/freelas-agent', 'X-Title': 'Transcritor WhatsApp' },
        body: { model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'NVIDIA NIM' && process.env.NVIDIA_API_KEY) {
      const status = await testCall({
        name: 'NVIDIA NIM',
        url: `${process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'Hugging Face' && process.env.HF_TOKEN) {
      const status = await testCall({
        name: 'Hugging Face',
        url: `${process.env.HF_BASE_URL || 'https://router.huggingface.co/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: { model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'Cohere' && process.env.COHERE_API_KEY) {
      const status = await testCall({
        name: 'Cohere',
        url: `${process.env.COHERE_BASE_URL || 'https://api.cohere.com'}/v2/chat`,
        headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.message?.content?.[0]?.text?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'Cerebras' && process.env.CEREBRAS_API_KEY) {
      const status = await testCall({
        name: 'Cerebras',
        url: `${process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'OpenCode' && process.env.OPENCODE_API_KEY) {
      const status = await testCall({
        name: 'OpenCode',
        url: `${process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.OPENCODE_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'Cloudflare Workers AI' && process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
      const status = await testCall({
        name: 'Cloudflare Workers AI',
        url: `${process.env.CLOUDFLARE_BASE_URL || 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CLOUDFLARE_ACCOUNT_ID + '/ai/v1'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: { model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'BytePlus/ModelArk' && (process.env.BYTEPLUS_API_KEY || process.env.ARK_API_KEY)) {
      const status = await testCall({
        name: 'BytePlus/ModelArk',
        url: `${process.env.BYTEPLUS_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3'}/chat/completions`,
        headers: { Authorization: `Bearer ${process.env.BYTEPLUS_API_KEY || process.env.ARK_API_KEY}`, 'Content-Type': 'application/json' },
        body: { model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'Google Gemini' && process.env.GEMINI_API_KEY) {
      const status = await testCall({
        name: 'Gemini',
        url: `${process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'}/models/${modelName}:generateContent`,
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
        extractor: json => json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status, lastError: '' };
    }

    if (providerName === 'Ollama (local)' && (process.env.OLLAMA_URL || process.env.OLLAMA_MODEL)) {
      try {
        const baseUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(15000)
        });
        const text = await response.text();
        const available = response.ok && (JSON.parse(text).choices?.[0]?.message?.content?.trim() || '') ? 'available' : 'unavailable';
        return { ...provider, status: available, lastError: available === 'available' ? '' : 'Não respondeu.' };
      } catch (error) {
        return { ...provider, status: 'unavailable', lastError: error.message };
      }
    }
  } catch (error) {
    return { ...provider, status: 'unavailable', lastError: error.message };
  }

  return { ...provider, status: keyPresent ? 'unavailable' : 'missing_key', lastError: keyPresent ? 'Não respondeu no teste.' : 'Chave não configurada.' };
}

async function refreshProviders() {
  const providers = providerEnvSnapshot();
  providerCache = await Promise.all(providers.map(probeProvider));
  providerCacheAt = Date.now();
  return providerCache;
}

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let tempFile;
  try {
    if (!req.file) {
      sseSend(res, 'error', { error: 'Envie um arquivo de áudio.' });
      res.end();
      return;
    }

    const ext = path.extname(req.file.originalname) || '.ogg';
    tempFile = path.join(tempDir, `upload_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    await ensureDir(tempDir);
    await fs.writeFile(tempFile, req.file.buffer);

    sseSend(res, 'progress', { percent: 5, step: 'Áudio recebido, iniciando transcrição...' });

    const text = await transcribeAudio(tempFile, (progress) => {
      sseSend(res, 'progress', progress);
    });

    await fs.remove(tempFile).catch(() => {});
    const wavFile = tempFile.replace(ext, '.wav');
    await fs.remove(wavFile).catch(() => {});

    let finalText = text;
    const shouldCorrect = process.env.ENABLE_TRANSCRIPTION_CORRECTION !== 'false';
    if (shouldCorrect && text && text.trim()) {
      sseSend(res, 'progress', { percent: 85, step: 'Corrigindo transcrição com IA...' });
      finalText = await correctTranscription(text, (p) => {
        sseSend(res, 'progress', { percent: 85 + Math.round(p.percent * 0.13), step: p.step });
      });
    }

    sseSend(res, 'progress', { percent: 100, step: 'Transcrição concluída!' });
    sseSend(res, 'result', { text: finalText });
    res.end();
  } catch (error) {
    if (tempFile) await fs.remove(tempFile).catch(() => {});
    sseSend(res, 'error', { error: error.message || 'Falha na transcrição.' });
    res.end();
  }
});

app.post('/api/respond', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const transcript = normalizeText(req.body?.transcript);
    const userContext = normalizeText(req.body?.userContext);
    if (!transcript) {
      sseSend(res, 'error', { error: 'Informe a transcrição antes de gerar a resposta.' });
      res.end();
      return;
    }
    const prompt = buildPrompt(transcript, userContext);
    const answer = await generateResponse({ transcript, userContext, prompt, onProgress: (p) => sseSend(res, 'progress', p) });
    sseSend(res, 'result', { text: answer });
    res.end();
  } catch (error) {
    sseSend(res, 'error', { error: error.message || 'Falha ao gerar resposta.' });
    res.end();
  }
});

app.get('/api/providers', async (req, res) => {
  try {
    const stale = Date.now() - providerCacheAt > 180000;
    const providers = stale || providerCache.length === 0 ? await refreshProviders() : providerCache;
    res.json({
      providers,
      checkedAt: providerCacheAt
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Falha ao verificar provedores.' });
  }
});

app.get('/health', async (req, res) => {
  try {
    await ensureRuntimeDirs();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Falha no healthcheck.' });
  }
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, async () => {
  await ensureRuntimeDirs();
  await refreshProviders().catch(() => {});
  console.log(`Servidor iniciado em http://${host}:${port}`);
});
