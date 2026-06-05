import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import wav from 'wav-decoder';
import { pipeline } from '@xenova/transformers';

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const audioDir = path.join(root, 'audio');
const outputDir = path.join(root, 'output');
const tempDir = path.join(root, 'temp');

const TRANSCRIPTION_MODELS = [
  process.env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
  'whisper-1'
].filter(Boolean);

const SUMMARY_MODELS = [
  process.env.SUMMARY_MODEL || 'gpt-4.1-mini',
  'gpt-4o-mini',
  'gpt-4o'
].filter(Boolean);

const LOCAL_TRANSCRIPTION_MODEL = process.env.LOCAL_TRANSCRIPTION_MODEL || 'Xenova/whisper-base';
const SUPPORTED = /\.(opus|ogg|mp3|m4a|wav|webm|mp4|mpeg|mpga)$/i;
const STOPWORDS = new Set([
  'a', 'à', 'agora', 'ainda', 'algo', 'alguma', 'algumas', 'algum', 'alguns', 'ao', 'aos',
  'as', 'até', 'com', 'como', 'da', 'das', 'de', 'dela', 'dele', 'deles', 'demais', 'depois',
  'do', 'dos', 'e', 'ela', 'elas', 'ele', 'eles', 'em', 'entre', 'era', 'essa', 'essas',
  'esse', 'esses', 'esta', 'está', 'estao', 'estão', 'eu', 'foi', 'foram', 'isso', 'isto',
  'já', 'la', 'lá', 'mais', 'mas', 'me', 'mesmo', 'meu', 'minha', 'muito', 'na', 'não',
  'nas', 'nem', 'no', 'nos', 'nós', 'o', 'os', 'ou', 'para', 'pela', 'pelas', 'pelo', 'pelos',
  'por', 'porque', 'pra', 'que', 'quem', 'se', 'sem', 'ser', 'só', 'sua', 'suas', 'seu',
  'seus', 'também', 'te', 'tem', 'tenho', 'ter', 'to', 'tô', 'tu', 'um', 'uma', 'você', 'vocês'
]);

let cachedLocalTranscriber;

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function hasApiKey() {
  const openAiEnabled = String(process.env.USE_OPENAI || 'true').toLowerCase() !== 'false';
  return openAiEnabled && Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length >= 10);
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function splitIntoSentences(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function excerpt(text, maxLength = 220) {
  const cleaned = normalizeText(text);
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength).trimEnd()}...`;
}

function extractKeywords(text, limit = 8) {
  const counts = new Map();
  const words = normalizeText(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 4 && !STOPWORDS.has(word));

  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'))
    .slice(0, limit)
    .map(([word]) => word);
}

async function convertToWav(inputFile) {
  const base = path.basename(inputFile, path.extname(inputFile));
  const outputFile = path.join(tempDir, `${base}.wav`);
  await fs.ensureDir(tempDir);

  return new Promise((resolve, reject) => {
    ffmpeg(inputFile)
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('end', () => resolve(outputFile))
      .on('error', reject)
      .save(outputFile);
  });
}

async function getLocalTranscriber() {
  if (!cachedLocalTranscriber) {
    log(`Carregando transcritor local ${LOCAL_TRANSCRIPTION_MODEL}...`);
    cachedLocalTranscriber = pipeline('automatic-speech-recognition', LOCAL_TRANSCRIPTION_MODEL);
  }

  return cachedLocalTranscriber;
}

async function transcribeLocally(audioFile) {
  const buffer = await fs.readFile(audioFile);
  const audioData = await wav.decode(buffer);
  const channel = audioData.channelData?.[0];

  if (!channel?.length) {
    throw new Error(`Falha ao decodificar o áudio localmente: ${path.basename(audioFile)}`);
  }

  const transcriber = await getLocalTranscriber();
  const result = await transcriber(channel, {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: 'portuguese',
    task: 'transcribe'
  });

  return {
    model: LOCAL_TRANSCRIPTION_MODEL,
    provider: 'local',
    text: normalizeText(result?.text)
  };
}

async function transcribeWithFallback(openai, audioFile) {
  let lastError;

  if (openai) {
    for (const model of TRANSCRIPTION_MODELS) {
      try {
        log(`Transcrevendo com OpenAI (${model}): ${path.basename(audioFile)}`);
        const result = await openai.audio.transcriptions.create({
          file: fs.createReadStream(audioFile),
          model,
          language: 'pt',
          response_format: 'text'
        });

        return {
          model,
          provider: 'openai',
          text: normalizeText(typeof result === 'string' ? result : String(result))
        };
      } catch (error) {
        lastError = error;
        log(`Falhou com ${model}: ${error.message}`);
      }
    }
  }

  log(`Usando fallback local para ${path.basename(audioFile)}${lastError ? ` após erro na OpenAI: ${lastError.message}` : ''}`);
  return transcribeLocally(audioFile);
}

function buildOfflineReport(transcriptEntries) {
  const combinedText = transcriptEntries.map(entry => entry.text).join(' ');
  const keywords = extractKeywords(combinedText);
  const chronological = transcriptEntries
    .map(({ filename, text }) => {
      const firstSentence = splitIntoSentences(text)[0] || excerpt(text, 180);
      return `1. ${filename}: ${excerpt(firstSentence, 180)}`;
    })
    .join('\n');

  const concerns = transcriptEntries
    .flatMap(({ text }) => splitIntoSentences(text))
    .filter(sentence => /(medo|receio|insegur|confus|ansio|angust|triste|machuc|joguin|demora|sum|afast|duvida|dúvida|bloque|trauma|processo)/i.test(sentence))
    .slice(0, 6)
    .map(sentence => `- ${excerpt(sentence, 200)}`)
    .join('\n') || '- A transcrição local sugere conteúdo emocional e relacional, mas a leitura humana ainda é importante para validar nuances.';

  return `## Resumo geral

