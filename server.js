import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import wav from 'wav-decoder';
import { pipeline } from '@xenova/transformers';
import OpenAI from 'openai';

ffmpeg.setFfmpegPath(ffmpegPath);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;
const publicDir = path.join(root, 'public');
const tempDir = path.join(root, 'temp');
const uploadDir = path.join(tempDir, 'uploads');

const app = express();
const upload = multer({ dest: uploadDir });
app.use(express.json({ limit: '2mb' }));
app.use(express.static(publicDir));

const TRANSCRIPTION_MODEL = process.env.LOCAL_TRANSCRIPTION_MODEL || 'Xenova/whisper-base';
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

async function convertToWav(inputFile) {
  const outputFile = path.join(tempDir, `${path.basename(inputFile, path.extname(inputFile))}.wav`);
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
    localTranscriberPromise = pipeline('automatic-speech-recognition', TRANSCRIPTION_MODEL);
  }
  return localTranscriberPromise;
}

async function transcribeAudio(inputPath) {
  const wavPath = await convertToWav(inputPath);
  const buffer = await fs.readFile(wavPath);
  const audioData = await wav.decode(buffer);
  const transcriber = await getLocalTranscriber();
  const result = await transcriber(audioData.channelData[0], {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: 'portuguese',
    task: 'transcribe'
  });
  return normalizeText(result?.text);
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

async function callOpenAi(prompt) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: process.env.SUMMARY_MODEL || 'gpt-4.1-mini',
    temperature: 0.3,
    messages: [
      { role: 'system', content: 'Você é um assistente brasileiro.' },
      { role: 'user', content: prompt }
    ]
  });
  return response.choices?.[0]?.message?.content?.trim() || '';
}

function summariseLocally(transcript, userContext) {
  const cleaned = normalizeText(transcript);
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  const first = sentences.slice(0, 6).join(' ');
  return `Li com atenção o que você trouxe e quero responder com cuidado, sem ser superficial. Pelo que entendi, tem pontos importantes aí que merecem ser levados a sério: ${first || cleaned}

Também estou levando em conta este contexto: ${userContext || 'não há um contexto adicional além da própria transcrição'}.

Quero ser honesto e cuidadoso ao mesmo tempo. Eu valorizo essa troca e o que você está tentando comunicar, mas também não quero criar uma expectativa que eu não possa sustentar. Para mim, faz sentido continuar essa conversa com calma, tentando entender melhor o que é mais importante para você agora e o que você espera que eu compreenda de forma mais concreta.`;
}

async function callProvider({ name, url, headers, body, extractor, errorHint }) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    const quota = response.status === 429 || /quota|rate limit|insufficient/i.test(text);
    throw new Error(`${name} retornou ${response.status}: ${errorHint || text}`, { cause: quota ? 'quota' : 'error' });
  }
  return extractor(JSON.parse(text));
}

