# Prompt para usar no OpenAI Codex

Você está dentro de um projeto Node.js chamado `transcritor-audios-whatsapp`.

Objetivo: executar uma aplicação que transcreve os áudios da pasta `audio/`, gera um resumo geral da conversa e sugere uma resposta pronta para enviar no WhatsApp.

Siga estes passos:

1. Verifique se existe Node.js 18+ e npm disponíveis.
2. Rode `npm install` na raiz do projeto.
3. Verifique se existe arquivo `.env`. Se não existir, copie `.env.example` para `.env`.
4. Confirme comigo se a variável `OPENAI_API_KEY` está preenchida no `.env`. Não exponha a chave no terminal nem no chat.
5. Rode `npm run diagnostico`.
6. Se o diagnóstico estiver ok, rode `npm start`.
7. Ao final, abra a pasta `output/` e me informe quais arquivos foram criados.
8. Se ocorrer erro de modelo indisponível, ajuste os modelos no `.env` ou no fallback do script sem remover os fallbacks existentes.
9. Se ocorrer erro de conversão, verifique a dependência `ffmpeg-static` e o caminho do FFmpeg no script.

Restrições:

- Não mova os áudios originais para fora da pasta `audio/`.
- Não apague os arquivos de saída sem autorização.
- Não faça commit da chave da API.
- Não envie a chave da API para nenhum lugar além da OpenAI API usada pela biblioteca oficial `openai`.

Resultado esperado:

- `output/transcricao-completa-*.md`
- `output/relatorio-final-*.md`
- transcrições individuais `output/*.transcricao.txt`
