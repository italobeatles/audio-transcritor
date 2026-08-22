# Audio Transcritor

Aplicacao Node.js para transcrever audios de WhatsApp, revisar a transcricao em uma interface web e gerar uma resposta pronta para envio. A UI segue o tema visual Corona Admin, com layout escuro, cards de providers e fluxo direto para upload, transcricao e resposta.

## Funcionalidades

- Upload de arquivos de audio no navegador.
- Transcricao local com `@xenova/transformers` e FFmpeg embarcado via `ffmpeg-static`.
- Campo editavel para revisar a transcricao antes de gerar resposta.
- Campo de contexto para informar tom, limites, detalhes pessoais e informacoes relevantes.
- Geracao de resposta pronta para WhatsApp, sem resumo intermediario.
- Cards laterais com status dos providers de IA configurados.
- Fallback entre multiplos provedores de IA, inspirado na logica da aplicacao `99freelas/java-app`.

## Stack

- Node.js 18+
- Express
- Multer
- FFmpeg local via `ffmpeg-static`
- Transformers.js (`@xenova/transformers`)
- OpenAI SDK
- Frontend estatico em HTML, CSS e JavaScript

## Como executar

1. Instale as dependencias:

```bash
npm install
```

2. Crie o arquivo `.env` a partir do exemplo:

```bash
copy .env.example .env
```

3. Preencha no `.env` apenas as chaves que pretende usar.

4. Inicie a aplicacao:

```bash
npm start
```

5. Abra no navegador:

```text
http://localhost:3000
```

## Publicacao com Apache

Neste servidor, a publicacao recomendada e `Apache + proxy reverso + systemd`.

- Defina `HOST=127.0.0.1` para manter o Node acessivel apenas localmente.
- Use `GET /health` para validar servico e proxy reverso.
- Publique o dominio HTTPS no Apache apontando para `http://127.0.0.1:PORT`.

## Variaveis de ambiente

O arquivo `.env` e ignorado pelo Git. Nunca commite chaves reais. Use `.env.example` como referencia.

Variaveis principais:

- `PORT`: porta HTTP local, padrao `3000`.
- `HOST`: interface de bind do Express, padrao `127.0.0.1` para uso com proxy reverso local.
- `LOCAL_TRANSCRIPTION_MODEL`: modelo local de transcricao, padrao `Xenova/whisper-tiny`.
- `OPENAI_API_KEY`: chave da OpenAI.
- `USE_OPENAI`: `true` ou `false` para habilitar chamadas OpenAI.
- `TRANSCRIPTION_MODEL`: modelo OpenAI para transcricao, quando usado.
- `PREFER_REMOTE_TRANSCRIPTION`: usa a transcricao OpenAI antes do fallback local quando definido como `true`.
- `TRANSCRIPTION_PROVIDERS`: ordem dos providers de audio, separados por virgula; padrao `openai,groq`.
- `ALLOW_LOCAL_TRANSCRIPTION_FALLBACK`: permite voltar ao Whisper local quando a API remota falha; mantenha `false` em producao para evitar o erro de stream do runtime ONNX.
- `SUMMARY_MODEL`: modelo OpenAI para texto, quando usado.
- `FOUNDRY_API_KEY`: chave do Microsoft Foundry Models.
- `FOUNDRY_ENDPOINT`: endpoint do projeto no Foundry.
- `FOUNDRY_MODEL`: modelo deployado no Foundry.
- `OPENROUTER_API_KEY`: chave do OpenRouter.
- `GEMINI_API_KEY`: chave do Google Gemini.
- `COHERE_API_KEY`: chave do Cohere.
- `HF_TOKEN`: token do Hugging Face.

## Providers de IA

A aplicacao tenta gerar respostas usando os providers configurados no `.env`. Se um provider falhar por cota, autenticacao ou indisponibilidade, o backend tenta o proximo. A tela mostra o status de cada provider em cards na lateral esquerda.

Providers usados:

- OpenAI: `gpt-5-mini` para resposta e `gpt-4o-transcribe` para transcricao remota.
- Groq: `whisper-large-v3-turbo` como segundo provider de transcricao, quando `GROQ_API_KEY` estiver configurada.
- Microsoft Foundry Models: substitui o antigo GitHub Models, que foi retirado em 2026.
- OpenRouter: `openrouter/auto`.
- Google Gemini: `gemini-2.5-flash`.
- Cohere: `command-a-03-2025`.
- Hugging Face Inference Providers: `zai-org/GLM-4.5`.
- Transformers.js local: `Xenova/whisper-tiny` ou outro modelo configurado.

## Documentacao para obter chaves

- OpenAI API keys: https://platform.openai.com/docs/api-reference/authentication
- OpenAI Help Center sobre API keys: https://help.openai.com/en/articles/4936850-how-to-create-and-use-an-api-key
- GitHub Models foi retirado em 2026: https://docs.github.com/en/github-models?ref=apidog.com
- Migracao de GitHub Models para Microsoft Foundry Models: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/quickstart-github-models
- Microsoft Foundry Models: https://learn.microsoft.com/en-us/azure/foundry/
- OpenRouter API keys: https://openrouter.ai/docs/api-keys
- Google Gemini API keys: https://ai.google.dev/gemini-api/docs/api-key
- Google Gemini 2.5 Flash: https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash
- Cohere docs: https://docs.cohere.com/
- Cohere Command A: https://docs.cohere.com/docs/command-a
- Hugging Face Inference Providers: https://huggingface.co/docs/inference-providers/tasks/chat-completion
- OpenAI GPT-5: https://openai.com/index/introducing-gpt-5/
- OpenAI audio models: https://openai.com/index/introducing-our-next-generation-audio-models/
- NVIDIA NIM docs, usado na aplicacao 99freelas mas ainda nao integrado neste frontend: https://docs.api.nvidia.com/nim/docs/api-quickstart
- BytePlus ModelArk, usado na aplicacao 99freelas mas ainda nao integrado neste frontend: https://docs.byteplus.com/en/docs/ModelArk/1399008

## Estrutura

```text
server.js            Backend Express, upload, transcricao e geracao de resposta
public/             Frontend estatico
scripts/            Scripts CLI originais de diagnostico, limpeza e transcricao em lote
audio/              Pasta local para audios, ignorada no Git
output/             Saidas locais, ignoradas no Git
temp/               Arquivos temporarios, ignorados no Git
```

## Scripts

```bash
npm start
npm run diagnostico
npm run limpar
npm run transcrever
```

## Seguranca

- `.env` esta no `.gitignore`.
- `.env.example` deve conter apenas placeholders e valores publicos.
- Arquivos reais de audio em `audio/` sao ignorados.
- Saidas de transcricao e relatorios em `output/` sao ignoradas.
- Tokens e API keys devem ser rotacionados se forem expostos por engano.
