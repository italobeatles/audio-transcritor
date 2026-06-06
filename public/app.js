const audioInput = document.getElementById('audioInput');
const chooseFileBtn = document.getElementById('chooseFileBtn');
const dropZone = document.getElementById('dropZone');
const fileName = document.getElementById('fileName');
const transcript = document.getElementById('transcript');
const context = document.getElementById('context');
const answer = document.getElementById('answer');
const transcribeBtn = document.getElementById('transcribeBtn');
const generateBtn = document.getElementById('generateBtn');
const copyBtn = document.getElementById('copyBtn');
const statusPill = document.getElementById('statusPill');
const refreshProvidersBtn = document.getElementById('refreshProvidersBtn');
const providersGrid = document.getElementById('providersGrid');
const providersMeta = document.getElementById('providersMeta');
const transcribeProgress = document.getElementById('transcribeProgress');
const transcribeProgressBar = document.getElementById('transcribeProgressBar');
const transcribeProgressText = document.getElementById('transcribeProgressText');
const respondProgress = document.getElementById('respondProgress');
const respondProgressBar = document.getElementById('respondProgressBar');
const respondProgressText = document.getElementById('respondProgressText');

let selectedFile = null;

function setStatus(text) {
  statusPill.textContent = text;
}

function setFile(file) {
  selectedFile = file;
  fileName.textContent = file ? file.name : 'Nenhum arquivo selecionado';
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.dataset.original = button.dataset.original || button.textContent;
  button.textContent = busy ? label : button.dataset.original;
}

function providerBadgeClass(status) {
  if (status === 'available') return 'badge-ok';
  if (status === 'missing_key') return 'badge-missing';
  return 'badge-off';
}

function providerStatusLabel(status) {
  if (status === 'available') return 'Online';
  if (status === 'missing_key') return 'Sem chave';
  if (status === 'quota_exhausted') return 'Sem cota';
  return 'Offline';
}

function renderProviders(providers = [], checkedAt) {
  providersGrid.innerHTML = providers.map(provider => `
    <article class="provider-card">
      <div class="provider-head">
        <div>
          <div class="provider-name">${provider.providerName}</div>
          <div class="provider-model">${provider.modelName}</div>
        </div>
        <div class="provider-badge ${providerBadgeClass(provider.status)}">${providerStatusLabel(provider.status)}</div>
      </div>
      <div class="provider-error">${provider.lastError || 'Conexão verificada.'}</div>
      <div class="provider-foot">
        <span>${provider.enabled ? 'Habilitado' : 'Desabilitado'}</span>
        <span>${provider.localFallback ? 'Fallback local' : (provider.keyPresent ? 'Chave configurada' : 'Chave ausente')}</span>
      </div>
    </article>
  `).join('');
  providersMeta.textContent = checkedAt ? `Atualizado em ${new Date(checkedAt).toLocaleString('pt-BR')}` : 'Verificação pendente';
}

async function loadProviders() {
  setStatus('Verificando providers');
  const response = await fetch('/api/providers');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Falha ao verificar providers');
  renderProviders(data.providers || [], data.checkedAt);
  setStatus('Providers atualizados');
}

chooseFileBtn.addEventListener('click', () => audioInput.click());
dropZone.addEventListener('click', () => audioInput.click());
refreshProvidersBtn.addEventListener('click', async () => {
  refreshProvidersBtn.disabled = true;
  try {
    await loadProviders();
  } catch (error) {
    setStatus('Erro ao verificar providers');
    providersMeta.textContent = error.message;
  } finally {
    refreshProvidersBtn.disabled = false;
  }
});

audioInput.addEventListener('change', () => setFile(audioInput.files?.[0] || null));

['dragenter', 'dragover'].forEach(eventName => {
  dropZone.addEventListener(eventName, e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  });
});

dropZone.addEventListener('drop', e => {
  const file = e.dataTransfer.files?.[0];
  if (file) {
    audioInput.files = e.dataTransfer.files;
    setFile(file);
  }
});

async function readSSE(response, onEvent, onError) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let eventType = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event: ')) {
        eventType = trimmed.slice(7).trim();
      } else if (trimmed.startsWith('data: ')) {
        try {
          const data = JSON.parse(trimmed.slice(6));
          if (eventType === 'error') {
            onError?.(data.error || 'Erro desconhecido');
          } else {
            onEvent?.(eventType, data);
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    }
  }
}

function showProgress(container, bar, text, percent, step) {
  if (!container) return;
  container.style.display = 'block';
  bar.style.width = `${Math.min(percent, 100)}%`;
  text.textContent = step ? `${step} (${percent}%)` : `${percent}%`;
}

function hideProgress(container) {
  if (container) container.style.display = 'none';
}

transcribeBtn.addEventListener('click', async () => {
  if (!selectedFile) {
    setStatus('Selecione um áudio');
    return;
  }

  setBusy(transcribeBtn, true, 'Transcrevendo...');
  showProgress(transcribeProgress, transcribeProgressBar, transcribeProgressText, 0, 'Iniciando...');
  setStatus('Transcrevendo');
  try {
    const formData = new FormData();
    formData.append('audio', selectedFile);

    const response = await fetch('/api/transcribe', { method: 'POST', body: formData });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Erro ${response.status}`);
    }

    await readSSE(response, (event, data) => {
      if (event === 'progress') {
        showProgress(transcribeProgress, transcribeProgressBar, transcribeProgressText, data.percent, data.step);
        setStatus(data.step || 'Transcrevendo');
      } else if (event === 'result') {
        transcript.value = data.text || '';
        hideProgress(transcribeProgress);
        setStatus('Transcrição pronta');
      }
    }, (error) => {
      setStatus('Erro na transcrição');
      transcript.value = `Erro: ${error}`;
      hideProgress(transcribeProgress);
    });
  } catch (error) {
    setStatus('Erro na transcrição');
    transcript.value = `Erro: ${error.message}`;
    hideProgress(transcribeProgress);
  } finally {
    setBusy(transcribeBtn, false);
  }
});

generateBtn.addEventListener('click', async () => {
  if (!transcript.value.trim()) {
    setStatus('Transcreva antes');
    return;
  }

  setBusy(generateBtn, true, 'Gerando...');
  showProgress(respondProgress, respondProgressBar, respondProgressText, 0, 'Iniciando...');
  setStatus('Gerando resposta');
  try {
    const response = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: transcript.value,
        userContext: context.value
      })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Erro ${response.status}`);
    }

    await readSSE(response, (event, data) => {
      if (event === 'progress') {
        showProgress(respondProgress, respondProgressBar, respondProgressText, data.percent, data.step);
        setStatus(data.step || 'Gerando resposta');
      } else if (event === 'result') {
        answer.value = data.text || '';
        hideProgress(respondProgress);
        setStatus('Resposta pronta');
      }
    }, (error) => {
      setStatus('Erro na resposta');
      answer.value = `Erro: ${error}`;
      hideProgress(respondProgress);
    });
  } catch (error) {
    setStatus('Erro na resposta');
    answer.value = `Erro: ${error.message}`;
    hideProgress(respondProgress);
  } finally {
    setBusy(generateBtn, false);
  }
});

copyBtn.addEventListener('click', async () => {
  if (!answer.value.trim()) return;
  await navigator.clipboard.writeText(answer.value);
  setStatus('Resposta copiada');
});

loadProviders().catch(error => {
  providersMeta.textContent = error.message;
});