Transcrição concluída em modo local, porque a conta da OpenAI não respondeu com cota disponível para a etapa de resumo. O conteúdo indica uma conversa emocional, com tentativa de explicar sentimentos, justificar comportamentos e oferecer um ponto de vista sobre o que a outra pessoa está vivendo.

Temas recorrentes identificados localmente: ${keywords.join(', ') || 'sem palavras-chave dominantes suficientes'}.

## Principais pontos em ordem cronológica

${chronological}

## Possíveis intenções, preocupações ou pedidos

${concerns}

## Pontos que precisam de confirmação antes de responder

- Confirme o contexto real da relação entre vocês, porque a transcrição local pode perder nomes, negações e sutilezas.
- Valide se a pessoa está apenas desabafando ou se espera uma resposta prática, reconciliação, posicionamento ou limite.
- Identifique se há pedidos concretos escondidos em meio ao desabafo, como conversar, esclarecer algo ou receber acolhimento.

## Resposta sugerida para WhatsApp

Li e ouvi com atenção. Obrigado por organizar isso tudo e me falar com sinceridade. Dá para perceber que você pensou bastante antes de mandar e que tem coisa importante aí no que você está sentindo e tentando elaborar. Quero entender melhor alguns pontos para não responder de forma superficial nem injusta com você. Se fizer sentido, me diz qual é a parte principal que você queria que eu compreendesse ou levasse em conta agora.

## Estratégias para lidar com possíveis problemas apontados

- Se o problema for ruído de comunicação, responda resumindo o que você entendeu e peça confirmação.
- Se houver insegurança por demora, alinhe expectativa de tempo e frequência de resposta.
- Se aparecer ambiguidade afetiva, evite prometer proximidade que você não pretende sustentar.
- Se a pessoa estiver emocionalmente sobrecarregada, valide o sentimento antes de entrar em debate ou defesa.`;
}

async function summarizeWithFallback(openai, combinedTranscript) {
  if (!openai) {
    throw new Error('OpenAI indisponível para resumo.');
  }

  let lastError;
  const system = 'Você é um assistente brasileiro especializado em resumir conversas de áudio do WhatsApp com atenção a contexto emocional e relações interpessoais. Seja fiel ao conteúdo, não invente fatos e deixe claro quando algo depender do contexto.';
  const user = `Abaixo está a transcrição de uma sequência de áudios. Produza em Markdown:

1. Resumo geral da conversa.
2. Principais pontos em ordem cronológica.
3. Possíveis intenções, preocupações ou pedidos da pessoa que enviou os áudios.
4. Pontos que precisam de confirmação antes de responder.
5. Uma sugestão de resposta pronta para enviar no WhatsApp, em tom respeitoso, humano e interessado.
6. Estratégias objetivas para lidar com os problemas ou riscos apontados nos áudios.

Transcrição:

${combinedTranscript}`;

  for (const model of SUMMARY_MODELS) {
    try {
      log(`Gerando resumo e resposta sugerida com ${model}`);
      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      });

      return {
        model,
        text: completion.choices?.[0]?.message?.content?.trim() || ''
      };
    } catch (error) {
      lastError = error;
      log(`Falhou com ${model}: ${error.message}`);
    }
  }

  throw lastError;
}

async function main() {
  await fs.ensureDir(audioDir);
  await fs.ensureDir(outputDir);
  await fs.ensureDir(tempDir);

  const openai = hasApiKey() ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  const files = (await fs.readdir(audioDir))
    .filter(file => SUPPORTED.test(file))
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
    .map(file => path.join(audioDir, file));

  if (!files.length) {
    throw new Error('Nenhum áudio encontrado na pasta audio/.');
  }

  if (!openai) {
    log('OPENAI_API_KEY ausente ou inválida. O app seguirá com transcrição local.');
  }

  const runId = nowStamp();
  const transcriptEntries = [];
  const metadata = [];

  log(`${files.length} áudio(s) encontrado(s).`);

  for (let index = 0; index < files.length; index += 1) {
    const original = files[index];
    const filename = path.basename(original);
    log(`Processando ${index + 1}/${files.length}: ${filename}`);

    const wavFile = await convertToWav(original);
    const { model, provider, text } = await transcribeWithFallback(openai, wavFile);
    const transcriptionText = text.trim();
    const individualTxt = path.join(outputDir, `${path.basename(filename, path.extname(filename))}.transcricao.txt`);

    await fs.writeFile(individualTxt, `${transcriptionText}\n`, 'utf8');

    transcriptEntries.push({ filename, text: transcriptionText });
    metadata.push({
      filename,
      transcriptionModel: model,
      transcriptionProvider: provider,
      textLength: transcriptionText.length
    });
  }

  const combinedTranscript = `# Transcrição completa dos áudios\n\nGerado em: ${new Date().toLocaleString('pt-BR')}\n\n${transcriptEntries.map(entry => `## ${entry.filename}\n\n${entry.text}\n`).join('\n---\n\n')}`;
  const combinedPath = path.join(outputDir, `transcricao-completa-${runId}.md`);
  await fs.writeFile(combinedPath, combinedTranscript, 'utf8');

  let summaryModel = 'offline-report';
  let summaryText;

  try {
    const summary = await summarizeWithFallback(openai, combinedTranscript);
    summaryModel = summary.model;
    summaryText = summary.text;
  } catch (error) {
    log(`Resumo com OpenAI indisponível: ${error.message}`);
    summaryText = buildOfflineReport(transcriptEntries);
  }

  const finalReport = `# Relatório final dos áudios\n\nGerado em: ${new Date().toLocaleString('pt-BR')}\n\nModelo de resumo: ${summaryModel}\n\n---\n\n${summaryText}\n\n---\n\n## Arquivos processados\n\n${metadata.map((item, idx) => `${idx + 1}. ${item.filename} — transcrição: ${item.transcriptionProvider}/${item.transcriptionModel}`).join('\n')}\n`;
  const reportPath = path.join(outputDir, `relatorio-final-${runId}.md`);
  const jsonPath = path.join(outputDir, `resultado-${runId}.json`);

  await fs.writeFile(reportPath, finalReport, 'utf8');
  await fs.writeJson(jsonPath, {
    generatedAt: new Date().toISOString(),
    metadata,
    combinedTranscript,
    summaryModel,
    summaryText
  }, { spaces: 2 });

  log('Concluído!');
  console.log('\nArquivos gerados:');
  console.log(`- ${path.relative(root, combinedPath)}`);
  console.log(`- ${path.relative(root, reportPath)}`);
  console.log(`- ${path.relative(root, jsonPath)}`);
}

main().catch(error => {
  console.error('\nFalha ao executar a transcrição:');
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