async function generateResponse({ transcript, userContext, prompt }) {
  const attempts = [];

  if (hasOpenAi()) {
    attempts.push(async () => callOpenAi(prompt));
  }

  if (process.env.GITHUB_TOKEN) {
    attempts.push(() => callProvider({
      name: 'GitHub Models',
      url: `${process.env.GITHUB_BASE_URL || 'https://models.inference.ai.azure.com'}/chat/completions`,
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: { model: process.env.GITHUB_MODEL || 'gpt-4o-mini', temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
      extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
      errorHint: 'sem resposta util'
    }));
  }

  if (process.env.OPENROUTER_API_KEY) {
    attempts.push(() => callProvider({
      name: 'OpenRouter',
      url: `${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/italolopes/freelas-agent',
        'X-Title': 'Transcritor WhatsApp'
      },
      body: { model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat', temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
      extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
      errorHint: 'sem resposta util'
    }));
  }

  if (process.env.GEMINI_API_KEY) {
    attempts.push(() => callProvider({
      name: 'Gemini',
      url: `${process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'}/models/${process.env.GEMINI_MODEL || 'gemini-flash-latest'}:generateContent`,
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
      extractor: json => json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '',
      errorHint: 'sem resposta util'
    }));
  }

  if (process.env.COHERE_API_KEY) {
    attempts.push(() => callProvider({
      name: 'Cohere',
      url: `${process.env.COHERE_BASE_URL || 'https://api.cohere.com'}/v2/chat`,
      headers: {
        Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: { model: process.env.COHERE_MODEL || 'command-r-plus-08-2024', temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
      extractor: json => json.message?.content?.[0]?.text?.trim() || '',
      errorHint: 'sem resposta util'
    }));
  }

  if (process.env.HF_TOKEN) {
    attempts.push(() => callProvider({
      name: 'Hugging Face',
      url: `${process.env.HF_BASE_URL || 'https://router.huggingface.co/v1'}/chat/completions`,
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: { model: process.env.HF_MODEL || 'deepseek-ai/DeepSeek-V4-Flash:fastest', temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
      extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
      errorHint: 'sem resposta util'
    }));
  }

  let lastError;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
  }

  return summariseLocally(transcript || prompt, userContext);
}

function providerEnvSnapshot() {
  return [
    {
      providerName: 'OpenAI',
      modelName: process.env.SUMMARY_MODEL || 'gpt-4.1-mini',
      keyPresent: Boolean(process.env.OPENAI_API_KEY),
      enabled: process.env.USE_OPENAI !== 'false'
    },
    {
      providerName: 'GitHub Models',
      modelName: process.env.GITHUB_MODEL || 'gpt-4o-mini',
      keyPresent: Boolean(process.env.GITHUB_TOKEN),
      enabled: Boolean(process.env.GITHUB_TOKEN)
    },
    {
      providerName: 'OpenRouter',
      modelName: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat',
      keyPresent: Boolean(process.env.OPENROUTER_API_KEY),
      enabled: Boolean(process.env.OPENROUTER_API_KEY)
    },
    {
      providerName: 'Google Gemini',
      modelName: process.env.GEMINI_MODEL || 'gemini-flash-latest',
      keyPresent: Boolean(process.env.GEMINI_API_KEY),
      enabled: Boolean(process.env.GEMINI_API_KEY)
    },
    {
      providerName: 'Cohere',
      modelName: process.env.COHERE_MODEL || 'command-r-plus-08-2024',
      keyPresent: Boolean(process.env.COHERE_API_KEY),
      enabled: Boolean(process.env.COHERE_API_KEY)
    },
    {
      providerName: 'Hugging Face',
      modelName: process.env.HF_MODEL || 'deepseek-ai/DeepSeek-V4-Flash:fastest',
      keyPresent: Boolean(process.env.HF_TOKEN),
      enabled: Boolean(process.env.HF_TOKEN)
    }
  ];
}

async function probeProvider(provider) {
  const prompt = 'Responda somente OK.';
  try {
    if (provider.providerName === 'OpenAI' && hasOpenAi()) {
      const text = await callOpenAi(prompt);
      return { ...provider, status: text ? 'available' : 'unavailable', lastError: '' };
    }

    if (provider.providerName === 'GitHub Models' && process.env.GITHUB_TOKEN) {
      const text = await callProvider({
        name: 'GitHub Models',
        url: `${process.env.GITHUB_BASE_URL || 'https://models.inference.ai.azure.com'}/chat/completions`,
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: { model: provider.modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status: text ? 'available' : 'unavailable', lastError: '' };
    }

    if (provider.providerName === 'OpenRouter' && process.env.OPENROUTER_API_KEY) {
      const text = await callProvider({
        name: 'OpenRouter',
        url: `${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`,
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/italolopes/freelas-agent',
          'X-Title': 'Transcritor WhatsApp'
        },
        body: { model: provider.modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status: text ? 'available' : 'unavailable', lastError: '' };
    }

    if (provider.providerName === 'Google Gemini' && process.env.GEMINI_API_KEY) {
      const text = await callProvider({
        name: 'Gemini',
        url: `${process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'}/models/${provider.modelName}:generateContent`,
        headers: {
          'x-goog-api-key': process.env.GEMINI_API_KEY,
          'Content-Type': 'application/json'
        },
        body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
        extractor: json => json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status: text ? 'available' : 'unavailable', lastError: '' };
    }

    if (provider.providerName === 'Cohere' && process.env.COHERE_API_KEY) {
      const text = await callProvider({
        name: 'Cohere',
        url: `${process.env.COHERE_BASE_URL || 'https://api.cohere.com'}/v2/chat`,
        headers: {
          Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: { model: provider.modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.message?.content?.[0]?.text?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status: text ? 'available' : 'unavailable', lastError: '' };
    }

    if (provider.providerName === 'Hugging Face' && process.env.HF_TOKEN) {
      const text = await callProvider({
        name: 'Hugging Face',
        url: `${process.env.HF_BASE_URL || 'https://router.huggingface.co/v1'}/chat/completions`,
        headers: {
          Authorization: `Bearer ${process.env.HF_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: { model: provider.modelName, temperature: 0, messages: [{ role: 'user', content: prompt }] },
        extractor: json => json.choices?.[0]?.message?.content?.trim() || '',
        errorHint: 'sem resposta'
      });
      return { ...provider, status: text ? 'available' : 'unavailable', lastError: '' };
    }
  } catch (error) {
    return { ...provider, status: 'unavailable', lastError: error.message };
  }

  return { ...provider, status: provider.keyPresent ? 'unavailable' : 'missing_key', lastError: provider.keyPresent ? 'Não respondeu no teste.' : 'Chave não configurada.' };
}

async function refreshProviders() {
  const providers = providerEnvSnapshot();
  providerCache = await Promise.all(providers.map(probeProvider));
  providerCacheAt = Date.now();
  return providerCache;
}

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Envie um arquivo de áudio.' });
    }
    const text = await transcribeAudio(req.file.path);
    await fs.remove(req.file.path).catch(() => {});
    res.json({ text });
  } catch (error) {
    if (req.file?.path) await fs.remove(req.file.path).catch(() => {});
    res.status(500).json({ error: error.message || 'Falha na transcrição.' });
  }
});

app.post('/api/respond', async (req, res) => {
  try {
    const transcript = normalizeText(req.body?.transcript);
    const userContext = normalizeText(req.body?.userContext);
    if (!transcript) {
      return res.status(400).json({ error: 'Informe a transcrição antes de gerar a resposta.' });
    }
    const prompt = buildPrompt(transcript, userContext);
    const answer = await generateResponse({ transcript, userContext, prompt });
    res.json({ text: answer });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Falha ao gerar resposta.' });
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

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  await ensureDir(tempDir);
  await ensureDir(uploadDir);
  await refreshProviders().catch(() => {});
  console.log(`Servidor iniciado em http://localhost:${port}`);
});
