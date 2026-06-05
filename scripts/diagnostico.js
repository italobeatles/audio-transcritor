import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import ffmpegPath from 'ffmpeg-static';

dotenv.config();

const root = process.cwd();
const audioDir = path.join(root, 'audio');
const outputDir = path.join(root, 'output');
const tempDir = path.join(root, 'temp');

function ok(message) {
  console.log(`OK  - ${message}`);
}

function warn(message) {
  console.log(`AVISO - ${message}`);
}

function fail(message) {
  console.log(`ERRO - ${message}`);
  process.exitCode = 1;
}

console.log('\n=== Diagnóstico do Transcritor de Áudios ===\n');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 18) ok(`Node.js ${process.versions.node}`);
else fail(`Node.js ${process.versions.node}. Use Node 18 ou superior.`);

if (ffmpegPath && fs.existsSync(ffmpegPath)) ok(`FFmpeg encontrado via ffmpeg-static: ${ffmpegPath}`);
else fail('FFmpeg não foi encontrado. Rode npm install novamente.');

for (const dir of [audioDir, outputDir, tempDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  ok(`Pasta disponível: ${path.relative(root, dir)}`);
}

const audios = fs.readdirSync(audioDir).filter(file => /\.(opus|ogg|mp3|m4a|wav|webm|mp4|mpeg|mpga)$/i.test(file));
if (audios.length) ok(`${audios.length} arquivo(s) de áudio encontrado(s) em /audio`);
else warn('Nenhum áudio encontrado em /audio. Copie arquivos .opus, .mp3, .m4a, .wav ou .webm para essa pasta.');

if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 10) {
  ok('OPENAI_API_KEY configurada. O app tentará OpenAI antes do fallback local.');
} else {
  warn('OPENAI_API_KEY não configurada. O app seguirá direto para transcrição local.');
}

console.log('\nDiagnóstico concluído.\n');
